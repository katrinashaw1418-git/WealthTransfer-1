// =============================================================================
// FEE ENGINE — INSUFFICIENT FUNDS TEST SCRIPT (Task #34)
// =============================================================================
// Verifies the new insufficient-funds gate inside settleApprovedDeduction:
//
//   1. INSUFFICIENT — client balance < totalAccrued must:
//        a. throw InsufficientFundsError
//        b. flip the deduction to status='insufficient_funds' with a
//           failureReason populated
//        c. NOT insert a transactions row for the deterministic idempotency key
//        d. NOT insert any ledger entries that reference that idempotency key
//
//   2. SUFFICIENT — after a synthetic top-up that brings the client balance
//      above totalAccrued, retrying the same deduction must:
//        a. return successfully with status='settled'
//        b. clear failureReason
//        c. insert exactly one transactions row with the deterministic key
//        d. insert the balanced ledger triple (client debit + adviser credit
//           + platform credit), all balanced to zero
//
// Hard rules:
//   - Scoped to deterministic test users; cleans its own rows on every run.
//   - Does NOT touch any production user, advice record, fee consent, or
//     fee rule. settleApprovedDeduction only reads the deduction row plus
//     the accounts ledger, so a deduction can be inserted directly without
//     the consent/rule/accrual chain and the gate is exercised end-to-end.
//   - Exits non-zero if any assertion fails so a deploy gate can rely on it.
//
// Usage:
//   npx tsx scripts/test-fee-insufficient-funds.ts
// =============================================================================

import { and, eq, sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  users,
  accounts,
  ledgerEntries,
  transactions,
  adviserFeeDeductions,
  wallets,
} from "../shared/schema";
import {
  getOrCreateClientAccount,
  getOrCreateSuspenseAccount,
  postLedgerEntries,
  refreshWalletCacheBalance,
} from "../server/services/ledger";
import {
  settleApprovedDeduction,
  InsufficientFundsError,
} from "../server/services/fee-engine";
// Task #204 — sweep + shortfall parser regression assertions.
// We import the SAME entry point the cron and the new admin endpoint use,
// so this script also acts as a regression gate for both call sites.
import { runInsufficientFundsSweep } from "../server/services/insufficient-funds-sweep";
import { parseShortfallFromFailureReason } from "../client/src/lib/insufficient-funds";

const CLIENT_USERNAME = "__feegate_test_client__";
const ADVISER_USERNAME = "__feegate_test_adviser__";
const TEST_CURRENCY = "AUD";

type TestResult = { name: string; passed: boolean; details?: string };
const results: TestResult[] = [];

function pass(name: string, details?: string) {
  results.push({ name, passed: true, details });
}
function fail(name: string, details?: string) {
  results.push({ name, passed: false, details });
}

// ---------------------------------------------------------------------------
// Fixture management
// ---------------------------------------------------------------------------

async function ensureUser(username: string, email: string): Promise<number> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.username, username));
  if (existing) return existing.id;
  const [created] = await db
    .insert(users)
    .values({
      username,
      email,
      password: "not-a-real-password",
      firstName: "FeeGate",
      lastName: "Test",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  return created.id;
}

async function ensureFreshTestWallet(userId: number): Promise<void> {
  const [existing] = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.currency, TEST_CURRENCY)));
  if (existing) {
    await db
      .update(wallets)
      .set({ balance: "0", availableBalance: "0" })
      .where(eq(wallets.id, existing.id));
    return;
  }
  await db.insert(wallets).values({
    userId,
    currency: TEST_CURRENCY,
    balance: "0",
    availableBalance: "0",
    walletType: "fiat",
  });
}

