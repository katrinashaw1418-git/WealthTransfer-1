// =============================================================================
// Task #42 — wallet cache stays in sync with the ledger
// =============================================================================
// Locks in the Session 25 / Task #17 contract that `refreshWalletCacheBalance`
// is the ONLY sanctioned writer of `wallets.balance` / `wallets.availableBalance`
// and that it always re-derives the cache from SUM(ledger_entries) for the
// (userId, currency) pair.
//
// If a future change ever lets a code path bypass the refresh helper, the
// wallet cache and the ledger will silently drift — and reconciliation only
// catches it after the fact. These vitest cases pin the contract:
//
//   1. After posting a balanced ledger pair and calling
//      refreshWalletCacheBalance(), the wallet row's cached balance equals
//      the ledger SUM for that user+currency.
//
//   2. If the cache is drifted by a direct (forbidden in production) update,
//      re-running refreshWalletCacheBalance() snaps the cache back to the
//      ledger SUM — i.e. the cache writer wins, never the manual edit.
//
// Cleanup mirrors `ledger.test.ts`: anything we insert (transactions,
// ledger entries, wallets, accounts, the test user, and a freshly created
// platform suspense account if we had to make one) is removed in afterAll
// so reruns are idempotent against the dev database.
//
// Run with:  npx vitest run
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
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
  getOrCreateClientAccount,
  getOrCreateSuspenseAccount,
  getUserCurrencyBalance,
  postLedgerEntries,
  refreshWalletCacheBalance,
} from "./ledger";

type DbHandle = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Kept different from ledger.test.ts (which uses USD) as defence in depth:
// Task #51 fixed the real bug (vitest.config.ts was using a non-existent
// `fileParallel` key instead of `fileParallelism`, so files were running in
// parallel forks against the same dev DB and racing on
// `accounts_user_currency_type_uidx`). With the config fix this currency
// split is no longer load-bearing, but it costs nothing to keep and makes
// the test files independently inspectable.
const TEST_CURRENCY = "EUR";
const DEPOSIT_AMOUNT = "250.00000000";
const DRIFT_AMOUNT = "999.99999999";

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function createTestUser(): Promise<number> {
  const suffix = uniqueSuffix();
  const [u] = await db
    .insert(users)
    .values({
      username: `wallet-cache-test-${suffix}`,
      email: `wallet-cache-test-${suffix}@test.invalid`,
      password: "not-a-real-password",
      firstName: "WalletCache",
      lastName: "Test",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning({ id: users.id });
  return u.id;
}

async function createTestWallet(userId: number): Promise<number> {
  const [w] = await db
    .insert(wallets)
    .values({
      userId,
      currency: TEST_CURRENCY,
      balance: "0.00000000",
      availableBalance: "0.00000000",
      walletType: "fiat",
    })
    .returning({ id: wallets.id });
  return w.id;
}

async function insertSettledTx(
  userId: number,
  amount: string,
): Promise<number> {
  const [tx] = await db
    .insert(transactions)
    .values({
      userId,
      type: "deposit",
      fromCurrency: null,
      toCurrency: TEST_CURRENCY,
      amount,
      fee: "0.00000000",
      exchangeRate: null,
      status: "completed",
      settlementStatus: "internal_only",
      description: "Task #42 wallet cache test",
    })
    .returning({ id: transactions.id });
  return tx.id;
}

function balancedPair(
  amount: string,
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
      amount,
      description: "wallet cache test (suspense leg)",
    },
    {
      accountId: clientAccountId,
      userId: clientUserId,
      currency: TEST_CURRENCY,
      direction: "credit" as const,
      amount,
      description: "wallet cache test (client leg)",
    },
  ];
}

const createdTxIds: number[] = [];
let testUserId: number;
let createdSuspenseAccountId: number | null = null;
let suspenseResolved = false;

async function resolveSuspenseAccount(handle: DbHandle = db) {
  if (!suspenseResolved) {
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
  await createTestWallet(testUserId);
});

