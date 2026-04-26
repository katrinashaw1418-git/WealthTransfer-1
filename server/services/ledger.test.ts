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
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  accounts,
  ledgerEntries,
  ledgerPostings,
  transactions,
  users,
  wallets,
} from "@shared/schema";
import {
  LedgerDoublePostError,
  LedgerUnbalancedError,
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
    // Task #37 — drop the matching ledger_postings receipts so the FK to
    // transactions doesn't block the transactions delete below.
    await db
      .delete(ledgerPostings)
      .where(inArray(ledgerPostings.transactionId, createdTxIds));
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

  // ---------------------------------------------------------------------
  // Task #37 — concurrent double-post protection.
  //
  // The previous COUNT-then-INSERT guard had a TOCTOU window at the
  // default READ COMMITTED isolation level: two concurrent posters on
  // different connections targeting the same pre-existing transactionId
  // could both pass the COUNT check before either INSERT, silently
  // double-posting. The ledger_postings receipt table closes that window
  // by giving Postgres a primary key to lock on.
  //
  // This test reproduces the race directly. We pre-create a parent
  // transactions row OUTSIDE any tx, then fire two postLedgerEntries
  // calls in parallel — each inside its own `db.transaction(...)` — and
  // assert that EXACTLY one balanced pair (2 entries) lands and the
  // other call rejects with LedgerDoublePostError.
  // ---------------------------------------------------------------------
  it("serialises concurrent posts on different connections — exactly one wins", async () => {
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

    // Two parallel attempts, each in its own connection-bound tx. The
    // pool default size is large enough for two concurrent
    // db.transaction() handles to acquire distinct connections.
    const attempt = () =>
      db.transaction(async (tx) => {
        await postLedgerEntries(txId, pair, tx);
      });

    const results = await Promise.allSettled([attempt(), attempt()]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(LedgerDoublePostError);
    expect((rejected[0].reason as LedgerDoublePostError).transactionId).toBe(txId);

    // Exactly one balanced pair landed, and exactly one posting receipt
    // was claimed.
    const [{ entryCount }] = await db
      .select({ entryCount: sql<number>`COUNT(*)::int` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, txId));
    expect(Number(entryCount)).toBe(2);

    const [{ receiptCount }] = await db
      .select({ receiptCount: sql<number>`COUNT(*)::int` })
      .from(ledgerPostings)
      .where(eq(ledgerPostings.transactionId, txId));
    expect(Number(receiptCount)).toBe(1);
  });
});

// ===========================================================================
// Task #41 — automated test for the mixed-currency journal guard
// ===========================================================================
// Locks in the rule in postLedgerEntries() that every entry in a single
// journal must share one currency. Multi-currency FX must be split into two
// single-currency journals (one per leg). The guard fires synchronously on
// the in-memory entries array BEFORE any DB write, so this test does not
// need to create accounts, transactions, or ledger rows — and therefore
// has nothing to clean up. We deliberately use sentinel non-existent
// account/user ids: if a regression ever lets execution reach the insert,
// the FK constraint on ledger_entries.account_id will surface as a
// distinct (non-Error-message) failure rather than a silent pass.
// ===========================================================================
describe("postLedgerEntries — mixed-currency guard (Task #41)", () => {
  it("throws when entries in the same journal use different currencies", async () => {
    const SENTINEL_TX_ID = -1;
    const SENTINEL_ACCT_ID = -1;
    const SENTINEL_USER_ID = -1;

    const mixedCurrencyJournal = [
      {
        accountId: SENTINEL_ACCT_ID,
        userId: SENTINEL_USER_ID,
        currency: "USD",
        direction: "debit" as const,
        amount: TEST_AMOUNT,
        description: "mixed-currency test (USD leg)",
      },
      {
        accountId: SENTINEL_ACCT_ID,
        userId: SENTINEL_USER_ID,
        currency: "EUR",
        direction: "credit" as const,
        amount: TEST_AMOUNT,
        description: "mixed-currency test (EUR leg)",
      },
    ];

    await expect(
      postLedgerEntries(SENTINEL_TX_ID, mixedCurrencyJournal),
    ).rejects.toThrow(
      "Multi-currency ledger entries require explicit FX transaction handling",
    );

    // The guard fires before any DB access, so no ledger entries can have
    // been inserted against our sentinel transactionId.
    const leaked = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, SENTINEL_TX_ID));
    expect(leaked).toHaveLength(0);
  });

  it("accepts a single-currency journal of the same shape (control case)", async () => {
    // Control: prove the rejection above is specifically about currency
    // mismatch, not some other validation failing first. Same sentinel
    // ids and amounts as above, but both legs in USD — execution must
    // proceed past the currency guard. With sentinel (non-existent)
    // account ids the insert step will then fail with an FK violation,
    // which is exactly what we assert: a DB error, NOT the multi-currency
    // error string.
    const SENTINEL_TX_ID = -2;
    const SENTINEL_ACCT_ID = -1;
    const SENTINEL_USER_ID = -1;

    const singleCurrencyJournal = [
      {
        accountId: SENTINEL_ACCT_ID,
        userId: SENTINEL_USER_ID,
        currency: "USD",
        direction: "debit" as const,
        amount: TEST_AMOUNT,
        description: "single-currency control (debit leg)",
      },
      {
        accountId: SENTINEL_ACCT_ID,
        userId: SENTINEL_USER_ID,
        currency: "USD",
        direction: "credit" as const,
        amount: TEST_AMOUNT,
        description: "single-currency control (credit leg)",
      },
    ];

    let captured: unknown = null;
    try {
      await postLedgerEntries(SENTINEL_TX_ID, singleCurrencyJournal);
    } catch (err) {
      captured = err;
    }
    expect(captured).not.toBeNull();
    const msg = (captured as Error).message ?? "";
    expect(msg).not.toMatch(/Multi-currency ledger entries/);

    // Same belt-and-braces check: nothing got inserted.
    const leaked = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, SENTINEL_TX_ID));
    expect(leaked).toHaveLength(0);
  });
});