async function cleanupForUser(userId: number): Promise<void> {
  // FK chain: ledger_entries / ledger_postings → transactions ← adviser_fee_deductions.
  // Order: drop ledger refs, drop fee_deductions (which FK transactions), then transactions,
  // then wallets / accounts (which transactions and ledger_entries reference).
  await db.execute(sql`
    DELETE FROM ledger_entries
    WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = ${userId})
  `);
  await db.execute(sql`
    DELETE FROM ledger_entries
    WHERE account_id IN (SELECT id FROM accounts WHERE user_id = ${userId})
  `);
  await db.execute(sql`
    DELETE FROM ledger_postings
    WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = ${userId})
  `);
  // adviser_fee_deductions has FKs settled_transaction_id / reversal_transaction_id → transactions.
  // Must drop before deleting the tx rows they point at.
  await db
    .delete(adviserFeeDeductions)
    .where(eq(adviserFeeDeductions.clientUserId, userId));
  await db
    .delete(adviserFeeDeductions)
    .where(eq(adviserFeeDeductions.adviserUserId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(wallets).where(eq(wallets.userId, userId));
  await db.delete(accounts).where(eq(accounts.userId, userId));
}

// ---------------------------------------------------------------------------
// Synthetic top-up: posts a balanced credit-client / debit-suspense pair so
// the client account's ledger-derived balance is positive — without touching
// any real-world deposit handler. Mirrors what test-transaction-safety.ts
// does to seed funds for assertions.
// ---------------------------------------------------------------------------
async function topUpClient(userId: number, amount: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [txRow] = await (tx as any)
      .insert(transactions)
      .values({
        userId,
        type: "deposit",
        fromCurrency: null,
        toCurrency: TEST_CURRENCY,
        amount,
        fee: "0",
        status: "completed",
        description: "feegate test top-up",
      })
      .returning();

    const clientAccount = await getOrCreateClientAccount(
      userId,
      TEST_CURRENCY,
      tx,
    );
    const suspense = await getOrCreateSuspenseAccount(TEST_CURRENCY, tx);

    await postLedgerEntries(
      txRow.id,
      [
        {
          accountId: suspense.id,
          userId: suspense.userId,
          currency: TEST_CURRENCY,
          direction: "debit",
          amount,
          description: "feegate test top-up (suspense debit)",
        },
        {
          accountId: clientAccount.id,
          userId,
          currency: TEST_CURRENCY,
          direction: "credit",
          amount,
          description: "feegate test top-up (client credit)",
        },
      ],
      tx,
    );

    await refreshWalletCacheBalance(tx, userId, TEST_CURRENCY);
  });
}

