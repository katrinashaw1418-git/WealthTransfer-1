// =============================================================================
// Task #294 — reconcileRuleConsentState lifecycle alignment
// -----------------------------------------------------------------------------
// Locks the contract used by the daily cron and the admin "reconcile now"
// button. Walks every non-terminal rule and aligns it with its consent:
//
//   * consent.renewalStatus = 'expired'     → rule.status = 'expired' (terminal)
//   * consent.consentExpiryDate <= now      → rule.status = 'expired' (terminal)
//   * consent.withdrawnAt set (and not yet  → rule.status = 'paused',
//     expired)                                 pausedReason = 'consent_withdrawn'
//   * neither condition                     → rule untouched (alreadyAligned)
//
// And it is IDEMPOTENT — calling it a second time on a fully aligned set
// performs no transitions and writes no new audit rows.
//
// We exercise all four cases with real DB rows and assert both the column
// state and the audit trail (`fee_rule_consent_reconciled`) afterwards.
// =============================================================================

import "../../scripts/_bootstrap-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  adviceRecords,
  adviserFeeRules,
  auditLogs,
  feeConsents,
  users,
} from "@shared/schema";
import { createFeeRule, reconcileRuleConsentState } from "./fee-engine";

const TAG = `t294-reconcile-${Date.now()}`;

let clientUserId: number;
let adviserUserId: number;
let adviceRecordId: number;
let consentExpiredStatusId: number;
let consentExpiredByDateId: number;
let consentWithdrawnId: number;
let consentHealthyId: number;
let ruleExpiredStatus: number;
let ruleExpiredByDate: number;
let ruleWithdrawn: number;
let ruleHealthy: number;

async function seed() {
  const [client] = await db
    .insert(users)
    .values({
      username: `${TAG}-client`,
      email: `${TAG}-client@test.local`,
      password: "x",
      firstName: "T",
      lastName: "C",
      role: "client",
    })
    .returning();
  const [adviser] = await db
    .insert(users)
    .values({
      username: `${TAG}-adv`,
      email: `${TAG}-adv@test.local`,
      password: "x",
      firstName: "T",
      lastName: "A",
      role: "adviser",
    })
    .returning();
  clientUserId = client.id;
  adviserUserId = adviser.id;

  const [advice] = await db
    .insert(adviceRecords)
    .values({
      clientId: clientUserId,
      adviserId: adviserUserId,
      adviceType: "personal",
      adviceSource: "hybrid",
      status: "issued",
    })
    .returning();
  adviceRecordId = advice.id;

  const future = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const past = new Date(Date.now() - 24 * 3600 * 1000);

  const baseConsent = {
    adviceRecordId,
    clientId: clientUserId,
    adviserId: adviserUserId,
    feeType: "ongoing_service_fee",
    amountType: "percentage",
    amount: "1.0000",
    deductionFrequency: "monthly",
    referenceDay: new Date(),
    renewalWindowStart: new Date(),
    renewalWindowEnd: future,
    clientSignatureName: "Test Client",
  };

  // 1. renewalStatus = 'expired' (date is still in the future)
  const [c1] = await db
    .insert(feeConsents)
    .values({
      ...baseConsent,
      accountNumber: `${TAG}-EXP-STATUS`,
      consentExpiryDate: future,
      renewalStatus: "expired",
    })
    .returning();
  consentExpiredStatusId = c1.id;

  // 2. consentExpiryDate in the past (status still 'active')
  const [c2] = await db
    .insert(feeConsents)
    .values({
      ...baseConsent,
      accountNumber: `${TAG}-EXP-DATE`,
      consentExpiryDate: past,
      renewalStatus: "active",
    })
    .returning();
  consentExpiredByDateId = c2.id;

  // 3. withdrawn (not expired) — created NOT yet withdrawn so we can run
  // createFeeRule on it (createFeeRule rejects rules on withdrawn consents),
  // then we set withdrawnAt below before invoking reconcile.
  const [c3] = await db
    .insert(feeConsents)
    .values({
      ...baseConsent,
      accountNumber: `${TAG}-WITHDRAWN`,
      consentExpiryDate: future,
      renewalStatus: "active",
    })
    .returning();
  consentWithdrawnId = c3.id;

  // 4. healthy
  const [c4] = await db
    .insert(feeConsents)
    .values({
      ...baseConsent,
      accountNumber: `${TAG}-HEALTHY`,
      consentExpiryDate: future,
      renewalStatus: "active",
    })
    .returning();
  consentHealthyId = c4.id;

  // Create the four rules. createFeeRule rejects withdrawn or already-expired
  // consents, so we use a direct insert for the two expired ones — this is
  // the same shape an existing legacy rule would have when its consent
  // later transitions to expired.
  const ruleBase = {
    clientUserId,
    adviserUserId,
    feeType: "ongoing_service_fee",
    amountType: "percentage" as const,
    rateBps: 100,
    adviserSplitBps: 8000,
    platformSplitBps: 2000,
  };

  const [rExpStatus] = await db
    .insert(adviserFeeRules)
    .values({
      ...ruleBase,
      feeConsentId: consentExpiredStatusId,
      accountNumber: `${TAG}-EXP-STATUS`,
      status: "active",
    })
    .returning();
  ruleExpiredStatus = rExpStatus.id;

  const [rExpDate] = await db
    .insert(adviserFeeRules)
    .values({
      ...ruleBase,
      feeConsentId: consentExpiredByDateId,
      accountNumber: `${TAG}-EXP-DATE`,
      status: "active",
    })
    .returning();
  ruleExpiredByDate = rExpDate.id;

  const wRule = await createFeeRule(
    { ...ruleBase, feeConsentId: consentWithdrawnId },
    { actorUserId: adviserUserId },
  );
  ruleWithdrawn = wRule.id;
  // Now mark the consent withdrawn AFTER creating the rule on it.
  await db
    .update(feeConsents)
    .set({ withdrawnAt: new Date() })
    .where(eq(feeConsents.id, consentWithdrawnId));

  const hRule = await createFeeRule(
    { ...ruleBase, feeConsentId: consentHealthyId },
    { actorUserId: adviserUserId },
  );
  ruleHealthy = hRule.id;
}

