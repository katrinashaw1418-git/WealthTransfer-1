// =============================================================================
// Task #395 — assert /api/portfolio/real-metrics and /api/ai-recommendations/
// generate agree on the rebalancing benchmark.
// =============================================================================
// Task #376 made both routes resolve their rebalancing benchmark from the
// client's latest recorded `risk_profiles` row when one exists, falling back
// to the equal-weight illustrative benchmark on real-metrics and to the
// band-derived illustrative benchmark on AI recs when no profile is on file.
// The original fix was verified by hand only: a future contributor changing
// either route could silently re-introduce the parity gap, and the only
// signal would be a user noticing that the two screens disagree.
//
// This file pins the contract end-to-end:
//
//   1. With a `risk_profiles` row on file, both endpoints return
//      `rebalancingBenchmarkType: "risk_profile_personalised"` AND a
//      numerically identical `rebalancingGap` (rounded to 1 dp on both
//      sides, since both routes round the percent to 1 dp before responding).
//
//   2. With no `risk_profiles` row, /api/portfolio/real-metrics returns
//      `equal_weight_illustrative`, and /api/ai-recommendations/generate
//      returns the band-derived illustrative type that matches the supplied
//      `riskTolerance` (1→conservative, 3→moderate, 5→aggressive).
//
// Implementation notes:
//   * Auth + KYC: AI recs requires verified KYC, real-metrics requires only
//     auth. We seed one verified user that satisfies both.
//   * The portfolio is a single AUD wallet so both routes see the same
//     allocation (100% fiat) regardless of the unit they total it up in
//     (real-metrics totals in AUD via convertToAud; AI recs totals in USD
//     via getFxRate). With one bucket non-zero the percentages line up.
//   * Real-metrics needs no FX rate for an AUD wallet (convertToAud short-
//     circuits on currency==="AUD"). AI recs needs an AUD↔USD rate for its
//     inline FX path; we upsert one as a test fixture so the suite is self-
//     sufficient against a dev DB that may or may not have it seeded. The
//     specific rate value does not affect the assertions: we only care that
//     fiat is the only non-zero bucket on both sides.
//   * The AI recs route writes ai_recommendations rows. We delete every row
//     for the test user in afterAll, alongside the wallet, risk profile, and
//     fact-find snapshot. The user row is intentionally left behind: matches
//     the convention used by kill-switch.test.ts and admin-routes-product-
//     risk-profile.test.ts, where leftover FK referrers (audit_logs and the
//     like) make a clean DELETE unsafe.
// =============================================================================

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// JWT_SECRET must land before any transitive import of server/auth.ts (which
// asserts the variable at module init outside local-dev). vi.hoisted runs
// before ES-module-hoisted imports below.
vi.hoisted(() => {
  process.env.JWT_SECRET ||= "task-395-portfolio-benchmark-parity-test-secret";
});

import express from "express";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Server } from "http";

import { db } from "./db";
import {
  adviceRecords,
  aiRecommendations,
  factFindSnapshots,
  fxRates,
  riskProfiles,
  users,
  wallets,
} from "@shared/schema";
import { signToken } from "./auth";
import { registerRoutes } from "./routes";

let testApp: express.Express;
let httpServer: Server;
let testUserId: number;
let testToken: string;
let factFindSnapshotId: number;
let seedKey: string;

// Both endpoints respond with `rebalancingGap` rounded to 1 dp. We assert
// equality on the rounded value rather than the raw float so the assertion
// is robust to tiny drift in the routes' totalling math (USD vs AUD unit
// choice).
//
// Two personalised allocations are exercised:
//   * CASH_ONLY (gap = 0)        — the simplest "everything matches" case.
//                                  Fiat weight = 1.0 so the 100% AUD wallet
//                                  collapses gap to 0 on both sides.
//   * MIXED    (gap ≈ 50%)       — a non-zero fixture so a regression in
//                                  the gap formula on either route would
//                                  trip the equality assertion. Risk-model
//                                  buckets {cash 50, equities 50} map via
//                                  resolveBenchmarkForRiskProfileRow to
//                                  {fiat 0.5, investment 0.5} which against
//                                  the 100% fiat wallet gives a gap of
//                                  0.5 × (|1−0.5| + 0 + 0 + 0.5) = 0.5
//                                  (50.0% after rounding).
const PERSONALISED_ALLOCATION_CASH_ONLY = {
  cash: 100,
  bonds: 0,
  equities: 0,
  alternatives: 0,
  crypto: 0,
};

