import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  loadKycState,
  mergeSnapshotIntoSteps,
  verdictToStepStatus,
  _resetKycStateCacheForTests,
} from "./kyc-state";
import { SumsubApiError, type SumsubApplicantSnapshot, type SumsubConfig } from "./sumsub";
import type { ComplianceOverview, ComplianceSumsubBlock } from "@shared/schema";

const FAKE_CONFIG: SumsubConfig = {
  appToken: "tkn",
  secretKey: "sec",
  levelName: "basic",
  baseUrl: "https://api.sumsub.example",
  ttlSecs: 600,
};

function makeFallbackSteps(): ComplianceSumsubBlock["steps"] {
  return {
    identity: {
      key: "identity",
      status: "in_progress",
      description: "fallback identity",
      completedAt: null,
    },
    liveness: {
      key: "liveness",
      status: "in_progress",
      description: "fallback liveness",
      completedAt: null,
    },
    amlPep: {
      key: "amlPep",
      status: "in_progress",
      description: "fallback amlPep",
      completedAt: null,
    },
    sourceOfFunds: {
      key: "sourceOfFunds",
      status: "action_required",
      description: "submit wealth application",
      completedAt: null,
    },
  };
}

function makeOverview(): ComplianceOverview {
  return {
    sumsub: {
      status: "in_progress",
      description: "verification in progress",
      steps: makeFallbackSteps(),
    },
    // The compliance page reads only `.sumsub` from the overview when building
    // the KYC-state response, so the rest of the structure is intentionally
    // omitted from this fixture; cast to the shared interface to keep the
    // test focused on the behavior under test.
  } as unknown as ComplianceOverview;
}

describe("kyc-state", () => {
  beforeEach(() => {
    _resetKycStateCacheForTests();
  });

  describe("verdictToStepStatus", () => {
    it("maps every verdict to a UI status", () => {
      expect(verdictToStepStatus("approved")).toBe("completed");
      expect(verdictToStepStatus("rejected")).toBe("rejected");
      expect(verdictToStepStatus("retry")).toBe("action_required");
      expect(verdictToStepStatus("review")).toBe("review");
      expect(verdictToStepStatus("in_progress")).toBe("in_progress");
      expect(verdictToStepStatus("not_started")).toBe("action_required");
    });
  });

  describe("mergeSnapshotIntoSteps", () => {
    it("uses Sumsub's reviewedAt for approved steps and falls back otherwise", () => {
      const reviewedAt = "2026-04-28T05:00:00.000Z";
      const fallback = makeFallbackSteps();
      fallback.identity.completedAt = "2026-01-01T00:00:00.000Z";
      const snapshot: SumsubApplicantSnapshot = {
        applicantId: "abc",
        identity: "approved",
        liveness: "review",
        amlPep: "approved",
        reviewedAt,
      };
      const merged = mergeSnapshotIntoSteps(snapshot, fallback);
      expect(merged.identity.status).toBe("completed");
      expect(merged.identity.completedAt).toBe(reviewedAt);
      expect(merged.liveness.status).toBe("review");
      expect(merged.liveness.completedAt).toBeNull();
      expect(merged.amlPep.status).toBe("completed");
      expect(merged.amlPep.completedAt).toBe(reviewedAt);
      // Source-of-funds is intentionally untouched by Sumsub.
      expect(merged.sourceOfFunds).toBe(fallback.sourceOfFunds);
    });
  });

  describe("loadKycState — endpoint contract", () => {
    it("returns source=fallback when Sumsub is not configured", async () => {
      const result = await loadKycState(7, {
        buildComplianceOverviewFn: async () => makeOverview(),
        loadConfigFn: () => null,
        getApplicantStatusFn: vi.fn(),
      });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.response.source).toBe("fallback");
      expect(result.response.steps).toEqual(makeFallbackSteps());
    });

    it("returns source=sumsub with merged per-step verdicts on success", async () => {
      const snapshot: SumsubApplicantSnapshot = {
        applicantId: "abc",
        identity: "approved",
        liveness: "approved",
        amlPep: "approved",
        reviewedAt: "2026-04-28T05:00:00.000Z",
      };
      const result = await loadKycState(7, {
        buildComplianceOverviewFn: async () => makeOverview(),
        loadConfigFn: () => FAKE_CONFIG,
        getApplicantStatusFn: async () => snapshot,
      });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.response.source).toBe("sumsub");
      expect(result.response.steps.identity.status).toBe("completed");
      expect(result.response.steps.liveness.status).toBe("completed");
      expect(result.response.steps.amlPep.status).toBe("completed");
    });

    it("falls back to overview-mapped steps when /requiredIdDocsStatus fails (500)", async () => {
      // Regression guard for Task #404 — the helper used to swallow the
      // /requiredIdDocsStatus error and return a partial snapshot with
      // identity/liveness="not_started", which the route then served as
      // `source: "sumsub"`. That mislabeled already-verified users as
      // "Action required". The contract is now: any non-404 upstream
      // failure must surface as the overview-mapped fallback.
      const overview = makeOverview();
      const result = await loadKycState(7, {
        buildComplianceOverviewFn: async () => overview,
        loadConfigFn: () => FAKE_CONFIG,
        getApplicantStatusFn: async () => {
          throw new SumsubApiError("requiredIdDocsStatus failed", 500, "internal error");
        },
      });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.response.source).toBe("fallback");
      expect(result.response.steps).toEqual(overview.sumsub.steps);
    });

    it("falls back when the upstream call throws a non-API error too", async () => {
      const overview = makeOverview();
      const result = await loadKycState(7, {
        buildComplianceOverviewFn: async () => overview,
        loadConfigFn: () => FAKE_CONFIG,
        getApplicantStatusFn: async () => {
          throw new Error("ECONNRESET");
        },
      });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.response.source).toBe("fallback");
      expect(result.response.steps).toEqual(overview.sumsub.steps);
    });

    it("returns not_found when the user has no compliance overview", async () => {
      const result = await loadKycState(404, {
        buildComplianceOverviewFn: async () => null,
        loadConfigFn: () => FAKE_CONFIG,
        getApplicantStatusFn: vi.fn(),
      });
      expect(result.kind).toBe("not_found");
    });

    it("caches the upstream snapshot for repeat callers", async () => {
      const snapshot: SumsubApplicantSnapshot = {
        applicantId: "abc",
        identity: "approved",
        liveness: "approved",
        amlPep: "approved",
        reviewedAt: null,
      };
      const upstream = vi.fn(async () => snapshot);
      const overviewFn = async () => makeOverview();
      const opts = {
        buildComplianceOverviewFn: overviewFn,
        loadConfigFn: () => FAKE_CONFIG,
        getApplicantStatusFn: upstream,
      };
      await loadKycState(7, opts);
      await loadKycState(7, opts);
      await loadKycState(7, opts);
      expect(upstream).toHaveBeenCalledTimes(1);
    });
  });
});
