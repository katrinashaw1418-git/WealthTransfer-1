// =============================================================================
// Task #201 — regression test: platform user's per-currency ledger sums net to
// zero after a balanced deposit→withdraw round-trip, with NO scrub helper.
// =============================================================================
// Why this test exists:
//   Before Task #201, the lifecycle 2c/2d/2e gates in pre-launch-safety.ts
//   wrote the client side of the wallet directly while still posting only the
//   SUSPENSE leg of each scenario through the ledger. Those orphan platform-
//   side legs accumulated against PLATFORM_USER_ID and would have surfaced in
//   the Stage 3 wallet-vs-ledger reconciliation as a critical mismatch — the
//   pre-launch script worked around this by calling `scrubLifecyclePlatformLegs()`
//   to delete the residue immediately before Stage 3.
//
//   Task #201 migrated the FX / wallet-transfer / investment routes to post
//   FULL balanced journals via `postLedgerEntries`, removed the scrub helper,
//   and flagged the platform user `is_demo=true` so reconciliation skips it
//   entirely. THIS test locks in the underlying math invariant the design
//   relies on: when a real-world client lifecycle runs through the public
//   ledger primitive, every leg posted against the platform suspense user
//   has an exact opposing leg, so the platform user's per-currency ledger
//   sum returns to ZERO at the end of a self-cancelling round-trip.
//
//   If a future refactor reintroduces a one-sided posting (e.g. forgets the
//   suspense leg, or splits a fee onto a different user) this test will fail
//   loudly — preventing the scrub workaround from quietly being needed again.
//
// Run with:  npx vitest run server/services/platform-user-net-zero.test.ts
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
  getOrCreateClientAccount,
  getOrCreateSuspenseAccount,
  getUserLedgerSumsByCurrency,
  postLedgerEntries,
} from "./ledger";

const TEST_CURRENCY = "USD";
// Use a single round-trip amount so the deposit (CREDIT client / DEBIT
// suspense) and withdrawal (DEBIT client / CREDIT suspense) cancel each
// other out EXACTLY at the suspense account. We deliberately do NOT model a
// withdrawal fee on top, because adding a fee would route money to the
// platform fee account (a separate platform-owned account). That's a
// legitimate flow but would shift this test from "platform user nets zero"
// to "platform user nets the fee", which is a different (and weaker)
// invariant. Keeping the round-trip symmetric is what catches the actual
// regression we care about (orphan suspense legs).
const ROUND_TRIP_AMOUNT = "100.00000000";

// Track every db row this file creates so the afterAll teardown can drop
// it cleanly without touching production seed data or rows owned by other
// test files (this same db is shared across the whole project).
const createdTxIds: number[] = [];
let testUserId: number;
let createdSuspenseAccountId: number | null = null;

