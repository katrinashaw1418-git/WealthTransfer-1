// Task #284 — verify the new dashboard summary fields against the live dev DB.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db";
import {
  users,
  adviserClients,
  adviceRecords,
  feeConsents,
} from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import { getAdviserDashboardSummary } from "./adviser-access";

const ADVISER_EMAIL = "task284-dash-adviser@example.invalid";
const CLIENT_A_EMAIL = "task284-dash-client-a@example.invalid";
const CLIENT_B_EMAIL = "task284-dash-client-b@example.invalid";
const FIXTURE_EMAILS = [ADVISER_EMAIL, CLIENT_A_EMAIL, CLIENT_B_EMAIL];

let adviserId = 0;
let clientAId = 0;
let clientBId = 0;
let adviceRecordIds: number[] = [];
let feeConsentIds: number[] = [];

async function cleanup() {
  if (feeConsentIds.length) {
    await db.delete(feeConsents).where(inArray(feeConsents.id, feeConsentIds));
  }
  if (adviceRecordIds.length) {
    await db.delete(adviceRecords).where(inArray(adviceRecords.id, adviceRecordIds));
  }
  if (adviserId) {
    await db.delete(adviserClients).where(eq(adviserClients.adviserUserId, adviserId));
  }
  await db.delete(users).where(inArray(users.email, FIXTURE_EMAILS));
}

describe("getAdviserDashboardSummary — Task #284 fields", () => {
  beforeAll(async () => {
    await cleanup();

    const [adviser] = await db
      .insert(users)
      .values({
        username: "task284-dash-adviser",
        email: ADVISER_EMAIL,
        password: "x",
        firstName: "Adviser",
        lastName: "Fixture",
        role: "adviser",
        kycStatus: "verified",
      })
      .returning({ id: users.id });
    adviserId = adviser.id;

    const insertedClients = await db
      .insert(users)
      .values([
        {
          username: "task284-dash-client-a",
          email: CLIENT_A_EMAIL,
          password: "x",
          firstName: "Alice",
          lastName: "Anderson",
          role: "client",
          kycStatus: "verified",
        },
        {
          username: "task284-dash-client-b",
          email: CLIENT_B_EMAIL,
          password: "x",
          // Blank name — exercises the email-fallback path in clientName.
          firstName: "",
          lastName: "",
          role: "client",
          kycStatus: "verified",
        },
      ])
      .returning({ id: users.id, email: users.email });

    clientAId = insertedClients.find((r) => r.email === CLIENT_A_EMAIL)!.id;
    clientBId = insertedClients.find((r) => r.email === CLIENT_B_EMAIL)!.id;

    await db.insert(adviserClients).values([
      {
        adviserUserId: adviserId,
        clientUserId: clientAId,
        relationshipType: "servicing",
        isActive: true,
      },
      {
        adviserUserId: adviserId,
        clientUserId: clientBId,
        relationshipType: "servicing",
        isActive: true,
      },
    ]);

    // Two issued + one accepted + one draft = 3 active for client A.
    // One declined = 0 active for client B.
    const advice = await db
      .insert(adviceRecords)
      .values([
        { clientId: clientAId, adviserId, status: "issued" },
        { clientId: clientAId, adviserId, status: "accepted" },
        { clientId: clientAId, adviserId, status: "issued" },
        { clientId: clientAId, adviserId, status: "draft" },
        { clientId: clientBId, adviserId, status: "declined" },
      ])
      .returning({ id: adviceRecords.id });
    adviceRecordIds = advice.map((r) => r.id);

    // One fee consent expiring in 5 days for client B (blank name → email).
    // One fee consent expiring in 200 days for client A (outside window).
    const inFiveDays = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const in200Days = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const consents = await db
      .insert(feeConsents)
      .values([
        {
          adviceRecordId: advice[0].id,
          clientId: clientBId,
          adviserId,
          feeType: "ongoing_service_fee",
          amountType: "fixed",
          amount: "100",
          accountNumber: "ACC-B",
          deductionFrequency: "monthly",
          referenceDay: yesterday,
          renewalWindowStart: yesterday,
          renewalWindowEnd: inFiveDays,
          consentExpiryDate: inFiveDays,
          renewalStatus: "active",
          clientSignatureName: "Test",
        },
        {
          adviceRecordId: advice[0].id,
          clientId: clientAId,
          adviserId,
          feeType: "ongoing_service_fee",
          amountType: "fixed",
          amount: "200",
          accountNumber: "ACC-A",
          deductionFrequency: "monthly",
          referenceDay: yesterday,
          renewalWindowStart: yesterday,
          renewalWindowEnd: in200Days,
          consentExpiryDate: in200Days,
          renewalStatus: "active",
          clientSignatureName: "Test",
        },
      ])
      .returning({ id: feeConsents.id });
    feeConsentIds = consents.map((r) => r.id);
  });

  afterAll(cleanup);

  it("counts only issued + accepted advice records as active", async () => {
    const summary = await getAdviserDashboardSummary(adviserId);
    expect(summary.adviceRecordsActive).toBe(3);
  });

  it("returns expiring fee consent detail with resolved client name", async () => {
    const summary = await getAdviserDashboardSummary(adviserId);
    expect(summary.feeConsentsExpiringSoon).toBe(1);
    expect(summary.expiringFeeConsentDetail).toHaveLength(1);

    const [detail] = summary.expiringFeeConsentDetail;
    expect(detail.clientUserId).toBe(clientBId);
    // Blank name → falls back to email via clientDisplayName.
    expect(detail.clientName).toBe(CLIENT_B_EMAIL);
    expect(typeof detail.expiryDate).toBe("string");
    expect(detail.feeConsentId).toBeGreaterThan(0);
  });

  it("preserves existing summary fields", async () => {
    const summary = await getAdviserDashboardSummary(adviserId);
    expect(summary.linkedClients).toBe(2);
    expect(summary.openTasks).toBeGreaterThanOrEqual(0);
    expect(summary.pendingReports).toBeGreaterThanOrEqual(0);
  });
});
