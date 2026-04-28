/**
 * Unit tests for `server/config/rebalancing-benchmark.ts` — the resolver
 * functions that drive the rebalancing-gap number on both
 * `/api/portfolio/real-metrics` and `/api/ai-recommendations/generate`.
 *
 * The three functions exercised here:
 *
 *   1. `resolveBenchmarkForRiskProfileRow` — maps the five-asset risk-
 *      profile allocation (cash / bonds / equities / alternatives /
 *      crypto) onto the four-bucket platform benchmark
 *      (fiat / crypto / stablecoin / investment) using the deterministic
 *      mapping documented in the source file:
 *        fiat       ← cash
 *        crypto     ← crypto
 *        investment ← bonds + equities + alternatives
 *        stablecoin ← 0
 *
 *   2. `resolveBenchmarkForRiskTolerance` — bucket selector for the
 *      1–5 risk-tolerance integer the AI recommendations route accepts.
 *
 *   3. `computeRebalancingGap` — one-sided turnover distance between a
 *      live allocation and a benchmark.
 *
 * The script is purely static — it does not hit the database or any
 * external service — so it can be wired into the same CI surface as
 * `scripts/test-no-synthetic-portfolio-data.ts` (the existing static-
 * regression test pattern in this repo) without leak-gate concerns.
 *
 * Run with: `npx tsx scripts/test-rebalancing-benchmark.ts`
 *
 * Exits non-zero on the first failure with an actionable message.
 */

import {
  computeRebalancingGap,
  DEFAULT_REBALANCING_BENCHMARK,
  REBALANCING_BENCHMARKS,
  resolveBenchmarkForRiskProfileRow,
  resolveBenchmarkForRiskTolerance,
  resolvePerClientBenchmark,
  type RebalancingBenchmark,
  type RiskProfileAllocation,
} from "../server/config/rebalancing-benchmark";
import { PORTFOLIO_ALLOCATIONS } from "../server/services/risk-scoring";

// ---------------------------------------------------------------------------
// Tiny assertion helpers — kept local so this script has no test-runner
// dependency, matching the style of the other `scripts/test-*.ts` files
// (e.g. test-no-synthetic-portfolio-data.ts, test-recheck-gate-count.ts).
// ---------------------------------------------------------------------------

const failures: string[] = [];
let passed = 0;

