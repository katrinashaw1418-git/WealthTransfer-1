// =============================================================================
// TASK #373 — Build the client KYC & compliance overview view.
// -----------------------------------------------------------------------------
// Pure function (modulo db reads) that derives the `ComplianceOverview` shape
// for a single user from the data we actually store today:
//
//   * `users.kycStatus`           — pending | verified | rejected | not_required
//   * `users.userTier`            — standard | premium | hnwi
//   * `users.kycUpdatedAt`        — last KYC status change (re-verification anchor)
//   * `users.createdAt`           — account creation (Sumsub applicant created date)
//   * latest `factFindSnapshots`  — risk assessment in progress
//   * latest `riskProfiles`       — risk assessment scoring complete
//   * latest `wealthApplications` — source-of-funds / wholesale onboarding state
//
// The page used to render hard-coded placeholder content (applicant
// `AMAX-W-00042`, "Completed 2 Aug 2025", static "1 under review" etc). Every
// pill, date, counter and applicant ID rendered by `/compliance` now flows
// through this single function so the UI stays in lock-step with the user's
// real record.
// =============================================================================

import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  factFindSnapshots,
  riskAssessmentResponses,
  riskProfiles,
  users,
  wealthApplications,
  deriveSumsubApplicantId,
  type ComplianceAmaxBlock,
  type ComplianceClassification,
  type ComplianceOverview,
  type ComplianceProgress,
  type ComplianceStep,
  type ComplianceStepStatus,
  type ComplianceSumsubBlock,
  type ComplianceTierPill,
  type ComplianceWholesalePill,
} from "@shared/schema";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REVERIFICATION_INTERVAL_DAYS = 365;

// Tier classification — mirrors the wholesale set used elsewhere in the app
// (client/src/components/layout/sidebar.tsx, adviser/client-detail.tsx) so the
// compliance page matches the rest of the product. Keep in sync with those
// callers if we ever add another wholesale-equivalent tier value.
const HNWI_TIERS = new Set(["hnwi"]);
const WHOLESALE_TIERS = new Set(["premium", "professional", "wholesale"]);

function isHnwiTier(tier: string): boolean {
  return HNWI_TIERS.has((tier || "").toLowerCase());
}

function isWholesaleTier(tier: string): boolean {
  const v = (tier || "").toLowerCase();
  return WHOLESALE_TIERS.has(v) || HNWI_TIERS.has(v);
}