const PERSONALISED_ALLOCATION_MIXED = {
  cash: 50,
  bonds: 0,
  equities: 50,
  alternatives: 0,
  crypto: 0,
};

beforeAll(async () => {
  seedKey = `t395_${randomBytes(4).toString("hex")}`;

  // Seed a verified KYC user. AI recs requires KYC; real-metrics does not but
  // sharing one user keeps cleanup simple. The username carries the seedKey
  // so a leftover row from a failed run cannot collide with a fresh one.
  const [created] = await db
    .insert(users)
    .values({
      username: `${seedKey}_client`,
      email: `${seedKey}@test.invalid`,
      password: "not-a-real-password",
      firstName: "Parity",
      lastName: "Test",
      role: "client",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  testUserId = created.id;
  testToken = signToken({
    userId: testUserId,
    username: created.username,
    email: created.email,
    role: "client",
  });

  // 100% fiat AUD wallet: one bucket non-zero so both endpoints' allocation
  // fractions read 100% fiat regardless of which currency unit they total in.
  await db.insert(wallets).values({
    userId: testUserId,
    currency: "AUD",
    balance: "10000.00",
    availableBalance: "10000.00",
    walletType: "fiat",
  });

  // AI recs needs an AUD↔USD rate for its inline `wallets.filter(walletType
  // === 'fiat')` FX path. We insert AUD→USD if missing so this test is self-
  // sufficient. The exact rate is irrelevant — only the bucket assignment
  // (fiat vs crypto vs stablecoin vs investment) matters for the assertions.
  const [existingAudUsd] = await db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.baseCurrency, "AUD"), eq(fxRates.targetCurrency, "USD")))
    .limit(1);
  if (!existingAudUsd) {
    await db.insert(fxRates).values({
      baseCurrency: "AUD",
      targetCurrency: "USD",
      rate: "0.66",
      spread: "0.01",
    });
  }

  // Risk-profile rows are FK-bound to a fact-find snapshot. Seed a minimal
  // one for this user; the contents do not affect benchmark resolution.
  const [snap] = await db
    .insert(factFindSnapshots)
    .values({
      clientId: testUserId,
      rawAnswers: { source: "task-395-test" },
      isComplete: true,
    })
    .returning();
  factFindSnapshotId = snap.id;

  // Spin up the production routes on an in-process express app. Mirroring
  // the trust-proxy + json setup from server/index.ts is unnecessary here:
  // neither route uses the rate limiter or req.ip in a way that affects
  // the assertions.
  testApp = express();
  testApp.use(express.json());
  httpServer = await registerRoutes(testApp);
}, 60_000);

afterAll(async () => {
  // Clean up anything we created. Leave the seed user behind to avoid the
  // DELETE-vs-FK problem documented at the top of this file.
  if (testUserId !== undefined) {
    await db.delete(aiRecommendations).where(eq(aiRecommendations.userId, testUserId));
    await db.delete(riskProfiles).where(eq(riskProfiles.clientId, testUserId));
    // Task #405 — drop any advice records the SoA-target tests inserted so
    // a re-run does not see stale issued targets driving the benchmark.
    await db.delete(adviceRecords).where(eq(adviceRecords.clientId, testUserId));
    await db.delete(factFindSnapshots).where(eq(factFindSnapshots.clientId, testUserId));
    await db.delete(wallets).where(eq(wallets.userId, testUserId));
  }
  if (httpServer && typeof httpServer.close === "function") {
    httpServer.close();
  }
});

beforeEach(async () => {
  // Each test starts with no risk profile on file — individual cases that
  // need one insert it themselves so the with/without-profile cases cannot
  // bleed across.
  await db.delete(riskProfiles).where(eq(riskProfiles.clientId, testUserId));
  // Task #405 — also wipe any advice_records the SoA preference tests left
  // behind so a subsequent risk-profile-only case is not silently shadowed
  // by a stale issued target.
  await db.delete(adviceRecords).where(eq(adviceRecords.clientId, testUserId));
  // Wipe any AI recommendations the previous case generated so each test
  // sees a clean slate (the route supersedes existing rows but leaves them
  // in place for audit; we just want predictable storage state).
  await db.delete(aiRecommendations).where(eq(aiRecommendations.userId, testUserId));
});

function getRealMetrics() {
  return request(testApp)
    .get("/api/portfolio/real-metrics")
    .set("Authorization", `Bearer ${testToken}`);
}