async function cleanup() {
  try {
    await db
      .delete(auditLogs)
      .where(
        sql`${auditLogs.entityType} = 'adviser_fee_rule' AND ${auditLogs.metadata}->>'consentId' IN (${String(consentExpiredStatusId)}, ${String(consentExpiredByDateId)}, ${String(consentWithdrawnId)}, ${String(consentHealthyId)})`,
      );
  } catch {}
  try {
    await db.delete(adviserFeeRules).where(eq(adviserFeeRules.clientUserId, clientUserId));
  } catch {}
  try {
    await db.delete(feeConsents).where(eq(feeConsents.clientId, clientUserId));
  } catch {}
  try {
    await db.delete(adviceRecords).where(eq(adviceRecords.id, adviceRecordId));
  } catch {}
  try {
    await db.delete(users).where(eq(users.id, clientUserId));
    await db.delete(users).where(eq(users.id, adviserUserId));
  } catch {}
}

beforeAll(async () => {
  await seed();
});

afterAll(async () => {
  await cleanup();
});

describe("reconcileRuleConsentState (Task #294)", () => {
  it("expires rules whose consent is expired (status or date), pauses rules whose consent is withdrawn, and leaves healthy rules alone", async () => {
    const summary = await reconcileRuleConsentState({ actorUserId: null });

    // The summary numbers are aggregate over EVERY non-terminal rule in the
    // dev DB, not just our four — but our four MUST account for >=2 expired
    // and >=1 paused. Use >= so other concurrent suites do not destabilise us.
    expect(summary.expired).toBeGreaterThanOrEqual(2);
    expect(summary.pausedForWithdrawal).toBeGreaterThanOrEqual(1);
    expect(summary.checked).toBeGreaterThanOrEqual(4);

    // Per-row assertions are exact.
    const [expStatus] = await db
      .select()
      .from(adviserFeeRules)
      .where(eq(adviserFeeRules.id, ruleExpiredStatus));
    expect(expStatus.status).toBe("expired");

    const [expDate] = await db
      .select()
      .from(adviserFeeRules)
      .where(eq(adviserFeeRules.id, ruleExpiredByDate));
    expect(expDate.status).toBe("expired");

    const [withdrawn] = await db
      .select()
      .from(adviserFeeRules)
      .where(eq(adviserFeeRules.id, ruleWithdrawn));
    expect(withdrawn.status).toBe("paused");
    expect(withdrawn.pausedReason).toBe("consent_withdrawn");
    expect(withdrawn.pausedAt).not.toBeNull();

    const [healthy] = await db
      .select()
      .from(adviserFeeRules)
      .where(eq(adviserFeeRules.id, ruleHealthy));
    expect(healthy.status).toBe("active");

    // Audit trail check: each transition wrote one fee_rule_consent_reconciled
    // line for the affected rule.
    for (const id of [ruleExpiredStatus, ruleExpiredByDate, ruleWithdrawn]) {
      const rows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, "adviser_fee_rule"),
            eq(auditLogs.entityId, String(id)),
            eq(auditLogs.action, "fee_rule_consent_reconciled"),
          ),
        );
      expect(rows.length).toBeGreaterThanOrEqual(1);
    }
    // The healthy rule was NOT touched, so it must NOT have a reconcile audit
    // row for this run.
    const healthyRows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "adviser_fee_rule"),
          eq(auditLogs.entityId, String(ruleHealthy)),
          eq(auditLogs.action, "fee_rule_consent_reconciled"),
        ),
      );
    expect(healthyRows.length).toBe(0);
  });

  it("is idempotent — a second call writes no new audit rows for our seeded set", async () => {
    const auditCountBefore = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "adviser_fee_rule"),
          eq(auditLogs.action, "fee_rule_consent_reconciled"),
          sql`${auditLogs.entityId} IN (${String(ruleExpiredStatus)}, ${String(ruleExpiredByDate)}, ${String(ruleWithdrawn)}, ${String(ruleHealthy)})`,
        ),
      );

    await reconcileRuleConsentState({ actorUserId: null });

    const auditCountAfter = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "adviser_fee_rule"),
          eq(auditLogs.action, "fee_rule_consent_reconciled"),
          sql`${auditLogs.entityId} IN (${String(ruleExpiredStatus)}, ${String(ruleExpiredByDate)}, ${String(ruleWithdrawn)}, ${String(ruleHealthy)})`,
        ),
      );
    // expired rules are now status='expired' (terminal — skipped by the walk
    // entirely), the withdrawn rule already has pausedReason='consent_withdrawn'
    // (alreadyAligned branch), and the healthy rule was untouched. Net: zero
    // new audit rows for any of our four.
    expect(auditCountAfter[0].n).toBe(auditCountBefore[0].n);
  });
});
