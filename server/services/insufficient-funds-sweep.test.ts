// =============================================================================
// Task #64 — automated tests for the insufficient-funds sweep cron
// =============================================================================
// Locks in the behaviour of runInsufficientFundsSweep():
//
//   1. A deduction parked in `insufficient_funds` whose client has since
//      topped up settles cleanly on the next sweep — the row flips to
//      `settled`, lastRecheckedAt is bumped, and an audit log row is
//      written under `fee_deduction.auto_resettled`.
//
//   2. A deduction that is still short triggers a client notification on
//      the first visit (clientNotifiedAt populated, count = 1) and an
//      audit log row under `fee_deduction.client_notified`. A second
//      sweep within the debounce window does NOT re-notify (count stays
//      at 1) but still bumps lastRecheckedAt.
//
//   3. Reversed rows are never re-attempted by the sweep, even if their
//      status row reads `insufficient_funds`.
//
// Hard rules:
//   - All fixtures live under deterministic test usernames so the suite is
//     idempotent: each run wipes its own rows in beforeAll, and afterAll
//     deletes the test users entirely.
//   - The sweep is invoked with an injected `now` and a tiny renotify
//     interval so the debounce path is deterministic without time travel.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  accounts,
  adviserFeeDeductions,
  auditLogs,
  ledgerEntries,
  ledgerPostings,
  transactions,
  users,
  wallets,
} from "@shared/schema";
import {
  getOrCreateClientAccount,
  getOrCreateSuspenseAccount,
  postLedgerEntries,
  refreshWalletCacheBalance,
} from "./ledger";
import { runInsufficientFundsSweep } from "./insufficient-funds-sweep";

const CLIENT_USERNAME = "__sweep_test_client__";
const ADVISER_USERNAME = "__sweep_test_adviser__";
const TEST_CURRENCY = "AUD";

let clientUserId: number;
let adviserUserId: number;

async function ensureUser(username: string, email: string): Promise<number> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.username, username));
  if (existing) {
    // Reset email/firstName so the notification path has stable inputs even
    // if a prior run mutated the row.
    await db
      .update(users)
      .set({ email, firstName: "Sweep", lastName: "Test" })
      .where(eq(users.id, existing.id));
    return existing.id;
  }
  const [created] = await db
    .insert(users)
    .values({
      username,
      email,
      password: "not-a-real-password",
      firstName: "Sweep",
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
  await db.execute(sql`
    DELETE FROM ledger_entries
    WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = ${userId})
  `);
  await db.execute(sql`
    DELETE FROM ledger_entries
    WHERE account_id IN (SELECT id FROM accounts WHERE user_id = ${userId})
  `);
  // Deductions reference transactions via settled_transaction_id /
  // reversal_transaction_id, so they must be removed before the underlying
  // transactions row can be deleted (the FK has no ON DELETE SET NULL).
  await db
    .delete(adviserFeeDeductions)
    .where(eq(adviserFeeDeductions.clientUserId, userId));
  await db
    .delete(adviserFeeDeductions)
    .where(eq(adviserFeeDeductions.adviserUserId, userId));
  // ledger_postings only exists in some deployments (Task #37 receipt table);
  // drop receipts when the table is present, ignore otherwise.
  try {
    await db.execute(sql`
      DELETE FROM ledger_postings
      WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = ${userId})
    `);
  } catch {
    // Table missing — safe to skip.
  }
  await db.delete(transactions).where(eq(transactions.userId, userId));
  // Note (Task #149): audit_logs is now immutable at the DB level — every
  // UPDATE/DELETE is rejected by a trigger. We deliberately leave the audit
  // rows from prior test runs in place; the assertions below scope by the
  // freshly-generated `deductionId` (which is unique per test run), so
  // residual rows from earlier runs do not interfere with this test.
  await db.delete(wallets).where(eq(wallets.userId, userId));
  await db.delete(accounts).where(eq(accounts.userId, userId));
}

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
        description: "sweep test top-up",
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
          description: "sweep test top-up (suspense debit)",
        },
        {
          accountId: clientAccount.id,
          userId,
          currency: TEST_CURRENCY,
          direction: "credit",
          amount,
          description: "sweep test top-up (client credit)",
        },
      ],
      tx,
    );

    await refreshWalletCacheBalance(tx, userId, TEST_CURRENCY);
  });
}

