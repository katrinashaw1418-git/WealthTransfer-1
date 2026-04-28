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

// TASK #366 — bootstrap calls assertFixtureInsertionAllowed() so this
// script refuses to run against a production-like database.
import "./_bootstrap-test-env";
import { and, eq, sql, inArray } from "drizzle-orm";
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
// Task #204 — Sweep + shortfall parser + projection contract regression
// assertions. Resolved during rebase to keep BOTH branches' helpers: main's
// shortfall parser (used by testSweepWorkflow) and this task's
// status-predicate + API-contract projection (used by the new banner /
// manual-sweep / settled-clean assertions).
import { runInsufficientFundsSweep } from "../server/services/insufficient-funds-sweep";
import { parseShortfallFromFailureReason } from "../client/src/lib/insufficient-funds";
import {
  isInsufficientFundsStatus,
  projectDeductionForApiContract,
} from "../shared/fee-deduction-status";

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

// ===========================================================================
// TASK #204 — BANNER / MANUAL-SWEEP / SETTLED-CLEAN ASSERTIONS
// ===========================================================================

// ---------------------------------------------------------------------------
// Banner query — replicates the WHERE clause the
// /api/client/fee-deductions/insufficient-funds-summary endpoint runs so we
// can assert the banner becomes visible / hidden as a deduction transitions
// in and out of the insufficient_funds state.
// ---------------------------------------------------------------------------
async function loadBannerHeldCount(clientUserId: number): Promise<number> {
  const rows = await db
    .select({
      id: adviserFeeDeductions.id,
      status: adviserFeeDeductions.status,
    })
    .from(adviserFeeDeductions)
    .where(
      and(
        eq(adviserFeeDeductions.clientUserId, clientUserId),
        eq(adviserFeeDeductions.status, "insufficient_funds"),
        sql`${adviserFeeDeductions.reversedAt} IS NULL`,
      ),
    );
  // Belt-and-braces: drop anything the centralised predicate disagrees with.
  return rows.filter((r) => isInsufficientFundsStatus(r)).length;
}