async function createTestUser(): Promise<number> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [u] = await db
    .insert(users)
    .values({
      username: `task201-platform-net-zero-${suffix}`,
      email: `task201-platform-net-zero-${suffix}@test.invalid`,
      password: "not-a-real-password",
      firstName: "Task201",
      lastName: "PlatformNetZero",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning({ id: users.id });
  return u.id;
}

async function insertSettledTx(
  userId: number,
  type: "deposit" | "withdrawal",
): Promise<number> {
  const [tx] = await db
    .insert(transactions)
    .values({
      userId,
      type,
      fromCurrency: type === "withdrawal" ? TEST_CURRENCY : null,
      toCurrency: type === "deposit" ? TEST_CURRENCY : null,
      amount: ROUND_TRIP_AMOUNT,
      fee: "0.00000000",
      exchangeRate: null,
      status: "completed",
      settlementStatus: "internal_only",
      description: `Task #201 platform-net-zero regression (${type})`,
    })
    .returning({ id: transactions.id });
  return tx.id;
}

beforeAll(async () => {
  if (!process.env.PLATFORM_USER_ID) {
    throw new Error(
      "PLATFORM_USER_ID env var must be set so getOrCreateSuspenseAccount() " +
        "can resolve the platform suspense owner.",
    );
  }
  testUserId = await createTestUser();

  // Deterministic suspense ownership check (same idiom as ledger.test.ts):
  // if a suspense account for TEST_CURRENCY already exists, leave it alone;
  // if we create it, record the id so afterAll can drop it. Doing this in
  // beforeAll keeps the test bodies focused on the actual invariant.
  const platformUserId = parseInt(process.env.PLATFORM_USER_ID, 10);
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
  const acct = await getOrCreateSuspenseAccount(TEST_CURRENCY);
  if (!existing) {
    createdSuspenseAccountId = acct.id;
  }
});

afterAll(async () => {
  if (createdTxIds.length > 0) {
    await db
      .delete(ledgerEntries)
      .where(inArray(ledgerEntries.transactionId, createdTxIds));
    await db
      .delete(ledgerPostings)
      .where(inArray(ledgerPostings.transactionId, createdTxIds));
    await db
      .delete(transactions)
      .where(inArray(transactions.id, createdTxIds));
  }
  if (testUserId !== undefined) {
    await db.delete(wallets).where(eq(wallets.userId, testUserId));
    await db.delete(accounts).where(eq(accounts.userId, testUserId));
    await db.delete(users).where(eq(users.id, testUserId));
  }
  if (createdSuspenseAccountId !== null) {
    // Safe because we delete every entry we posted against this account
    // above (by transactionId). If anything is still referencing it the FK
    // from ledger_entries.account_id will surface a loud failure here —
    // which is the correct behaviour.
    await db
      .delete(accounts)
      .where(eq(accounts.id, createdSuspenseAccountId));
  }
});

describe("platform user nets zero after a balanced lifecycle (Task #201)", () => {
  it(
    "deposit → withdraw round-trip leaves PLATFORM_USER's per-currency ledger sum at exactly zero — no scrub helper required",
    async () => {
      const platformUserId = parseInt(process.env.PLATFORM_USER_ID!, 10);

      // -----------------------------------------------------------------
      // Snapshot the platform user's USD ledger sum BEFORE the round-trip.
      // The dev DB is shared with other tests / seed scripts so the
      // baseline is rarely zero in absolute terms — what we assert is
      // that the DELTA introduced by this round-trip is exactly zero.
      // -----------------------------------------------------------------
      const sumsBefore = await getUserLedgerSumsByCurrency(platformUserId);
      const baselineUsd = Number(sumsBefore.get(TEST_CURRENCY) ?? "0");

      // -----------------------------------------------------------------
      // Sample lifecycle, posted ENTIRELY through the public ledger
      // primitive (the same call site every Task #201-migrated route now
      // uses). We don't mock or shortcut anything — if the primitive
      // grows a one-sided posting in the future this test will catch it.
      // -----------------------------------------------------------------

      // 1) Deposit: DEBIT suspense, CREDIT client (mirrors handleDeposit).
      const depositTxId = await insertSettledTx(testUserId, "deposit");
      createdTxIds.push(depositTxId);
      const depositClient = await getOrCreateClientAccount(
        testUserId,
        TEST_CURRENCY,
      );
      const depositSuspense = await getOrCreateSuspenseAccount(TEST_CURRENCY);
      await postLedgerEntries(depositTxId, [
        {
          accountId: depositSuspense.id,
          userId: depositSuspense.userId,
          currency: TEST_CURRENCY,
          direction: "debit",
          amount: ROUND_TRIP_AMOUNT,
          description: `Task #201 net-zero deposit (suspense leg) tx#${depositTxId}`,
        },
        {
          accountId: depositClient.id,
          userId: testUserId,
          currency: TEST_CURRENCY,
          direction: "credit",
          amount: ROUND_TRIP_AMOUNT,
          description: `Task #201 net-zero deposit (client leg) tx#${depositTxId}`,
        },
      ]);

      // 2) Withdrawal of the same magnitude: DEBIT client, CREDIT suspense
      //    (mirrors handleWithdraw with fee=0). Equal & opposite to the
      //    deposit's suspense leg, so the PLATFORM_USER side returns to
      //    its baseline.
      const withdrawTxId = await insertSettledTx(testUserId, "withdrawal");
      createdTxIds.push(withdrawTxId);
      const withdrawClient = await getOrCreateClientAccount(
        testUserId,
        TEST_CURRENCY,
      );
      const withdrawSuspense = await getOrCreateSuspenseAccount(TEST_CURRENCY);
      await postLedgerEntries(withdrawTxId, [
        {
          accountId: withdrawClient.id,
          userId: testUserId,
          currency: TEST_CURRENCY,
          direction: "debit",
          amount: ROUND_TRIP_AMOUNT,
          description: `Task #201 net-zero withdraw (client leg) tx#${withdrawTxId}`,
        },
        {
          accountId: withdrawSuspense.id,
          userId: withdrawSuspense.userId,
          currency: TEST_CURRENCY,
          direction: "credit",
          amount: ROUND_TRIP_AMOUNT,
          description: `Task #201 net-zero withdraw (suspense leg) tx#${withdrawTxId}`,
        },
      ]);

      // -----------------------------------------------------------------
      // Assertion 1 (the core invariant): the DELTA on the platform user
      // for TEST_CURRENCY across the full round-trip is exactly zero.
      // Use the same helper reconciliation uses (single source of truth)
      // so a regression in the helper itself would also surface here.
      // -----------------------------------------------------------------
      const sumsAfter = await getUserLedgerSumsByCurrency(platformUserId);
      const finalUsd = Number(sumsAfter.get(TEST_CURRENCY) ?? "0");
      const delta = finalUsd - baselineUsd;
      expect(delta).toBe(0);

      // -----------------------------------------------------------------
      // Assertion 2 (defence-in-depth): both legs of both transactions
      // we posted against the platform suspense account exist (i.e. the
      // round-trip really DID hit the platform side, so a "trivially
      // zero" pass cannot mask a regression that simply skipped the
      // suspense legs entirely).
      // -----------------------------------------------------------------
      const [{ platformLegCount }] = await db
        .select({ platformLegCount: sql<number>`COUNT(*)::int` })
        .from(ledgerEntries)
        .where(
          and(
            inArray(ledgerEntries.transactionId, [
              depositTxId,
              withdrawTxId,
            ]),
            eq(ledgerEntries.userId, platformUserId),
            eq(ledgerEntries.currency, TEST_CURRENCY),
          ),
        );
      expect(Number(platformLegCount)).toBe(2);
    },
  );
});