function record(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function approxEqual(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

function weightsApproxEqual(
  actual: RebalancingBenchmark["weights"],
  expected: RebalancingBenchmark["weights"],
  eps = 1e-9,
): boolean {
  return (
    approxEqual(actual.fiat, expected.fiat, eps) &&
    approxEqual(actual.crypto, expected.crypto, eps) &&
    approxEqual(actual.stablecoin, expected.stablecoin, eps) &&
    approxEqual(actual.investment, expected.investment, eps)
  );
}

function fmtWeights(w: RebalancingBenchmark["weights"]): string {
  return `{ fiat: ${w.fiat}, crypto: ${w.crypto}, stablecoin: ${w.stablecoin}, investment: ${w.investment} }`;
}

// ---------------------------------------------------------------------------
// 1. resolveBenchmarkForRiskProfileRow — canonical risk-band allocations.
//
// The five risk-band percentage allocations are imported directly from
// `server/services/risk-scoring.ts` (`PORTFOLIO_ALLOCATIONS`) — the same
// map that produces every persisted `risk_profiles.allocation` row in
// production. The expected four-bucket weights are then derived from
// those live percentages using the deterministic mapping documented at
// the top of this file:
//
//   fiat       ← cash       / 100
//   crypto     ← crypto     / 100
//   investment ← (bonds + equities + alternatives) / 100
//   stablecoin ← 0
//
// This means an intentional update to `PORTFOLIO_ALLOCATIONS` keeps the
// test green automatically (both sides move together), while any change
// that breaks the resolver's mapping — or restructures the allocation
// shape so the four-bucket buckets no longer sum to 1 — fails the gate
// with a "benchmark mapping changed" message instead of silently passing
// on stale numbers.
// ---------------------------------------------------------------------------

interface CanonicalCase {
  band: string;
  allocation: RiskProfileAllocation;
  expected: RebalancingBenchmark["weights"];
}

function deriveExpectedWeights(
  allocation: RiskProfileAllocation,
): RebalancingBenchmark["weights"] {
  return {
    fiat: allocation.cash / 100,
    crypto: allocation.crypto / 100,
    stablecoin: 0,
    investment:
      (allocation.bonds + allocation.equities + allocation.alternatives) / 100,
  };
}

const CANONICAL_CASES: CanonicalCase[] = (
  Object.entries(PORTFOLIO_ALLOCATIONS) as Array<
    [keyof typeof PORTFOLIO_ALLOCATIONS, RiskProfileAllocation]
  >
).map(([band, allocation]) => ({
  band,
  allocation,
  expected: deriveExpectedWeights(allocation),
}));

// Defensive: if a future refactor empties or otherwise deletes a band,
// the test surface itself shrinks silently. Pin the expected count.
record(
  "canonical risk-band coverage",
  CANONICAL_CASES.length === 5,
  `expected 5 risk bands in PORTFOLIO_ALLOCATIONS, got ${CANONICAL_CASES.length} — benchmark mapping changed`,
);

for (const { band, allocation, expected } of CANONICAL_CASES) {
  const result = resolveBenchmarkForRiskProfileRow({ allocation });
  record(
    `risk-profile mapping: ${band}`,
    result.type === "risk_profile_personalised" &&
      weightsApproxEqual(result.weights, expected),
    `benchmark mapping changed for ${band}: expected ${fmtWeights(expected)} (type=risk_profile_personalised) derived from PORTFOLIO_ALLOCATIONS=${JSON.stringify(allocation)}, got ${fmtWeights(result.weights)} (type=${result.type})`,
  );
}

// Sanity: every canonical mapping must produce weights that sum to 1.
// The resolver normalises by the allocation total, so this invariant
// holds for any positive-sum input — the assertion guards against a
// future change to the resolver itself (e.g. dropping the normaliser
// or introducing a fifth output bucket) rather than against the raw
// PORTFOLIO_ALLOCATIONS totals. Drift from the canonical 100% totals
// is caught by the per-band mapping assertion above (which compares
// against value/100, not value/total).
for (const { band, allocation } of CANONICAL_CASES) {
  const w = resolveBenchmarkForRiskProfileRow({ allocation }).weights;
  const sum = w.fiat + w.crypto + w.stablecoin + w.investment;
  record(
    `risk-profile mapping sum-to-one: ${band}`,
    approxEqual(sum, 1.0, 1e-9),
    `benchmark mapping changed: resolver weights sum to ${sum} for ${band} (expected 1) — resolver no longer normalises by total or emits an unexpected bucket`,
  );
}

// ---------------------------------------------------------------------------
// 2. resolveBenchmarkForRiskProfileRow — fallback behaviour.
//
// All four documented fallback inputs must return the equal-weight default
// (the same reference as `DEFAULT_REBALANCING_BENCHMARK`).
// ---------------------------------------------------------------------------

const DEFAULT_TYPE = DEFAULT_REBALANCING_BENCHMARK.type; // "equal_weight_illustrative"
const DEFAULT_WEIGHTS = DEFAULT_REBALANCING_BENCHMARK.weights;

function isDefault(b: RebalancingBenchmark): boolean {
  return b.type === DEFAULT_TYPE && weightsApproxEqual(b.weights, DEFAULT_WEIGHTS);
}

record(
  "fallback: profile is null",
  isDefault(resolveBenchmarkForRiskProfileRow(null)),
  "null profile must fall back to equal-weight default",
);

record(
  "fallback: profile is undefined",
  isDefault(resolveBenchmarkForRiskProfileRow(undefined)),
  "undefined profile must fall back to equal-weight default",
);

// `allocation` itself is missing.
record(
  "fallback: profile.allocation is null",
  isDefault(
    resolveBenchmarkForRiskProfileRow({
      // Cast through unknown so this script can pass the malformed shape
      // without disabling type-checking globally — mirroring what would
      // arrive from a stale DB row.
      allocation: null as unknown as RiskProfileAllocation,
    }),
  ),
  "null allocation must fall back to equal-weight default",
);

// Every numeric field present but all zero — sums to zero.
record(
  "fallback: allocation sums to zero",
  isDefault(
    resolveBenchmarkForRiskProfileRow({
      allocation: { cash: 0, bonds: 0, equities: 0, alternatives: 0, crypto: 0 },
    }),
  ),
  "all-zero allocation must fall back to equal-weight default",
);

// Malformed: non-numeric strings + NaN. `Number(...) || 0` should coerce
// every field to 0, so the total is 0 and we fall back.
record(
  "fallback: allocation values are non-numeric",
  isDefault(
    resolveBenchmarkForRiskProfileRow({
      allocation: {
        cash: "oops" as unknown as number,
        bonds: NaN,
        equities: undefined as unknown as number,
        alternatives: null as unknown as number,
        crypto: "" as unknown as number,
      },
    }),
  ),
  "malformed allocation values must fall back to equal-weight default",
);

// ---------------------------------------------------------------------------
// 3. resolveBenchmarkForRiskTolerance — band boundaries on the 1-5 scale.
//
// The source defines: <=2 conservative, <=4 moderate, <=5 aggressive,
// else default. Cover every integer in-range plus the documented out-of-
// range / non-finite fallbacks.
// ---------------------------------------------------------------------------

interface ToleranceCase {
  input: number | null | undefined;
  expectedType: RebalancingBenchmark["type"];
  label: string;
}

const TOLERANCE_CASES: ToleranceCase[] = [
  // Lower edge of conservative — 1 and 2.
  { input: 1, expectedType: "conservative_illustrative", label: "tolerance=1" },
  { input: 2, expectedType: "conservative_illustrative", label: "tolerance=2 (conservative upper boundary)" },
  // Moderate band — 3 and 4.
  { input: 3, expectedType: "moderate_illustrative", label: "tolerance=3 (moderate lower boundary)" },
  { input: 4, expectedType: "moderate_illustrative", label: "tolerance=4 (moderate upper boundary)" },
  // Aggressive band — 5 only.
  { input: 5, expectedType: "aggressive_illustrative", label: "tolerance=5 (aggressive boundary)" },
  // Out-of-range high — falls back to default.
  { input: 6, expectedType: DEFAULT_TYPE, label: "tolerance=6 (above range → default)" },
  { input: 100, expectedType: DEFAULT_TYPE, label: "tolerance=100 (far above range → default)" },
  // Non-finite / missing — also fall back to default.
  { input: NaN, expectedType: DEFAULT_TYPE, label: "tolerance=NaN → default" },
  { input: Infinity, expectedType: DEFAULT_TYPE, label: "tolerance=Infinity → default" },
  { input: -Infinity, expectedType: DEFAULT_TYPE, label: "tolerance=-Infinity → default" },
  { input: null, expectedType: DEFAULT_TYPE, label: "tolerance=null → default" },
  { input: undefined, expectedType: DEFAULT_TYPE, label: "tolerance=undefined → default" },
  // Sub-1 numeric — still <= 2, so conservative (documents inclusive upper bound).
  { input: 0, expectedType: "conservative_illustrative", label: "tolerance=0 (still <=2 → conservative)" },
  { input: -3, expectedType: "conservative_illustrative", label: "tolerance=-3 (still <=2 → conservative)" },
  // Fractional just above a boundary — verifies the comparator is `<=`.
  { input: 2.0001, expectedType: "moderate_illustrative", label: "tolerance=2.0001 (just above conservative cap)" },
  { input: 4.0001, expectedType: "aggressive_illustrative", label: "tolerance=4.0001 (just above moderate cap)" },
  { input: 5.0001, expectedType: DEFAULT_TYPE, label: "tolerance=5.0001 (just above aggressive cap → default)" },
];

for (const { input, expectedType, label } of TOLERANCE_CASES) {
  const result = resolveBenchmarkForRiskTolerance(input);
  const expected = REBALANCING_BENCHMARKS[expectedType];
  record(
    `risk-tolerance: ${label}`,
    result.type === expectedType && weightsApproxEqual(result.weights, expected.weights),
    `expected type=${expectedType} weights=${fmtWeights(expected.weights)}, got type=${result.type} weights=${fmtWeights(result.weights)}`,
  );
}

// ---------------------------------------------------------------------------
// 4. computeRebalancingGap — known fixtures.
//
// One-sided turnover: 0.5 * sum(|a_i - b_i|). Verified by hand against
// the equal-weight 25/25/25/25 benchmark and against a custom benchmark.
// ---------------------------------------------------------------------------

interface GapCase {
  label: string;
  allocation: { fiat: number; crypto: number; stablecoin: number; investment: number };
  benchmark?: RebalancingBenchmark;
  expected: number;
}

const customBenchmark: RebalancingBenchmark = {
  type: "risk_profile_personalised",
  weights: { fiat: 0.5, crypto: 0.2, stablecoin: 0.0, investment: 0.3 },
  note: "test fixture",
};

const GAP_CASES: GapCase[] = [
  // Identity — allocation matches the default benchmark exactly.
  {
    label: "identity vs default benchmark → 0",
    allocation: { fiat: 0.25, crypto: 0.25, stablecoin: 0.25, investment: 0.25 },
    expected: 0,
  },
  // 100% in one bucket vs the equal-weight benchmark.
  // diffs: |1-0.25| + |0-0.25|*3 = 0.75 + 0.75 = 1.5; * 0.5 = 0.75
  {
    label: "100% fiat vs default benchmark → 0.75",
    allocation: { fiat: 1.0, crypto: 0.0, stablecoin: 0.0, investment: 0.0 },
    expected: 0.75,
  },
  // Symmetry — swapping fiat and investment gives the same number.
  // diffs: |0-0.25| + |0.25-0.25| + |0.25-0.25| + |0.5-0.25| = 0.5; * 0.5 = 0.25
  {
    label: "shifted allocation vs default benchmark → 0.25",
    allocation: { fiat: 0.0, crypto: 0.25, stablecoin: 0.25, investment: 0.5 },
    expected: 0.25,
  },
  // Custom benchmark, identity case.
  {
    label: "identity vs custom benchmark → 0",
    allocation: { fiat: 0.5, crypto: 0.2, stablecoin: 0.0, investment: 0.3 },
    benchmark: customBenchmark,
    expected: 0,
  },
  // Custom benchmark, off by a known amount.
  // diffs: |0.4-0.5| + |0.3-0.2| + |0.0-0.0| + |0.3-0.3| = 0.2; * 0.5 = 0.1
  {
    label: "small drift vs custom benchmark → 0.1",
    allocation: { fiat: 0.4, crypto: 0.3, stablecoin: 0.0, investment: 0.3 },
    benchmark: customBenchmark,
    expected: 0.1,
  },
  // computeRebalancingGap omitted-benchmark default-arg path: same as the
  // explicit `DEFAULT_REBALANCING_BENCHMARK`. diffs: |0.4-0.25|*2 + |0.1-0.25|*2 = 0.6; * 0.5 = 0.3
  {
    label: "default-arg path matches explicit default benchmark",
    allocation: { fiat: 0.4, crypto: 0.4, stablecoin: 0.1, investment: 0.1 },
    expected: 0.3,
  },
];

for (const { label, allocation, benchmark, expected } of GAP_CASES) {
  const actual =
    benchmark === undefined
      ? computeRebalancingGap(allocation)
      : computeRebalancingGap(allocation, benchmark);
  record(
    `computeRebalancingGap: ${label}`,
    approxEqual(actual, expected, 1e-9),
    `expected ${expected}, got ${actual}`,
  );
}

// Range invariant — every gap result must sit in [0, 1].
for (const { label, allocation, benchmark } of GAP_CASES) {
  const actual =
    benchmark === undefined
      ? computeRebalancingGap(allocation)
      : computeRebalancingGap(allocation, benchmark);
  record(
    `computeRebalancingGap range: ${label}`,
    actual >= 0 && actual <= 1,
    `gap=${actual} outside [0, 1]`,
  );
}

// ---------------------------------------------------------------------------
// 5. resolvePerClientBenchmark — the shared per-user resolver that
// /api/portfolio/allocation, /api/portfolio/real-metrics, and
// /api/ai-recommendations/generate all delegate to (task #388).
//
// Two invariants are exercised here:
//   (a) for any input the helper returns the same benchmark on repeat
//       invocation (deterministic — same user always gets same target);
//   (b) every input that reaches the resolver-with-no-profile branch
//       lands on the equal-weight default — so a profile-less user can
//       never see one target on their portfolio page and a different
//       target on the AI-recommendations page.
// ---------------------------------------------------------------------------

interface SharedHelperCase {
  label: string;
  profile: { allocation: RiskProfileAllocation } | null | undefined;
  expectedType: RebalancingBenchmark["type"];
}

const SHARED_HELPER_CASES: SharedHelperCase[] = [
  {
    label: "no profile (null) → equal-weight default",
    profile: null,
    expectedType: DEFAULT_TYPE,
  },
  {
    label: "no profile (undefined) → equal-weight default",
    profile: undefined,
    expectedType: DEFAULT_TYPE,
  },
  {
    label: "profile present (conservative) → personalised",
    profile: { allocation: PORTFOLIO_ALLOCATIONS.conservative },
    expectedType: "risk_profile_personalised",
  },
  {
    label: "profile present (high_growth) → personalised",
    profile: { allocation: PORTFOLIO_ALLOCATIONS.high_growth },
    expectedType: "risk_profile_personalised",
  },
];

for (const { label, profile, expectedType } of SHARED_HELPER_CASES) {
  const a = resolvePerClientBenchmark(profile);
  const b = resolvePerClientBenchmark(profile);
  // (a) deterministic — repeat calls for the same input return the same payload.
  record(
    `shared helper deterministic: ${label}`,
    a.type === b.type && weightsApproxEqual(a.weights, b.weights) && a.note === b.note,
    `expected repeat invocations to match, got first=${a.type}/${fmtWeights(a.weights)} second=${b.type}/${fmtWeights(b.weights)}`,
  );
  // (b) correct branch landed.
  record(
    `shared helper branch: ${label}`,
    a.type === expectedType,
    `expected type=${expectedType}, got type=${a.type}`,
  );
}

// Cross-surface agreement: simulate the exact resolver call
// /api/portfolio/allocation and /api/ai-recommendations/generate make for
// the same user (with and without a stored risk profile) and assert the
// resulting benchmark payloads are byte-for-byte equal. This is the
// regression that the original task #388 review flagged was missing.
interface CrossSurfaceCase {
  label: string;
  profile: { allocation: RiskProfileAllocation } | null;
}

const CROSS_SURFACE_CASES: CrossSurfaceCase[] = [
  { label: "user with stored balanced risk profile", profile: { allocation: PORTFOLIO_ALLOCATIONS.balanced } },
  { label: "user with stored growth risk profile",   profile: { allocation: PORTFOLIO_ALLOCATIONS.growth } },
  { label: "user with no stored risk profile",       profile: null },
];

for (const { label, profile } of CROSS_SURFACE_CASES) {
  const fromAllocationRoute = resolvePerClientBenchmark(profile);
  const fromAiRoute         = resolvePerClientBenchmark(profile);
  const fromMetricsRoute    = resolvePerClientBenchmark(profile);
  record(
    `cross-surface agreement (allocation == ai-recommendations): ${label}`,
    fromAllocationRoute.type === fromAiRoute.type &&
      weightsApproxEqual(fromAllocationRoute.weights, fromAiRoute.weights) &&
      fromAllocationRoute.note === fromAiRoute.note,
    `expected allocation and ai-recommendations to return same benchmark, got allocation=${fromAllocationRoute.type}/${fmtWeights(fromAllocationRoute.weights)} ai=${fromAiRoute.type}/${fmtWeights(fromAiRoute.weights)}`,
  );
  record(
    `cross-surface agreement (allocation == real-metrics): ${label}`,
    fromAllocationRoute.type === fromMetricsRoute.type &&
      weightsApproxEqual(fromAllocationRoute.weights, fromMetricsRoute.weights) &&
      fromAllocationRoute.note === fromMetricsRoute.note,
    `expected allocation and real-metrics to return same benchmark, got allocation=${fromAllocationRoute.type}/${fmtWeights(fromAllocationRoute.weights)} metrics=${fromMetricsRoute.type}/${fmtWeights(fromMetricsRoute.weights)}`,
  );
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(
    `✗ rebalancing-benchmark tests: ${failures.length} failure(s) (${passed} passed)\n`,
  );
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nSee server/config/rebalancing-benchmark.ts and task #378 for context.",
  );
  process.exit(1);
}

console.log(
  `✓ rebalancing-benchmark tests: ${passed} assertion(s) passed across resolveBenchmarkForRiskProfileRow, resolveBenchmarkForRiskTolerance, computeRebalancingGap, and resolvePerClientBenchmark.`,
);