function formatVerifiedDate(d: Date | null): string {
  if (!d) return "";
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function buildSumsubStep(
  key: string,
  kycStatus: string,
  kycUpdatedAt: Date | null,
): ComplianceStep {
  if (kycStatus === "verified") {
    return {
      key,
      status: "completed",
      description: kycUpdatedAt
        ? `Completed ${formatVerifiedDate(kycUpdatedAt)}`
        : "Completed",
      completedAt: kycUpdatedAt ? kycUpdatedAt.toISOString() : null,
    };
  }
  if (kycStatus === "rejected") {
    return {
      key,
      status: "rejected",
      description: "Verification rejected — please contact support",
      completedAt: null,
    };
  }
  if (kycStatus === "not_required") {
    return {
      key,
      status: "completed",
      description: "Not required for this account type",
      completedAt: null,
    };
  }
  // pending (default)
  return {
    key,
    status: "action_required",
    description: "Awaiting verification — start your Sumsub session",
    completedAt: null,
  };
}

function buildSourceOfFundsStep(
  kycStatus: string,
  app: { status: string; createdAt: Date | null } | null,
): ComplianceStep {
  // No wealth onboarding application yet — track the basic KYC signal.
  if (!app) {
    if (kycStatus === "verified") {
      return {
        key: "source_of_funds",
        status: "action_required",
        description: "Submit a source-of-funds declaration to unlock wholesale access",
        completedAt: null,
      };
    }
    return {
      key: "source_of_funds",
      status: "action_required",
      description: "Complete identity verification first",
      completedAt: null,
    };
  }
  switch (app.status) {
    case "approved":
      return {
        key: "source_of_funds",
        status: "completed",
        description: app.createdAt
          ? `Approved ${formatVerifiedDate(app.createdAt)}`
          : "Approved",
        completedAt: app.createdAt ? app.createdAt.toISOString() : null,
      };
    case "rejected":
      return {
        key: "source_of_funds",
        status: "rejected",
        description: "Declaration rejected — please resubmit",
        completedAt: null,
      };
    case "under_review":
      return {
        key: "source_of_funds",
        status: "review",
        description: "Awaiting AMAX review · 1–2 business days",
        completedAt: null,
      };
    case "pending":
    default:
      return {
        key: "source_of_funds",
        status: "review",
        description: "Declaration submitted — under AMAX compliance review",
        completedAt: null,
      };
  }
}

function buildRiskAssessmentStep(
  hasRiskProfile: boolean,
  riskProfileCreatedAt: Date | null,
  hasFactFind: boolean,
  factFindCreatedAt: Date | null,
  factFindIsComplete: boolean,
  riskAssessmentResponse: {
    status: string;
    submittedAt: Date | null;
    updatedAt: Date | null;
  } | null,
): ComplianceStep {
  // Task #375 introduced a dedicated risk-assessment questionnaire stored in
  // `risk_assessment_responses`. Treat a submitted response as authoritative,
  // an in-progress response as the "Continue questionnaire" state, and fall
  // back to the legacy fact-find / risk-profile signals otherwise.
  if (riskAssessmentResponse?.status === "complete") {
    const ts = riskAssessmentResponse.submittedAt ?? riskAssessmentResponse.updatedAt;
    return {
      key: "risk_assessment",
      status: "completed",
      description: ts ? `Completed ${formatVerifiedDate(ts)}` : "Completed",
      completedAt: ts ? ts.toISOString() : null,
    };
  }
  if (hasRiskProfile) {
    return {
      key: "risk_assessment",
      status: "completed",
      description: riskProfileCreatedAt
        ? `Completed ${formatVerifiedDate(riskProfileCreatedAt)}`
        : "Completed",
      completedAt: riskProfileCreatedAt ? riskProfileCreatedAt.toISOString() : null,
    };
  }
  if (riskAssessmentResponse?.status === "in_progress") {
    const startedAt = riskAssessmentResponse.updatedAt;
    return {
      key: "risk_assessment",
      status: "in_progress",
      description: startedAt
        ? `Started ${formatVerifiedDate(startedAt)} · Continue questionnaire`
        : "In progress · Continue questionnaire",
      completedAt: null,
    };
  }
  if (hasFactFind) {
    return {
      key: "risk_assessment",
      status: "in_progress",
      description: factFindIsComplete
        ? "Fact-find submitted — scoring in progress"
        : factFindCreatedAt
          ? `Started ${formatVerifiedDate(factFindCreatedAt)} · Continue questionnaire`
          : "In progress · Continue questionnaire",
      completedAt: null,
    };
  }
  return {
    key: "risk_assessment",
    status: "action_required",
    description: "Your action required",
    completedAt: null,
  };
}

function buildWholesaleCertificationStep(
  hasRiskProfile: boolean,
  userTier: string,
  kycUpdatedAt: Date | null,
): ComplianceStep {
  // Wholesale-equivalent tiers (premium / professional / wholesale / hnwi)
  // imply certification has already been accepted. We anchor the completion
  // date on kycUpdatedAt because we don't currently persist a separate
  // "wholesale certified at" timestamp.
  if (isWholesaleTier(userTier)) {
    return {
      key: "wholesale_certification",
      status: "completed",
      description: kycUpdatedAt
        ? `Completed ${formatVerifiedDate(kycUpdatedAt)}`
        : "Completed",
      completedAt: kycUpdatedAt ? kycUpdatedAt.toISOString() : null,
    };
  }
  if (!hasRiskProfile) {
    return {
      key: "wholesale_certification",
      status: "locked",
      description: "Locked — complete risk assessment first",
      completedAt: null,
    };
  }
  return {
    key: "wholesale_certification",
    status: "action_required",
    description: "Upload accountant certificate to upgrade",
    completedAt: null,
  };
}

function buildTierPill(kycStatus: string, userTier: string): ComplianceTierPill {
  if (kycStatus === "rejected") {
    return { label: "Verification rejected", tone: "amber" };
  }
  if (kycStatus !== "verified") {
    return { label: "Verification pending", tone: "amber" };
  }
  if (isHnwiTier(userTier)) {
    return { label: "Tier 3 HNWI", tone: "green" };
  }
  if (isWholesaleTier(userTier)) {
    return { label: "Tier 2 wholesale", tone: "green" };
  }
  return { label: "Tier 1 verified", tone: "blue" };
}

function buildWholesalePill(
  userTier: string,
  riskAssessment: ComplianceStep,
  wholesaleCert: ComplianceStep,
): ComplianceWholesalePill {
  if (isWholesaleTier(userTier)) {
    return { label: "Wholesale verified", state: "completed_wholesale" };
  }
  if (
    riskAssessment.status === "completed" &&
    wholesaleCert.status === "completed"
  ) {
    return { label: "Wholesale upgrade ready", state: "completed" };
  }
  if (
    riskAssessment.status === "in_progress" ||
    riskAssessment.status === "completed" ||
    wholesaleCert.status === "action_required" ||
    wholesaleCert.status === "in_progress"
  ) {
    return { label: "Wholesale upgrade in progress", state: "in_progress" };
  }
  return { label: null, state: "not_started" };
}

function countByOutcome(steps: ComplianceStep[]): {
  complete: number;
  actionRequired: number;
  underReview: number;
} {
  let complete = 0;
  let actionRequired = 0;
  let underReview = 0;
  for (const s of steps) {
    if (s.status === "completed") complete++;
    else if (s.status === "review" || s.status === "in_progress") underReview++;
    else if (s.status === "action_required" || s.status === "rejected") actionRequired++;
    // "locked" is not counted in any bucket — it's blocked by another step.
  }
  return { complete, actionRequired, underReview };
}

function buildProgress(steps: ComplianceStep[]): ComplianceProgress {
  const counted = steps.filter((s) => s.status !== "locked");
  const total = counted.length;
  const { complete, actionRequired, underReview } = countByOutcome(counted);
  const percent = total === 0 ? 0 : Math.round((complete / total) * 100);
  return { percent, complete, actionRequired, underReview, total };
}

function buildClassification(
  kycStatus: string,
  userTier: string,
  kycUpdatedAt: Date | null,
  wholesaleStep: ComplianceStep,
  riskStep: ComplianceStep,
  now: Date,
): ComplianceClassification {
  const tierLabel =
    kycStatus !== "verified"
      ? "Pending verification"
      : isHnwiTier(userTier)
        ? "Tier 3 — HNWI"
        : isWholesaleTier(userTier)
          ? "Tier 2 — Wholesale"
          : "Tier 1 — Verified";

  let reverificationDueAt: Date | null = null;
  let remainingDays: number | null = null;
  if (kycStatus === "verified" && kycUpdatedAt) {
    reverificationDueAt = new Date(
      kycUpdatedAt.getTime() + REVERIFICATION_INTERVAL_DAYS * MS_PER_DAY,
    );
    remainingDays = Math.ceil(
      (reverificationDueAt.getTime() - now.getTime()) / MS_PER_DAY,
    );
  }

  let wholesaleUpgradeNote: string;
  if (isWholesaleTier(userTier)) {
    wholesaleUpgradeNote = "Wholesale upgrade: complete";
  } else {
    const pendingSteps: string[] = [];
    if (riskStep.status !== "completed") pendingSteps.push("A");
    if (wholesaleStep.status !== "completed") pendingSteps.push("B");
    wholesaleUpgradeNote =
      pendingSteps.length === 0
        ? "Wholesale upgrade: complete"
        : `Wholesale upgrade: pending step${
            pendingSteps.length > 1 ? "s" : ""
          } ${pendingSteps.join(" & ")}`;
  }

  return {
    currentTierLabel: tierLabel,
    reverificationDueAt: reverificationDueAt ? reverificationDueAt.toISOString() : null,
    remainingDays,
    wholesaleUpgradeNote,
  };
}

export async function buildComplianceOverview(
  userId: number,
  now: Date = new Date(),
): Promise<ComplianceOverview | null> {
  const [user] = await db
    .select({
      id: users.id,
      kycStatus: users.kycStatus,
      userTier: users.userTier,
      kycUpdatedAt: users.kycUpdatedAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) return null;

  const kycStatus = user.kycStatus;
  const userTier = user.userTier;
  const kycUpdatedAt = user.kycUpdatedAt ?? null;
  const createdAt = user.createdAt ?? now;

  // Fetch the latest fact-find / risk-profile / wealth-application / risk-
  // assessment rows in parallel — each is at most one row per user for the
  // purposes of this view.
  const [latestFactFind, latestRiskProfile, latestApp, latestRiskAssessment] = await Promise.all([
    db
      .select({
        id: factFindSnapshots.id,
        createdAt: factFindSnapshots.createdAt,
        isComplete: factFindSnapshots.isComplete,
      })
      .from(factFindSnapshots)
      .where(eq(factFindSnapshots.clientId, userId))
      .orderBy(desc(factFindSnapshots.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        id: riskProfiles.id,
        createdAt: riskProfiles.createdAt,
      })
      .from(riskProfiles)
      .where(eq(riskProfiles.clientId, userId))
      .orderBy(desc(riskProfiles.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        id: wealthApplications.id,
        status: wealthApplications.status,
        createdAt: wealthApplications.createdAt,
      })
      .from(wealthApplications)
      .where(eq(wealthApplications.userId, userId))
      .orderBy(desc(wealthApplications.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        status: riskAssessmentResponses.status,
        submittedAt: riskAssessmentResponses.submittedAt,
        updatedAt: riskAssessmentResponses.updatedAt,
      })
      .from(riskAssessmentResponses)
      .where(eq(riskAssessmentResponses.userId, userId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);

  // Sumsub steps (identity / liveness / AML-PEP) all share the same "kycStatus"
  // signal today — Sumsub is not yet integrated, so we cannot show per-step
  // outcomes. Once Sumsub webhooks land, this function is the only place that
  // needs to learn about per-step timestamps.
  const identity = buildSumsubStep("identity", kycStatus, kycUpdatedAt);
  const liveness = buildSumsubStep("liveness", kycStatus, kycUpdatedAt);
  const amlPep = buildSumsubStep("aml_pep", kycStatus, kycUpdatedAt);
  const sourceOfFunds = buildSourceOfFundsStep(
    kycStatus,
    latestApp
      ? { status: latestApp.status, createdAt: latestApp.createdAt ?? null }
      : null,
  );

  const riskAssessment = buildRiskAssessmentStep(
    !!latestRiskProfile,
    latestRiskProfile?.createdAt ?? null,
    !!latestFactFind,
    latestFactFind?.createdAt ?? null,
    !!latestFactFind?.isComplete,
    latestRiskAssessment
      ? {
          status: latestRiskAssessment.status,
          submittedAt: latestRiskAssessment.submittedAt ?? null,
          updatedAt: latestRiskAssessment.updatedAt ?? null,
        }
      : null,
  );

  // Wholesale certification gates on either the legacy risk-profile signal or
  // a completed task #375 risk-assessment response.
  const riskAssessmentSatisfied =
    !!latestRiskProfile || latestRiskAssessment?.status === "complete";

  const wholesaleCertification = buildWholesaleCertificationStep(
    riskAssessmentSatisfied,
    userTier,
    kycUpdatedAt,
  );

  const sumsub: ComplianceSumsubBlock = {
    applicantId: deriveSumsubApplicantId(user.id),
    createdAt: createdAt.toISOString(),
    lastVerifiedAt:
      kycStatus === "verified" && kycUpdatedAt ? kycUpdatedAt.toISOString() : null,
    sessionState:
      kycStatus === "verified"
        ? "verified"
        : kycStatus === "rejected"
          ? "rejected"
          : kycStatus === "pending"
            ? "session_active"
            : "not_started",
    steps: { identity, liveness, amlPep, sourceOfFunds },
  };

  const amax: ComplianceAmaxBlock = { riskAssessment, wholesaleCertification };

  const progress = buildProgress([
    identity,
    liveness,
    amlPep,
    sourceOfFunds,
    riskAssessment,
    wholesaleCertification,
  ]);

  const tier = buildTierPill(kycStatus, userTier);
  const wholesaleUpgrade = buildWholesalePill(
    userTier,
    riskAssessment,
    wholesaleCertification,
  );
  const classification = buildClassification(
    kycStatus,
    userTier,
    kycUpdatedAt,
    wholesaleCertification,
    riskAssessment,
    now,
  );

  return {
    tier,
    wholesaleUpgrade,
    progress,
    sumsub,
    amax,
    classification,
  };
}

// Re-export for tests.
export const __test__ = {
  buildSumsubStep,
  buildSourceOfFundsStep,
  buildRiskAssessmentStep,
  buildWholesaleCertificationStep,
  buildTierPill,
  buildWholesalePill,
  buildProgress,
  buildClassification,
  REVERIFICATION_INTERVAL_DAYS,
};

// Helper that exposes the status-bucket counter to tests independent of the
// rest of the build pipeline. Internal export used by the test file only.
export function _countByOutcomeForTest(steps: ComplianceStep[]): {
  complete: number;
  actionRequired: number;
  underReview: number;
} {
  return countByOutcome(steps);
}

export type { ComplianceStepStatus };
