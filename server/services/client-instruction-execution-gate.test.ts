// =============================================================================
// Slice 5 — client instruction consent vs live advice execution gate
// -----------------------------------------------------------------------------
// Ensures `consentClientInstruction` refuses (403 + audit) when the linked
// advice_record_id exists but canExecute() fails, and allows consent when the
// gate passes or when no advice record is linked (legacy shelf).
// =============================================================================

import "../../scripts/_bootstrap-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";

import { db } from "../db";
import {
  adviceRecords,
  adviserClients,
  auditLogs,
  feeConsents,
  investmentInstructions,
  investmentProducts,
  users,
} from "@shared/schema";
import { consentClientInstruction } from "./adviser-access";
import { ExecutionGateBlockedError } from "./execution-gate";

const TAG = `t515-${Date.now()}`;

let adviserUserId = 0;
let clientUserId = 0;
let productId = 0;
let blockedAdviceId = 0;
let happyAdviceId = 0;
let happyConsentId = 0;

function futureConsentExpiry(): Date {
  return new Date(Date.now() + 365 * 24 * 3600 * 1000);
}

beforeAll(async () => {
  const [client] = await db
    .insert(users)
    .values({
      username: `${TAG}-client`,
      email: `${TAG}-client@test.local`,
      password: "x",
      firstName: "T515",
      lastName: "C",
      role: "client",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  const [adviser] = await db
    .insert(users)
    .values({
      username: `${TAG}-adv`,
      email: `${TAG}-adv@test.local`,
      password: "x",
      firstName: "T515",
      lastName: "A",
      role: "adviser",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  clientUserId = client.id;
  adviserUserId = adviser.id;

  await db.insert(adviserClients).values({
    adviserUserId,
    clientUserId,
    isActive: true,
  });

  const [prod] = await db
    .insert(investmentProducts)
    .values({
      name: `${TAG}-product`,
      category: "real_estate",
      subCategory: "first_mortgage",
      investmentStrategy: "fixture",
      targetNetIrr: "0.08",
      term: "12 months",
      structure: "trust",
      distributions: "monthly",
      liquidity: "low",
      minimumInvestment: "1000.00",
      riskProfile: "moderate",
      returnType: "income",
    })
    .returning();
  productId = prod.id;

  const issuedAt = new Date(Date.UTC(2026, 2, 1, 12, 0, 0));
  const viewedAt = new Date(Date.UTC(2026, 2, 2, 12, 0, 0));

  const [badAdvice] = await db
    .insert(adviceRecords)
    .values({
      clientId: clientUserId,
      adviserId: adviserUserId,
      adviceType: "personal",
      adviceSource: "hybrid",
      status: "issued",
      soaIssued: true,
      soaIssuedAt: issuedAt,
      soaViewed: true,
      soaViewedAt: viewedAt,
      adviceAccepted: false,
    })
    .returning();
  blockedAdviceId = badAdvice.id;

  const [goodAdvice] = await db
    .insert(adviceRecords)
    .values({
      clientId: clientUserId,
      adviserId: adviserUserId,
      adviceType: "personal",
      adviceSource: "hybrid",
      status: "issued",
      soaIssued: true,
      soaIssuedAt: issuedAt,
      soaViewed: true,
      soaViewedAt: viewedAt,
      adviceAccepted: true,
    })
    .returning();
  happyAdviceId = goodAdvice.id;

  const [fc] = await db
    .insert(feeConsents)
    .values({
      adviceRecordId: happyAdviceId,
      clientId: clientUserId,
      adviserId: adviserUserId,
      feeType: "ongoing_service_fee",
      amountType: "fixed",
      amount: "10.0000",
      deductionFrequency: "monthly",
      referenceDay: new Date(),
      renewalWindowStart: new Date(),
      renewalWindowEnd: futureConsentExpiry(),
      consentExpiryDate: futureConsentExpiry(),
      renewalStatus: "active",
      clientSignatureName: "T515 Client",
      accountNumber: `${TAG}-acct`,
    })
    .returning();
  happyConsentId = fc.id;
});

afterAll(async () => {
  await db
    .delete(investmentInstructions)
    .where(
      and(
        eq(investmentInstructions.adviserUserId, adviserUserId),
        eq(investmentInstructions.clientUserId, clientUserId),
      ),
    );
  if (happyConsentId) {
    await db.delete(feeConsents).where(eq(feeConsents.id, happyConsentId));
  }
  if (blockedAdviceId) {
    await db.delete(adviceRecords).where(eq(adviceRecords.id, blockedAdviceId));
  }
  if (happyAdviceId) {
    await db.delete(adviceRecords).where(eq(adviceRecords.id, happyAdviceId));
  }
  await db.delete(investmentProducts).where(eq(investmentProducts.id, productId));
  await db
    .delete(adviserClients)
    .where(
      and(
        eq(adviserClients.adviserUserId, adviserUserId),
        eq(adviserClients.clientUserId, clientUserId),
      ),
    );
  // Leave fixture users — audit_logs FK prevents deleting users after tests
  // wrote `client_instruction_consent_blocked_execution_gate` rows.
});

describe("consentClientInstruction — advice execution gate (Slice 5)", () => {
  it("refuses consent with ExecutionGateBlockedError when advice is not accepted", async () => {
    const [ins] = await db
      .insert(investmentInstructions)
      .values({
        adviserUserId,
        clientUserId,
        productId,
        action: "buy",
        amount: "500.00",
        status: "pending_consent",
        adviceRecordId: blockedAdviceId,
        adviceRecordNotLinked: false,
        expiresAt: futureConsentExpiry(),
      })
      .returning();

    let caught: unknown;
    try {
      await consentClientInstruction(clientUserId, ins.id);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExecutionGateBlockedError);
    expect(caught).toMatchObject({
      status: 403,
      gateReason: "advice_not_accepted",
    });

    const [blockedAudit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.userId, clientUserId),
          eq(auditLogs.action, "client_instruction_consent_blocked_execution_gate"),
          eq(auditLogs.entityId, String(ins.id)),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(blockedAudit).toBeTruthy();

    await db.delete(investmentInstructions).where(eq(investmentInstructions.id, ins.id));
  });

  it("allows consent when canExecute passes", async () => {
    const [ins] = await db
      .insert(investmentInstructions)
      .values({
        adviserUserId,
        clientUserId,
        productId,
        action: "buy",
        amount: "500.00",
        status: "pending_consent",
        adviceRecordId: happyAdviceId,
        feeConsentId: happyConsentId,
        adviceRecordNotLinked: false,
        expiresAt: futureConsentExpiry(),
      })
      .returning();

    const updated = await consentClientInstruction(clientUserId, ins.id);
    expect(updated.status).toBe("consented");

    await db.delete(investmentInstructions).where(eq(investmentInstructions.id, ins.id));
  });

  it("allows consent when no advice record is linked (legacy path)", async () => {
    const [ins] = await db
      .insert(investmentInstructions)
      .values({
        adviserUserId,
        clientUserId,
        productId,
        action: "buy",
        amount: "500.00",
        status: "pending_consent",
        adviceRecordId: null,
        adviceRecordNotLinked: true,
        expiresAt: futureConsentExpiry(),
      })
      .returning();

    const updated = await consentClientInstruction(clientUserId, ins.id);
    expect(updated.status).toBe("consented");

    await db.delete(investmentInstructions).where(eq(investmentInstructions.id, ins.id));
  });
});