async function insertInsufficientDeduction(opts: {
  totalAccrued: string;
  adviserShare: string;
}): Promise<number> {
  const start = new Date(Date.UTC(2026, 2, 1));
  const end = new Date(Date.UTC(2026, 3, 1));
  const platformShare = (
    Number(opts.totalAccrued) - Number(opts.adviserShare)
  ).toFixed(4);
  const [row] = await db
    .insert(adviserFeeDeductions)
    .values({
      clientUserId,
      adviserUserId,
      periodStart: start,
      periodEnd: end,
      totalAccrued: opts.totalAccrued,
      adviserShareAmount: opts.adviserShare,
      platformShareAmount: platformShare,
      currency: TEST_CURRENCY,
      accrualIds: [] as any,
      // Pre-mark as insufficient_funds with a synthetic failureReason so the
      // sweep treats it as a candidate. (Normally the fee engine puts a row
      // here after a settle attempt fails — we skip that round-trip.)
      status: "insufficient_funds",
      failureReason: "synthetic — set by sweep test fixture",
    })
    .returning();
  return row.id;
}

beforeAll(async () => {
  if (!process.env.PLATFORM_USER_ID) {
    // Mirror the fee insufficient-funds script: synthesise a platform user
    // so the suspense-account helper can resolve its owner.
    const [platform] = await db
      .insert(users)
      .values({
        username: "__sweep_test_platform__",
        email: "sweep-platform@test.invalid",
        password: "not-a-real-password",
        firstName: "Sweep",
        lastName: "Platform",
        kycStatus: "verified",
        emailVerified: true,
      })
      .onConflictDoNothing()
      .returning();
    if (platform) {
      process.env.PLATFORM_USER_ID = String(platform.id);
    } else {
      const [existing] = await db
        .select()
        .from(users)
        .where(eq(users.username, "__sweep_test_platform__"));
      if (!existing) {
        throw new Error(
          "Could not synthesise __sweep_test_platform__ user for the sweep test.",
        );
      }
      process.env.PLATFORM_USER_ID = String(existing.id);
    }
  }

  clientUserId = await ensureUser(
    CLIENT_USERNAME,
    "sweep-client@test.invalid",
  );
  adviserUserId = await ensureUser(
    ADVISER_USERNAME,
    "sweep-adviser@test.invalid",
  );

  await cleanupForUser(clientUserId);
  await cleanupForUser(adviserUserId);
  await ensureFreshTestWallet(clientUserId);
  await ensureFreshTestWallet(adviserUserId);
});

afterAll(async () => {
  await cleanupForUser(clientUserId);
  await cleanupForUser(adviserUserId);
  await db.delete(users).where(eq(users.id, clientUserId));
  await db.delete(users).where(eq(users.id, adviserUserId));
});

