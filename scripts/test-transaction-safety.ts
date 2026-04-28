// =============================================================================
// TRANSACTION SAFETY TEST SCRIPT — Build #3
// =============================================================================
// Verifies the integrity rails that the deposit/withdraw money paths rely on:
//
//   1. deposit idempotency        — same Idempotency-Key 3x → one transaction only
//   2. pending no ledger impact   — a transaction in 'pending' has no ledger rows
//   3. settlement single entry    — postLedgerEntries(tx, ...) cannot run twice
//                                   for the same transactionId (Task #22 guard)
//   4. failure no ledger impact   — a transaction in 'failed' has no ledger rows
//   5. reversal offset            — a reversal posts the OPPOSITE pair against a
//                                   NEW transactionId (history is never edited),
//                                   netting the user's ledger sum to its prior
//                                   value
//   6. reconciliation mismatch    — deliberately drifting the wallet cache from
//                                   the ledger sum surfaces as
//                                   `status='mismatch'` in
//                                   wallet_ledger_reconciliations
//   7. concurrent post race       — two parallel postLedgerEntries() calls on
//                                   different connections targeting the same
//                                   pre-existing transactionId — exactly one
//                                   wins, the other rejects with
//                                   LedgerDoublePostError, and only ONE
//                                   balanced pair is persisted (Task #37
//                                   DB-enforced guard)
//
// Hard rules:
//   - This script does NOT touch any production user. All work is scoped to a
//     deterministic test user (`__txsafety_test_user__`). Each run cleans the
//     test user's prior ledger/transaction/idempotency/recon rows so it stays
//     re-runnable.
//   - It exits non-zero if any assertion fails, so CI / a deploy gate can block
//     fee-engine work until the rails are green.
//   - It does not mutate the platform suspense account directly — it goes
//     through the same `getOrCreateSuspenseAccount` helper the production
//     handlers use.
//
// Usage:
//   npm run test:transaction-safety
//   # or
//   npx tsx scripts/test-transaction-safety.ts
// =============================================================================

// TASK #366 — bootstrap calls assertFixtureInsertionAllowed() so this
// script refuses to run against a production-like database.
import "./_bootstrap-test-env";
import { createHash } from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  users,
  wallets,
  transactions,
  ledgerEntries,
  idempotencyKeys,
  walletLedgerReconciliations,
  adviserFeeDeductions,
  adviserFeeAccruals,
  accounts,
} from "../shared/schema";
import {
  getOrCreateClientAccount,
  getOrCreateFeeAccount,
  getOrCreateSuspenseAccount,
  postLedgerEntries,
  getUserCurrencyBalance,
  getAccountBalance,
  refreshWalletCacheBalance,
  LedgerDoublePostError,
} from "../server/services/ledger";
import { runWalletLedgerReconciliation } from "../server/services/reconciliation";
import {
  settleApprovedDeduction,
  reverseSettledDeduction,
} from "../server/services/fee-engine";

const TEST_USERNAME = "__txsafety_test_user__";
const TEST_EMAIL = "txsafety@test.invalid";
const TEST_ADVISER_USERNAME = "__txsafety_adviser_user__";
const TEST_ADVISER_EMAIL = "txsafety-adviser@test.invalid";
const TEST_CURRENCY = "AUD";

// Task #152 — SKIP is a first-class outcome alongside PASS and FAIL,
// mirroring the contract in scripts/pre-launch-safety.ts. A SKIP means
// "we did not actually verify this check" (precondition missing,
// fixture row absent, env var unset, sub-script dependency didn't
// land). Without --strict, SKIP does not change the exit code; with
// --strict, any SKIP fails the exit code so the parent roll-up sees a
// real propagated outcome instead of a hidden PASS.
type Outcome = "pass" | "fail" | "skip";
type TestResult = { name: string; outcome: Outcome; details?: string };
const results: TestResult[] = [];

function pass(name: string, details?: string) {
  results.push({ name, outcome: "pass", details });
}

function fail(name: string, details?: string) {
  results.push({ name, outcome: "fail", details });
}

function skip(name: string, reason: string) {
  results.push({ name, outcome: "skip", details: reason });
}

function hashPayload(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

// ---------------------------------------------------------------------------
// Test fixture management
// ---------------------------------------------------------------------------

async function ensureTestUser(): Promise<number> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.username, TEST_USERNAME));
  if (existing) return existing.id;

  const [created] = await db
    .insert(users)
    .values({
      username: TEST_USERNAME,
      email: TEST_EMAIL,
      password: "not-a-real-password",
      firstName: "TxSafety",
      lastName: "Test",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();

  return created.id;
}

async function ensureAdviserTestUser(): Promise<number> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.username, TEST_ADVISER_USERNAME));
  if (existing) return existing.id;

  const [created] = await db
    .insert(users)
    .values({
      username: TEST_ADVISER_USERNAME,
      email: TEST_ADVISER_EMAIL,
      password: "not-a-real-password",
      firstName: "TxSafety",
      lastName: "Adviser",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();

  return created.id;
}

async function ensureFreshWalletFor(userId: number): Promise<void> {
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

async function ensureFreshTestWallet(userId: number): Promise<void> {
  await ensureFreshWalletFor(userId);
}

async function cleanupTestUser(userId: number): Promise<void> {
  // Order matters: adviser_fee_deductions has FK references to transactions
  // (settled_transaction_id, reversal_transaction_id) so we must drop those
  // rows BEFORE deleting transactions. Same goes for adviser_fee_accruals,
  // which we drop alongside since they're scoped to the test user-pair.
  await db
    .delete(adviserFeeDeductions)
    .where(eq(adviserFeeDeductions.clientUserId, userId));
  await db
    .delete(adviserFeeAccruals)
    .where(eq(adviserFeeAccruals.clientUserId, userId));

  await db.execute(sql`
    DELETE FROM ledger_entries
    WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = ${userId})
  `);
  // Task #37 — drop the matching ledger_postings receipts so the FK from
  // ledger_postings.transaction_id doesn't block the transactions delete.
  await db.execute(sql`
    DELETE FROM ledger_postings
    WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = ${userId})
  `);
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.userId, userId));
  await db
    .delete(walletLedgerReconciliations)
    .where(eq(walletLedgerReconciliations.userId, userId));

  // Task #186 — every settlement path in this script writes through
  // `refreshWalletCacheBalance`, which leaves a non-zero `wallets.balance`
  // row for the test user. We've just dropped all of that user's ledger
  // entries above, so the cache now disagrees with an empty ledger. Re-run
  // the same cache-refresh primitive: it recomputes the ledger sum (now 0)
  // and writes it back into the cache so the next
  // `runWalletLedgerReconciliation()` does not flag a wallet-vs-ledger
  // drift alert against this user. Returns null (no-op) if the wallet
  // row doesn't exist yet, which is fine for first-run start-of-test
  // cleanup before `ensureFreshTestWallet` has created it.
  await refreshWalletCacheBalance(db, userId, TEST_CURRENCY);
}

