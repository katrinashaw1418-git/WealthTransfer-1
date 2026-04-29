// Task #514 — Daily accrual scheduler skips rules whose consent fails
// `assertConsentValidForExecution` and continues to the next rule.
//
// Acceptance test (single, per spec):
//   In one runDailyAccruals call, a rule with an invalid consent
//   produces NO accrual row, while a rule with a valid consent in the
//   SAME run still accrues normally.
//
// What this proves:
//   - The consent gate fires per-rule (not job-fatal).
//   - A consent-failed rule writes nothing to adviser_fee_accruals
//     (Task #514 contract — distinct from Task #476's earlier
//     "skipped placeholder row" pattern).
//   - The structured log line includes ruleId, consentId, and the
//     umbrella reasonCode CONSENT_INVALID_AT_EXECUTION.

import "../../scripts/_bootstrap-test-env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "../db";
import {
  adviceRecords,
  adviserClients,
  adviserFeeAccruals,
  adviserFeeRules,
  feeConsents,
  users,
} from "@shared/schema";
import { runDailyAccruals } from "./fee-engine";

const TAG = `t514-${Date.now()}`;

let clientUserId: number;
let adviserUserId: number;
let adviceRecordId: number;

let validRuleId: number;
let invalidRuleId: number;
let validConsentId: number;
let invalidConsentId: number;

const accrualDate = new Date(Date.UTC(2026, 8, 14));

function future(daysFromNow = 365): Date {
  return new Date(Date.now() + daysFromNow * 24 * 3600 * 1000);
}

async function ensurePlatformUser(): Promise<void> {
  if (process.env.PLATFORM_USER_ID) return;
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.username, "__t514_platform__"));
  if (existing) {
    process.env.PLATFORM_USER_ID = String(existing.id);
    return;
  }
  const [created] = await db
    .insert(users)
    .values({
      username: "__t514_platform__",
      email: "t514-platform@test.invalid",
      password: "x",
      firstName: "T514",
      lastName: "Platform",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  process.env.PLATFORM_USER_ID = String(created.id);
}

async function makeUser(role: "client" | "adviser"): Promise<number> {
  const [u] = await db
    .insert(users)
    .values({
      username: `${TAG}-${role}`,
      email: `${TAG}-${role}@test.invalid`,
      password: "x",
      firstName: role,
      lastName: TAG,
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  return u.id;
}

async function makeConsent(suffix: string): Promise<number> {
  const [c] = await db
    .insert(feeConsents)
    .values({
      adviceRecordId,
      clientId: clientUserId,
      adviserId: adviserUserId,
      feeType: "ongoing_service_fee",
      amountType: "fixed",
      amount: "10.0000",
      deductionFrequency: "monthly",
      referenceDay: new Date(),
      renewalWindowStart: new Date(),
      renewalWindowEnd: future(),
      consentExpiryDate: future(),
      renewalStatus: "active",
      clientSignatureName: "T514 Client",
      accountNumber: `${TAG}-${suffix}`,
    })
    .returning();
  return c.id;
}

async function makeRule(consentId: number, suffix: string): Promise<number> {
  const [r] = await db
    .insert(adviserFeeRules)
    .values({
      feeConsentId: consentId,
      clientUserId,
      adviserUserId,
      feeType: "ongoing_service_fee",
      accountNumber: `${TAG}-${suffix}`,
      amountType: "fixed",
      fixedAmount: "10.0000",
      adviserSplitBps: 8000,
      platformSplitBps: 2000,
      status: "active",
    })
    .returning();
  return r.id;
}

beforeAll(async () => {
  await ensurePlatformUser();
  clientUserId = await makeUser("client");
  adviserUserId = await makeUser("adviser");
  await db.insert(adviserClients).values({
    adviserUserId,
    clientUserId,
    isActive: true,
  });
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
  // Two rules, two consents. We withdraw the "invalid" consent before
  // the run so the gate refuses that rule only.
  validConsentId = await makeConsent("valid-c");
  invalidConsentId = await makeConsent("invalid-c");
  validRuleId = await makeRule(validConsentId, "valid-r");
  invalidRuleId = await makeRule(invalidConsentId, "invalid-r");
  await db
    .update(feeConsents)
    .set({ withdrawnAt: new Date() })
    .where(eq(feeConsents.id, invalidConsentId));
});

afterAll(async () => {
  // Best-effort cleanup so re-runs don't accumulate fixtures. The
  // accrual rows for validRuleId are removed too so the unique
  // (rule_id, accrual_date) constraint never re-fires.
  await db
    .delete(adviserFeeAccruals)
    .where(eq(adviserFeeAccruals.feeRuleId, validRuleId));
  await db
    .delete(adviserFeeAccruals)
    .where(eq(adviserFeeAccruals.feeRuleId, invalidRuleId));
  await db.delete(adviserFeeRules).where(eq(adviserFeeRules.id, validRuleId));
  await db.delete(adviserFeeRules).where(eq(adviserFeeRules.id, invalidRuleId));
  await db.delete(feeConsents).where(eq(feeConsents.id, validConsentId));
  await db.delete(feeConsents).where(eq(feeConsents.id, invalidConsentId));
  await db
    .delete(adviserClients)
    .where(
      and(
        eq(adviserClients.adviserUserId, adviserUserId),
        eq(adviserClients.clientUserId, clientUserId),
      ),
    );
  await db.delete(adviceRecords).where(eq(adviceRecords.id, adviceRecordId));
  await db.delete(users).where(eq(users.id, clientUserId));
  await db.delete(users).where(eq(users.id, adviserUserId));
});

describe("runDailyAccruals — Task #514 consent skip-and-continue", () => {
  it("skips the invalid-consent rule (no accrual row) while the valid rule in the SAME run still accrues", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runDailyAccruals({ accrualDate });

      // 1. The invalid-consent rule produced NO accrual row.
      const invalidRows = await db
        .select()
        .from(adviserFeeAccruals)
        .where(
          and(
            eq(adviserFeeAccruals.feeRuleId, invalidRuleId),
            eq(adviserFeeAccruals.accrualDate, accrualDate),
          ),
        );
      expect(invalidRows).toHaveLength(0);

      // 2. The valid-consent rule in the SAME run still accrued.
      const [validRow] = await db
        .select()
        .from(adviserFeeAccruals)
        .where(
          and(
            eq(adviserFeeAccruals.feeRuleId, validRuleId),
            eq(adviserFeeAccruals.accrualDate, accrualDate),
          ),
        );
      expect(validRow).toBeDefined();
      expect(validRow.gateReason).toBeNull();
      expect(Number(validRow.accrualAmount)).toBeGreaterThan(0);

      // 3. The structured log line carries the umbrella reason code
      //    plus ruleId and consentId for log-aggregator filtering.
      const matchingCalls = logSpy.mock.calls.filter(
        (args) => args[0] === "[fee-accrual] CONSENT_INVALID_AT_EXECUTION",
      );
      expect(matchingCalls.length).toBeGreaterThanOrEqual(1);
      const matching = matchingCalls.find(
        (args) =>
          (args[1] as { ruleId?: number } | undefined)?.ruleId ===
          invalidRuleId,
      );
      expect(matching).toBeDefined();
      const payload = matching![1] as {
        ruleId: number;
        consentId: number;
        gateReason: string;
      };
      expect(payload.ruleId).toBe(invalidRuleId);
      expect(payload.consentId).toBe(invalidConsentId);
      expect(payload.gateReason).toBe("consent_withdrawn");
    } finally {
      logSpy.mockRestore();
    }
  });
});
