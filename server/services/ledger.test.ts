// =============================================================================
// Task #26 — automated tests for the ledger double-post guard
// =============================================================================
// Locks in the same-transaction posting guard added by Task #22:
//   - postLedgerEntries() refuses to insert a second balanced pair against a
//     transactionId that already has any ledger entries.
//   - It throws a typed LedgerDoublePostError so callers/tests can assert on
//     the error identity rather than string-matching the message.
//   - The guard fires regardless of whether the call is made against the
//     global `db` handle or inside an outer `db.transaction(async tx => ...)`
//     (the shape both `handleDeposit` and `handleWithdraw` in
//     `server/routes.ts` use).
//
// Without a permanent test, a future refactor could silently remove the guard
// and only surface as drift on the next reconciliation run. These tests
// reproduce both code paths against the dev database used by the rest of the
// project (the same one the seed scripts target) and clean up every row they
// create — including any platform suspense account they had to create — so
// reruns are idempotent.
//
// Run with:  npx vitest run
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  accounts,
  ledgerEntries,
  transactions,
  users,
  wallets,
} from "@shared/schema";
import {
  LedgerDoublePostError,
  getOrCreateClientAccount,
  getOrCreateSuspenseAccount,
  postLedgerEntries,
} from "./ledger";

// Mirror the loose handle alias used inside ledger.ts so this test file does
// not need to reach into private types and does not fall back to `any`.
type DbHandle = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const TEST_CURRENCY = "USD";
const TEST_AMOUNT = "100.00000000";

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function createTestUser(): Promise<number> {
  const suffix = uniqueSuffix();
  const [u] = await db
    .insert(users)
    .values({
      username: `ledger-doublepost-test-${suffix}`,
      email: `ledger-doublepost-test-${suffix}@test.invalid`,
      password: "not-a-real-password",
      firstName: "Ledger",
      lastName: "DoublePostTest",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning({ id: users.id });
  return u.id;
}

async function insertSettledTx(
  userId: number,
  handle: DbHandle = db,
): Promise<number> {
  const [tx] = await handle
    .insert(transactions)
    .values({
      userId,
      type: "deposit",
      fromCurrency: null,
      toCurrency: TEST_CURRENCY,
      amount: TEST_AMOUNT,
      fee: "0.00000000",
      exchangeRate: null,
      status: "completed",
      settlementStatus: "internal_only",
      description: "Task #26 double-post guard test",
    })
    .returning({ id: transactions.id });
  return tx.id;
}

function balancedPair(
  clientAccountId: number,
  clientUserId: number,
  suspenseAccountId: number,
  suspenseUserId: number,
) {
  return [
    {
      accountId: suspenseAccountId,
      userId: suspenseUserId,
      currency: TEST_CURRENCY,
      direction: "debit" as const,
      amount: TEST_AMOUNT,
      description: "double-post test (suspense leg)",
    },
    {
      accountId: clientAccountId,
      userId: clientUserId,
      currency: TEST_CURRENCY,
      direction: "credit" as const,
      amount: TEST_AMOUNT,
      description: "double-post test (client leg)",
    },
  ];
}

// Cross-test cleanup state. Tracking the suspense account separately from
// the test user lets us delete a suspense account we had to create
// without removing one a previous run / production seed already owned.
const createdTxIds: number[] = [];
let testUserId: number;
let createdSuspenseAccountId: number | null = null;
let suspenseResolved = false;

async function resolveSuspenseAccount(handle: DbHandle = db) {
  if (!suspenseResolved) {
    // Deterministic ownership check: query for an existing suspense account
    // for this currency BEFORE asking getOrCreateSuspenseAccount to make
    // one. If none exists pre-call, the row that comes back is ours and we
    // record its id for cleanup. If one exists pre-call, we leave it alone.
    const platformUserId = parseInt(process.env.PLATFORM_USER_ID!, 10);
    const [existing] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, platformUserId),
          eq(accounts.currency, TEST_CURRENCY),
          eq(accounts.accountType, "platform_suspense"),
        ),
      )
      .limit(1);

    const acct = await getOrCreateSuspenseAccount(TEST_CURRENCY, handle);
    if (!existing) {
      createdSuspenseAccountId = acct.id;
    }
    suspenseResolved = true;
    return acct;
  }
  return getOrCreateSuspenseAccount(TEST_CURRENCY, handle);
}