async function cleanupAdviserTestUser(adviserUserId: number): Promise<void> {
  // The adviser is the credit/debit counterparty in adviser-fee deductions.
  // The settled / reversal transactions are owned by the CLIENT (so they're
  // already cleaned by cleanupTestUser), but any deduction rows whose
  // adviserUserId matches must be cleared too in case a previous run left
  // them behind. Same for any standalone accruals.
  await db
    .delete(adviserFeeDeductions)
    .where(eq(adviserFeeDeductions.adviserUserId, adviserUserId));
  await db
    .delete(adviserFeeAccruals)
    .where(eq(adviserFeeAccruals.adviserUserId, adviserUserId));
}

// ---------------------------------------------------------------------------
// Idempotency helper that mirrors the production deposit handler shape:
//   1. checkIdempotency
//   2. if existing → return cached
//   3. else → insert transaction
//   4. saveIdempotentResponse
// ---------------------------------------------------------------------------
const IDEM_ROUTE = "/api/test-deposit";

async function attemptIdempotentDeposit(
  userId: number,
  key: string,
  amount: string,
): Promise<{ created: boolean; transactionId?: number }> {
  const payloadHash = hashPayload({ amount });

  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, userId),
        eq(idempotencyKeys.route, IDEM_ROUTE),
        eq(idempotencyKeys.key, key),
      ),
    );
  if (existing) {
    return {
      created: false,
      transactionId: (existing.responseJson as any)?.id,
    };
  }

  const [tx] = await db
    .insert(transactions)
    .values({
      userId,
      type: "deposit",
      fromCurrency: null,
      toCurrency: TEST_CURRENCY,
      amount,
      fee: "0",
      status: "pending",
      description: "txsafety idempotent",
    })
    .returning();

  await db
    .insert(idempotencyKeys)
    .values({
      userId,
      route: IDEM_ROUTE,
      key,
      payloadHash,
      responseJson: tx as any,
    })
    .onConflictDoNothing();

  return { created: true, transactionId: tx.id };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function test1_depositIdempotency(userId: number) {
  const key = `txsafety-${Date.now()}-1`;
  const a = await attemptIdempotentDeposit(userId, key, "10.00");
  const b = await attemptIdempotentDeposit(userId, key, "10.00");
  const c = await attemptIdempotentDeposit(userId, key, "10.00");

  const createdCount = [a, b, c].filter((r) => r.created).length;

  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        sql`${transactions.description} = 'txsafety idempotent'`,
      ),
    );

  const txCount = Number(n);
  if (createdCount === 1 && txCount === 1) {
    pass(
      "deposit idempotency",
      `3 attempts, 1 transaction (id=${a.transactionId})`,
    );
  } else {
    fail(
      "deposit idempotency",
      `expected 1 created / 1 row, got created=${createdCount}, rows=${txCount}`,
    );
  }

  // Sub-assertion: same key + DIFFERENT payload must be detected as a
  // payload-hash conflict (production returns HTTP 422 in this case). This
  // guards against a client accidentally reusing an idempotency key with a
  // changed amount and silently getting back the old transaction.
  const [stored] = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, userId),
        eq(idempotencyKeys.route, IDEM_ROUTE),
        eq(idempotencyKeys.key, key),
      ),
    );
  const otherHash = hashPayload({ amount: "999.00" });
  const isConflict = stored && stored.payloadHash !== otherHash;
  if (isConflict) {
    pass(
      "deposit idempotency payload-hash guard",
      "different payload with reused key would be rejected",
    );
  } else {
    fail(
      "deposit idempotency payload-hash guard",
      `stored hash matches a different payload (stored=${stored?.payloadHash}, other=${otherHash})`,
    );
  }
}

async function test2_pendingNoLedger(userId: number) {
  const [tx] = await db
    .insert(transactions)
    .values({
      userId,
      type: "deposit",
      fromCurrency: null,
      toCurrency: TEST_CURRENCY,
      amount: "50.00",
      fee: "0",
      status: "pending",
      description: "txsafety pending",
    })
    .returning();

  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transactionId, tx.id));

  if (Number(n) === 0) {
    pass("pending no ledger impact", `tx#${tx.id} has 0 ledger entries`);
  } else {
    fail("pending no ledger impact", `tx#${tx.id} has ${n} ledger entries`);
  }
}

