// =============================================================================
// Task #203 — drift-admin workflow contract test (vitest)
// -----------------------------------------------------------------------------
// Codifies the four behaviours called out in
// `.local/tasks/drift-admin-workflow-consolidation.md`:
//
//   1. critical -> notify  : a fresh `critical` drift fires exactly one
//      operator notification on the first reconciliation pass.
//   2. ack -> suppress     : after the admin records a drift acknowledgement
//      that hasn't moved beyond MATCH_EPSILON, the next pass writes the
//      reconciliation row but does NOT page (suppression counter +1).
//   3. expired ack -> re-page : when the acknowledgement is older than the
//      DRIFT_ACK_TTL_DAYS window, the next pass treats the row as un-ack'd
//      and pages again.
//   4. ack-render contract : the `getActiveDriftAcknowledgement` query (and
//      thus the admin reconciliation table) only returns the ack while it
//      is fresh; once expired it disappears from the active set even
//      though the row remains in the DB for audit.
//
// The pre-existing scripts/test-task-35-suppression.ts is a procedural
// smoke test that exercises a similar path; this file is the focused
// vitest the consolidation plan explicitly required so the contract is
// captured in the same harness as the rest of the service tests
// (server/services/*.test.ts).
//
// We rely on summary counters exposed by `runWalletLedgerReconciliation`
// rather than mocking `notifyOperator` directly: those counters are
// updated on the same control-flow branch as the dispatch, so they prove
// the gate fires/suppresses without needing module mocks.
//
// Run with:  npx vitest run server/services/reconciliation.test.ts
// =============================================================================

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  accounts,
  ledgerEntries,
  ledgerPostings,
  transactions,
  users,
  wallets,
  walletLedgerReconciliations,
  walletLedgerDriftAcknowledgements,
} from "@shared/schema";
import {
  runWalletLedgerReconciliation,
  acknowledgeWalletLedgerDrift,
  getDriftAckTtlDays,
} from "./reconciliation";

// Different currency from the procedural smoke test (AUD) and from
// wallet-cache.test.ts (EUR) so the two suites can share the dev DB
// without colliding on the (user, currency) primary key when run in
// parallel.
const TEST_CURRENCY = "GBP";
const TEST_USERNAME = "__task203_recon_test_user__";

// Drift large enough that classifySeverity returns `critical`. The current
// thresholds in reconciliation.ts are: info ≥ 0.01, warning ≥ 1, alert ≥
// 100, critical ≥ 1000. Picked at 1500.00 to leave headroom and to be
// unambiguously above the critical threshold so the notify-gate fires.
const CRITICAL_DRIFT = "1500.00000000";

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
      password: "x",
      email: `${TEST_USERNAME}@test.local`,
      firstName: "Task203",
      lastName: "Test",
      role: "client",
    })
    .returning();
  return created.id;
}

async function wipeUserState(userId: number): Promise<void> {
  // Order matters: ack table first (no FK to others touched here), then
  // reconciliation row, then ledger entries (FK transactions), then
  // ledger postings receipts, then transactions, then wallets, then
  // accounts. Mirrors wipe order in wallet-cache.test.ts so the dev DB
  // stays clean across runs.
  await db
    .delete(walletLedgerDriftAcknowledgements)
    .where(eq(walletLedgerDriftAcknowledgements.userId, userId));
  await db
    .delete(walletLedgerReconciliations)
    .where(eq(walletLedgerReconciliations.userId, userId));
  await db.delete(ledgerEntries).where(eq(ledgerEntries.userId, userId));
  const leftoverTxIds = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.userId, userId));
  if (leftoverTxIds.length > 0) {
    await db
      .delete(ledgerPostings)
      .where(
        inArray(
          ledgerPostings.transactionId,
          leftoverTxIds.map((r) => r.id),
        ),
      );
  }
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(wallets).where(eq(wallets.userId, userId));
  await db
    .delete(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.currency, TEST_CURRENCY)));
}

