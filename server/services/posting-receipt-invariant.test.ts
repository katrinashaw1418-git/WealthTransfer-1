// =============================================================================
// Task #63 — automated test for the posting-receipt invariant guard
// =============================================================================
// Locks in three contracts of runPostingReceiptInvariantCheck():
//
//   1. Missing-receipts divergence: when a transaction has rows in
//      `ledger_entries` but no matching row in `ledger_postings`, the check
//        a. surfaces a positive `missingCount`,
//        b. names the offending transactionId in `missingSample`, and
//        c. dispatches an operator alert (one row in `operator_alerts`
//           with source = "posting-receipt-invariant", severity = "alert",
//           and divergenceDirection = "missing_receipts").
//
//   2. Healthy path: once every transactionId has a receipt the
//      missingCount stops growing and the check stops dispatching new
//      alerts (asserted via the alert-row delta, not the global table
//      contents — the dev DB may legitimately carry pre-existing drift
//      that this task is meant to surface).
//
//   3. Orphan-receipts divergence (opposite direction): when receipts
//      exist for transactionIds that have NO matching ledger_entries
//      (which would only happen if entries were deleted out-of-band),
//      the check still alerts but with divergenceDirection =
//      "orphan_receipts" and a different remediation message.
//
// All inserted rows are tracked by primary key and removed in afterAll so
// the test file is idempotent on reruns and never deletes audit history
// it did not create itself.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  accounts,
  ledgerEntries,
  ledgerPostings,
  operatorAlerts,
  transactions,
  users,
} from "@shared/schema";
import {
  MISSING_TX_SAMPLE_LIMIT,
  runPostingReceiptInvariantCheck,
} from "./posting-receipt-invariant";

const TEST_CURRENCY = "GBP"; // distinct from other test files (USD/EUR) for log clarity

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

// ---------------------------------------------------------------------------
// Cleanup tracking — strictly by primary key for rows THIS file inserted.
// We deliberately do NOT delete by `source = 'posting-receipt-invariant'`:
// the dev DB is shared with the running app and may already contain operator
// alerts from prior boot-cron runs that are part of the durable audit trail.
// Bulk-deleting by source would erase that history.
// ---------------------------------------------------------------------------
const insertedTxIds: number[] = [];
const insertedAlertIds: number[] = [];
// Receipts we wrote during the orphan-receipts test against synthesised
// transactionIds that have NO ledger_entries. Tracked separately because
// they need to be deleted before the parent transactions row can be dropped.
const insertedReceiptOrphanTxIds: number[] = [];
// Receipts we wrote against PRE-EXISTING transaction ids in the dev DB to
// temporarily zero out historical missing-receipts drift so the orphan
// branch can be tested in isolation. Removed in afterAll so we leave the
// dev DB in exactly the state we found it.
const temporaryHealReceiptTxIds: number[] = [];
let testUserId: number;
let testAccountId: number;