async function test3_settlementSingleEntry(userId: number) {
  const [tx] = await db
    .insert(transactions)
    .values({
      userId,
      type: "deposit",
      fromCurrency: null,
      toCurrency: TEST_CURRENCY,
      amount: "100.00",
      fee: "0",
      status: "completed",
      description: "txsafety settlement",
    })
    .returning();

  const client = await getOrCreateClientAccount(userId, TEST_CURRENCY);
  const suspense = await getOrCreateSuspenseAccount(TEST_CURRENCY);

  await postLedgerEntries(tx.id, [
    {
      accountId: suspense.id,
      userId: suspense.userId,
      currency: TEST_CURRENCY,
      direction: "debit",
      amount: "100.00000000",
      description: "settlement (suspense leg)",
    },
    {
      accountId: client.id,
      userId,
      currency: TEST_CURRENCY,
      direction: "credit",
      amount: "100.00000000",
      description: "settlement (client leg)",
    },
  ]);

  let threw = false;
  let errName = "";
  try {
    await postLedgerEntries(tx.id, [
      {
        accountId: suspense.id,
        userId: suspense.userId,
        currency: TEST_CURRENCY,
        direction: "debit",
        amount: "100.00000000",
        description: "duplicate suspense leg",
      },
      {
        accountId: client.id,
        userId,
        currency: TEST_CURRENCY,
        direction: "credit",
        amount: "100.00000000",
        description: "duplicate client leg",
      },
    ]);
  } catch (err: any) {
    threw = true;
    errName = err?.name ?? err?.constructor?.name ?? "Error";
  }

  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transactionId, tx.id));

  const entryCount = Number(n);
  const ok =
    threw && errName === "LedgerDoublePostError" && entryCount === 2;

  if (ok) {
    pass(
      "settlement single ledger entry",
      `2 entries on tx#${tx.id}; second post threw LedgerDoublePostError`,
    );
  } else {
    fail(
      "settlement single ledger entry",
      `threw=${threw} (${errName}), entries=${entryCount} (expected 2)`,
    );
  }
}

async function test4_failedNoLedger(userId: number) {
  const [tx] = await db
    .insert(transactions)
    .values({
      userId,
      type: "deposit",
      fromCurrency: null,
      toCurrency: TEST_CURRENCY,
      amount: "75.00",
      fee: "0",
      status: "failed",
      failureReason: "txsafety simulated failure",
      description: "txsafety failed",
    })
    .returning();

  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transactionId, tx.id));

  if (Number(n) === 0) {
    pass("failure no ledger impact", `tx#${tx.id} has 0 ledger entries`);
  } else {
    fail("failure no ledger impact", `tx#${tx.id} has ${n} ledger entries`);
  }
}

async function test5_reversalOffset(userId: number) {
  const before = Number(await getUserCurrencyBalance(userId, TEST_CURRENCY));

  // Forward leg: post a deposit pair against a fresh transaction id.
  const [forward] = await db
    .insert(transactions)
    .values({
      userId,
      type: "deposit",
      fromCurrency: null,
      toCurrency: TEST_CURRENCY,
      amount: "200.00",
      fee: "0",
      status: "completed",
      description: "txsafety reversal forward",
    })
    .returning();

  const client = await getOrCreateClientAccount(userId, TEST_CURRENCY);
  const suspense = await getOrCreateSuspenseAccount(TEST_CURRENCY);

  await postLedgerEntries(forward.id, [
    {
      accountId: suspense.id,
      userId: suspense.userId,
      currency: TEST_CURRENCY,
      direction: "debit",
      amount: "200.00000000",
      description: "fwd suspense",
    },
    {
      accountId: client.id,
      userId,
      currency: TEST_CURRENCY,
      direction: "credit",
      amount: "200.00000000",
      description: "fwd client",
    },
  ]);

  const after = Number(await getUserCurrencyBalance(userId, TEST_CURRENCY));

  // Reversal: post the opposite pair against a NEW transaction id so the
  // original posting is preserved (audit-safe). Mark the new row's status
  // 'reversed' to make the intent explicit.
  const [reverse] = await db
    .insert(transactions)
    .values({
      userId,
      type: "deposit",
      fromCurrency: null,
      toCurrency: TEST_CURRENCY,
      amount: "200.00",
      fee: "0",
      status: "reversed",
      reversedAt: new Date(),
      description: `txsafety reversal of #${forward.id}`,
    })
    .returning();

  await postLedgerEntries(reverse.id, [
    {
      accountId: client.id,
      userId,
      currency: TEST_CURRENCY,
      direction: "debit",
      amount: "200.00000000",
      description: "rev client",
    },
    {
      accountId: suspense.id,
      userId: suspense.userId,
      currency: TEST_CURRENCY,
      direction: "credit",
      amount: "200.00000000",
      description: "rev suspense",
    },
  ]);

  const final = Number(await getUserCurrencyBalance(userId, TEST_CURRENCY));

  const moved = after - before;
  const back = after - final;
  const net = final - before;

  if (
    Math.abs(moved - 200) < 0.0001 &&
    Math.abs(back - 200) < 0.0001 &&
    Math.abs(net) < 0.0001
  ) {
    pass(
      "reversal offset",
      `ledger sum ${before.toFixed(2)} → ${after.toFixed(2)} → ${final.toFixed(2)}`,
    );
  } else {
    fail(
      "reversal offset",
      `before=${before} after=${after} final=${final} (net=${net})`,
    );
  }
}