afterAll(async () => {
  if (createdTxIds.length > 0) {
    await db
      .delete(ledgerEntries)
      .where(inArray(ledgerEntries.transactionId, createdTxIds));
    // Task #37 — drop the matching ledger_postings receipts so the FK from
    // ledger_postings.transaction_id doesn't block the transactions delete.
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
    // Safe only because every ledger entry we posted against this suspense
    // account belongs to a transactionId we deleted above. If a future test
    // posts surviving entries against this account, this delete will fail
    // loudly via the FK from ledger_entries.account_id — which is correct.
    await db.delete(accounts).where(eq(accounts.id, createdSuspenseAccountId));
  }
});

describe("refreshWalletCacheBalance — wallet cache stays in sync (Task #42)", () => {
  it("matches the cached balance to the ledger sum after a balanced post", async () => {
    const txId = await insertSettledTx(testUserId, DEPOSIT_AMOUNT);
    createdTxIds.push(txId);

    const clientAcct = await getOrCreateClientAccount(testUserId, TEST_CURRENCY);
    const suspenseAcct = await resolveSuspenseAccount();

    await postLedgerEntries(
      txId,
      balancedPair(
        DEPOSIT_AMOUNT,
        clientAcct.id,
        testUserId,
        suspenseAcct.id,
        suspenseAcct.userId,
      ),
    );

    const refreshed = await refreshWalletCacheBalance(
      db,
      testUserId,
      TEST_CURRENCY,
    );
    expect(refreshed).not.toBeNull();

    const ledgerSum = await getUserCurrencyBalance(testUserId, TEST_CURRENCY);
    expect(refreshed!.balance).toBe(ledgerSum);
    expect(Number(ledgerSum)).toBeCloseTo(Number(DEPOSIT_AMOUNT), 8);

    const [walletRow] = await db
      .select({
        balance: wallets.balance,
        availableBalance: wallets.availableBalance,
      })
      .from(wallets)
      .where(
        and(
          eq(wallets.userId, testUserId),
          eq(wallets.currency, TEST_CURRENCY),
        ),
      );

    expect(walletRow).toBeDefined();
    expect(Number(walletRow.balance)).toBeCloseTo(Number(ledgerSum), 8);
    expect(Number(walletRow.availableBalance)).toBeCloseTo(
      Number(ledgerSum),
      8,
    );
  });

  it("snaps a drifted cache back to the ledger sum (cache writer wins)", async () => {
    // Drift the cache directly — this is the kind of forbidden write the
    // refresh helper is supposed to defend against. The next refresh must
    // overwrite this value with the ledger-derived sum.
    await db
      .update(wallets)
      .set({
        balance: DRIFT_AMOUNT,
        availableBalance: DRIFT_AMOUNT,
      })
      .where(
        and(
          eq(wallets.userId, testUserId),
          eq(wallets.currency, TEST_CURRENCY),
        ),
      );

    const [drifted] = await db
      .select({ balance: wallets.balance })
      .from(wallets)
      .where(
        and(
          eq(wallets.userId, testUserId),
          eq(wallets.currency, TEST_CURRENCY),
        ),
      );
    expect(Number(drifted.balance)).toBeCloseTo(Number(DRIFT_AMOUNT), 8);

    const ledgerSumBefore = await getUserCurrencyBalance(
      testUserId,
      TEST_CURRENCY,
    );
    expect(Number(ledgerSumBefore)).not.toBeCloseTo(Number(DRIFT_AMOUNT), 8);

    const refreshed = await refreshWalletCacheBalance(
      db,
      testUserId,
      TEST_CURRENCY,
    );
    expect(refreshed).not.toBeNull();
    expect(refreshed!.balance).toBe(ledgerSumBefore);

    const [resynced] = await db
      .select({
        balance: wallets.balance,
        availableBalance: wallets.availableBalance,
      })
      .from(wallets)
      .where(
        and(
          eq(wallets.userId, testUserId),
          eq(wallets.currency, TEST_CURRENCY),
        ),
      );

    expect(Number(resynced.balance)).toBeCloseTo(Number(ledgerSumBefore), 8);
    expect(Number(resynced.availableBalance)).toBeCloseTo(
      Number(ledgerSumBefore),
      8,
    );
    // And critically, NOT the drifted value.
    expect(Number(resynced.balance)).not.toBeCloseTo(Number(DRIFT_AMOUNT), 8);
  });
});

