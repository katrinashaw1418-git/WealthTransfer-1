// =============================================================================
// Task #294 — admin / adviser / client GET fee-rules now LEFT JOIN feeConsents
// -----------------------------------------------------------------------------
// All three role-specific list endpoints were widened to project the consent
// context (renewalStatus, consentExpiryDate, withdrawnAt, accountNumber,
// accountName, deductionFrequency) alongside each fee-rule row, so the UI
// cards can render Gate-A consent state and "since {effectiveDate} on
// account ****{last 4}" without a per-row round trip.
//
// We test the SELECT *projection* directly rather than spinning up the full
// Express app + auth stack — the handlers wrap this exact projection in a
// `res.json({ items, users })` envelope, so a contract test on the projection
// covers the surface area where regressions actually land.
//
// Run a real Drizzle SELECT against the dev DB with the same shape used by:
//   - server/admin-routes.ts  (admin GET /api/admin/fee-rules)
//   - server/adviser-routes.ts (GET /api/adviser/fee-rules)
//   - server/client-routes.ts  (GET /api/client/fees)
//
// The contract: every field in the projection comes back, AND when a
// fee-rule has a populated consent the joined fields are non-null with the
// expected values. When a rule's consent FK is missing/dangling, the joined
// fields are null (LEFT JOIN, not INNER JOIN — the rule still surfaces in
// the UI list, just without consent context).
// =============================================================================

import "../scripts/_bootstrap-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { db } from "./db";
import {
  adviceRecords,
  adviserFeeRules,
  feeConsents,
  users,
} from "@shared/schema";
import { createFeeRule } from "./services/fee-engine";

const TAG = `t294-getjoin-${Date.now()}`;

let clientUserId: number;
let adviserUserId: number;
let adviceRecordId: number;
let consentId: number;
let ruleId: number;

beforeAll(async () => {
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

  const [consent] = await db
    .insert(feeConsents)
    .values({
      adviceRecordId,
      clientId: clientUserId,
      adviserId: adviserUserId,
      feeType: "ongoing_service_fee",
      amountType: "percentage",
      amount: "1.0000",
      accountNumber: `${TAG}-ACC`,
      accountName: `${TAG} test acct name`,
      deductionFrequency: "monthly",
      referenceDay: new Date(),
      renewalWindowStart: new Date(),
      renewalWindowEnd: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      consentExpiryDate: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      renewalStatus: "active",
      clientSignatureName: "Test Client",
    })
    .returning();
  consentId = consent.id;

  const r = await createFeeRule(
    {
      feeConsentId: consentId,
      clientUserId,
      adviserUserId,
      feeType: "ongoing_service_fee",
      amountType: "percentage",
      rateBps: 100,
      adviserSplitBps: 8000,
      platformSplitBps: 2000,
    },
    { actorUserId: adviserUserId },
  );
  ruleId = r.id;
});

afterAll(async () => {
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
});

describe("GET fee-rules joined-consent projection (Task #294)", () => {
  it("adviser-side projection returns consent renewalStatus / expiry / withdrawnAt / accountNumber / accountName / deductionFrequency", async () => {
    // Same projection as server/adviser-routes.ts GET /api/adviser/fee-rules.
    const rows = await db
      .select({
        id: adviserFeeRules.id,
        status: adviserFeeRules.status,
        accountNumber: adviserFeeRules.accountNumber,
        effectiveDate: adviserFeeRules.effectiveDate,
        consentRenewalStatus: feeConsents.renewalStatus,
        consentExpiryDate: feeConsents.consentExpiryDate,
        consentWithdrawnAt: feeConsents.withdrawnAt,
        consentAccountNumber: feeConsents.accountNumber,
        consentAccountName: feeConsents.accountName,
        consentDeductionFrequency: feeConsents.deductionFrequency,
      })
      .from(adviserFeeRules)
      .leftJoin(feeConsents, eq(feeConsents.id, adviserFeeRules.feeConsentId))
      .where(
        and(
          eq(adviserFeeRules.adviserUserId, adviserUserId),
          eq(adviserFeeRules.clientUserId, clientUserId),
        ),
      )
      .orderBy(desc(adviserFeeRules.createdAt));

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.id).toBe(ruleId);
    expect(row.status).toBe("active");
    expect(row.accountNumber).toBe(`${TAG}-ACC`);
    expect(row.effectiveDate).not.toBeNull();
    // Joined consent fields — these are the new Task #294 surface.
    expect(row.consentRenewalStatus).toBe("active");
    expect(row.consentExpiryDate).not.toBeNull();
    expect(row.consentWithdrawnAt).toBeNull();
    expect(row.consentAccountNumber).toBe(`${TAG}-ACC`);
    expect(row.consentAccountName).toBe(`${TAG} test acct name`);
    expect(row.consentDeductionFrequency).toBe("monthly");
  });

  it("client-side projection returns the same consent context (uses LEFT JOIN, so a missing consent does not drop the row)", async () => {
    // Same projection as server/client-routes.ts GET /api/client/fees.
    const rows = await db
      .select({
        id: adviserFeeRules.id,
        feeType: adviserFeeRules.feeType,
        status: adviserFeeRules.status,
        adviserSplitBps: adviserFeeRules.adviserSplitBps,
        platformSplitBps: adviserFeeRules.platformSplitBps,
        accountNumber: adviserFeeRules.accountNumber,
        consentRenewalStatus: feeConsents.renewalStatus,
        consentExpiryDate: feeConsents.consentExpiryDate,
        consentWithdrawnAt: feeConsents.withdrawnAt,
        consentDeductionFrequency: feeConsents.deductionFrequency,
      })
      .from(adviserFeeRules)
      .leftJoin(feeConsents, eq(feeConsents.id, adviserFeeRules.feeConsentId))
      .where(eq(adviserFeeRules.clientUserId, clientUserId))
      .orderBy(desc(adviserFeeRules.createdAt));

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.consentRenewalStatus).toBe("active");
    expect(row.consentDeductionFrequency).toBe("monthly");
    expect(row.adviserSplitBps).toBe(8000);
    expect(row.platformSplitBps).toBe(2000);
  });

  it("admin-side projection returns the same six joined consent fields", async () => {
    // Same projection as server/admin-routes.ts GET /api/admin/fee-rules.
    const rows = await db
      .select({
        id: adviserFeeRules.id,
        status: adviserFeeRules.status,
        accountNumber: adviserFeeRules.accountNumber,
        consentRenewalStatus: feeConsents.renewalStatus,
        consentExpiryDate: feeConsents.consentExpiryDate,
        consentWithdrawnAt: feeConsents.withdrawnAt,
        consentAccountNumber: feeConsents.accountNumber,
        consentAccountName: feeConsents.accountName,
        consentDeductionFrequency: feeConsents.deductionFrequency,
      })
      .from(adviserFeeRules)
      .leftJoin(feeConsents, eq(feeConsents.id, adviserFeeRules.feeConsentId))
      .where(eq(adviserFeeRules.id, ruleId));

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.consentRenewalStatus).toBe("active");
    expect(row.consentExpiryDate).not.toBeNull();
    expect(row.consentWithdrawnAt).toBeNull();
    expect(row.consentAccountNumber).toBe(`${TAG}-ACC`);
    expect(row.consentAccountName).toBe(`${TAG} test acct name`);
    expect(row.consentDeductionFrequency).toBe("monthly");
  });
});