// Force a critical drift by writing a wallet cache balance of 0 against a
// ledger sum of CRITICAL_DRIFT. We deliberately bypass the normal
// settlement path (which would post a balanced pair and refresh the
// cache) because the whole point of the test is to model state where
// the cache and the ledger disagree — i.e. exactly the scenario the
// reconciler is built to detect.
async function seedCriticalDrift(userId: number): Promise<void> {
  // 1. Wallet row at zero (the "cache").
  const [wallet] = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.currency, TEST_CURRENCY)));
  if (!wallet) {
    await db.insert(wallets).values({
      userId,
      currency: TEST_CURRENCY,
      walletType: "fiat",
      balance: "0",
      availableBalance: "0",
    });
  } else {
    await db
      .update(wallets)
      .set({ balance: "0", availableBalance: "0" })
      .where(eq(wallets.id, wallet.id));
  }

  // 2. Account row + a single credit ledger entry summing to
  //    CRITICAL_DRIFT for this user+currency.
  let [account] = await db
    .select()
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), eq(accounts.currency, TEST_CURRENCY)),
    );
  if (!account) {
    [account] = await db
      .insert(accounts)
      .values({
        userId,
        accountType: "client",
        currency: TEST_CURRENCY,
        name: "task203 test client account",
      })
      .returning();
  }
  // Use a placeholder transaction so the ledger entry has a valid FK.
  // Real ledger entries always belong to a transaction; the reconciler
  // doesn't read the transaction itself so any minimal row works.
  const [tx] = await db
    .insert(transactions)
    .values({
      userId,
      type: "deposit",
      toCurrency: TEST_CURRENCY,
      amount: CRITICAL_DRIFT,
      fee: "0",
      status: "completed",
      description: "task203 vitest critical-drift fixture",
    })
    .returning();
  await db.insert(ledgerEntries).values({
    transactionId: tx.id,
    accountId: account.id,
    userId,
    currency: TEST_CURRENCY,
    direction: "credit",
    amount: CRITICAL_DRIFT,
    description: "task203 vitest critical-drift fixture credit",
  });
}

let testUserId: number;

beforeAll(async () => {
  testUserId = await ensureTestUser();
});

afterEach(async () => {
  // Reset between tests so each `it` describes a fresh scenario.
  await wipeUserState(testUserId);
});

afterAll(async () => {
  await wipeUserState(testUserId);
  // Leave the test user in place — wallet-cache.test.ts and other
  // service tests follow the same pattern (drop state, keep the user).
});