function postAiRecommendations(body: Record<string, unknown>) {
  return request(testApp)
    .post("/api/ai-recommendations/generate")
    .set("Authorization", `Bearer ${testToken}`)
    .send(body);
}

describe("portfolio ↔ AI-recs benchmark parity (Task #395)", () => {
  describe("with a recorded risk profile", () => {
    async function seedRiskProfile(
      allocation: typeof PERSONALISED_ALLOCATION_CASH_ONLY,
    ) {
      await db.insert(riskProfiles).values({
        clientId: testUserId,
        factFindSnapshotId,
        behaviouralScore: 30,
        capacityAdjustment: 0,
        finalScore: 30,
        riskBand: "conservative",
        recommendedPortfolio: "task-395-test",
        overrideApplied: false,
        overrideReasons: [],
        allocation,
        scoringInputs: { source: "task-395-test" },
      });
    }

    it("both endpoints report `risk_profile_personalised` with a matching zero gap when the personalised benchmark already matches the portfolio", async () => {
      // Cash-only personalised benchmark vs the 100% AUD wallet → expected
      // gap is exactly 0 on both sides. This is the simplest "everything
      // matches" case and pins the type assertion at minimum.
      // riskTolerance=3 is deliberate: if either route fell back to the
      // band-derived benchmark it would resolve to "moderate_illustrative",
      // which would fail the type assertion below — proving the personalised
      // path actually wins over the band fallback when a profile exists.
      await seedRiskProfile(PERSONALISED_ALLOCATION_CASH_ONLY);

      const real = await getRealMetrics();
      const ai = await postAiRecommendations({
        riskTolerance: 3,
        investmentHorizon: "5-10",
        investmentGoal: "growth",
      });

      expect(real.status).toBe(200);
      expect(ai.status).toBe(200);

      expect(real.body.rebalancingBenchmarkType).toBe("risk_profile_personalised");
      expect(ai.body.rebalancingBenchmarkType).toBe("risk_profile_personalised");

      // Both routes round the gap percent to 1 dp before responding. With a
      // 100% fiat portfolio and a cash-only personalised benchmark the gap
      // is exactly 0 on both sides — pin equality on the rounded number so
      // the assertion is robust to USD-vs-AUD totalling drift between routes.
      expect(typeof real.body.rebalancingGap).toBe("number");
      expect(typeof ai.body.rebalancingGap).toBe("number");
      expect(real.body.rebalancingGap).toBe(0);
      expect(ai.body.rebalancingGap).toBe(0);
    });

    it("both endpoints report the same NON-ZERO rebalancingGap when the personalised benchmark differs from the portfolio", async () => {
      // Mixed personalised benchmark ({cash 50, equities 50} → fiat 0.5,
      // investment 0.5) vs the 100% AUD wallet → expected gap is 50.0% on
      // both sides. This is the regression-sensitive case: a future change
      // that miscalculates the gap on EITHER route by even 0.1pp would
      // break the equality assertion below.
      await seedRiskProfile(PERSONALISED_ALLOCATION_MIXED);

      const real = await getRealMetrics();
      const ai = await postAiRecommendations({
        riskTolerance: 3,
        investmentHorizon: "5-10",
        investmentGoal: "growth",
      });

      expect(real.status).toBe(200);
      expect(ai.status).toBe(200);

      expect(real.body.rebalancingBenchmarkType).toBe("risk_profile_personalised");
      expect(ai.body.rebalancingBenchmarkType).toBe("risk_profile_personalised");

      // Sanity-check the expected non-zero value first (so a regression in
      // the gap formula on BOTH routes simultaneously cannot accidentally
      // pass via two-wrongs-make-a-right), THEN pin equality across routes.
      expect(real.body.rebalancingGap).toBe(50);
      expect(ai.body.rebalancingGap).toBe(50);
      expect(real.body.rebalancingGap).toBe(ai.body.rebalancingGap);
    });
  });

  describe("with no risk profile on file", () => {
    // riskTolerance → expected band-derived benchmark type. Mirrors the
    // ranges in resolveBenchmarkForRiskTolerance:
    //   <=2 → conservative, 3-4 → moderate, 5 → aggressive.
    const cases: Array<{
      label: string;
      riskTolerance: number;
      expectedAiType: string;
    }> = [
      { label: "1 → conservative", riskTolerance: 1, expectedAiType: "conservative_illustrative" },
      { label: "3 → moderate",     riskTolerance: 3, expectedAiType: "moderate_illustrative" },
      { label: "5 → aggressive",   riskTolerance: 5, expectedAiType: "aggressive_illustrative" },
    ];

    it("/api/portfolio/real-metrics falls back to equal_weight_illustrative", async () => {
      const real = await getRealMetrics();
      expect(real.status).toBe(200);
      expect(real.body.rebalancingBenchmarkType).toBe("equal_weight_illustrative");
    });

    for (const c of cases) {
      it(`/api/ai-recommendations/generate returns the band-derived type for riskTolerance=${c.riskTolerance} (${c.label})`, async () => {
        const ai = await postAiRecommendations({
          riskTolerance: c.riskTolerance,
          investmentHorizon: "5-10",
          investmentGoal: "growth",
        });
        expect(ai.status).toBe(200);
        expect(ai.body.rebalancingBenchmarkType).toBe(c.expectedAiType);
      });
    }
  });

  // ===========================================================================
  // Task #405 — SoA target preference
  // ===========================================================================
  // The resolver order is: SoA target → risk-profile → equal-weight default.
  // The two cases below pin the override at both ends of the order:
  //   1. SoA target wins over a recorded risk profile (the SoA's per-bucket
  //      values, not the band derivation, drive the gap on both routes).
  //   2. Only `issued`/`accepted` advice records count — a `draft` target
  //      must not win over the equal-weight default.
  // ===========================================================================
  describe("with a Statement-of-Advice target on file (Task #405)", () => {
    async function seedAdviceWithSoaTarget(opts: {
      status: "draft" | "issued" | "accepted" | "review_pending" | "superseded" | "declined";
      target: { fiat: number; crypto: number; stablecoin: number; investment: number } | null;
    }) {
      const now = new Date();
      await db.insert(adviceRecords).values({
        clientId: testUserId,
        adviserUserId: testUserId, // self-referential for the test fixture
        status: opts.status,
        soaTargetAllocation: opts.target,
        soaTargetSetAt: opts.target ? now : null,
        soaTargetSetByUserId: opts.target ? testUserId : null,
      });
    }

    it("issued SoA target overrides a recorded risk profile on both endpoints", async () => {
      // Seed a risk profile with the MIXED allocation (would resolve to a
      // 50% gap against the 100% AUD wallet) AND an issued SoA target with
      // {fiat 100, ...} (gap = 0 against the same wallet). If the SoA
      // target wins, both endpoints must report `soa_personalised` and
      // gap=0. If the resolver fell back to the risk profile, the gap
      // would be 50.0 and the type would still say `risk_profile_*`.
      await db.insert(riskProfiles).values({
        clientId: testUserId,
        factFindSnapshotId,
        behaviouralScore: 30,
        capacityAdjustment: 0,
        finalScore: 30,
        riskBand: "conservative",
        recommendedPortfolio: "task-405-test",
        overrideApplied: false,
        overrideReasons: [],
        allocation: PERSONALISED_ALLOCATION_MIXED,
        scoringInputs: { source: "task-405-test" },
      });
      await seedAdviceWithSoaTarget({
        status: "issued",
        target: { fiat: 100, crypto: 0, stablecoin: 0, investment: 0 },
      });

      const real = await getRealMetrics();
      const ai = await postAiRecommendations({
        riskTolerance: 3,
        investmentHorizon: "5-10",
        investmentGoal: "growth",
      });

      expect(real.status).toBe(200);
      expect(ai.status).toBe(200);
      expect(real.body.rebalancingBenchmarkType).toBe("soa_personalised");
      expect(ai.body.rebalancingBenchmarkType).toBe("soa_personalised");
      expect(real.body.rebalancingGap).toBe(0);
      expect(ai.body.rebalancingGap).toBe(0);
    });

    it("draft SoA target does NOT override the equal-weight default (only issued/accepted count)", async () => {
      // No risk profile, no live SoA — only a DRAFT target. The resolver
      // must skip drafts and fall back to the equal-weight illustrative
      // benchmark. If a draft were honoured by mistake, real-metrics would
      // report `soa_personalised` instead of `equal_weight_illustrative`.
      await seedAdviceWithSoaTarget({
        status: "draft",
        target: { fiat: 100, crypto: 0, stablecoin: 0, investment: 0 },
      });

      const real = await getRealMetrics();
      expect(real.status).toBe(200);
      expect(real.body.rebalancingBenchmarkType).toBe("equal_weight_illustrative");
    });
  });
});