// =============================================================================
// Task #50 — wallet cache refresh participates in the settlement transaction
// =============================================================================
// Task #42 above only exercises refreshWalletCacheBalance() against the global
// `db` handle. In production, every settlement caller (handleDeposit and
// handleWithdraw in server/routes.ts) runs the entire pattern inside a
// `db.transaction(async tx => { postLedgerEntries(..., tx);
// refreshWalletCacheBalance(tx, ...); })` block. The cache write MUST commit
// or roll back atomically with the ledger insert — if a refactor ever broke
// that atomicity, the wallet cache could survive a rolled-back ledger post (or
// vice versa) and silently desync the source of truth from its display copy.
//
// These cases pin that contract at the function-level seam:
//   1. A successful outer tx that posts a balanced pair via `tx` and refreshes
//      the cache via `tx` results in BOTH the ledger sum and the cached
//      wallet row reflecting the new amount after the outer commit.
//   2. An outer tx that does the same posting + refresh and then throws (so
//      the transaction rolls back) leaves NO surviving ledger entries for
//      that transactionId AND leaves the wallet cache untouched — proving
//      both sides participate in the same atomic boundary.
// =============================================================================

const IN_TX_AMOUNT = "125.00000000";
const ROLLBACK_AMOUNT = "777.00000000";