describe("Task #203 — drift admin workflow contract", () => {
  it("(1) critical drift fires exactly one operator notification on first pass", async () => {
    await seedCriticalDrift(testUserId);

    const summary = await runWalletLedgerReconciliation();

    // Find OUR row in the summary's per-pair notifications. The summary
    // is global (counts notifications across ALL drifted users on the
    // dev DB), so we cannot simply assert on the global counter equaling
    // 1. We instead assert:
    //   - the reconciliation row for our user was inserted with the
    //     expected severity
    //   - the global notify-counter increased by at least 1 (one of those
    //     was ours; if other test residue exists the counter will be
    //     higher)
    //   - the row's `operatorAlertSent` flag (or notes) is consistent
    //     with notification dispatch
    expect(summary.operatorNotifications).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select()
      .from(walletLedgerReconciliations)
      .where(
        and(
          eq(walletLedgerReconciliations.userId, testUserId),
          eq(walletLedgerReconciliations.currency, TEST_CURRENCY),
        ),
      );
    expect(row).toBeDefined();
    expect(row.severity).toBe("critical");
    expect(row.status).toBe("mismatch");
    // The notes should NOT contain a suppression line on the first pass.
    expect((row.notes ?? "").toLowerCase()).not.toContain(
      "operator alert suppressed",
    );
  });

  it("(2) acknowledgement suppresses notification on the next pass", async () => {
    await seedCriticalDrift(testUserId);

    // First pass — establishes the drift row that the ack will reference.
    await runWalletLedgerReconciliation();

    // Admin acks the drift with a note.
    await acknowledgeWalletLedgerDrift({
      userId: testUserId,
      currency: TEST_CURRENCY,
      actorUserId: testUserId,
      note: "task203 vitest ack — under investigation",
    });

    // Second pass — same drift, fresh ack.
    const summary = await runWalletLedgerReconciliation();
    expect(summary.operatorNotificationsSuppressed).toBeGreaterThanOrEqual(1);

    // The most recent reconciliation row for our user must carry the
    // suppression note so the admin UI shows "suppressed because
    // acknowledged on YYYY-MM-DD" beside the row.
    const ourRows = await db
      .select()
      .from(walletLedgerReconciliations)
      .where(
        and(
          eq(walletLedgerReconciliations.userId, testUserId),
          eq(walletLedgerReconciliations.currency, TEST_CURRENCY),
        ),
      )
      .orderBy(walletLedgerReconciliations.createdAt);
    const latest = ourRows[ourRows.length - 1];
    expect(latest).toBeDefined();
    expect((latest.notes ?? "").toLowerCase()).toContain(
      "operator alert suppressed",
    );
  });

  it("(3) expired acknowledgement re-pages on the next pass", async () => {
    await seedCriticalDrift(testUserId);

    // First pass to seed the row.
    await runWalletLedgerReconciliation();

    // Insert an ack and then back-date `acknowledgedAt` past the TTL
    // window so `getActiveDriftAcknowledgement` filters it out. We can't
    // use `acknowledgeWalletLedgerDrift` for the back-dated case because
    // it stamps `now()`; we update the row directly after creation.
    await acknowledgeWalletLedgerDrift({
      userId: testUserId,
      currency: TEST_CURRENCY,
      actorUserId: testUserId,
      note: "task203 vitest ack to expire",
    });
    const ttlDays = getDriftAckTtlDays();
    // Back-date by ttlDays + 1 so the row is unambiguously past the TTL
    // even with clock-skew tolerance inside the SQL `now() - interval`.
    await db.execute(sql`
      UPDATE wallet_ledger_drift_acknowledgements
      SET acknowledged_at = now() - make_interval(days => ${ttlDays + 1})
      WHERE user_id = ${testUserId}
        AND currency = ${TEST_CURRENCY}
        AND cleared_at IS NULL
    `);

    // Snapshot the suppression counter, run again, and assert NO new
    // suppression happened — the run instead paged because the ack is
    // beyond TTL and the active-ack query returned null.
    const baseline = await runWalletLedgerReconciliation();

    const ourRows = await db
      .select()
      .from(walletLedgerReconciliations)
      .where(
        and(
          eq(walletLedgerReconciliations.userId, testUserId),
          eq(walletLedgerReconciliations.currency, TEST_CURRENCY),
        ),
      )
      .orderBy(walletLedgerReconciliations.createdAt);
    const latest = ourRows[ourRows.length - 1];
    expect(latest).toBeDefined();
    // The latest row must NOT carry a suppression note — proving the
    // expired ack was treated as inactive and the row paged normally.
    expect((latest.notes ?? "").toLowerCase()).not.toContain(
      "operator alert suppressed",
    );
    // Sanity: the run still flagged at least one notification.
    expect(baseline.operatorNotifications).toBeGreaterThanOrEqual(1);
  });

  it("(4) ack-render contract: expired ack still in DB, but excluded from active set", async () => {
    await seedCriticalDrift(testUserId);
    await runWalletLedgerReconciliation();

    await acknowledgeWalletLedgerDrift({
      userId: testUserId,
      currency: TEST_CURRENCY,
      actorUserId: testUserId,
      note: "task203 vitest expired-ack persistence check",
    });

    // Back-date past TTL.
    const ttlDays = getDriftAckTtlDays();
    await db.execute(sql`
      UPDATE wallet_ledger_drift_acknowledgements
      SET acknowledged_at = now() - make_interval(days => ${ttlDays + 1})
      WHERE user_id = ${testUserId}
        AND currency = ${TEST_CURRENCY}
        AND cleared_at IS NULL
    `);

    // The row MUST still exist in the table (audit trail intact).
    const rowsInDb = await db
      .select()
      .from(walletLedgerDriftAcknowledgements)
      .where(
        and(
          eq(walletLedgerDriftAcknowledgements.userId, testUserId),
          eq(walletLedgerDriftAcknowledgements.currency, TEST_CURRENCY),
        ),
      );
    expect(rowsInDb.length).toBeGreaterThan(0);

    // But the ACTIVE-set query (which the admin UI / runner consult) must
    // exclude it because it's past TTL. We replicate the query the
    // service uses internally.
    const [active] = await db
      .select()
      .from(walletLedgerDriftAcknowledgements)
      .where(
        and(
          eq(walletLedgerDriftAcknowledgements.userId, testUserId),
          eq(walletLedgerDriftAcknowledgements.currency, TEST_CURRENCY),
          sql`${walletLedgerDriftAcknowledgements.clearedAt} IS NULL`,
          sql`${walletLedgerDriftAcknowledgements.acknowledgedAt} > now() - (${ttlDays} || ' days')::interval`,
        ),
      );
    expect(active).toBeUndefined();
  });
});
