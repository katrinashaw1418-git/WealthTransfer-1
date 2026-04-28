import {
  buildExternalUserId,
  getApplicantStatus as defaultGetApplicantStatus,
  loadSumsubConfigFromEnv,
  SumsubApiError,
  type SumsubApplicantSnapshot,
  type SumsubConfig,
  type SumsubStepVerdict,
} from "./sumsub.js";
import { buildComplianceOverview as defaultBuildComplianceOverview } from "./compliance-overview.js";
import type {
  ComplianceStepStatus,
  ComplianceSumsubBlock,
  KycStateResponse,
} from "@shared/schema";

const KYC_STATE_CACHE_MS = 15_000;

interface CacheEntry {
  snapshot: SumsubApplicantSnapshot;
  expiresAt: number;
}

const kycStateCache = new Map<string, CacheEntry>();

export function _resetKycStateCacheForTests(): void {
  kycStateCache.clear();
}

export async function getKycStateCached(
  externalUserId: string,
  config: SumsubConfig,
  getApplicantStatusFn: typeof defaultGetApplicantStatus = defaultGetApplicantStatus,
  now: () => number = Date.now,
): Promise<SumsubApplicantSnapshot> {
  const t = now();
  const hit = kycStateCache.get(externalUserId);
  if (hit && hit.expiresAt > t) return hit.snapshot;
  const snapshot = await getApplicantStatusFn(externalUserId, config);
  kycStateCache.set(externalUserId, { snapshot, expiresAt: t + KYC_STATE_CACHE_MS });
  return snapshot;
}

export function verdictToStepStatus(verdict: SumsubStepVerdict): ComplianceStepStatus {
  switch (verdict) {
    case "approved":     return "completed";
    case "rejected":     return "rejected";
    case "retry":        return "action_required";
    case "review":       return "review";
    case "in_progress":  return "in_progress";
    case "not_started":
    default:             return "action_required";
  }
}

export function describeSumsubStep(
  verdict: SumsubStepVerdict,
  stepLabel: "Identity document" | "Liveness check" | "AML / PEP screening",
): string {
  switch (verdict) {
    case "approved":     return `${stepLabel} verified`;
    case "rejected":     return `${stepLabel} rejected — please contact support`;
    case "retry":        return `${stepLabel} needs another attempt`;
    case "review":       return `${stepLabel} under review`;
    case "in_progress":  return `${stepLabel} in progress`;
    case "not_started":
    default:             return `${stepLabel} not started`;
  }
}

export function mergeSnapshotIntoSteps(
  snapshot: SumsubApplicantSnapshot,
  fallback: ComplianceSumsubBlock["steps"],
): ComplianceSumsubBlock["steps"] {
  return {
    identity: {
      key: fallback.identity.key,
      status: verdictToStepStatus(snapshot.identity),
      description: describeSumsubStep(snapshot.identity, "Identity document"),
      completedAt:
        snapshot.identity === "approved"
          ? snapshot.reviewedAt ?? fallback.identity.completedAt
          : null,
    },
    liveness: {
      key: fallback.liveness.key,
      status: verdictToStepStatus(snapshot.liveness),
      description: describeSumsubStep(snapshot.liveness, "Liveness check"),
      completedAt:
        snapshot.liveness === "approved"
          ? snapshot.reviewedAt ?? fallback.liveness.completedAt
          : null,
    },
    amlPep: {
      key: fallback.amlPep.key,
      status: verdictToStepStatus(snapshot.amlPep),
      description: describeSumsubStep(snapshot.amlPep, "AML / PEP screening"),
      completedAt:
        snapshot.amlPep === "approved"
          ? snapshot.reviewedAt ?? fallback.amlPep.completedAt
          : null,
    },
    // Source-of-funds is driven by AMAX's own wealth-application flow, not
    // by Sumsub. Keep the overview's mapping unchanged so the page reflects
    // the real underwriting state.
    sourceOfFunds: fallback.sourceOfFunds,
  };
}

export interface LoadKycStateDeps {
  buildComplianceOverviewFn?: typeof defaultBuildComplianceOverview;
  getApplicantStatusFn?: typeof defaultGetApplicantStatus;
  loadConfigFn?: typeof loadSumsubConfigFromEnv;
}

export type LoadKycStateResult =
  | { kind: "ok"; response: KycStateResponse }
  | { kind: "not_found" };

/**
 * Load per-step KYC state for a user.
 *
 * Falls back to the overall-status mapping produced by `buildComplianceOverview`
 * when:
 *   - Sumsub isn't configured for this environment, OR
 *   - the upstream call to Sumsub fails for ANY reason other than a 404 (which
 *     `getApplicantStatus` already maps to a legitimate `not_started` snapshot).
 *
 * The fallback path is essential: returning a partial Sumsub snapshot when
 * `/requiredIdDocsStatus` is unreachable would silently mislabel verified
 * users as "Action required".
 */
export async function loadKycState(
  userId: number,
  deps: LoadKycStateDeps = {},
): Promise<LoadKycStateResult> {
  const buildComplianceOverviewFn = deps.buildComplianceOverviewFn ?? defaultBuildComplianceOverview;
  const getApplicantStatusFn = deps.getApplicantStatusFn ?? defaultGetApplicantStatus;
  const loadConfigFn = deps.loadConfigFn ?? loadSumsubConfigFromEnv;

  const overview = await buildComplianceOverviewFn(userId);
  if (!overview) return { kind: "not_found" };

  const fallback: KycStateResponse = {
    source: "fallback",
    steps: overview.sumsub.steps,
  };

  const config = loadConfigFn();
  if (!config) return { kind: "ok", response: fallback };

  try {
    const externalUserId = buildExternalUserId(userId);
    const snapshot = await getKycStateCached(externalUserId, config, getApplicantStatusFn);
    const merged = mergeSnapshotIntoSteps(snapshot, overview.sumsub.steps);
    return { kind: "ok", response: { source: "sumsub", steps: merged } };
  } catch (err) {
    if (err instanceof SumsubApiError) {
      console.warn("[sumsub] getApplicantStatus upstream error", err.upstreamStatus);
    } else {
      console.warn("[sumsub] getApplicantStatus failed", err);
    }
    return { kind: "ok", response: fallback };
  }
}