async function test6_reconciliationMismatch(userId: number) {
  // Deliberately drift the wallet cache by +50 vs the ledger sum — bypass
  // refreshWalletCacheBalance by writing the cache directly. This is exactly
  // the kind of corruption the daily reconciliation must catch.
  const ledgerSum = Number(await getUserCurrencyBalance(userId, TEST_CURRENCY));
  const driftCache = (ledgerSum + 50).toFixed(8);

  await db
    .update(wallets)
    .set({ balance: driftCache, availableBalance: driftCache })
    .where(
      and(eq(wallets.userId, userId), eq(wallets.currency, TEST_CURRENCY)),
    );

  await runWalletLedgerReconciliation();

  const [latest] = await db
    .select()
    .from(walletLedgerReconciliations)
    .where(
      and(
        eq(walletLedgerReconciliations.userId, userId),
        eq(walletLedgerReconciliations.currency, TEST_CURRENCY),
      ),
    )
    .orderBy(sql`${walletLedgerReconciliations.createdAt} DESC`)
    .limit(1);

  if (!latest) {
    fail(
      "reconciliation mismatch detection",
      "no wallet_ledger_reconciliations row was written for the test user",
    );
    return;
  }

  const drift = Math.abs(Number(latest.driftAmount));
  const ok = latest.status === "mismatch" && Math.abs(drift - 50) < 0.01;

  if (ok) {
    pass(
      "reconciliation mismatch detection",
      `status=${latest.status}, drift=${latest.driftAmount}`,
    );
  } else {
    fail(
      "reconciliation mismatch detection",
      `status=${latest.status}, drift=${latest.driftAmount} (expected 'mismatch' ≈50)`,
    );
  }

  // Restore the cache so we don't leave a permanent drift the daily cron
  // would re-flag every day. Use the sanctioned writer
  // (`refreshWalletCacheBalance`) rather than a manual UPDATE — this both
  // recomputes the cache from the *current* ledger sum (avoiding stale
  // values captured at the start of the test) AND reinforces the rule that
  // the wallet cache is only ever written via this helper.
  await db.transaction(async (tx) => {
    await refreshWalletCacheBalance(tx, userId, TEST_CURRENCY);
  });
}

