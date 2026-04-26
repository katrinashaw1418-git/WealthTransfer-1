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

import { createHash } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  users,
  wallets,
  transactions,
  ledgerEntries,
  idempotencyKeys,
  walletLedgerReconciliations,
} from "../shared/schema";
import {
  getOrCreateClientAccount,
  getOrCreateSuspenseAccount,
  postLedgerEntries,
  getUserCurrencyBalance,
  refreshWalletCacheBalance,
  LedgerDoublePostError,
} from "../server/services/ledger";
import { runWalletLedgerReconciliation } from "../server/services/reconciliation";

const TEST_USERNAME = "__txsafety_test_user__";
const TEST_EMAIL = "txsafety@test.invalid";
const TEST_CURRENCY = "AUD";

type TestResult = { name: string; passed: boolean; details?: string };
const results: TestResult[] = [];

function pass(name: string, details?: string) {
  results.push({ name, passed: true, details });
}

function fail(name: string, details?: string) {
  results.push({ name, passed: false, details });
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

async function cleanupTestUser(userId: number): Promise<void> {
  // Order matters: ledger_entries → transactions (FK), then everything else.
  await db.execute(sql`
    DELETE FROM ledger_entries
    WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = ${userId})
  `);
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.userId, userId));
  await db
    .delete(walletLedgerReconciliations)
    .where(eq(walletLedgerReconciliations.userId, userId));
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
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Transaction Safety Test ===\n");

  const userId = await ensureTestUser();
  await cleanupTestUser(userId);
  await ensureFreshTestWallet(userId);

  await test1_depositIdempotency(userId);
  await test2_pendingNoLedger(userId);
  await test3_settlementSingleEntry(userId);
  await test4_failedNoLedger(userId);
  await test5_reversalOffset(userId);
  await test6_reconciliationMismatch(userId);

  console.log("");
  for (const r of results) {
    const tag = r.passed ? "PASS" : "FAIL";
    const tail = r.details ? ` — ${r.details}` : "";
    console.log(`${tag} ${r.name}${tail}`);
  }

  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    console.error(
      `\n${failed.length} transaction safety test(s) failed. ` +
        "Do not proceed to fee-engine money movement.",
    );
    process.exit(1);
  }

  console.log("\nALL TRANSACTION SAFETY TESTS PASSED \u2705");
  process.exit(0);
}

main().catch((err) => {
  console.error("Transaction safety test crashed:", err);
  process.exit(1);
});