async function createTestUser(): Promise<number> {
  const suffix = uniqueSuffix();
  const [u] = await db
    .insert(users)
    .values({
      username: `posting-receipt-invariant-test-${suffix}`,
      email: `posting-receipt-invariant-test-${suffix}@test.invalid`,
      password: "not-a-real-password",
      firstName: "PostingReceipt",
      lastName: "InvariantTest",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning({ id: users.id });
  return u.id;
}

async function createTestAccount(userId: number): Promise<number> {
  const [a] = await db
    .insert(accounts)
    .values({
      userId,
      currency: TEST_CURRENCY,
      accountType: "client",
      status: "active",
    })
    .returning({ id: accounts.id });
  return a.id;
}

/**
 * Insert a transactions row + a single ledger_entries row referencing it,
 * but DO NOT insert into ledger_postings. This is exactly the shape the
 * invariant check is designed to flag: a historical transaction whose
 * receipt is missing.
 */
async function insertTxWithoutReceipt(
  userId: number,
  accountId: number,
): Promise<number> {
  const [tx] = await db
    .insert(transactions)
    .values({
      userId,
      type: "deposit",
      fromCurrency: null,
      toCurrency: TEST_CURRENCY,
      amount: "1.00000000",
      fee: "0.00000000",
      exchangeRate: null,
      status: "completed",
      settlementStatus: "internal_only",
      description: "Task #63 invariant test (no receipt)",
    })
    .returning({ id: transactions.id });

  await db.insert(ledgerEntries).values({
    transactionId: tx.id,
    accountId,
    userId,
    currency: TEST_CURRENCY,
    direction: "debit",
    amount: "1.00000000",
    description: "Task #63 invariant test entry",
  });

  return tx.id;
}

/**
 * Insert a transactions row WITHOUT any ledger_entries, then insert a
 * matching ledger_postings receipt. Together this synthesises the
 * "orphan receipt" anomaly the invariant check is meant to catch in the
 * opposite direction (receipts > distinct tx ids in ledger_entries).
 */
async function insertOrphanReceipt(userId: number): Promise<number> {
  const [tx] = await db
    .insert(transactions)
    .values({
      userId,
      type: "deposit",
      fromCurrency: null,
      toCurrency: TEST_CURRENCY,
      amount: "1.00000000",
      fee: "0.00000000",
      exchangeRate: null,
      status: "completed",
      settlementStatus: "internal_only",
      description: "Task #63 invariant test (orphan receipt)",
    })
    .returning({ id: transactions.id });

  await db.insert(ledgerPostings).values({ transactionId: tx.id });
  return tx.id;
}

beforeAll(async () => {
  testUserId = await createTestUser();
  testAccountId = await createTestAccount(testUserId);
});

afterAll(async () => {
  // Delete in FK-safe order, by primary key only — never by source/filter.
  if (insertedAlertIds.length > 0) {
    await db
      .delete(operatorAlerts)
      .where(inArray(operatorAlerts.id, insertedAlertIds));
  }
  if (insertedReceiptOrphanTxIds.length > 0) {
    await db
      .delete(ledgerPostings)
      .where(inArray(ledgerPostings.transactionId, insertedReceiptOrphanTxIds));
  }
  if (temporaryHealReceiptTxIds.length > 0) {
    // Restore the dev DB to the missing-receipts state we found it in. The
    // running app's invariant cron will continue to flag these on its next
    // tick — that is the entire point of Task #63.
    await db
      .delete(ledgerPostings)
      .where(inArray(ledgerPostings.transactionId, temporaryHealReceiptTxIds));
  }
  if (insertedTxIds.length > 0) {
    await db
      .delete(ledgerEntries)
      .where(inArray(ledgerEntries.transactionId, insertedTxIds));
    await db
      .delete(ledgerPostings)
      .where(inArray(ledgerPostings.transactionId, insertedTxIds));
    await db
      .delete(transactions)
      .where(inArray(transactions.id, insertedTxIds));
  }
  if (insertedReceiptOrphanTxIds.length > 0) {
    await db
      .delete(transactions)
      .where(inArray(transactions.id, insertedReceiptOrphanTxIds));
  }
  if (testAccountId !== undefined) {
    await db.delete(accounts).where(eq(accounts.id, testAccountId));
  }
  if (testUserId !== undefined) {
    await db.delete(users).where(eq(users.id, testUserId));
  }
});

describe("runPostingReceiptInvariantCheck — Task #63", () => {
  it("detects a missing posting receipt and dispatches an operator alert", async () => {
    // Snapshot the most recent alert id BEFORE we trigger anything, so we
    // can isolate the row this test creates and avoid touching pre-existing
    // audit history.
    const [latestBefore] = await db
      .select({ id: operatorAlerts.id })
      .from(operatorAlerts)
      .where(eq(operatorAlerts.source, "posting-receipt-invariant"))
      .orderBy(operatorAlerts.id);
    const watermarkId = latestBefore?.id ?? 0;
    // Above sorts ASC; we want the highest existing id. Re-query with desc
    // would be cleaner, but a single descending order on a small dev table
    // is overkill — just take MAX via the ids we see.
    const allBefore = await db
      .select({ id: operatorAlerts.id })
      .from(operatorAlerts)
      .where(eq(operatorAlerts.source, "posting-receipt-invariant"));
    const maxBefore = allBefore.reduce(
      (acc, r) => (r.id > acc ? r.id : acc),
      watermarkId,
    );

    // Snapshot baseline counts so we can assert the divergence DELTA, not the
    // absolute count — the dev DB may already carry historical drift unrelated
    // to this test, and we don't want that to mask a real regression.
    const baseline = await runPostingReceiptInvariantCheck();
    const baselineMissing = baseline.missingCount;

    // Introduce a single missing-receipt transaction: ledger_entries row
    // exists but ledger_postings row does NOT. This is the precise shape the
    // invariant guard is designed to catch.
    const orphanTxId = await insertTxWithoutReceipt(testUserId, testAccountId);
    insertedTxIds.push(orphanTxId);

    const result = await runPostingReceiptInvariantCheck();

    // Counting contract — divergence increased by exactly 1 because we added
    // one new (transaction_id with entries) but no new receipt.
    expect(result.missingCount).toBe(baselineMissing + 1);
    expect(result.txWithEntries).toBe(baseline.txWithEntries + 1);
    expect(result.receipts).toBe(baseline.receipts);

    // Sample contract — bounded, and our id is reachable when room exists.
    expect(result.missingSample.length).toBeLessThanOrEqual(
      MISSING_TX_SAMPLE_LIMIT,
    );
    if (result.missingCount <= MISSING_TX_SAMPLE_LIMIT) {
      expect(result.missingSample).toContain(orphanTxId);
    }

    // Alert dispatch contract — exactly the new alert rows this test caused
    // (id > maxBefore) belong to us. Track only those for cleanup; never
    // touch rows that pre-dated this test.
    expect(result.alertDispatched).toBe(true);
    const allAfterBaselineAndTest = await db
      .select()
      .from(operatorAlerts)
      .where(eq(operatorAlerts.source, "posting-receipt-invariant"));
    const ours = allAfterBaselineAndTest.filter((r) => r.id > maxBefore);
    // We ran the check exactly twice (baseline + post-insertion). Only the
    // second one was divergent enough to dispatch a new alert — the
    // baseline call may also have dispatched (if pre-existing dev-DB drift
    // was non-zero). Either way, every row with id > maxBefore was created
    // by this test and is safe to delete.
    expect(ours.length).toBeGreaterThanOrEqual(1);
    for (const r of ours) {
      insertedAlertIds.push(r.id);
    }

    const fromThisInsertion = ours.find((r) => {
      const d = r.details as Record<string, unknown>;
      return d && Number(d.missingCount) === result.missingCount;
    });
    expect(fromThisInsertion).toBeDefined();
    expect(fromThisInsertion!.severity).toBe("alert");
    expect(fromThisInsertion!.title).toMatch(/missing\s+\d+\s+receipt/i);
    expect(fromThisInsertion!.title).toMatch(/backfill-ledger-postings/);

    const details = fromThisInsertion!.details as Record<string, unknown>;
    expect(details.missingCount).toBe(result.missingCount);
    expect(details.txWithEntries).toBe(result.txWithEntries);
    expect(details.receipts).toBe(result.receipts);
    expect(details.divergenceDirection).toBe("missing_receipts");
    expect(typeof details.remediation).toBe("string");
    expect(String(details.remediation)).toContain(
      "scripts/backfill-ledger-postings.ts",
    );
    expect(Array.isArray(details.missingSample)).toBe(true);
  });

  it("does not dispatch an alert when every transactionId has a receipt", async () => {
    // Heal the divergence we introduced above by writing the missing
    // receipts for our test transactions. Bounded to ids this test created.
    if (insertedTxIds.length > 0) {
      const values = insertedTxIds.map((transactionId) => ({ transactionId }));
      await db
        .insert(ledgerPostings)
        .values(values)
        .onConflictDoNothing();
    }

    // Snapshot the alert-id high-water mark for THIS source so we can detect
    // whether new rows landed during this call.
    const beforeRows = await db
      .select({ id: operatorAlerts.id })
      .from(operatorAlerts)
      .where(eq(operatorAlerts.source, "posting-receipt-invariant"));
    const maxBefore = beforeRows.reduce(
      (acc, r) => (r.id > acc ? r.id : acc),
      0,
    );

    const result = await runPostingReceiptInvariantCheck();

    // After healing our test rows, this test no longer contributes to
    // divergence. We can't assert missingCount === 0 (the dev DB may carry
    // pre-existing drift unrelated to this test — exactly the situation
    // the invariant guard is supposed to surface). What we CAN assert is
    // the dispatch behaviour matches the count: zero divergence => zero
    // new alert rows; non-zero divergence => exactly one new alert row.
    const afterRows = await db
      .select({ id: operatorAlerts.id })
      .from(operatorAlerts)
      .where(eq(operatorAlerts.source, "posting-receipt-invariant"));
    const newOnes = afterRows.filter((r) => r.id > maxBefore);
    for (const r of newOnes) {
      if (!insertedAlertIds.includes(r.id)) insertedAlertIds.push(r.id);
    }

    if (result.missingCount === 0) {
      expect(result.alertDispatched).toBe(false);
      expect(result.missingSample).toEqual([]);
      expect(newOnes).toHaveLength(0);
    } else {
      expect(result.alertDispatched).toBe(true);
      expect(result.missingSample.length).toBeLessThanOrEqual(
        MISSING_TX_SAMPLE_LIMIT,
      );
      expect(newOnes).toHaveLength(1);
    }
  });

  it("alerts on the opposite-direction divergence (orphan receipts)", async () => {
    // The dev DB this test runs against may carry pre-existing missing-
    // receipts drift (the very situation Task #63 is meant to surface).
    // To exercise the orphan-receipts branch in isolation, we first heal
    // any historical missing-receipts entries — tracking them so we can
    // remove the heal in afterAll and leave the dev DB exactly as we
    // found it. After healing, missingCount === 0 and adding a single
    // orphan receipt drives missingCount strictly negative, which is the
    // condition that selects the orphan-receipts code path.
    const missingRowsBefore = await db.execute(sql`
      SELECT DISTINCT le.transaction_id AS "transactionId"
      FROM ledger_entries le
      LEFT JOIN ledger_postings lp ON lp.transaction_id = le.transaction_id
      WHERE le.transaction_id IS NOT NULL
        AND lp.transaction_id IS NULL
    `);
    const preExistingMissingIds = (
      ((missingRowsBefore as unknown as { rows?: Array<{ transactionId: number | string }> }).rows) ?? []
    )
      .map((r) => Number(r.transactionId))
      .filter((n) => Number.isFinite(n));

    if (preExistingMissingIds.length > 0) {
      await db
        .insert(ledgerPostings)
        .values(preExistingMissingIds.map((transactionId) => ({ transactionId })))
        .onConflictDoNothing();
      for (const id of preExistingMissingIds) {
        temporaryHealReceiptTxIds.push(id);
      }
    }

    // After the heal the invariant should be exactly satisfied.
    const baseline = await runPostingReceiptInvariantCheck();
    expect(baseline.missingCount).toBe(0);
    expect(baseline.alertDispatched).toBe(false);

    // Snapshot the alert-id watermark BEFORE we synthesise the orphan.
    const beforeRows = await db
      .select({ id: operatorAlerts.id })
      .from(operatorAlerts)
      .where(eq(operatorAlerts.source, "posting-receipt-invariant"));
    const maxBefore = beforeRows.reduce(
      (acc, r) => (r.id > acc ? r.id : acc),
      0,
    );

    // Synthesise the orphan: a transaction with a receipt but no ledger
    // entries. Drives `receipts` up by 1 without changing `txWithEntries`,
    // so missingCount goes negative.
    const orphanTxId = await insertOrphanReceipt(testUserId);
    insertedReceiptOrphanTxIds.push(orphanTxId);

    const result = await runPostingReceiptInvariantCheck();

    expect(result.txWithEntries).toBe(baseline.txWithEntries);
    expect(result.receipts).toBe(baseline.receipts + 1);
    expect(result.missingCount).toBe(-1);
    // Sample collection only runs when missingCount > 0; the orphan branch
    // has nothing to sample because the LEFT JOIN looks for the opposite.
    expect(result.missingSample).toEqual([]);
    expect(result.alertDispatched).toBe(true);

    const afterRows = await db
      .select()
      .from(operatorAlerts)
      .where(eq(operatorAlerts.source, "posting-receipt-invariant"));
    const newOnes = afterRows.filter((r) => r.id > maxBefore);
    for (const r of newOnes) {
      insertedAlertIds.push(r.id);
    }
    expect(newOnes).toHaveLength(1);

    const ours = newOnes[0];
    expect(ours.severity).toBe("alert");
    expect(ours.title).toMatch(/orphan\s+receipt/i);

    const details = ours.details as Record<string, unknown>;
    expect(details.divergenceDirection).toBe("orphan_receipts");
    expect(details.missingCount).toBe(-1);
    expect(typeof details.remediation).toBe("string");
    // Orphan-receipt remediation must NOT point at the additive backfill
    // script — that script cannot fix an orphan-receipt anomaly.
    expect(String(details.remediation)).not.toContain(
      "backfill-ledger-postings.ts",
    );
  });
});
