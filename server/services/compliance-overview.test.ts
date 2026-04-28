// =============================================================================
// Task #373 — Compliance overview view derivation tests.
// -----------------------------------------------------------------------------
// Pins the contract that `/api/compliance/overview` reflects the user's real
// KYC record (kycStatus, userTier, kycUpdatedAt, createdAt) and the latest
// fact-find / risk-profile / wealth-application rows — instead of the old
// hard-coded placeholder content the page used to render.
//
// Cases covered:
//
//   1. Brand-new pending user — sumsub steps are "action required", the
//      derived applicant id matches the deterministic AMAX-W-{userId} format,
//      lastVerifiedAt is null, and the tier pill is the pending-verification
//      pill.
//
//   2. Verified standard-tier user with a fact-find but no risk profile yet —
//      sumsub steps come back "completed" with the kycUpdatedAt timestamp,
//      risk assessment is "in_progress", wholesale certification is "locked",
//      the wholesale upgrade pill is "in_progress", and the re-verification
//      due date is exactly kycUpdatedAt + 1y.
//
//   3. Verified premium-tier user with a risk profile — both AMAX steps are
//      "completed", the wholesale upgrade pill flips to "completed_wholesale",
//      and the gating-banner-suppressing state is reflected on the view.
//
// Run with:  npx vitest run server/services/compliance-overview.test.ts
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  factFindSnapshots,
  riskProfiles,
  users,
  deriveSumsubApplicantId,
} from "@shared/schema";
import { buildComplianceOverview, __test__ } from "./compliance-overview";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function createTestUser(opts: {
  kycStatus: "pending" | "verified" | "rejected" | "not_required";
  userTier: "standard" | "premium" | "professional" | "wholesale" | "hnwi";
  kycUpdatedAt?: Date | null;
  createdAt?: Date | null;
}): Promise<number> {
  const suffix = uniqueSuffix();
  const [u] = await db
    .insert(users)
    .values({
      username: `compliance-overview-test-${suffix}`,
      email: `compliance-overview-test-${suffix}@test.invalid`,
      password: "not-a-real-password",
      firstName: "Compliance",
      lastName: "Test",
      kycStatus: opts.kycStatus,
      userTier: opts.userTier,
      emailVerified: true,
    })
    .returning({ id: users.id });

  // We backfill kycUpdatedAt / createdAt explicitly so the assertions on the
  // re-verification due date can use a known anchor.
  const patch: Partial<typeof users.$inferInsert> = {};
  if (opts.kycUpdatedAt !== undefined) patch.kycUpdatedAt = opts.kycUpdatedAt;
  if (opts.createdAt !== undefined) patch.createdAt = opts.createdAt;
  if (Object.keys(patch).length > 0) {
    await db.update(users).set(patch).where(eq(users.id, u.id));
  }
  return u.id;
}

async function insertFactFind(userId: number, isComplete = true): Promise<number> {
  const [row] = await db
    .insert(factFindSnapshots)
    .values({
      clientId: userId,
      isComplete,
      rawAnswers: { source: "compliance-overview-test" },
    })
    .returning({ id: factFindSnapshots.id });
  return row.id;
}

async function insertRiskProfile(
  userId: number,
  factFindSnapshotId: number,
): Promise<number> {
  const [row] = await db
    .insert(riskProfiles)
    .values({
      clientId: userId,
      factFindSnapshotId,
      behaviouralScore: 50,
      capacityAdjustment: 0,
      finalScore: 50,
      riskBand: "balanced",
      recommendedPortfolio: "balanced_default",
      overrideApplied: false,
      overrideReasons: [],
      allocation: { cash: 10, bonds: 30, equities: 40, alternatives: 15, crypto: 5 },
      scoringInputs: { source: "compliance-overview-test" },
    })
    .returning({ id: riskProfiles.id });
  return row.id;
}

const createdUserIds: number[] = [];

afterAll(async () => {
  if (createdUserIds.length === 0) return;
  // Cascade clean — risk profiles → fact finds → users.
  await db.delete(riskProfiles).where(inArray(riskProfiles.clientId, createdUserIds));
  await db
    .delete(factFindSnapshots)
    .where(inArray(factFindSnapshots.clientId, createdUserIds));
  await db.delete(users).where(inArray(users.id, createdUserIds));
});