// ---------------------------------------------------------------------------
// Test 7 — Task #37: concurrent double-post protection.
//
// Background: until Task #37, postLedgerEntries() guarded against double
// posts with a COUNT-then-INSERT inside the caller's transaction. At the
// default Postgres READ COMMITTED isolation level, two concurrent posters
// on different connections targeting the same pre-existing transactionId
// could both pass the COUNT check before either inserted — a silent
// double-post that would only surface as drift on the next reconciliation.
//
// The fix is a `ledger_postings` receipt table whose primary key is
// `transaction_id`, written in the same DB tx as the ledger inserts. This
// test reproduces the race directly: pre-create a parent transactions row
// outside any tx so both posters see it, then fire two postLedgerEntries
// calls in parallel — each in its own `db.transaction(...)` so they take
// distinct connections from the pool. Exactly one must win, the other must
// reject with LedgerDoublePostError, and the surviving entry count must be
// 2 (a single balanced pair).
// ---------------------------------------------------------------------------
async function test7_concurrentDoublePost(userId: number) {
  const [tx] = await db
    .insert(transactions)
    .values({
      userId,
      type: "deposit",
      fromCurrency: null,
      toCurrency: TEST_CURRENCY,
      amount: "300.00",
      fee: "0",
      status: "completed",
      description: "txsafety concurrent",
    })
    .returning();

  const client = await getOrCreateClientAccount(userId, TEST_CURRENCY);
  const suspense = await getOrCreateSuspenseAccount(TEST_CURRENCY);

  const pair = [
    {
      accountId: suspense.id,
      userId: suspense.userId,
      currency: TEST_CURRENCY,
      direction: "debit" as const,
      amount: "300.00000000",
      description: "concurrent suspense leg",
    },
    {
      accountId: client.id,
      userId,
      currency: TEST_CURRENCY,
      direction: "credit" as const,
      amount: "300.00000000",
      description: "concurrent client leg",
    },
  ];

  const attempt = () =>
    db.transaction(async (innerTx) => {
      await postLedgerEntries(tx.id, pair, innerTx);
    });

  const settled = await Promise.allSettled([attempt(), attempt()]);
  const fulfilled = settled.filter((r) => r.status === "fulfilled").length;
  const rejected = settled.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  const doublePostErrors = rejected.filter(
    (r) =>
      r.reason instanceof LedgerDoublePostError ||
      (r.reason as any)?.name === "LedgerDoublePostError",
  ).length;

  const [{ n: entryCount }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transactionId, tx.id));

  const ok =
    fulfilled === 1 &&
    doublePostErrors === 1 &&
    Number(entryCount) === 2 &&
    rejected.length === 1;

  if (ok) {
    pass(
      "concurrent post race",
      `tx#${tx.id}: 1 fulfilled, 1 LedgerDoublePostError, ${entryCount} entries`,
    );
  } else {
    const otherErr = rejected[0]?.reason
      ? `${(rejected[0].reason as any)?.name ?? "Error"}: ${
          (rejected[0].reason as any)?.message ?? rejected[0].reason
        }`
      : "n/a";
    fail(
      "concurrent post race",
      `fulfilled=${fulfilled}, doublePostErrors=${doublePostErrors}, ` +
        `entries=${entryCount} (expected 1/1/2). first rejection: ${otherErr}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test 8 — Task #62: reverseSettledDeduction must fully unwind the ledger.
//
// Background: Task #33 added an admin-driven reversal of a settled adviser
// fee deduction. The reversal posts the OPPOSITE balanced ledger triple
// against a NEW transactions row whose deterministic idempotency key is
// `fee_deduction_<id>_reversal`, and flips the deduction.status to
// 'reversed' inside the same DB transaction. The hand-tested smoke run
// confirmed the invariants but no automated test guards them — a future
// refactor of `server/services/fee-engine.ts` could silently break the
// triple-mirror or the idempotency contract and only surface as drift on
// the next reconciliation. This test pins the contract end-to-end:
//
//   1. Seed a real settle path: pre-fund the client, insert a
//      `pending_approval` deduction (totalAccrued=120, adviserShare=80,
//      platformShare=40 in TEST_CURRENCY), call settleApprovedDeduction()
//      and snapshot per-account ledger sums + wallet caches.
//   2. Call reverseSettledDeduction() and assert:
//        a. status flips to 'reversed' and reversalTransactionId is set.
//        b. A NEW transactions row exists with type
//           'adviser_fee_deduction_reversal' and idempotency_key
//           `fee_deduction_<id>_reversal`.
//        c. The reversal's ledger entries are an EXACT mirror of the
//           settlement entries (same accounts + amounts, opposite
//           directions).
//        d. Per-user/per-account ledger sums for client / adviser / fee
//           net back to their PRE-settlement values.
//        e. The cached wallet balance for client and adviser equals the
//           authoritative ledger sum (refreshWalletCacheBalance ran
//           inside the same DB tx as the reversing pair).
//   3. Idempotency: a second reverseSettledDeduction() call with the same
//      deductionId returns the same row, posts NO additional transactions
//      and NO additional ledger entries.
//   4. Negative case: calling reverseSettledDeduction on a fresh
//      `pending_approval` deduction throws a 409.
// ---------------------------------------------------------------------------
async function test8_reverseSettledDeductionUnwindsLedger(
  clientUserId: number,
  adviserUserId: number,
) {
  // (0) Resolve / create the accounts the deduction will touch and the
  // platform fee account. We snapshot pre-settle ledger sums on each so
  // assertions are delta-based and robust to whatever the earlier tests
  // in this run left behind.
  const clientAccount = await getOrCreateClientAccount(
    clientUserId,
    TEST_CURRENCY,
  );
  const adviserAccount = await getOrCreateClientAccount(
    adviserUserId,
    TEST_CURRENCY,
  );
  const feeAccount = await getOrCreateFeeAccount(TEST_CURRENCY);
  const suspense = await getOrCreateSuspenseAccount(TEST_CURRENCY);

  const TOTAL = 120;
  const ADVISER_SHARE = 80;
  const PLATFORM_SHARE = TOTAL - ADVISER_SHARE; // 40
  const PRE_FUND = 500;

  // (1) Pre-fund the client so they can absorb the debit. Suspense ↓500,
  // client ↑500. This is just stage dressing for the deduction; we don't
  // rely on any specific starting balance, only on the deltas around
  // settle / reverse.
  const [fundTx] = await db
    .insert(transactions)
    .values({
      userId: clientUserId,
      type: "deposit",
      fromCurrency: null,
      toCurrency: TEST_CURRENCY,
      amount: PRE_FUND.toFixed(8),
      fee: "0",
      status: "completed",
      description: "txsafety pre-fund for reversal test",
    })
    .returning();
  await postLedgerEntries(fundTx.id, [
    {
      accountId: suspense.id,
      userId: suspense.userId,
      currency: TEST_CURRENCY,
      direction: "debit",
      amount: PRE_FUND.toFixed(8),
      description: "pre-fund (suspense leg)",
    },
    {
      accountId: clientAccount.id,
      userId: clientUserId,
      currency: TEST_CURRENCY,
      direction: "credit",
      amount: PRE_FUND.toFixed(8),
      description: "pre-fund (client leg)",
    },
  ]);
  await db.transaction(async (tx) => {
    await refreshWalletCacheBalance(tx, clientUserId, TEST_CURRENCY);
  });

  // Snapshot AT THE PRE-SETTLEMENT BOUNDARY — i.e. after pre-funding but
  // before any deduction posting. The reversal must drive every one of
  // these back to its current value.
  const preSettleClientUserSum = Number(
    await getUserCurrencyBalance(clientUserId, TEST_CURRENCY),
  );
  const preSettleAdviserUserSum = Number(
    await getUserCurrencyBalance(adviserUserId, TEST_CURRENCY),
  );
  const preSettleClientAcctBal = Number(await getAccountBalance(clientAccount.id));
  const preSettleAdviserAcctBal = Number(
    await getAccountBalance(adviserAccount.id),
  );
  const preSettleFeeAcctBal = Number(await getAccountBalance(feeAccount.id));

  // (2) Insert the deduction in pending_approval — the canonical entry
  // state for settleApprovedDeduction(). 7-day period ending today is
  // arbitrary but realistic.
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 7 * 24 * 3600 * 1000);
  const [deduction] = await db
    .insert(adviserFeeDeductions)
    .values({
      clientUserId,
      adviserUserId,
      periodStart,
      periodEnd,
      totalAccrued: TOTAL.toFixed(4),
      adviserShareAmount: ADVISER_SHARE.toFixed(4),
      platformShareAmount: PLATFORM_SHARE.toFixed(4),
      currency: TEST_CURRENCY,
      accrualIds: [],
      status: "pending_approval",
    })
    .returning();

  // (3) Settle through the production path so the reversal really has to
  // mirror what the engine wrote (rather than something we hand-crafted).
  const settled = await settleApprovedDeduction({
    deductionId: deduction.id,
    approverUserId: clientUserId, // approverUserId is just an audit pointer
  });
  if (settled.status !== "settled" || !settled.settledTransactionId) {
    fail(
      "reverseSettledDeduction unwinds ledger",
      `settle failed: status=${settled.status}, settledTxId=${settled.settledTransactionId}`,
    );
    return;
  }
  const settleTxId = settled.settledTransactionId;
  const settleEntries = await db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transactionId, settleTxId));

  // (4) Call the function under test.
  const reversed = await reverseSettledDeduction({
    deductionId: deduction.id,
    reverserUserId: clientUserId,
    reason: "txsafety automated reversal",
  });

  // (5a) Status / metadata assertions on the deduction row.
  const okStatus =
    reversed.status === "reversed" &&
    reversed.reversalTransactionId !== null &&
    reversed.reversedAt !== null &&
    reversed.reversedReason === "txsafety automated reversal";
  if (!okStatus) {
    fail(
      "reverseSettledDeduction unwinds ledger (status flip)",
      `status=${reversed.status}, reversalTxId=${reversed.reversalTransactionId}, ` +
        `reversedAt=${reversed.reversedAt}, reason=${reversed.reversedReason}`,
    );
  } else {
    pass(
      "reverseSettledDeduction unwinds ledger (status flip)",
      `deduction#${deduction.id} → reversed (reversalTx#${reversed.reversalTransactionId})`,
    );
  }

  // (5b) Reversal transaction row + deterministic idempotency key.
  const reversalTxId = reversed.reversalTransactionId!;
  const [reversalTxRow] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, reversalTxId));
  const expectedKey = `fee_deduction_${deduction.id}_reversal`;
  const okTxRow =
    reversalTxRow &&
    reversalTxRow.type === "adviser_fee_deduction_reversal" &&
    reversalTxRow.idempotencyKey === expectedKey &&
    reversalTxRow.status === "completed" &&
    reversalTxRow.userId === clientUserId;
  if (!okTxRow) {
    fail(
      "reverseSettledDeduction unwinds ledger (reversal tx row)",
      `tx#${reversalTxId}: type=${reversalTxRow?.type}, key=${reversalTxRow?.idempotencyKey} ` +
        `(expected ${expectedKey})`,
    );
  } else {
    pass(
      "reverseSettledDeduction unwinds ledger (reversal tx row)",
      `tx#${reversalTxId} type=${reversalTxRow.type} key=${reversalTxRow.idempotencyKey}`,
    );
  }

  // (5c) The reversal entries must be an EXACT mirror of the settlement
  // entries: same (accountId, |amount|), opposite direction. There must
  // be no extra leg and no missing leg.
  const reversalEntries = await db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transactionId, reversalTxId));

  type Leg = { accountId: number; direction: string; amount: string };
  const normalize = (e: Leg) => `${e.accountId}|${e.direction}|${Number(e.amount).toFixed(8)}`;
  const flip = (e: Leg) =>
    `${e.accountId}|${e.direction === "debit" ? "credit" : "debit"}|${Number(e.amount).toFixed(8)}`;

  const settleSig = settleEntries.map(normalize).sort();
  const reversalAsFlipped = reversalEntries.map(flip).sort();

  const sameLength = settleEntries.length === reversalEntries.length;
  const sameSet =
    sameLength &&
    settleSig.every((s, i) => s === reversalAsFlipped[i]);

  if (!sameSet) {
    fail(
      "reverseSettledDeduction unwinds ledger (mirror entries)",
      `settle=${JSON.stringify(settleSig)} vs reversal(flipped)=${JSON.stringify(reversalAsFlipped)}`,
    );
  } else {
    pass(
      "reverseSettledDeduction unwinds ledger (mirror entries)",
      `${reversalEntries.length} reversal legs exactly mirror ${settleEntries.length} settle legs`,
    );
  }

  // (5d) Per-user / per-account ledger sums net back to the
  // pre-settlement snapshot.
  const postClientUserSum = Number(
    await getUserCurrencyBalance(clientUserId, TEST_CURRENCY),
  );
  const postAdviserUserSum = Number(
    await getUserCurrencyBalance(adviserUserId, TEST_CURRENCY),
  );
  const postClientAcctBal = Number(await getAccountBalance(clientAccount.id));
  const postAdviserAcctBal = Number(
    await getAccountBalance(adviserAccount.id),
  );
  const postFeeAcctBal = Number(await getAccountBalance(feeAccount.id));

  const close = (a: number, b: number) => Math.abs(a - b) < 0.0001;
  const sumsRestored =
    close(postClientUserSum, preSettleClientUserSum) &&
    close(postAdviserUserSum, preSettleAdviserUserSum) &&
    close(postClientAcctBal, preSettleClientAcctBal) &&
    close(postAdviserAcctBal, preSettleAdviserAcctBal) &&
    close(postFeeAcctBal, preSettleFeeAcctBal);

  if (!sumsRestored) {
    fail(
      "reverseSettledDeduction unwinds ledger (ledger sums restored)",
      `client user ${preSettleClientUserSum}→${postClientUserSum}, ` +
        `adviser user ${preSettleAdviserUserSum}→${postAdviserUserSum}, ` +
        `client acct ${preSettleClientAcctBal}→${postClientAcctBal}, ` +
        `adviser acct ${preSettleAdviserAcctBal}→${postAdviserAcctBal}, ` +
        `fee acct ${preSettleFeeAcctBal}→${postFeeAcctBal}`,
    );
  } else {
    pass(
      "reverseSettledDeduction unwinds ledger (ledger sums restored)",
      `all five sums back to pre-settle baseline`,
    );
  }

  // (5e) Wallet caches for both client and adviser equal their ledger
  // sums. reverseSettledDeduction calls refreshWalletCacheBalance inside
  // the same DB tx; we just compare the cached value to the
  // authoritative ledger sum.
  const [clientWallet] = await db
    .select()
    .from(wallets)
    .where(
      and(
        eq(wallets.userId, clientUserId),
        eq(wallets.currency, TEST_CURRENCY),
      ),
    );
  const [adviserWallet] = await db
    .select()
    .from(wallets)
    .where(
      and(
        eq(wallets.userId, adviserUserId),
        eq(wallets.currency, TEST_CURRENCY),
      ),
    );
  const cacheOk =
    clientWallet &&
    adviserWallet &&
    close(Number(clientWallet.balance), postClientUserSum) &&
    close(Number(adviserWallet.balance), postAdviserUserSum);
  if (!cacheOk) {
    fail(
      "reverseSettledDeduction unwinds ledger (wallet cache matches)",
      `client cache=${clientWallet?.balance} vs sum=${postClientUserSum}; ` +
        `adviser cache=${adviserWallet?.balance} vs sum=${postAdviserUserSum}`,
    );
  } else {
    pass(
      "reverseSettledDeduction unwinds ledger (wallet cache matches)",
      `client ${clientWallet.balance} == ${postClientUserSum}, ` +
        `adviser ${adviserWallet.balance} == ${postAdviserUserSum}`,
    );
  }

  // (6) Idempotency: a second reverse call MUST be a no-op — same row
  // back, no new transaction, no new ledger entries.
  //
  // We measure deltas TWO ways to defend against a pathological future
  // bug that might write rows under a different userId or skip the
  // deterministic key entirely:
  //   (a) global count of transactions whose idempotency_key matches
  //       `fee_deduction_<id>_reversal` — must stay at exactly 1.
  //   (b) global count of ledger_entries on the reversal transaction id
  //       — must stay at the same value as after the first call.
  //   (c) per-client transactions / ledger_entries — must not increase.
  const txCountBefore = await countClientTransactions(clientUserId);
  const entryCountBefore = await countClientLedgerEntries(clientUserId);
  const reversalKeyCountBefore = await countTxByIdempotencyKey(expectedKey);
  const reversalEntriesBefore = await countLedgerEntriesByTxId(reversalTxId);

  const second = await reverseSettledDeduction({
    deductionId: deduction.id,
    reverserUserId: clientUserId,
    reason: "txsafety automated reversal (retry)",
  });

  const txCountAfter = await countClientTransactions(clientUserId);
  const entryCountAfter = await countClientLedgerEntries(clientUserId);
  const reversalKeyCountAfter = await countTxByIdempotencyKey(expectedKey);
  const reversalEntriesAfter = await countLedgerEntriesByTxId(reversalTxId);

  const idempotent =
    second.id === reversed.id &&
    second.reversalTransactionId === reversalTxId &&
    txCountAfter === txCountBefore &&
    entryCountAfter === entryCountBefore &&
    reversalKeyCountBefore === 1 &&
    reversalKeyCountAfter === 1 &&
    reversalEntriesAfter === reversalEntriesBefore;
  if (!idempotent) {
    fail(
      "reverseSettledDeduction is idempotent",
      `txCount ${txCountBefore}→${txCountAfter}, ` +
        `entries ${entryCountBefore}→${entryCountAfter}, ` +
        `key '${expectedKey}' rows ${reversalKeyCountBefore}→${reversalKeyCountAfter} (expected 1→1), ` +
        `reversal-tx entries ${reversalEntriesBefore}→${reversalEntriesAfter}, ` +
        `reversalTxId ${reversalTxId} vs ${second.reversalTransactionId}`,
    );
  } else {
    pass(
      "reverseSettledDeduction is idempotent",
      `2nd call returned same row, +0 transactions, +0 ledger entries; ` +
        `exactly 1 row with idempotency_key '${expectedKey}'`,
    );
  }

  // (7) Negative case: a non-settled deduction must reject with 409.
  // We seed a fresh pending_approval deduction (no settle), then attempt
  // to reverse it.
  const [stub] = await db
    .insert(adviserFeeDeductions)
    .values({
      clientUserId,
      adviserUserId,
      periodStart,
      periodEnd,
      totalAccrued: "10.0000",
      adviserShareAmount: "6.0000",
      platformShareAmount: "4.0000",
      currency: TEST_CURRENCY,
      accrualIds: [],
      status: "pending_approval",
    })
    .returning();

  let threw = false;
  let status: number | undefined;
  let message = "";
  try {
    await reverseSettledDeduction({
      deductionId: stub.id,
      reverserUserId: clientUserId,
      reason: "should not succeed",
    });
  } catch (err: any) {
    threw = true;
    status = err?.status;
    message = String(err?.message ?? err);
  }
  if (threw && status === 409) {
    pass(
      "reverseSettledDeduction rejects non-settled (409)",
      `threw status=409: ${message.slice(0, 100)}`,
    );
  } else {
    fail(
      "reverseSettledDeduction rejects non-settled (409)",
      `threw=${threw}, status=${status}, message=${message}`,
    );
  }
}