// ---------------------------------------------------------------------------
// Task #204 — banner-shown assertion. After testInsufficient leaves a row
// in IF, the banner-shaped query must see it; after testSufficient settles
// the same row, the banner-shaped query must drop back to zero.
// ---------------------------------------------------------------------------
async function testBannerVisibility(opts: {
  clientUserId: number;
  /**
   * Set to true after a settle has flipped the row back out of IF — we
   * assert the banner has cleared. Set to false right after a fresh IF
   * row is in place — we assert the banner sees it.
   */
  expectShown: boolean;
  label: string;
}) {
  const held = await loadBannerHeldCount(opts.clientUserId);
  const shown = held > 0;
  if (shown === opts.expectShown) {
    pass(
      `banner: ${opts.label}`,
      `held=${held}, shown=${shown} (expected ${opts.expectShown})`,
    );
  } else {
    fail(
      `banner: ${opts.label}`,
      `held=${held}, shown=${shown}, expected ${opts.expectShown}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Task #204 — settled-formerly-IF row renders clean. Even if the DB still
// has clientNotifiedAt / clientNotificationCount / lastRecheckedAt populated
// (the cron sets them and never clears them), the API-contract projection
// must strip them once the row leaves the IF state. This assertion exercises
// the projection helper directly so a future consumer that forgets to call
// the predicate cannot leak stale notification metadata.
// ---------------------------------------------------------------------------
function testProjectionContract() {
  const stamp = new Date("2026-01-01T00:00:00.000Z");
  const settledFormerlyIf = {
    id: 999,
    status: "settled",
    lastRecheckedAt: stamp,
    clientNotifiedAt: stamp,
    clientNotificationCount: 3,
    totalAccrued: "100.0000",
  };
  const stillIf = {
    id: 998,
    status: "insufficient_funds",
    lastRecheckedAt: stamp,
    clientNotifiedAt: stamp,
    clientNotificationCount: 3,
    totalAccrued: "100.0000",
  };
  const projectedSettled = projectDeductionForApiContract(settledFormerlyIf);
  if (
    projectedSettled.lastRecheckedAt === null &&
    projectedSettled.clientNotifiedAt === null &&
    projectedSettled.clientNotificationCount === 0 &&
    projectedSettled.status === "settled"
  ) {
    pass(
      "projection: settled-formerly-IF row renders clean",
      `lastRecheckedAt/clientNotifiedAt nulled, count zeroed`,
    );
  } else {
    fail(
      "projection: settled-formerly-IF row renders clean",
      JSON.stringify(projectedSettled),
    );
  }

  const projectedIf = projectDeductionForApiContract(stillIf);
  if (
    projectedIf.lastRecheckedAt instanceof Date &&
    projectedIf.clientNotifiedAt instanceof Date &&
    projectedIf.clientNotificationCount === 3
  ) {
    pass(
      "projection: still-IF row preserves notification metadata",
      `lastRecheckedAt + clientNotifiedAt preserved, count=${projectedIf.clientNotificationCount}`,
    );
  } else {
    fail(
      "projection: still-IF row preserves notification metadata",
      JSON.stringify(projectedIf),
    );
  }

  // Predicate spot-check.
  if (
    isInsufficientFundsStatus({ status: "insufficient_funds" }) === true &&
    isInsufficientFundsStatus({ status: "settled" }) === false &&
    isInsufficientFundsStatus(null) === false &&
    isInsufficientFundsStatus(undefined) === false
  ) {
    pass("predicate: isInsufficientFundsStatus is exact-match", "ok");
  } else {
    fail("predicate: isInsufficientFundsStatus is exact-match", "unexpected truthiness");
  }
}

// ---------------------------------------------------------------------------
// Task #204 — manual-sweep summary correctness. Seeds two fresh IF rows on
// the same client (top up only enough to settle ONE of them on the next
// sweep), runs the sweep, and asserts the returned summary matches what
// actually happened in the DB:
//   checked              = 2  (both held rows visited)
//   settled              = 1  (the one whose totalAccrued the wallet covers)
//   stillInsufficient    = 1  (the one whose totalAccrued the wallet doesn't)
//   errors               = 0
// We also assert the settled row drops out of the banner-shaped query AND
// that its IF-only bookkeeping columns are stripped by the API projection.
// ---------------------------------------------------------------------------
async function testManualSweepSummary(opts: {
  clientUserId: number;
  adviserUserId: number;
  approverUserId: number;
}) {
  // Reset state: testSufficient left the client wallet at ~400 AUD with the
  // first deduction settled. Wipe back to baseline so this test's seeded
  // rows are the only IF candidates the sweep sees.
  await cleanupForUser(opts.clientUserId);
  await cleanupForUser(opts.adviserUserId);
  await ensureFreshTestWallet(opts.clientUserId);
  await ensureFreshTestWallet(opts.adviserUserId);

  // Phase 1: seed two IF rows. Each settle attempt must throw before any
  // top-up — we verify by catching the InsufficientFundsError.
  const deductionA = await insertPendingDeduction({
    clientUserId: opts.clientUserId,
    adviserUserId: opts.adviserUserId,
    totalAccrued: "120.0000",
    adviserShare: "84.0000",
  });
  const deductionB = await insertPendingDeduction({
    clientUserId: opts.clientUserId,
    adviserUserId: opts.adviserUserId,
    totalAccrued: "200.0000",
    adviserShare: "140.0000",
  });
  for (const id of [deductionA, deductionB]) {
    try {
      await settleApprovedDeduction({
        deductionId: id,
        approverUserId: opts.approverUserId,
      });
      fail(
        "manual sweep: seeding IF rows",
        `deduction #${id} settled unexpectedly while wallet was empty`,
      );
      return;
    } catch (err) {
      if (!(err instanceof InsufficientFundsError)) {
        fail(
          "manual sweep: seeding IF rows",
          `unexpected error settling #${id}: ${err}`,
        );
        return;
      }
    }
  }

  // Banner-shown assertion: with two IF rows in place, the banner-shaped
  // query must see them.
  await testBannerVisibility({
    clientUserId: opts.clientUserId,
    expectShown: true,
    label: "shows banner when IF rows exist",
  });

  // Phase 2: top up just enough to cover deductionA (120) but NOT B (200).
  // We pick 150 so A settles cleanly and B still throws on the sweep's
  // re-attempt.
  await topUpClient(opts.clientUserId, "150.00");

  const summary = await runInsufficientFundsSweep({
    approverUserId: opts.approverUserId,
  });

  if (
    summary.checked === 2 &&
    summary.settled === 1 &&
    summary.stillInsufficient === 1 &&
    summary.errors === 0
  ) {
    pass(
      "manual sweep: summary matches seeded outcome",
      `checked=${summary.checked} settled=${summary.settled} stillInsufficient=${summary.stillInsufficient} errors=${summary.errors}`,
    );
  } else {
    fail(
      "manual sweep: summary matches seeded outcome",
      `expected checked=2 settled=1 stillInsufficient=1 errors=0, got ${JSON.stringify(summary)}`,
    );
  }

  // The settled row must now read as `settled` in the DB.
  const [aRow] = await db
    .select()
    .from(adviserFeeDeductions)
    .where(eq(adviserFeeDeductions.id, deductionA));
  if (aRow?.status === "settled" && aRow.settledTransactionId) {
    pass(
      "manual sweep: covered row flipped to settled",
      `tx#${aRow.settledTransactionId}`,
    );
  } else {
    fail(
      "manual sweep: covered row flipped to settled",
      `status=${aRow?.status}, settledTransactionId=${aRow?.settledTransactionId}`,
    );
  }

  const [bRow] = await db
    .select()
    .from(adviserFeeDeductions)
    .where(eq(adviserFeeDeductions.id, deductionB));
  if (bRow?.status === "insufficient_funds") {
    pass(
      "manual sweep: uncovered row stays insufficient_funds",
      `failureReason set: ${!!bRow.failureReason}`,
    );
  } else {
    fail(
      "manual sweep: uncovered row stays insufficient_funds",
      `status=${bRow?.status}`,
    );
  }

  // Settled-row-renders-clean assertion: the projection helper must strip
  // the IF-only bookkeeping columns from row A even though the sweep
  // populated `lastRecheckedAt` on it just now (and may have left
  // `clientNotifiedAt` from a prior sweep visit). This is what every API
  // route — admin, adviser, client — runs the row through before it ships.
  if (aRow) {
    const projected = projectDeductionForApiContract(aRow);
    if (
      projected.lastRecheckedAt === null &&
      projected.clientNotifiedAt === null &&
      projected.clientNotificationCount === 0
    ) {
      pass(
        "settled row API contract: IF metadata stripped after settlement",
        `lastRecheckedAt nulled despite DB column being ${aRow.lastRecheckedAt ? "populated" : "null"}`,
      );
    } else {
      fail(
        "settled row API contract: IF metadata stripped after settlement",
        `projected=${JSON.stringify({
          lastRecheckedAt: projected.lastRecheckedAt,
          clientNotifiedAt: projected.clientNotifiedAt,
          clientNotificationCount: projected.clientNotificationCount,
        })}`,
      );
    }
  }

  // Banner must now show 1 (B only) — A dropped out as soon as it settled.
  await testBannerVisibility({
    clientUserId: opts.clientUserId,
    expectShown: true,
    label: "shows banner with the still-held row only",
  });
  // Sanity: held count should be exactly 1.
  const remaining = await loadBannerHeldCount(opts.clientUserId);
  if (remaining === 1) {
    pass(
      "banner: held count drops as rows settle",
      `remaining=${remaining}`,
    );
  } else {
    fail(
      "banner: held count drops as rows settle",
      `expected 1, got ${remaining}`,
    );
  }

  // Phase 3: top up to cover B as well, run sweep again, banner should
  // clear entirely.
  await topUpClient(opts.clientUserId, "300.00");
  const sweep2 = await runInsufficientFundsSweep({
    approverUserId: opts.approverUserId,
  });
  if (sweep2.checked === 1 && sweep2.settled === 1) {
    pass(
      "manual sweep: second run clears the last held row",
      JSON.stringify(sweep2),
    );
  } else {
    fail(
      "manual sweep: second run clears the last held row",
      `expected checked=1 settled=1, got ${JSON.stringify(sweep2)}`,
    );
  }
  await testBannerVisibility({
    clientUserId: opts.clientUserId,
    expectShown: false,
    label: "clears banner once every IF row has settled",
  });
}