async function insertPendingDeduction(opts: {
  clientUserId: number;
  adviserUserId: number;
  totalAccrued: string;
  adviserShare: string;
}): Promise<number> {
  const start = new Date(Date.UTC(2026, 0, 1));
  const end = new Date(Date.UTC(2026, 1, 1));
  const platformShare = (
    Number(opts.totalAccrued) - Number(opts.adviserShare)
  ).toFixed(4);
  const [row] = await db
    .insert(adviserFeeDeductions)
    .values({
      clientUserId: opts.clientUserId,
      adviserUserId: opts.adviserUserId,
      periodStart: start,
      periodEnd: end,
      totalAccrued: opts.totalAccrued,
      adviserShareAmount: opts.adviserShare,
      platformShareAmount: platformShare,
      currency: TEST_CURRENCY,
      accrualIds: [] as any,
    })
    .returning();
  return row.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testInsufficient(opts: {
  clientUserId: number;
  adviserUserId: number;
  approverUserId: number;
}) {
  const deductionId = await insertPendingDeduction({
    clientUserId: opts.clientUserId,
    adviserUserId: opts.adviserUserId,
    totalAccrued: "100.0000",
    adviserShare: "70.0000",
  });
  const idemKey = `fee_deduction_${deductionId}`;

  let caught: unknown = null;
  try {
    await settleApprovedDeduction({
      deductionId,
      approverUserId: opts.approverUserId,
    });
  } catch (err) {
    caught = err;
  }

  if (!(caught instanceof InsufficientFundsError)) {
    fail(
      "insufficient funds throws InsufficientFundsError",
      `expected InsufficientFundsError, got ${caught instanceof Error ? caught.constructor.name + ": " + caught.message : String(caught)}`,
    );
    return deductionId;
  }
  pass(
    "insufficient funds throws InsufficientFundsError",
    `required=${(caught as InsufficientFundsError).required}, available=${(caught as InsufficientFundsError).available}`,
  );

  const [deduction] = await db
    .select()
    .from(adviserFeeDeductions)
    .where(eq(adviserFeeDeductions.id, deductionId));

  if (deduction?.status === "insufficient_funds" && deduction.failureReason) {
    pass(
      "insufficient funds flips deduction status",
      `status=${deduction.status}, failureReason set`,
    );
  } else {
    fail(
      "insufficient funds flips deduction status",
      `status=${deduction?.status}, failureReason=${deduction?.failureReason ?? "<null>"}`,
    );
  }

  const [{ n: txCount }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(transactions)
    .where(eq(transactions.idempotencyKey, idemKey));
  if (Number(txCount) === 0) {
    pass(
      "insufficient funds writes no transactions row",
      `idempotencyKey=${idemKey}`,
    );
  } else {
    fail(
      "insufficient funds writes no transactions row",
      `expected 0 rows, got ${txCount}`,
    );
  }

  // Ledger entries are FK'd to a transaction row, so if no transaction row
  // exists, no ledger entries can exist either. We assert this directly to
  // catch any future refactor that decouples them.
  const [{ n: ledgerCount }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(ledgerEntries)
    .leftJoin(transactions, eq(ledgerEntries.transactionId, transactions.id))
    .where(
      sql`${transactions.idempotencyKey} = ${idemKey} OR ${transactions.id} IS NULL AND FALSE`,
    );
  if (Number(ledgerCount) === 0) {
    pass(
      "insufficient funds writes no ledger entries",
      `idempotencyKey=${idemKey}`,
    );
  } else {
    fail(
      "insufficient funds writes no ledger entries",
      `expected 0 rows, got ${ledgerCount}`,
    );
  }

  return deductionId;
}

async function testSufficient(opts: {
  deductionId: number;
  clientUserId: number;
  adviserUserId: number;
  approverUserId: number;
}) {
  // Top up the client to comfortably above totalAccrued (100.00).
  await topUpClient(opts.clientUserId, "500.00");

  const settled = await settleApprovedDeduction({
    deductionId: opts.deductionId,
    approverUserId: opts.approverUserId,
  });

  if (settled.status === "settled" && !settled.failureReason) {
    pass(
      "sufficient funds settles cleanly",
      `status=${settled.status}, settledTransactionId=${settled.settledTransactionId}`,
    );
  } else {
    fail(
      "sufficient funds settles cleanly",
      `status=${settled.status}, failureReason=${settled.failureReason ?? "<null>"}`,
    );
    return;
  }

  const idemKey = `fee_deduction_${opts.deductionId}`;
  const [{ n: txCount }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(transactions)
    .where(eq(transactions.idempotencyKey, idemKey));
  if (Number(txCount) === 1) {
    pass(
      "sufficient funds inserts exactly one transactions row",
      `idempotencyKey=${idemKey}`,
    );
  } else {
    fail(
      "sufficient funds inserts exactly one transactions row",
      `expected 1, got ${txCount}`,
    );
  }

  const entries = await db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transactionId, settled.settledTransactionId!));

  // Expect 3 entries: client debit + adviser credit + platform credit, all
  // in TEST_CURRENCY, summing to zero (debits == credits).
  const debits = entries
    .filter((e) => e.direction === "debit")
    .reduce((s, e) => s + Number(e.amount), 0);
  const credits = entries
    .filter((e) => e.direction === "credit")
    .reduce((s, e) => s + Number(e.amount), 0);
  if (
    entries.length === 3 &&
    Math.abs(debits - credits) < 1e-8 &&
    debits === 100
  ) {
    pass(
      "sufficient funds posts balanced 3-entry ledger triple",
      `entries=${entries.length}, debits=${debits}, credits=${credits}`,
    );
  } else {
    fail(
      "sufficient funds posts balanced 3-entry ledger triple",
      `entries=${entries.length}, debits=${debits}, credits=${credits}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Task #204 — sweep + parser regression tests.
//
// Exercises the full insufficient-funds workflow as a single deterministic
// sequence:
//
//   1. Insert a fresh deduction and force it into 'insufficient_funds' via
//      a direct settle attempt against an empty wallet.
//   2. Verify the shared `parseShortfallFromFailureReason` parser extracts
//      the same numeric shortfall the engine wrote into failureReason —
//      the client banner relies on this regex matching the engine's
//      message format exactly. If the engine ever changes the format, this
//      test fails loudly.
//   3. Run `runInsufficientFundsSweep()` against the empty wallet and
//      assert it reports `checked >= 1, settled === 0,
//      stillInsufficient >= 1`. This proves the same entry point used by
//      the daily cron AND the new admin manual-trigger endpoint correctly
//      identifies the held row without settling it.
//   4. Top the wallet up above the required amount and re-run the sweep.
//      Assert it reports `settled === 1, stillInsufficient === 0`.
//   5. Assert the deduction row is now CLEAN: status='settled',
//      failureReason cleared, lastRecheckedAt set (sweep timestamp),
//      settledTransactionId populated. This catches any regression where
//      the sweep settles a row but leaves stale IF bookkeeping behind.
// ---------------------------------------------------------------------------
async function testSweepWorkflow(opts: {
  clientUserId: number;
  adviserUserId: number;
  approverUserId: number;
}) {
  // testSufficient above credited the client ledger account by 500.00 to
  // settle its deduction. The fee engine reads the ledger sum (not the
  // wallet cache) when checking sufficient funds, so we MUST wipe both
  // ledger entries and the dependent transactions/deductions before
  // inserting a new deduction — otherwise the row would settle on first
  // attempt instead of falling into 'insufficient_funds'. cleanupForUser
  // is the same FK-walk used at start-of-run / end-of-run, so it leaves
  // the user row intact but resets balance to zero.
  await cleanupForUser(opts.clientUserId);
  await cleanupForUser(opts.adviserUserId);
  await ensureFreshTestWallet(opts.clientUserId);
  await ensureFreshTestWallet(opts.adviserUserId);

  // Fresh deduction so the assertions below can target a single ID without
  // colliding with anything else.
  const deductionId = await insertPendingDeduction({
    clientUserId: opts.clientUserId,
    adviserUserId: opts.adviserUserId,
    totalAccrued: "150.0000",
    adviserShare: "100.0000",
  });

  // 1. Force the row into 'insufficient_funds' by invoking
  //    settleApprovedDeduction against the now-empty ledger. The engine
  //    writes the canonical failureReason string the parser depends on.
  try {
    await settleApprovedDeduction({
      deductionId,
      approverUserId: opts.approverUserId,
    });
  } catch (err) {
    if (!(err instanceof InsufficientFundsError)) {
      fail(
        "sweep test fixture: forced into insufficient_funds",
        `expected InsufficientFundsError, got ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }
  pass("sweep test fixture: forced into insufficient_funds");

  // 2. Parser-vs-engine regression. Read the actual failureReason the
  //    engine wrote and feed it through the shared parser the banner uses.
  const [held] = await db
    .select()
    .from(adviserFeeDeductions)
    .where(eq(adviserFeeDeductions.id, deductionId));
  if (!held || held.status !== "insufficient_funds" || !held.failureReason) {
    fail(
      "sweep test fixture: deduction is in IF state with failureReason",
      `status=${held?.status}, failureReason=${held?.failureReason ?? "<null>"}`,
    );
    return;
  }
  const parsed = parseShortfallFromFailureReason(held.failureReason);
  // totalAccrued = 150, available = 0 -> shortfall = "150.00" (the parser
  // returns a fixed-2 string so the banner can render it directly without
  // any further formatting).
  if (
    parsed &&
    parsed.currency === TEST_CURRENCY &&
    Number(parsed.shortfall) === 150
  ) {
    pass(
      "shortfall parser extracts numeric gap from engine failureReason",
      `parsed=${JSON.stringify(parsed)}`,
    );
  } else {
    fail(
      "shortfall parser extracts numeric gap from engine failureReason",
      `failureReason=${held.failureReason}, parsed=${JSON.stringify(parsed)}`,
    );
  }

  // 3. Sweep against the still-empty wallet — must check the row, must
  //    NOT settle it, and must report it as still insufficient.
  const sweepHeld = await runInsufficientFundsSweep();
  if (
    sweepHeld.checked >= 1 &&
    sweepHeld.settled === 0 &&
    sweepHeld.stillInsufficient >= 1
  ) {
    pass(
      "sweep on empty wallet reports stillInsufficient and settles nothing",
      `summary=${JSON.stringify(sweepHeld)}`,
    );
  } else {
    fail(
      "sweep on empty wallet reports stillInsufficient and settles nothing",
      `summary=${JSON.stringify(sweepHeld)}`,
    );
  }

  // 4. Top up + re-run sweep. The row must now flip to settled.
  await topUpClient(opts.clientUserId, "500.00");
  const sweepSettled = await runInsufficientFundsSweep();
  if (
    sweepSettled.checked >= 1 &&
    sweepSettled.settled >= 1 &&
    sweepSettled.errors === 0
  ) {
    pass(
      "sweep after top-up reports settled >= 1 and zero errors",
      `summary=${JSON.stringify(sweepSettled)}`,
    );
  } else {
    fail(
      "sweep after top-up reports settled >= 1 and zero errors",
      `summary=${JSON.stringify(sweepSettled)}`,
    );
  }

  // 5. Settled-row-clean — the freshly-settled row must not retain stale
  //    IF bookkeeping. failureReason must be cleared (so the client banner
  //    can never re-resurrect the row), settledTransactionId must point at
  //    the settle transaction the sweep just posted, and lastRecheckedAt
  //    must be populated (the sweep stamps it on every visit).
  const [after] = await db
    .select()
    .from(adviserFeeDeductions)
    .where(eq(adviserFeeDeductions.id, deductionId));
  if (
    after?.status === "settled" &&
    after.failureReason === null &&
    after.settledTransactionId !== null &&
    after.lastRecheckedAt !== null
  ) {
    pass(
      "sweep-settled row is clean (no stale IF bookkeeping)",
      `status=${after.status}, settledTx=${after.settledTransactionId}, lastRecheckedAt=${after.lastRecheckedAt?.toISOString?.() ?? after.lastRecheckedAt}`,
    );
  } else {
    fail(
      "sweep-settled row is clean (no stale IF bookkeeping)",
      `status=${after?.status}, failureReason=${after?.failureReason ?? "<null>"}, settledTx=${after?.settledTransactionId ?? "<null>"}, lastRecheckedAt=${after?.lastRecheckedAt ?? "<null>"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Fee Engine Insufficient-Funds Test (Task #34) ===\n");

  // Ensure PLATFORM_USER_ID is set for getOrCreateSuspenseAccount during the
  // top-up step. We don't *use* its real owner in the assertions — we just
  // need a valid platform user id resolvable by the helper.
  if (!process.env.PLATFORM_USER_ID) {
    const platformId = await ensureUser(
      "__feegate_test_platform__",
      "feegate-platform@test.invalid",
    );
    process.env.PLATFORM_USER_ID = String(platformId);
  }

  const clientUserId = await ensureUser(
    CLIENT_USERNAME,
    "feegate-client@test.invalid",
  );
  const adviserUserId = await ensureUser(
    ADVISER_USERNAME,
    "feegate-adviser@test.invalid",
  );

  // Wipe any residual rows from a prior run BEFORE we touch fixtures so the
  // assertions about row counts are deterministic.
  await cleanupForUser(clientUserId);
  await cleanupForUser(adviserUserId);
  await ensureFreshTestWallet(clientUserId);
  await ensureFreshTestWallet(adviserUserId);

  let exitCode = 0;
  try {
    const deductionId = await testInsufficient({
      clientUserId,
      adviserUserId,
      approverUserId: adviserUserId,
    });

    await testSufficient({
      deductionId,
      clientUserId,
      adviserUserId,
      approverUserId: adviserUserId,
    });

    // Task #204 — sweep + parser regression suite. Runs against a fresh
    // deduction so the assertions don't collide with the row mutated by
    // testInsufficient/testSufficient above.
    await testSweepWorkflow({
      clientUserId,
      adviserUserId,
      approverUserId: adviserUserId,
    });

    console.log("");
    for (const r of results) {
      const tag = r.passed ? "PASS" : "FAIL";
      const tail = r.details ? ` — ${r.details}` : "";
      console.log(`${tag} ${r.name}${tail}`);
    }

    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      console.error(
        `\n${failed.length} fee insufficient-funds test(s) failed.`,
      );
      exitCode = 1;
    } else {
      console.log("\nALL FEE INSUFFICIENT-FUNDS TESTS PASSED \u2705");
    }
  } finally {
    // Task #187 — mirror the Task #158 pattern from
    // scripts/test-transaction-safety.ts and
    // scripts/test-fee-deduction-gate-b.ts: run cleanup at end-of-script
    // so the platform-side suspense and fee-account legs that
    // settleApprovedDeduction posts (whose user_id is the platform user
    // but whose transaction_id is owned by our test client) don't
    // accumulate on user 11's ledger sum between runs. cleanupForUser
    // already does the FK walk by `transaction_id IN (SELECT id FROM
    // transactions WHERE user_id = ${userId})`, which catches those
    // platform legs because every settle/top-up transaction is written
    // with `userId: deduction.clientUserId`. Without the end-of-run
    // sweep the leftover settle entries net to zero per-currency but
    // still appear as a non-baseline ledger sum until the *next* run's
    // start-of-run cleanup, which is enough to trip the wallet-ledger
    // reconciliation clean-room gate in pre-launch-safety.ts.
    try {
      await cleanupForUser(clientUserId);
      await cleanupForUser(adviserUserId);
    } catch (cleanupErr) {
      console.error("Post-run cleanup threw:", cleanupErr);
      if (exitCode === 0) exitCode = 1;
    }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Fee insufficient-funds test crashed:", err);
  process.exit(1);
});
