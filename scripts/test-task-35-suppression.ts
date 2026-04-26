// =============================================================================
// SMOKE TEST — Task #35 (drift acknowledgement suppression)
// =============================================================================
// Verifies, end-to-end, the contract laid out in the task:
//   1. A baseline reconciliation run on a drifted (user, currency) pair fires
//      ONE operator notification.
//   2. After the admin acknowledges the drift, the next run fires ZERO new
//      notifications and reports operatorNotificationsSuppressed = 1.
//   3. The reconciliation row is still written every run (audit trail intact).
//   4. If the drift moves by more than MATCH_EPSILON since the snapshot, the
//      next run fires ONE notification again.
//   5. Clearing the acknowledgement re-enables paging on the next run.
//   6. Acknowledging when there is no drift returns the no-mismatch error.
//   7. A second acknowledge attempt while one is open returns conflict.
// =============================================================================

import { db } from "../server/db";
import {
  users,
  wallets,
  ledgerEntries,
  transactions,
  accounts,
  walletLedgerReconciliations,
  walletLedgerDriftAcknowledgements,
} from "../shared/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  runWalletLedgerReconciliation,
  acknowledgeWalletLedgerDrift,
  clearWalletLedgerDriftAcknowledgement,
  DriftAckConflictError,
  DriftAckNoMismatchError,
  MATCH_EPSILON,
} from "../server/services/reconciliation";

const TEST_USERNAME = "__task35_test_user__";
const TEST_CURRENCY = "AUD";

function assert(cond: any, msg: string) {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

async function setupUser(): Promise<number> {
  // Idempotent setup — wipe any prior state for this user so the test is
  // re-runnable.
  let [u] = await db.select().from(users).where(eq(users.username, TEST_USERNAME));
  if (!u) {
    [u] = await db
      .insert(users)
      .values({
        username: TEST_USERNAME,
        password: "x",
        email: `${TEST_USERNAME}@test.local`,
        firstName: "Task35",
        lastName: "Test",
        role: "client",
      })
      .returning();
  }
  // Wipe per-user state.
  await db
    .delete(walletLedgerDriftAcknowledgements)
    .where(eq(walletLedgerDriftAcknowledgements.userId, u.id));
  await db
    .delete(walletLedgerReconciliations)
    .where(eq(walletLedgerReconciliations.userId, u.id));
  await db.delete(ledgerEntries).where(eq(ledgerEntries.userId, u.id));
  await db.delete(wallets).where(eq(wallets.userId, u.id));
  return u.id;
}

async function setWalletAndLedger(userId: number, walletBal: string, ledgerBal: string) {
  // Ensure ONE wallet row at the given balance.
  const existing = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.currency, TEST_CURRENCY)));
  if (existing.length === 0) {
    await db.insert(wallets).values({
      userId,
      currency: TEST_CURRENCY,
      walletType: "fiat",
      balance: walletBal,
      availableBalance: walletBal,
    });
  } else {
    await db
      .update(wallets)
      .set({ balance: walletBal, availableBalance: walletBal })
      .where(and(eq(wallets.userId, userId), eq(wallets.currency, TEST_CURRENCY)));
  }
  // Replace ledger entries with a single credit equal to ledgerBal.
  await db.delete(ledgerEntries).where(eq(ledgerEntries.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  if (Number(ledgerBal) !== 0) {
    // Make sure the user has a client-account row in this currency.
    let [acct] = await db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.currency, TEST_CURRENCY),
          eq(accounts.accountType, "client"),
        ),
      );
    if (!acct) {
      [acct] = await db
        .insert(accounts)
        .values({ userId, currency: TEST_CURRENCY, accountType: "client" })
        .returning();
    }
    const [tx] = await db
      .insert(transactions)
      .values({
        userId,
        type: "deposit",
        amount: ledgerBal,
        fee: "0",
        status: "completed",
        description: "task35-test-seed",
      })
      .returning();
    await db.insert(ledgerEntries).values({
      transactionId: tx.id,
      accountId: acct.id,
      userId,
      currency: TEST_CURRENCY,
      direction: "credit",
      amount: ledgerBal,
      counterAccount: "external:test",
      reasonCode: "test_seed",
    });
  }
}

async function countNotificationsForPair(userId: number) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(walletLedgerReconciliations)
    .where(
      and(
        eq(walletLedgerReconciliations.userId, userId),
        eq(walletLedgerReconciliations.currency, TEST_CURRENCY),
      ),
    );
  return Number(row?.count ?? 0);
}

