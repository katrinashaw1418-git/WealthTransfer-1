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
    process.exit(1);
  }

  console.log("\nALL FEE INSUFFICIENT-FUNDS TESTS PASSED \u2705");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fee insufficient-funds test crashed:", err);
  process.exit(1);
});