describe("buildComplianceOverview — Task #373", () => {
  it("returns null for a missing user id", async () => {
    const view = await buildComplianceOverview(-1);
    expect(view).toBeNull();
  });

  it("renders pending KYC as action-required and uses the deterministic applicant id", async () => {
    const createdAt = new Date("2025-01-15T00:00:00Z");
    const userId = await createTestUser({
      kycStatus: "pending",
      userTier: "standard",
      createdAt,
      kycUpdatedAt: createdAt,
    });
    createdUserIds.push(userId);

    const view = await buildComplianceOverview(userId);
    expect(view).not.toBeNull();
    if (!view) return;

    expect(view.sumsub.applicantId).toBe(deriveSumsubApplicantId(userId));
    expect(view.sumsub.lastVerifiedAt).toBeNull();
    expect(view.sumsub.sessionState).toBe("session_active");
    expect(view.sumsub.steps.identity.status).toBe("action_required");
    expect(view.sumsub.steps.liveness.status).toBe("action_required");
    expect(view.sumsub.steps.amlPep.status).toBe("action_required");
    expect(view.tier.label).toBe("Verification pending");
    expect(view.amax.riskAssessment.status).toBe("action_required");
    expect(view.amax.wholesaleCertification.status).toBe("locked");
    // Locked steps don't count against progress.
    expect(view.progress.total).toBe(5);
    expect(view.progress.complete).toBe(0);
    expect(view.classification.reverificationDueAt).toBeNull();
    expect(view.classification.remainingDays).toBeNull();
  });

  it("verified standard user with a fact-find shows risk assessment in progress and wholesale locked", async () => {
    const verifiedAt = new Date("2025-08-02T00:00:00Z");
    const now = new Date("2026-05-01T00:00:00Z");
    const userId = await createTestUser({
      kycStatus: "verified",
      userTier: "standard",
      createdAt: verifiedAt,
      kycUpdatedAt: verifiedAt,
    });
    createdUserIds.push(userId);
    await insertFactFind(userId, true);

    const view = await buildComplianceOverview(userId, now);
    expect(view).not.toBeNull();
    if (!view) return;

    expect(view.tier.label).toBe("Tier 1 verified");
    expect(view.tier.tone).toBe("blue");
    expect(view.sumsub.sessionState).toBe("verified");
    expect(view.sumsub.lastVerifiedAt).toBe(verifiedAt.toISOString());
    expect(view.sumsub.steps.identity.status).toBe("completed");
    expect(view.sumsub.steps.identity.completedAt).toBe(verifiedAt.toISOString());
    expect(view.sumsub.steps.liveness.status).toBe("completed");
    expect(view.sumsub.steps.amlPep.status).toBe("completed");
    expect(view.amax.riskAssessment.status).toBe("in_progress");
    expect(view.amax.wholesaleCertification.status).toBe("locked");
    expect(view.wholesaleUpgrade.state).toBe("in_progress");

    // Re-verification anchor = kycUpdatedAt + 365d. Compare ISO strings to
    // avoid intermittent millisecond drift.
    const expectedDue = new Date(
      verifiedAt.getTime() + __test__.REVERIFICATION_INTERVAL_DAYS * MS_PER_DAY,
    );
    expect(view.classification.reverificationDueAt).toBe(expectedDue.toISOString());
    expect(view.classification.remainingDays).toBe(
      Math.ceil((expectedDue.getTime() - now.getTime()) / MS_PER_DAY),
    );

    // Progress counter buckets — 3 sumsub completed; sourceOfFunds = action;
    // riskAssessment = in_progress (under_review bucket); wholesaleCert is
    // locked and excluded.
    expect(view.progress.total).toBe(5);
    expect(view.progress.complete).toBe(3);
    expect(view.progress.actionRequired).toBe(1);
    expect(view.progress.underReview).toBe(1);
    expect(view.progress.percent).toBe(60);
  });

  it("verified premium-tier user with a risk profile completes both AMAX steps and shows wholesale verified", async () => {
    const verifiedAt = new Date("2025-06-01T00:00:00Z");
    const userId = await createTestUser({
      kycStatus: "verified",
      userTier: "premium",
      createdAt: verifiedAt,
      kycUpdatedAt: verifiedAt,
    });
    createdUserIds.push(userId);
    const factFindId = await insertFactFind(userId, true);
    await insertRiskProfile(userId, factFindId);

    const view = await buildComplianceOverview(userId);
    expect(view).not.toBeNull();
    if (!view) return;

    expect(view.tier.label).toBe("Tier 2 wholesale");
    expect(view.tier.tone).toBe("green");
    expect(view.amax.riskAssessment.status).toBe("completed");
    expect(view.amax.wholesaleCertification.status).toBe("completed");
    expect(view.wholesaleUpgrade.state).toBe("completed_wholesale");
    expect(view.classification.currentTierLabel).toBe("Tier 2 — Wholesale");
    expect(view.classification.wholesaleUpgradeNote).toBe(
      "Wholesale upgrade: complete",
    );
    // Identity (3) + sourceOfFunds + risk + wholesale = 6 totalled steps, no
    // locked exclusions. sourceOfFunds is action_required (no wealth app).
    expect(view.progress.total).toBe(6);
    expect(view.progress.complete).toBe(5);
    expect(view.progress.actionRequired).toBe(1);
    expect(view.progress.underReview).toBe(0);
  });

  it("treats the 'professional' tier alias as wholesale-equivalent", async () => {
    // The seeded `wiseinvestor` demo account ships with userTier='professional'.
    // The wholesale set used elsewhere (sidebar.tsx, adviser/client-detail.tsx)
    // includes "professional" / "wholesale" alongside "premium" / "hnwi", so
    // the compliance page must do the same instead of falling back to Tier 1.
    const verifiedAt = new Date("2025-09-15T00:00:00Z");
    const userId = await createTestUser({
      kycStatus: "verified",
      userTier: "professional",
      createdAt: verifiedAt,
      kycUpdatedAt: verifiedAt,
    });
    createdUserIds.push(userId);

    const view = await buildComplianceOverview(userId);
    expect(view).not.toBeNull();
    if (!view) return;

    expect(view.tier.label).toBe("Tier 2 wholesale");
    expect(view.classification.currentTierLabel).toBe("Tier 2 — Wholesale");
    expect(view.amax.wholesaleCertification.status).toBe("completed");
    expect(view.wholesaleUpgrade.state).toBe("completed_wholesale");
  });
});