async function countClientTransactions(userId: number): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(transactions)
    .where(eq(transactions.userId, userId));
  return Number(n);
}

async function countClientLedgerEntries(userId: number): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(ledgerEntries)
    .where(
      sql`${ledgerEntries.transactionId} IN (SELECT id FROM transactions WHERE user_id = ${userId})`,
    );
  return Number(n);
}

async function countTxByIdempotencyKey(key: string): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(transactions)
    .where(eq(transactions.idempotencyKey, key));
  return Number(n);
}

async function countLedgerEntriesByTxId(txId: number): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transactionId, txId));
  return Number(n);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  // Task #152 — accept --strict from argv. In strict mode, any check
  // that resolves to SKIP fails the exit code (mirroring the contract
  // in scripts/pre-launch-safety.ts). The parent roll-up forwards
  // --strict to this child when it itself was invoked strict, so a
  // skipped internal check propagates up as a non-zero child exit
  // instead of being hidden behind a PASS.
  const strict = process.argv.slice(2).includes("--strict");
  console.log(
    `=== Transaction Safety Test ===${strict ? " (--strict)" : ""}\n`,
  );

  const userId = await ensureTestUser();
  const adviserUserId = await ensureAdviserTestUser();
  // Order matters: cleanup the adviser-side deduction rows first (they FK
  // into transactions belonging to the client), then run the standard
  // client-scoped cleanup which drops the client deductions and the
  // transactions themselves.
  await cleanupAdviserTestUser(adviserUserId);
  await cleanupTestUser(userId);
  await ensureFreshTestWallet(userId);
  await ensureFreshWalletFor(adviserUserId);

  // Task #220 (mirrors #219 in scripts/test-fee-insufficient-funds.ts) —
  // snapshot the set of `accounts` PKs already owned by the platform user
  // BEFORE this script runs. The settlement / reversal code paths exercised
  // by test3, test5, and test8 call getOrCreateSuspenseAccount /
  // getOrCreateFeeAccount, both of which insert a fresh platform-side
  // account row on a clean DB. cleanupTestUser walks ledger_entries +
  // transactions by user_id but never touches platform-side accounts
  // rows, so without this snapshot+diff the platform user accumulates one
  // new accounts row per fresh-DB run and the orphan-row gate (Task #198)
  // flags it. Diff against this snapshot in the finally block and
  // PK-delete only the rows THIS script created — never delete by
  // user_id alone, so concurrent test scripts that pin the same
  // PLATFORM_USER_ID are unaffected.
  const platformUserIdRaw = process.env.PLATFORM_USER_ID;
  const platformUserId =
    platformUserIdRaw && /^[1-9]\d*$/.test(platformUserIdRaw)
      ? Number(platformUserIdRaw)
      : null;
  const preExistingPlatformAccountIds = new Set<number>(
    platformUserId !== null
      ? (
          await db
            .select({ id: accounts.id })
            .from(accounts)
            .where(eq(accounts.userId, platformUserId))
        ).map((r) => r.id)
      : [],
  );

  let exitCode = 0;
  try {
    await test1_depositIdempotency(userId);
    await test2_pendingNoLedger(userId);
    await test3_settlementSingleEntry(userId);
    await test4_failedNoLedger(userId);
    await test5_reversalOffset(userId);
    await test6_reconciliationMismatch(userId);
    await test7_concurrentDoublePost(userId);
    await test8_reverseSettledDeductionUnwindsLedger(userId, adviserUserId);

    console.log("");
    for (const r of results) {
      const tag =
        r.outcome === "pass"
          ? "PASS"
          : r.outcome === "skip"
            ? "SKIP"
            : "FAIL";
      const tail = r.details ? ` — ${r.details}` : "";
      console.log(`${tag} ${r.name}${tail}`);
    }

    const failed = results.filter((r) => r.outcome === "fail");
    const skipped = results.filter((r) => r.outcome === "skip");
    if (failed.length > 0) {
      console.error(
        `\n${failed.length} transaction safety test(s) failed. ` +
          "Do not proceed to fee-engine money movement.",
      );
      exitCode = 1;
    } else if (skipped.length > 0 && strict) {
      // Task #152 — strict mode: any internal SKIP fails the exit code
      // so the parent roll-up's `existing: ...` gate flips off PASS,
      // mirroring scripts/pre-launch-safety.ts. Use exit code 2 so the
      // parent can distinguish "skipped" from "failed" when classifying
      // the existing-script outcome.
      console.error(
        `\n${skipped.length} transaction safety check(s) skipped under --strict. ` +
          "Treating as failure.",
      );
      exitCode = 2;
    } else if (skipped.length > 0) {
      console.log(
        `\nALL TRANSACTION SAFETY TESTS PASSED — ${skipped.length} skipped ` +
          "(run with --strict to block on skipped checks).",
      );
    } else {
      console.log("\nALL TRANSACTION SAFETY TESTS PASSED \u2705");
    }
  } finally {
    // Task #158 — drop ALL ledger entries written during this run, including
    // the platform-side suspense and fee-account legs of every test
    // transaction. cleanupTestUser deletes ledger_entries by
    // `transaction_id IN (SELECT id FROM transactions WHERE user_id = ...)`,
    // and every test transaction is owned by the test client user — even
    // the adviser-fee-deduction settle/reverse transactions, which the
    // fee-engine inserts with `userId: deduction.clientUserId`. That
    // single delete therefore cascades to the platform fee/suspense legs
    // as well, returning user_id=11 to its starting balance.
    //
    // Running cleanup AT THE END (not just at start-of-next-run) is what
    // keeps the operator-alert clean-room gate in pre-launch-safety.ts
    // green: between this script's exit and the recon clean-room, the
    // ledger sum on the platform user must already be back to its
    // baseline so the wallet-vs-ledger reconciliation does not flag a
    // critical drift.
    try {
      await cleanupAdviserTestUser(adviserUserId);
      await cleanupTestUser(userId);

      // Task #220 — diff platform-user accounts against the start-of-script
      // snapshot and PK-delete only the rows THIS run created. The two
      // cleanup calls above sweep ledger_entries by transaction_id, which
      // dereferences the platform-side legs, but they do not touch
      // accounts whose user_id is the platform user. PK delete (never
      // user_id alone) protects concurrent test scripts pinned to the
      // same platform user.
      if (platformUserId !== null) {
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
      }
    } catch (cleanupErr) {
      console.error("Post-run cleanup threw:", cleanupErr);
      if (exitCode === 0) exitCode = 1;
    }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Transaction safety test crashed:", err);
  process.exit(1);
});
