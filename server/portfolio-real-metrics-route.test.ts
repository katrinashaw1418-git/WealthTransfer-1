// =============================================================================
// Task #392 — pin /api/portfolio/real-metrics allocation comparison contract
// -----------------------------------------------------------------------------
// The AI Advisory page renders a per-asset-class comparison table and a
// rebalancing-gap figure built from the new fields on
// /api/portfolio/real-metrics:
//
//   * `currentAllocation`    — { fiat, crypto, stablecoin, investment }, %
//   * `benchmarkAllocation`  — { fiat, crypto, stablecoin, investment }, %
//   * `hasAllocationData`    — false when the portfolio is empty so the UI
//                              shows a placeholder rather than a row of zeros
//   * `rebalancingBenchmarkType` — switches between
//                              `risk_profile_personalised` (when a recorded
//                              risk-profile exists) and
//                              `equal_weight_illustrative` (fallback)
//
// This file pins each of those guarantees end-to-end by mounting only
// `registerPortfolioRealMetricsRoute` on a tiny loopback express app with
// stubbed dependencies and asserting the JSON the route emits. Booting the
// full registerRoutes() would pull in a dozen unrelated services and a real
// database connection just to test four payload fields, so the route was
// extracted into its own module with explicit dependency injection (see
// `server/portfolio-real-metrics-route.ts`) precisely to keep this test
// hermetic and CI-fast.
//
// What is NOT covered here on purpose:
//   * Risk metric statistics (Sharpe, volatility, max drawdown, CAGR) —
//     those have their own guards and are out of scope for the AI Advisory
//     allocation comparison card.
//   * Authentication failure paths — covered by other route tests; we just
//     forward a valid JWT so the auth check passes.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // server/auth.ts throws at import time when JWT_SECRET is missing outside
  // local-dev — set it before any transitive import touches the module.
  process.env.JWT_SECRET ||= "task-392-portfolio-real-metrics-test-secret";
});

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { signToken } from "./auth";
import {
  registerPortfolioRealMetricsRoute,
  type PortfolioRealMetricsDeps,
  type PortfolioTotals,
} from "./portfolio-real-metrics-route";
import {
  DEFAULT_REBALANCING_BENCHMARK,
  RISK_PROFILE_BENCHMARK_DERIVATION,
  buildBenchmarkDerivation,
  resolveBenchmarkForRiskProfileRow,
} from "./config/rebalancing-benchmark";

// ---------------------------------------------------------------------------
// Test harness — boot a fresh loopback express server per test scenario with
// the dependencies we want stubbed. A factory keeps the per-scenario noise
// down (each test only specifies the totals + risk-profile row it cares
// about). The server is closed in afterAll to keep vitest from hanging on
// open handles.
// ---------------------------------------------------------------------------
type SnapshotRow = {
  snapshotDate: Date;
  totalValue: string;
  source: "actual" | "historical_estimate";
};

interface HarnessOptions {
  totals: PortfolioTotals;
  hasUnpricedAssets?: boolean;
  riskProfileAllocation?: { cash: number; bonds: number; equities: number; alternatives: number; crypto: number } | null;
  snapshots?: SnapshotRow[];
  investments?: Array<{ productId: number; investedAmount: string }>;
  products?: Map<number, { annualReturn: string | null }>;
}

interface Harness {
  baseUrl: string;
  token: string;
  close: () => Promise<void>;
}