async function main() {
  console.log(`MATCH_EPSILON = ${MATCH_EPSILON}`);
  const userId = await setupUser();
  console.log(`Test user id: ${userId}`);

  // -------------------------------------------------------------------------
  // 1. Baseline drifted run — one notification, one row written.
  // -------------------------------------------------------------------------
  await setWalletAndLedger(userId, "1050.00000000", "1000.00000000"); // drift = +50
  const summary1 = await runWalletLedgerReconciliation();
  console.log("[run1 summary]", summary1);
  assert(summary1.operatorNotifications >= 1, "run1 dispatched at least one operator notification");
  assert(summary1.operatorNotificationsSuppressed === 0, "run1 suppressed zero notifications");
  const recCount1 = await countNotificationsForPair(userId);
  assert(recCount1 === 1, "run1 wrote exactly one reconciliation row for the test pair");

  // -------------------------------------------------------------------------
  // 2. Acknowledge the drift, then re-run — zero new notifications, one suppressed.
  // -------------------------------------------------------------------------
  const ack = await acknowledgeWalletLedgerDrift({
    userId,
    currency: TEST_CURRENCY,
    note: "Investigating ticket FOO-123",
    actorUserId: userId, // self-ack is fine for the test
  });
  assert(ack.id > 0, "acknowledge inserted a row");
  assert(
    Math.abs(Number(ack.acknowledgedDriftAmount) - 50) < 1e-6,
    `ack snapshot drift ≈ 50 (got ${ack.acknowledgedDriftAmount})`,
  );

  const summary2 = await runWalletLedgerReconciliation();
  console.log("[run2 summary]", summary2);
  assert(
    summary2.operatorNotificationsSuppressed >= 1,
    "run2 suppressed at least one notification (acknowledged)",
  );
  // The pair should have contributed zero new notifications (other unrelated
  // pairs in the DB may still page; we only assert the SUPPRESSED counter
  // moved upward and that the recon row written for OUR pair carries the
  // suppression note).
  const recCount2 = await countNotificationsForPair(userId);
  assert(recCount2 === 2, "run2 wrote a second reconciliation row (audit trail intact)");

  const [latestRow2] = await db
    .select()
    .from(walletLedgerReconciliations)
    .where(
      and(
        eq(walletLedgerReconciliations.userId, userId),
        eq(walletLedgerReconciliations.currency, TEST_CURRENCY),
      ),
    )
    .orderBy(sql`created_at DESC, id DESC`)
    .limit(1);
  assert(
    !!latestRow2.notes && latestRow2.notes.includes("suppressed"),
    `latest recon row notes mention suppression (got: ${latestRow2.notes})`,
  );

  // -------------------------------------------------------------------------
  // 3. Drift moves materially — next run pages again.
  // -------------------------------------------------------------------------
  await setWalletAndLedger(userId, "1100.50000000", "1000.00000000"); // drift = +100.5 (moved by 50.5)
  const summary3 = await runWalletLedgerReconciliation();
  console.log("[run3 summary]", summary3);
  assert(
    summary3.operatorNotifications >= 1,
    "run3 re-paged because drift moved beyond MATCH_EPSILON",
  );
  const [latestRow3] = await db
    .select()
    .from(walletLedgerReconciliations)
    .where(
      and(
        eq(walletLedgerReconciliations.userId, userId),
        eq(walletLedgerReconciliations.currency, TEST_CURRENCY),
      ),
    )
    .orderBy(sql`created_at DESC, id DESC`)
    .limit(1);
  assert(
    !!latestRow3.notes && latestRow3.notes.toLowerCase().includes("re-paging"),
    `latest recon row notes mention re-paging (got: ${latestRow3.notes})`,
  );

  // -------------------------------------------------------------------------
  // 4. Drift moves only within MATCH_EPSILON — still suppressed.
  // -------------------------------------------------------------------------
  // Reset to original drift +50 and re-ack.
  await setWalletAndLedger(userId, "1050.00000000", "1000.00000000");
  await clearWalletLedgerDriftAcknowledgement({
    userId,
    currency: TEST_CURRENCY,
    actorUserId: userId,
    reason: "reset for sub-epsilon test",
  });
  await acknowledgeWalletLedgerDrift({
    userId,
    currency: TEST_CURRENCY,
    note: "re-ack at +50",
    actorUserId: userId,
  });
  // Move drift by 0.005 (well below MATCH_EPSILON = 0.01).
  await setWalletAndLedger(userId, "1050.00500000", "1000.00000000");
  const summary4 = await runWalletLedgerReconciliation();
  console.log("[run4 summary]", summary4);
  assert(
    summary4.operatorNotificationsSuppressed >= 1,
    "run4 suppressed (drift moved by < MATCH_EPSILON)",
  );

  // -------------------------------------------------------------------------
  // 5. Clear acknowledgement → next run pages again.
  // -------------------------------------------------------------------------
  await clearWalletLedgerDriftAcknowledgement({
    userId,
    currency: TEST_CURRENCY,
    actorUserId: userId,
    reason: "investigation complete",
  });
  const summary5 = await runWalletLedgerReconciliation();
  console.log("[run5 summary]", summary5);
  assert(summary5.operatorNotifications >= 1, "run5 re-paged after acknowledgement was cleared");

  // -------------------------------------------------------------------------
  // 6. Acknowledge with no drift → DriftAckNoMismatchError
  // -------------------------------------------------------------------------
  await setWalletAndLedger(userId, "1000.00000000", "1000.00000000"); // no drift
  let caught6 = false;
  try {
    await acknowledgeWalletLedgerDrift({
      userId,
      currency: TEST_CURRENCY,
      note: "should fail",
      actorUserId: userId,
    });
  } catch (e) {
    caught6 = e instanceof DriftAckNoMismatchError;
  }
  assert(caught6, "acknowledge with no drift threw DriftAckNoMismatchError");

  // -------------------------------------------------------------------------
  // 7. Conflict — second active ack rejected.
  // -------------------------------------------------------------------------
  await setWalletAndLedger(userId, "1050.00000000", "1000.00000000");
  await acknowledgeWalletLedgerDrift({
    userId,
    currency: TEST_CURRENCY,
    note: "first",
    actorUserId: userId,
  });
  let caught7 = false;
  try {
    await acknowledgeWalletLedgerDrift({
      userId,
      currency: TEST_CURRENCY,
      note: "second",
      actorUserId: userId,
    });
  } catch (e) {
    caught7 = e instanceof DriftAckConflictError;
  }
  assert(caught7, "second active ack rejected with DriftAckConflictError");

  // Cleanup ack so the test user is left clean.
  await clearWalletLedgerDriftAcknowledgement({
    userId,
    currency: TEST_CURRENCY,
    actorUserId: userId,
    reason: "test cleanup",
  });

  console.log("\n✓✓✓ ALL TASK #35 ASSERTIONS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("test failed:", e);
  process.exit(1);
});