// ===========================================================================
// Task #45 — automated test for the balanced-journal guard
// ===========================================================================
// Locks in the rule in postLedgerEntries() that every journal's credit and
// debit totals must match within EPSILON. This is the core double-entry
// invariant: if it ever silently regresses, every wallet balance the
// platform reports becomes untrustworthy.
//
// The guard fires synchronously on the in-memory entries array BEFORE any
// DB write (it sits between the mixed-currency guard and the same-tx
// double-post guard), so this test does not need to create accounts,
// transactions, or ledger rows — and therefore has nothing to clean up.
// We deliberately use sentinel non-existent account/user ids: if a
// regression ever lets execution reach the insert, the FK constraint on
// ledger_entries.account_id will surface as a distinct (non-Error-message)
// failure rather than a silent pass.
// ===========================================================================
describe("postLedgerEntries — balanced-journal guard (Task #45)", () => {
  it("throws when credit and debit totals differ", async () => {
    const SENTINEL_TX_ID = -3;
    const SENTINEL_ACCT_ID = -1;
    const SENTINEL_USER_ID = -1;

    // Same currency on both legs (so we get past the mixed-currency guard)
    // but mismatched amounts: 100 debit vs 50 credit.
    const unbalancedJournal = [
      {
        accountId: SENTINEL_ACCT_ID,
        userId: SENTINEL_USER_ID,
        currency: TEST_CURRENCY,
        direction: "debit" as const,
        amount: "100.00000000",
        description: "unbalanced test (debit leg)",
      },
      {
        accountId: SENTINEL_ACCT_ID,
        userId: SENTINEL_USER_ID,
        currency: TEST_CURRENCY,
        direction: "credit" as const,
        amount: "50.00000000",
        description: "unbalanced test (credit leg)",
      },
    ];

    // Task #54 — capture the typed error so we can assert on its identity
    // and structured fields (transactionId / totals / difference / currency
    // / entryCount), not just the message text. The route-level mapping
    // depends on `instanceof LedgerUnbalancedError` to fire the operator
    // alert and return a 422; if the throw ever silently downgrades back
    // to a plain Error, this test fails.
    const promise = postLedgerEntries(SENTINEL_TX_ID, unbalancedJournal);
    await expect(promise).rejects.toBeInstanceOf(LedgerUnbalancedError);
    await expect(promise).rejects.toThrow("Ledger entries are not balanced");
    await expect(promise).rejects.toMatchObject({
      transactionId: SENTINEL_TX_ID,
      totalCredits: 50,
      totalDebits: 100,
      difference: -50,
      currency: TEST_CURRENCY,
      entryCount: 2,
      status: 422,
    });

    // The guard fires before any DB access, so no ledger entries can have
    // been inserted against our sentinel transactionId.
    const leaked = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, SENTINEL_TX_ID));
    expect(leaked).toHaveLength(0);
  });
});