beforeAll(async () => {
  if (!process.env.PLATFORM_USER_ID) {
    throw new Error(
      "PLATFORM_USER_ID env var must be set so getOrCreateSuspenseAccount() " +
        "can resolve the platform suspense owner.",
    );
  }
  testUserId = await createTestUser();
});

afterAll(async () => {
  if (createdTxIds.length > 0) {
    await db
      .delete(ledgerEntries)
      .where(inArray(ledgerEntries.transactionId, createdTxIds));
    await db.delete(transactions).where(inArray(transactions.id, createdTxIds));
  }
  if (testUserId !== undefined) {
    await db.delete(wallets).where(eq(wallets.userId, testUserId));
    await db.delete(accounts).where(eq(accounts.userId, testUserId));
    await db.delete(users).where(eq(users.id, testUserId));
  }
  if (createdSuspenseAccountId !== null) {
    // Only safe to delete because we never posted any entries that survived
    // (subtest A entries are deleted above by transactionId, subtest B
    // rolled back). If a future test posts entries that DO survive against
    // this account, this delete will fail loudly via the FK from
    // ledger_entries.account_id — which is the right behaviour.
    await db.delete(accounts).where(eq(accounts.id, createdSuspenseAccountId));
  }
  // Intentionally NOT calling pool.end(): vitest tears down the worker
  // process after the suite finishes, and leaving the pool open lets
  // future test files in the same process reuse the same db handle.
});

describe("postLedgerEntries — double-post guard (Task #22)", () => {
  it("throws LedgerDoublePostError on a repeat post via the global db handle", async () => {
    const txId = await insertSettledTx(testUserId);
    createdTxIds.push(txId);

    const clientAcct = await getOrCreateClientAccount(testUserId, TEST_CURRENCY);
    const suspenseAcct = await resolveSuspenseAccount();
    const pair = balancedPair(
      clientAcct.id,
      testUserId,
      suspenseAcct.id,
      suspenseAcct.userId,
    );

    await postLedgerEntries(txId, pair);

    const posted = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, txId));
    expect(posted).toHaveLength(2);

    await expect(postLedgerEntries(txId, pair)).rejects.toBeInstanceOf(
      LedgerDoublePostError,
    );

    // The guard MUST fire before the insert — row count unchanged.
    const stillPosted = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, txId));
    expect(stillPosted).toHaveLength(2);

    // Identity of the thrown error: assert via a fresh await/catch so we
    // can read the typed fields (transactionId / existingEntryCount) the
    // guard exposes for callers and reconciliation tooling.
    let captured: unknown = null;
    try {
      await postLedgerEntries(txId, pair);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(LedgerDoublePostError);
    const dpe = captured as LedgerDoublePostError;
    expect(dpe.name).toBe("LedgerDoublePostError");
    expect(dpe.transactionId).toBe(txId);
    expect(dpe.existingEntryCount).toBeGreaterThanOrEqual(2);
  });

  it("throws LedgerDoublePostError when the second post happens inside an outer db.transaction handle", async () => {
    let innerTxId: number | null = null;
    let captured: unknown = null;

    try {
      await db.transaction(async (tx) => {
        innerTxId = await insertSettledTx(testUserId, tx);

        const clientAcct = await getOrCreateClientAccount(
          testUserId,
          TEST_CURRENCY,
          tx,
        );
        const suspenseAcct = await resolveSuspenseAccount(tx);
        const pair = balancedPair(
          clientAcct.id,
          testUserId,
          suspenseAcct.id,
          suspenseAcct.userId,
        );

        await postLedgerEntries(innerTxId, pair, tx);
        // Second post inside the same outer tx — must throw.
        await postLedgerEntries(innerTxId, pair, tx);
      });
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(LedgerDoublePostError);
    const dpe = captured as LedgerDoublePostError;
    expect(innerTxId).not.toBeNull();
    expect(dpe.transactionId).toBe(innerTxId);

    // The outer tx must have rolled back: neither the parent transactions
    // row nor any ledger entries it tried to post should survive.
    if (innerTxId !== null) {
      const survivingTx = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.id, innerTxId));
      expect(survivingTx).toHaveLength(0);

      const survivingEntries = await db
        .select({ id: ledgerEntries.id })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.transactionId, innerTxId));
      expect(survivingEntries).toHaveLength(0);
    }
  });
});