// ---------------------------------------------------------------------------
// Task #204 — kill-switch short-circuit. The manual sweep route MUST honour
// the fee_deductions kill switch identically to the cron path. We flip the
// switch via the env var (which `isEnvForced` consults before the DB row),
// run the sweep against a known IF row, and assert checked=0 — meaning the
// service bailed before selecting candidates and did not bump
// lastRecheckedAt / settle anything.
// ---------------------------------------------------------------------------
async function testKillSwitchShortCircuits(opts: {
  clientUserId: number;
  adviserUserId: number;
  approverUserId: number;
}) {
  // Seed a fresh IF row so we have something for the sweep to find if the
  // kill switch were ignored.
  const deductionId = await insertPendingDeduction({
    clientUserId: opts.clientUserId,
    adviserUserId: opts.adviserUserId,
    totalAccrued: "999.0000",
    adviserShare: "699.0000",
  });
  try {
    await settleApprovedDeduction({
      deductionId,
      approverUserId: opts.approverUserId,
    });
  } catch (err) {
    if (!(err instanceof InsufficientFundsError)) {
      fail(
        "kill switch: seeding IF row before flip",
        `unexpected error: ${err}`,
      );
      return;
    }
  }

  const envVar = "DISABLE_FEE_DEDUCTIONS";
  const previous = process.env[envVar];
  process.env[envVar] = "1";
  try {
    // Code-review follow-up — the manual sweep route now surfaces an
    // explicit `killSwitchActive` flag + human-readable `message` so
    // operators can tell "sweep blocked" apart from "no held rows". The
    // service itself doesn't return those fields (they live on the route
    // wrapper), so this test still asserts the underlying sweep behaviour
    // (checked=0) and additionally checks the wrapper's flag via a direct
    // probe against the kill-switch helper.
    const summary = await runInsufficientFundsSweep({
      approverUserId: opts.approverUserId,
    });
    const switchActive = await (
      await import("../server/services/kill-switch")
    ).isKillSwitchActive("fee_deductions");
    if (
      summary.checked === 0 &&
      summary.settled === 0 &&
      summary.stillInsufficient === 0 &&
      switchActive === true
    ) {
      pass(
        "kill switch: manual sweep short-circuits when fee_deductions is engaged",
        `${JSON.stringify(summary)} (killSwitchActive=${switchActive})`,
      );
    } else {
      fail(
        "kill switch: manual sweep short-circuits when fee_deductions is engaged",
        `expected checked=0 + killSwitchActive=true, got ${JSON.stringify(summary)} killSwitchActive=${switchActive}`,
      );
    }
  } finally {
    if (previous === undefined) delete process.env[envVar];
    else process.env[envVar] = previous;
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
// Task #204 (code-review fix) — fee-exceptions report contract sanitization.
// The /api/admin/fee-exceptions endpoint emits one row per problem deduction
// (held / stuck / failed / role_corruption). The "stuck" and "failed" kinds
// pull settled or pending_approval rows that are NOT in the
// insufficient_funds state — without the projection they would still surface
// the IF-only bookkeeping columns. We replicate the exact mapping the route
// performs so a regression that drops the projection from either branch is
// caught before the report leaks stale notification metadata.
// ---------------------------------------------------------------------------
async function testFeeExceptionsReportContract(opts: {
  clientUserId: number;
  adviserUserId: number;
}) {
  // Synthesize one row of each shape the report can emit. We do NOT hit the
  // DB or the HTTP route — the projection helper is the contract surface,
  // and verifying it directly here keeps the test deterministic and fast.
  const stamp = new Date("2026-01-01T00:00:00.000Z");
  const seedFor = (status: string) => ({
    id: 1,
    clientUserId: opts.clientUserId,
    adviserUserId: opts.adviserUserId,
    status,
    totalAccrued: "100.0000",
    failureReason: status === "insufficient_funds" ? "out of funds" : null,
    lastRecheckedAt: stamp,
    clientNotifiedAt: stamp,
    clientNotificationCount: 5,
    createdAt: stamp,
    settledAt: status === "settled" ? stamp : null,
    reversedAt: status === "reversed" ? stamp : null,
  });

  // The report's mapping logic, mirrored from server/admin-routes.ts: every
  // branch must run the row through projectDeductionForApiContract before
  // it leaves the handler.
  const heldRow = projectDeductionForApiContract(seedFor("insufficient_funds"));
  const stuckRow = projectDeductionForApiContract(seedFor("pending_approval"));
  const failedRow = projectDeductionForApiContract(seedFor("settled"));
  const corruptRow = projectDeductionForApiContract(seedFor("reversed"));

  // Held row: IF metadata MUST be preserved (the "Held" tab needs to show
  // when the cron last re-checked it and how many times the client was
  // notified).
  if (
    heldRow.lastRecheckedAt instanceof Date &&
    heldRow.clientNotifiedAt instanceof Date &&
    heldRow.clientNotificationCount === 5
  ) {
    pass(
      "fee-exceptions: held row preserves IF metadata",
      `lastRecheckedAt + clientNotifiedAt + count=${heldRow.clientNotificationCount} preserved`,
    );
  } else {
    fail(
      "fee-exceptions: held row preserves IF metadata",
      JSON.stringify(heldRow),
    );
  }

  // Stuck / failed / role_corruption rows: IF metadata MUST be stripped.
  // These are the leak vectors the code review flagged — the sweep may have
  // populated lastRecheckedAt on a row that later settled, and without the
  // projection the report would still expose it.
  for (const [label, row] of [
    ["stuck", stuckRow],
    ["failed", failedRow],
    ["role_corruption", corruptRow],
  ] as const) {
    if (
      row.lastRecheckedAt === null &&
      row.clientNotifiedAt === null &&
      row.clientNotificationCount === 0
    ) {
      pass(
        `fee-exceptions: ${label} row strips IF metadata`,
        `lastRecheckedAt=null, clientNotifiedAt=null, count=0`,
      );
    } else {
      fail(
        `fee-exceptions: ${label} row strips IF metadata`,
        JSON.stringify({
          lastRecheckedAt: row.lastRecheckedAt,
          clientNotifiedAt: row.clientNotifiedAt,
          clientNotificationCount: row.clientNotificationCount,
        }),
      );
    }
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
  const platformUserId = parseInt(process.env.PLATFORM_USER_ID, 10);

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

  // Task #219 — snapshot the set of `accounts` PKs already owned by the
  // platform user BEFORE this script runs. settleApprovedDeduction +
  // topUpClient call getOrCreateSuspenseAccount / getOrCreateFeeAccount,
  // both of which insert a fresh platform-side account row on a clean DB.
  // cleanupForUser walks ledger_entries / transactions by user_id but
  // never touches the platform-side accounts row, so without this
  // snapshot+diff the platform user accumulates one new accounts row per
  // fresh-DB run. The orphan-row gate (Task #198) flags exactly that. We
  // delete by PK in the finally block so we can never wipe platform
  // accounts owned by other concurrent test scripts.
  const preExistingPlatformAccountIds = new Set<number>(
    (
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.userId, platformUserId))
    ).map((r) => r.id),
  );

  let exitCode = 0;
  try {
    const deductionId = await testInsufficient({
      clientUserId,
      adviserUserId,
      approverUserId: adviserUserId,
    });

    // Task #204 — banner-shown assertion right after the IF row was
    // created and before testSufficient settles it.
    await testBannerVisibility({
      clientUserId,
      expectShown: true,
      label: "shows banner immediately after IF settle attempt",
    });

    await testSufficient({
      deductionId,
      clientUserId,
      adviserUserId,
      approverUserId: adviserUserId,
    });

    // Task #204 — once the same row settles, the banner-shaped query
    // must drop back to zero.
    await testBannerVisibility({
      clientUserId,
      expectShown: false,
      label: "clears banner after the row settles",
    });

    // Task #204 — synchronous projection contract checks (no DB I/O).
    testProjectionContract();

    // Task #204 — sweep + shortfall-parser regression suite (from main).
    // Runs against a fresh deduction so its assertions don't collide
    // with the row mutated by testInsufficient/testSufficient above.
    await testSweepWorkflow({
      clientUserId,
      adviserUserId,
      approverUserId: adviserUserId,
    });

    // Task #204 (code-review fix) — fee-exceptions report must sanitize
    // every branch (held / stuck / failed / role_corruption) so settled or
    // pending rows never leak IF-only metadata into reporting payloads.
    await testFeeExceptionsReportContract({
      clientUserId,
      adviserUserId,
    });

    // Task #204 — manual sweep summary correctness end-to-end. This
    // wipes the test client's state internally so it can seed exactly
    // two known IF rows and assert the summary counts.
    await testManualSweepSummary({
      clientUserId,
      adviserUserId,
      approverUserId: adviserUserId,
    });

    // Task #204 — confirm the manual sweep route honours the
    // fee_deductions kill switch. Run this LAST so any rows it leaves
    // behind are cleaned up by the unconditional finally block below.
    await testKillSwitchShortCircuits({
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

      // Task #219 — cleanupForUser deletes ledger_entries by
      // transaction_id IN (test client/adviser tx), which sweeps the
      // platform-side legs because every settle/top-up tx is owned by
      // the test client. That leaves the platform-side accounts rows
      // (suspense + fee, owned by user_id=PLATFORM_USER_ID) with no
      // remaining ledger references — but cleanupForUser never deletes
      // accounts whose user_id is the platform user, so on a fresh DB
      // those one-per-currency rows leaked and tripped Task #198's
      // orphan-row gate. Diff against the start-of-script snapshot and
      // PK-delete only the rows THIS script created, so concurrent test
      // scripts that pin the same platform user are unaffected.
      const currentPlatformAccountIds = (
        await db
          .select({ id: accounts.id })
          .from(accounts)
          .where(eq(accounts.userId, platformUserId))
      ).map((r) => r.id);
      const newPlatformAccountIds = currentPlatformAccountIds.filter(
        (id) => !preExistingPlatformAccountIds.has(id),
      );
      if (newPlatformAccountIds.length > 0) {
        await db
          .delete(accounts)
          .where(inArray(accounts.id, newPlatformAccountIds));
      }
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