describe("refreshWalletCacheBalance — atomic with the settlement tx (Task #50)", () => {
  it("commits the cache update together with the ledger post inside an outer tx", async () => {
    const ledgerSumBefore = await getUserCurrencyBalance(
      testUserId,
      TEST_CURRENCY,
    );

    let committedTxId: number | null = null;

    await db.transaction(async (tx) => {
      // Insert the parent transaction row inside the outer tx, mirroring
      // handleDeposit in server/routes.ts. If the tx rolled back, this row
      // would vanish too — which is exactly the behaviour the second case
      // below relies on.
      const [txRow] = await tx
        .insert(transactions)
        .values({
          userId: testUserId,
          type: "deposit",
          fromCurrency: null,
          toCurrency: TEST_CURRENCY,
          amount: IN_TX_AMOUNT,
          fee: "0.00000000",
          exchangeRate: null,
          status: "completed",
          settlementStatus: "internal_only",
          description: "Task #50 in-tx commit case",
        })
        .returning({ id: transactions.id });
      committedTxId = txRow.id;

      const clientAcct = await getOrCreateClientAccount(
        testUserId,
        TEST_CURRENCY,
        tx,
      );
      const suspenseAcct = await resolveSuspenseAccount(tx);

      await postLedgerEntries(
        committedTxId,
        balancedPair(
          IN_TX_AMOUNT,
          clientAcct.id,
          testUserId,
          suspenseAcct.id,
          suspenseAcct.userId,
        ),
        tx,
      );

      const refreshed = await refreshWalletCacheBalance(
        tx,
        testUserId,
        TEST_CURRENCY,
      );
      expect(refreshed).not.toBeNull();
    });

    // The outer tx has now committed. Track for cleanup.
    expect(committedTxId).not.toBeNull();
    createdTxIds.push(committedTxId!);

    const ledgerSumAfter = await getUserCurrencyBalance(
      testUserId,
      TEST_CURRENCY,
    );
    expect(Number(ledgerSumAfter)).toBeCloseTo(
      Number(ledgerSumBefore) + Number(IN_TX_AMOUNT),
      8,
    );

    const [walletRow] = await db
      .select({
        balance: wallets.balance,
        availableBalance: wallets.availableBalance,
      })
      .from(wallets)
      .where(
        and(
          eq(wallets.userId, testUserId),
          eq(wallets.currency, TEST_CURRENCY),
        ),
      );
    expect(walletRow).toBeDefined();
    expect(Number(walletRow.balance)).toBeCloseTo(Number(ledgerSumAfter), 8);
    expect(Number(walletRow.availableBalance)).toBeCloseTo(
      Number(ledgerSumAfter),
      8,
    );

    // And the ledger entries for this txId really exist.
    const postedEntries = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, committedTxId!));
    expect(postedEntries.length).toBe(2);
  });

  it("rolls back both the ledger post and the cache refresh when the outer tx aborts", async () => {
    const ledgerSumBefore = await getUserCurrencyBalance(
      testUserId,
      TEST_CURRENCY,
    );
    const [walletBefore] = await db
      .select({
        balance: wallets.balance,
        availableBalance: wallets.availableBalance,
      })
      .from(wallets)
      .where(
        and(
          eq(wallets.userId, testUserId),
          eq(wallets.currency, TEST_CURRENCY),
        ),
      );
    expect(walletBefore).toBeDefined();

    let attemptedTxId: number | null = null;

    await expect(
      db.transaction(async (tx) => {
        const [txRow] = await tx
          .insert(transactions)
          .values({
            userId: testUserId,
            type: "deposit",
            fromCurrency: null,
            toCurrency: TEST_CURRENCY,
            amount: ROLLBACK_AMOUNT,
            fee: "0.00000000",
            exchangeRate: null,
            status: "completed",
            settlementStatus: "internal_only",
            description: "Task #50 in-tx rollback case",
          })
          .returning({ id: transactions.id });
        attemptedTxId = txRow.id;

        const clientAcct = await getOrCreateClientAccount(
          testUserId,
          TEST_CURRENCY,
          tx,
        );
        const suspenseAcct = await resolveSuspenseAccount(tx);

        await postLedgerEntries(
          attemptedTxId,
          balancedPair(
            ROLLBACK_AMOUNT,
            clientAcct.id,
            testUserId,
            suspenseAcct.id,
            suspenseAcct.userId,
          ),
          tx,
        );

        const refreshed = await refreshWalletCacheBalance(
          tx,
          testUserId,
          TEST_CURRENCY,
        );
        // Inside the tx, the cache row WOULD reflect the new sum — but we
        // are about to throw, so this in-flight write must be rolled back
        // by Postgres along with the ledger insert above.
        expect(refreshed).not.toBeNull();
        expect(Number(refreshed!.balance)).toBeCloseTo(
          Number(ledgerSumBefore) + Number(ROLLBACK_AMOUNT),
          8,
        );

        throw new Error("force rollback for Task #50 atomicity test");
      }),
    ).rejects.toThrow("force rollback for Task #50 atomicity test");

    expect(attemptedTxId).not.toBeNull();

    // The transactions row inserted inside the rolled-back tx must be gone.
    const txSurvivors = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.id, attemptedTxId!));
    expect(txSurvivors.length).toBe(0);

    // No ledger entries should survive for the aborted txId.
    const ledgerSurvivors = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, attemptedTxId!));
    expect(ledgerSurvivors.length).toBe(0);

    // The user's ledger sum must be exactly what it was before the aborted
    // tx — no partial double-entry leaked through.
    const ledgerSumAfter = await getUserCurrencyBalance(
      testUserId,
      TEST_CURRENCY,
    );
    expect(ledgerSumAfter).toBe(ledgerSumBefore);

    // And critically, the wallet cache row was NOT moved by the in-tx
    // refreshWalletCacheBalance() call — proving the cache write
    // participates in the same atomic boundary as the ledger insert.
    const [walletAfter] = await db
      .select({
        balance: wallets.balance,
        availableBalance: wallets.availableBalance,
      })
      .from(wallets)
      .where(
        and(
          eq(wallets.userId, testUserId),
          eq(wallets.currency, TEST_CURRENCY),
        ),
      );
    expect(walletAfter).toBeDefined();
    expect(walletAfter.balance).toBe(walletBefore.balance);
    expect(walletAfter.availableBalance).toBe(walletBefore.availableBalance);
  });
});