async function startHarness(opts: HarnessOptions): Promise<Harness> {
  const {
    totals,
    hasUnpricedAssets = false,
    riskProfileAllocation = null,
    snapshots = [],
    investments = [],
    products = new Map(),
  } = opts;

  // Drizzle-style chainable stub for the single db.select used by the route.
  // The route shape is:
  //   db.select({ allocation: ... }).from(riskProfiles).where(...).orderBy(...).limit(1)
  // We only need to return one row (or none) at the .limit() step, so the
  // chain ignores the field/where/orderBy arguments entirely.
  const dbStub = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () =>
              riskProfileAllocation
                ? [{ allocation: riskProfileAllocation }]
                : [],
          }),
        }),
      }),
    })),
  };

  const storageStub = {
    getUserInvestments: vi.fn(async () => investments as any),
    getInvestmentProduct: vi.fn(async (productId: number) => products.get(productId) ?? null),
    getPortfolioSnapshots: vi.fn(async () => snapshots as any),
  };

  const deps: PortfolioRealMetricsDeps = {
    storage: storageStub as any,
    db: dbStub as any,
    calculatePortfolioTotalsAtDate: vi.fn(async () => totals),
    calculateInvestmentTotalsAtDate: vi.fn(async () => ({ hasUnpricedAssets })),
  };

  const app = express();
  registerPortfolioRealMetricsRoute(app, deps);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const token = signToken({
    userId: 1234,
    username: "test_user",
    email: "test@invalid",
    role: "client",
  });

  return {
    baseUrl,
    token,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

const openHarnesses: Harness[] = [];
async function startTrackedHarness(opts: HarnessOptions): Promise<Harness> {
  const h = await startHarness(opts);
  openHarnesses.push(h);
  return h;
}

afterAll(async () => {
  for (const h of openHarnesses) {
    await h.close();
  }
});

async function fetchRealMetrics(h: Harness): Promise<{ status: number; body: any }> {
  const res = await fetch(`${h.baseUrl}/api/portfolio/real-metrics`, {
    headers: { Authorization: `Bearer ${h.token}` },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

describe("/api/portfolio/real-metrics — allocation comparison payload (Task #392)", () => {
  it("returns the four-bucket currentAllocation + benchmarkAllocation with hasAllocationData=true for a non-empty portfolio", async () => {
    // 50% fiat, 25% crypto, 25% investment; no stablecoin.
    const harness = await startTrackedHarness({
      totals: {
        fiatValue: 5_000,
        cryptoValue: 2_500,
        stablecoinValue: 0,
        investmentValue: 2_500,
        totalValue: 10_000,
      },
    });

    const { status, body } = await fetchRealMetrics(harness);
    expect(status).toBe(200);

    // Pin the exact wire shape the AI Advisory page reads from. Asserting the
    // four keys explicitly catches any future regression that would silently
    // rename or drop a bucket.
    expect(Object.keys(body.currentAllocation).sort()).toEqual([
      "crypto",
      "fiat",
      "investment",
      "stablecoin",
    ]);
    expect(Object.keys(body.benchmarkAllocation).sort()).toEqual([
      "crypto",
      "fiat",
      "investment",
      "stablecoin",
    ]);

    expect(body.currentAllocation).toEqual({
      fiat: 50,
      crypto: 25,
      stablecoin: 0,
      investment: 25,
    });
    // No risk-profile row was supplied, so the benchmark is the equal-weight
    // illustrative fallback. The benchmark numbers must be percentages — not
    // fractions — because the UI renders them with `.toFixed(1)%` directly.
    expect(body.benchmarkAllocation).toEqual({
      fiat: 25,
      crypto: 25,
      stablecoin: 25,
      investment: 25,
    });
    expect(body.hasAllocationData).toBe(true);
    expect(body.rebalancingBenchmarkType).toBe("equal_weight_illustrative");
  });

  it("returns hasAllocationData=false for an empty portfolio so the UI renders the placeholder instead of a row of zeros", async () => {
    const harness = await startTrackedHarness({
      totals: {
        fiatValue: 0,
        cryptoValue: 0,
        stablecoinValue: 0,
        investmentValue: 0,
        totalValue: 0,
      },
    });

    const { status, body } = await fetchRealMetrics(harness);
    expect(status).toBe(200);

    // hasAllocationData is the explicit "do we have anything to show?" gate.
    // The UI keys off this flag, NOT the per-class numbers, so the contract
    // here is that the flag is false EVEN THOUGH every bucket is 0%.
    expect(body.hasAllocationData).toBe(false);
    expect(body.currentAllocation).toEqual({
      fiat: 0,
      crypto: 0,
      stablecoin: 0,
      investment: 0,
    });
    // The benchmark side still resolves — the "no allocation data yet"
    // placeholder is not a hard 404, it just hides the comparison table.
    // We pin that the equal-weight default is what the route returns when
    // the client has no risk profile, so the placeholder reasoning above
    // (UI gates on hasAllocationData) holds even for the cold-start case.
    expect(body.benchmarkAllocation).toEqual({
      fiat: 25,
      crypto: 25,
      stablecoin: 25,
      investment: 25,
    });
  });

  it("uses the personalised benchmark when a risk_profiles row exists, mapped per resolveBenchmarkForRiskProfileRow", async () => {
    // Risk-profile allocation is in the 5-bucket schema (cash, bonds, equities,
    // alternatives, crypto). The route delegates the 4-bucket projection
    // (fiat ← cash, investment ← bonds + equities + alternatives,
    // stablecoin ← 0) to `resolveBenchmarkForRiskProfileRow` so the route
    // and the resolver can never disagree.
    const allocation = { cash: 20, bonds: 30, equities: 40, alternatives: 5, crypto: 5 };
    const harness = await startTrackedHarness({
      totals: {
        fiatValue: 5_000,
        cryptoValue: 2_500,
        stablecoinValue: 0,
        investmentValue: 2_500,
        totalValue: 10_000,
      },
      riskProfileAllocation: allocation,
    });

    const { status, body } = await fetchRealMetrics(harness);
    expect(status).toBe(200);

    // The wire shape (percentages, four buckets, 1-decimal rounding) must
    // match what the resolver emits after the route multiplies by 100.
    const expected = resolveBenchmarkForRiskProfileRow({ allocation }).weights;
    expect(body.benchmarkAllocation).toEqual({
      fiat:       +(expected.fiat       * 100).toFixed(1),
      crypto:     +(expected.crypto     * 100).toFixed(1),
      stablecoin: +(expected.stablecoin * 100).toFixed(1),
      investment: +(expected.investment * 100).toFixed(1),
    });
    expect(body.rebalancingBenchmarkType).toBe("risk_profile_personalised");
    // The note must surface so the UI can show the disclaimer about a
    // personalised benchmark NOT being a target.
    expect(typeof body.rebalancingBenchmarkNote).toBe("string");
    expect(body.rebalancingBenchmarkNote.length).toBeGreaterThan(0);
  });

  it("falls back to the equal-weight illustrative benchmark when the client has no risk_profiles row", async () => {
    const harness = await startTrackedHarness({
      totals: {
        fiatValue: 5_000,
        cryptoValue: 2_500,
        stablecoinValue: 0,
        investmentValue: 2_500,
        totalValue: 10_000,
      },
      riskProfileAllocation: null,
    });

    const { status, body } = await fetchRealMetrics(harness);
    expect(status).toBe(200);

    // Equal-weight 25/25/25/25 is the documented fallback. The benchmark
    // type telegraphs this to the UI so the AI Advisory page can render the
    // amber "No risk profile recorded — comparison is illustrative only"
    // badge instead of pretending the user has a personalised target.
    expect(body.rebalancingBenchmarkType).toBe("equal_weight_illustrative");
    expect(body.benchmarkAllocation).toEqual({
      fiat:       +(DEFAULT_REBALANCING_BENCHMARK.weights.fiat       * 100).toFixed(1),
      crypto:     +(DEFAULT_REBALANCING_BENCHMARK.weights.crypto     * 100).toFixed(1),
      stablecoin: +(DEFAULT_REBALANCING_BENCHMARK.weights.stablecoin * 100).toFixed(1),
      investment: +(DEFAULT_REBALANCING_BENCHMARK.weights.investment * 100).toFixed(1),
    });
  });

  // -------------------------------------------------------------------------
  // Task #402 — the bucket-derivation popover the AI Advisory page renders
  // must come from the API payload, not from hard-coded client copy. The
  // tests below pin (a) the wire shape, (b) the gating on benchmark type,
  // and (c) the self-healing property: the components in the derivation
  // payload reproduce the math `resolveBenchmarkForRiskProfileRow` runs.
  // -------------------------------------------------------------------------
  it("includes a per-bucket benchmarkDerivation payload when the personalised benchmark is in use", async () => {
    const allocation = { cash: 20, bonds: 30, equities: 40, alternatives: 5, crypto: 5 };
    const harness = await startTrackedHarness({
      totals: {
        fiatValue: 5_000,
        cryptoValue: 2_500,
        stablecoinValue: 0,
        investmentValue: 2_500,
        totalValue: 10_000,
      },
      riskProfileAllocation: allocation,
    });

    const { status, body } = await fetchRealMetrics(harness);
    expect(status).toBe(200);

    // The payload must carry one entry per platform bucket so the UI can key
    // off `benchmarkDerivation[cls]` directly without inventing fallback copy.
    expect(body.rebalancingBenchmarkType).toBe("risk_profile_personalised");
    expect(Object.keys(body.benchmarkDerivation).sort()).toEqual([
      "crypto",
      "fiat",
      "investment",
      "stablecoin",
    ]);

    // Pin the wire shape of one entry — formula is the human-readable string
    // the popover renders verbatim, components is the structured mapping the
    // server-side math also reads from. If a future contributor renames
    // `formula` or `components`, this assertion fails before the popover
    // silently goes blank in production.
    const fiat = body.benchmarkDerivation.fiat;
    expect(typeof fiat.formula).toBe("string");
    expect(typeof fiat.explanation).toBe("string");
    expect(Array.isArray(fiat.components)).toBe(true);
    expect(fiat.components).toEqual([{ sourceClass: "cash", weight: 1 }]);
    // Stablecoin currently has no contributing class — the popover must
    // describe this explicitly, otherwise the user is left guessing why
    // the bench shows 0%.
    expect(body.benchmarkDerivation.stablecoin.components).toEqual([]);
    expect(body.benchmarkDerivation.stablecoin.formula).toContain("0%");
  });

  it("omits benchmarkDerivation when the equal-weight fallback is used (nothing to derive from a risk-profile row)", async () => {
    // Without a risk-profile row the benchmark is the platform-wide
    // illustrative default, which isn't a per-client projection. The
    // payload is `null` so the UI knows not to render the popover.
    const harness = await startTrackedHarness({
      totals: {
        fiatValue: 1_000,
        cryptoValue: 0,
        stablecoinValue: 0,
        investmentValue: 0,
        totalValue: 1_000,
      },
      riskProfileAllocation: null,
    });

    const { status, body } = await fetchRealMetrics(harness);
    expect(status).toBe(200);
    expect(body.rebalancingBenchmarkType).toBe("equal_weight_illustrative");
    expect(body.benchmarkDerivation).toBeNull();
  });

  it("self-healing: the derivation components reproduce the same math the resolver runs (so changing the mapping changes the UI)", async () => {
    // This is the load-bearing assertion for task #402. We feed an arbitrary
    // risk-profile allocation to the route, recompute each bucket weight by
    // applying the derivation `components` to the same source numbers, and
    // assert it matches the percentages the route shipped in
    // `benchmarkAllocation`. If a future contributor changes
    // `RISK_PROFILE_BENCHMARK_DERIVATION` (e.g. gives stablecoin a non-zero
    // share of cash, or splits investment into separate buckets), this test
    // fails iff the route's math drifted from the derivation payload — i.e.
    // iff the popover would silently lie to the user.
    const allocation = { cash: 12, bonds: 28, equities: 40, alternatives: 15, crypto: 5 };
    const harness = await startTrackedHarness({
      totals: {
        fiatValue: 5_000,
        cryptoValue: 2_500,
        stablecoinValue: 0,
        investmentValue: 2_500,
        totalValue: 10_000,
      },
      riskProfileAllocation: allocation,
    });

    const { status, body } = await fetchRealMetrics(harness);
    expect(status).toBe(200);

    const total =
      allocation.cash +
      allocation.bonds +
      allocation.equities +
      allocation.alternatives +
      allocation.crypto;
    const sources: Record<string, number> = {
      cash: allocation.cash,
      bonds: allocation.bonds,
      equities: allocation.equities,
      alternatives: allocation.alternatives,
      crypto: allocation.crypto,
    };

    for (const bucket of ["fiat", "crypto", "stablecoin", "investment"] as const) {
      const components = body.benchmarkDerivation[bucket].components as Array<{
        sourceClass: string;
        weight: number;
      }>;
      const weightFromDerivation =
        components.reduce((acc, c) => acc + (sources[c.sourceClass] ?? 0) * c.weight, 0) / total;
      const expectedPct = +(weightFromDerivation * 100).toFixed(1);
      expect(body.benchmarkAllocation[bucket]).toBe(expectedPct);
    }
  });

  it("falls back to the equal-weight benchmark when a risk_profiles row exists but its allocation is all zero", async () => {
    // All-zero allocation is the canonical "malformed/seed-default" case the
    // resolver guards against (see comment in resolveBenchmarkForRiskProfileRow).
    // Without this guard the percentage projection would divide by zero and
    // surface NaN to the UI; the contract is that the route silently degrades
    // to the equal-weight fallback so the comparison card still renders.
    const harness = await startTrackedHarness({
      totals: {
        fiatValue: 1_000,
        cryptoValue: 0,
        stablecoinValue: 0,
        investmentValue: 0,
        totalValue: 1_000,
      },
      riskProfileAllocation: { cash: 0, bonds: 0, equities: 0, alternatives: 0, crypto: 0 },
    });

    const { status, body } = await fetchRealMetrics(harness);
    expect(status).toBe(200);
    expect(body.rebalancingBenchmarkType).toBe("equal_weight_illustrative");
    expect(body.benchmarkAllocation).toEqual({
      fiat: 25,
      crypto: 25,
      stablecoin: 25,
      investment: 25,
    });
  });
});

// ---------------------------------------------------------------------------
// Direct unit tests for the personalised-vs-fallback resolver. The route
// tests above prove the route plumbs the resolver correctly; these tests
// pin the resolver itself so any future refactor (e.g. adding a sixth
// risk-profile bucket) can't silently break the four-bucket projection.
// ---------------------------------------------------------------------------
describe("resolveBenchmarkForRiskProfileRow — Task #392 personalised vs fallback contract", () => {
  it("projects a seeded 5-bucket risk-profile row into the 4-bucket benchmark space", async () => {
    // cash 20 → fiat; bonds 30 + equities 40 + alternatives 5 → investment 75;
    // crypto 5 → crypto; stablecoin is hard-zero by the documented mapping.
    // Total is 100, so the fractions equal the percentages divided by 100.
    const benchmark = resolveBenchmarkForRiskProfileRow({
      allocation: { cash: 20, bonds: 30, equities: 40, alternatives: 5, crypto: 5 },
    });
    expect(benchmark.type).toBe("risk_profile_personalised");
    expect(benchmark.weights.fiat).toBeCloseTo(0.20, 6);
    expect(benchmark.weights.crypto).toBeCloseTo(0.05, 6);
    expect(benchmark.weights.investment).toBeCloseTo(0.75, 6);
    expect(benchmark.weights.stablecoin).toBe(0);
    // Round-trip sanity: the four weights must sum to exactly 1.0 (the
    // resolver normalises by `total`), so the rebalancing-gap math doesn't
    // get a benchmark that adds up to 0.97 or 1.03.
    const sum =
      benchmark.weights.fiat +
      benchmark.weights.crypto +
      benchmark.weights.stablecoin +
      benchmark.weights.investment;
    expect(sum).toBeCloseTo(1, 6);
  });

  it("falls back to the equal-weight illustrative benchmark when the row is missing", async () => {
    expect(resolveBenchmarkForRiskProfileRow(null).type).toBe("equal_weight_illustrative");
    expect(resolveBenchmarkForRiskProfileRow(undefined).type).toBe("equal_weight_illustrative");
  });

  // -------------------------------------------------------------------------
  // Task #402 — pin the derivation builder directly. The route tests above
  // prove the route ships the derivation, and the self-healing test proves
  // the math reads from the same components. These tests pin the format of
  // the formula strings the popover renders verbatim, so a regression in
  // the formatting helper (e.g. dropping the " + " separator) trips here
  // before it reaches a user.
  // -------------------------------------------------------------------------
  it("buildBenchmarkDerivation produces a formula and explanation per bucket, matching RISK_PROFILE_BENCHMARK_DERIVATION", async () => {
    const derivation = buildBenchmarkDerivation();

    expect(derivation.fiat.formula).toBe("Fiat ← Cash");
    expect(derivation.crypto.formula).toBe("Crypto ← Crypto");
    expect(derivation.stablecoin.formula).toBe("Stablecoin ← 0%");
    expect(derivation.investment.formula).toBe(
      "Investment ← Bonds + Equities + Alternatives",
    );

    // Explanations come straight from the source-of-truth table, so changing
    // the table updates both the popover and this assertion in lockstep.
    for (const bucket of ["fiat", "crypto", "stablecoin", "investment"] as const) {
      expect(derivation[bucket].explanation).toBe(
        RISK_PROFILE_BENCHMARK_DERIVATION[bucket].explanation,
      );
      // The wire components must be a plain array, not a frozen
      // ReadonlyArray reference — that lets the route layer JSON-serialise
      // the payload without leaking the config object's identity.
      expect(Array.isArray(derivation[bucket].components)).toBe(true);
    }
  });

  it("falls back to the equal-weight illustrative benchmark when the allocation is all zero or malformed", async () => {
    expect(
      resolveBenchmarkForRiskProfileRow({
        allocation: { cash: 0, bonds: 0, equities: 0, alternatives: 0, crypto: 0 },
      }).type,
    ).toBe("equal_weight_illustrative");
    // NaN inputs (Number(undefined)) — the resolver coalesces to 0 and the
    // total-zero guard then trips the fallback. Pinning this prevents a
    // future refactor that "trusts" the JSONB shape from leaking NaN to
    // the UI.
    expect(
      resolveBenchmarkForRiskProfileRow({
        allocation: { cash: NaN, bonds: NaN, equities: NaN, alternatives: NaN, crypto: NaN } as any,
      }).type,
    ).toBe("equal_weight_illustrative");
  });
});