describe("runInsufficientFundsSweep — Task #64", () => {
  it("retries and settles a deduction once the client has topped up", async () => {
    // Wallet starts at zero — fee engine returns InsufficientFundsError on
    // the initial pass. Top up generously so settle succeeds.
    await topUpClient(clientUserId, "500.00");
    const deductionId = await insertInsufficientDeduction({
      totalAccrued: "120.0000",
      adviserShare: "84.0000",
    });

    const summary = await runInsufficientFundsSweep({
      now: new Date(),
      renotifyIntervalMs: 1000,
    });

    expect(summary.checked).toBeGreaterThanOrEqual(1);
    expect(summary.settled).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select()
      .from(adviserFeeDeductions)
      .where(eq(adviserFeeDeductions.id, deductionId));
    expect(row.status).toBe("settled");
    expect(row.settledTransactionId).not.toBeNull();
    expect(row.failureReason).toBeNull();
    expect(row.lastRecheckedAt).not.toBeNull();

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "adviser_fee_deduction"),
          eq(auditLogs.entityId, String(deductionId)),
          eq(auditLogs.action, "fee_deduction.auto_resettled"),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(audit).toBeDefined();

    // Cleanup so the next test starts from a deterministic state.
    await cleanupForUser(clientUserId);
    await cleanupForUser(adviserUserId);
    await ensureFreshTestWallet(clientUserId);
    await ensureFreshTestWallet(adviserUserId);
  });

  it("notifies the client once and debounces a second sweep within the window", async () => {
    // Wallet stays at zero — sweep should still find it insufficient.
    const deductionId = await insertInsufficientDeduction({
      totalAccrued: "200.0000",
      adviserShare: "140.0000",
    });

    const t0 = new Date("2026-04-01T00:00:00Z");
    const summary1 = await runInsufficientFundsSweep({
      now: t0,
      renotifyIntervalMs: 7 * 24 * 60 * 60 * 1000,
    });

    expect(summary1.stillInsufficient).toBeGreaterThanOrEqual(1);
    // No real SMTP in tests — dispatch reports `sent: false` and the sweep
    // counts it under notificationsFailed. We don't care which bucket; we
    // only care that the row's tracking columns + audit log were updated
    // exactly the same way they would be in production.
    expect(
      summary1.notificationsSent + summary1.notificationsFailed,
    ).toBeGreaterThanOrEqual(1);

    const [afterFirst] = await db
      .select()
      .from(adviserFeeDeductions)
      .where(eq(adviserFeeDeductions.id, deductionId));
    expect(afterFirst.status).toBe("insufficient_funds");
    expect(afterFirst.clientNotifiedAt).not.toBeNull();
    expect(afterFirst.clientNotificationCount).toBe(1);
    expect(afterFirst.lastRecheckedAt?.toISOString()).toBe(t0.toISOString());

    const auditAfterFirst = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "adviser_fee_deduction"),
          eq(auditLogs.entityId, String(deductionId)),
          inArray(auditLogs.action, [
            "fee_deduction.client_notified",
            "fee_deduction.client_notification_failed",
          ]),
        ),
      );
    expect(auditAfterFirst.length).toBe(1);

    // Second sweep within the debounce window — must NOT re-notify, but
    // must still bump lastRecheckedAt.
    const t1 = new Date(t0.getTime() + 60 * 60 * 1000); // +1h
    const summary2 = await runInsufficientFundsSweep({
      now: t1,
      renotifyIntervalMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(summary2.notificationsSkippedDueToDebounce).toBeGreaterThanOrEqual(
      1,
    );

    const [afterSecond] = await db
      .select()
      .from(adviserFeeDeductions)
      .where(eq(adviserFeeDeductions.id, deductionId));
    expect(afterSecond.clientNotificationCount).toBe(1);
    expect(afterSecond.clientNotifiedAt?.toISOString()).toBe(
      afterFirst.clientNotifiedAt!.toISOString(),
    );
    expect(afterSecond.lastRecheckedAt?.toISOString()).toBe(t1.toISOString());

    const auditAfterSecond = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "adviser_fee_deduction"),
          eq(auditLogs.entityId, String(deductionId)),
          inArray(auditLogs.action, [
            "fee_deduction.client_notified",
            "fee_deduction.client_notification_failed",
          ]),
        ),
      );
    expect(auditAfterSecond.length).toBe(1);
  });

  it("ignores reversed deductions even if status is insufficient_funds", async () => {
    // Hard to construct a real reversal end-to-end here — instead we insert
    // a row pre-marked reversed and confirm the sweep skips it entirely.
    // This guards against a future SQL change accidentally including
    // reversed rows in the candidate set.
    const start = new Date(Date.UTC(2026, 4, 1));
    const end = new Date(Date.UTC(2026, 5, 1));
    const [row] = await db
      .insert(adviserFeeDeductions)
      .values({
        clientUserId,
        adviserUserId,
        periodStart: start,
        periodEnd: end,
        totalAccrued: "300.0000",
        adviserShareAmount: "210.0000",
        platformShareAmount: "90.0000",
        currency: TEST_CURRENCY,
        accrualIds: [] as any,
        status: "insufficient_funds",
        failureReason: "synthetic reversed-row test fixture",
        reversedAt: new Date(),
        reversedReason: "synthetic — already refunded",
      })
      .returning();

    const beforeChecked = (
      await runInsufficientFundsSweep({
        now: new Date(),
        renotifyIntervalMs: 7 * 24 * 60 * 60 * 1000,
      })
    ).checked;

    const [stillReversed] = await db
      .select()
      .from(adviserFeeDeductions)
      .where(eq(adviserFeeDeductions.id, row.id));

    // The row should NOT have been touched by the sweep — lastRecheckedAt
    // must remain NULL because no candidate scan ever included it.
    expect(stillReversed.lastRecheckedAt).toBeNull();
    expect(stillReversed.clientNotificationCount).toBe(0);
    // Sanity: the sweep should still have run end-to-end (other rows may
    // have been processed by the prior tests' cleanup, so we just confirm
    // it didn't throw).
    expect(beforeChecked).toBeGreaterThanOrEqual(0);
  });
});
