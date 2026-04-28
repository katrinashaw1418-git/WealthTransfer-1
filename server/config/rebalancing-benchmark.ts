// Rebalancing benchmark configuration.
//
// The "rebalancing gap" surfaced by /api/portfolio/real-metrics and
// /api/ai-recommendations/generate is a one-sided turnover measure of how far
// the user's current allocation sits from a reference benchmark across the
// four asset classes the platform tracks (fiat, crypto, stablecoin,
// investment).
//
// The benchmark is *illustrative only* — it is NOT a personal target. A
// personalised target allocation must be set by a licensed adviser inside a
// Statement of Advice. This module exists so the benchmark constants live in
// one auditable place rather than being scattered as magic numbers across
// route handlers.
//
// `DEFAULT_BENCHMARK_TYPE` is the equal-weight 25/25/25/25 split that was
// previously hardcoded inline in two route handlers in `server/routes.ts`.
// Per-risk-band benchmarks are also defined here so the AI-recommendations
// flow (which already takes a `riskTolerance` input) can resolve a slightly
// more honest reference than equal-weight when a profile is supplied. The
// per-band figures are still illustrative — they remain in this config and
// must not be treated as a target until enshrined in an SOA.

export type RebalancingBenchmarkType =
  | "equal_weight_illustrative"
  | "conservative_illustrative"
  | "moderate_illustrative"
  | "aggressive_illustrative"
  | "risk_profile_personalised";

export interface RebalancingBenchmark {
  type: RebalancingBenchmarkType;
  weights: {
    fiat: number;
    crypto: number;
    stablecoin: number;
    investment: number;
  };
  note: string;
}

const NOTE_EQUAL_WEIGHT =
  "Compared against an illustrative equal-weight (25/25/25/25) benchmark. A personalised benchmark must be set by your adviser in a Statement of Advice.";

const NOTE_RISK_DERIVED =
  "Compared against an illustrative benchmark derived from the risk-tolerance input you supplied. A personalised benchmark must still be set by your adviser in a Statement of Advice.";

const NOTE_RISK_PROFILE_PERSONALISED =
  "Compared against the asset-class allocation in your latest recorded risk profile. This is still a math-only reference — a personalised target must be set by your adviser in a Statement of Advice.";

export const REBALANCING_BENCHMARKS: Record<
  RebalancingBenchmarkType,
  RebalancingBenchmark
> = {
  equal_weight_illustrative: {
    type: "equal_weight_illustrative",
    weights: { fiat: 0.25, crypto: 0.25, stablecoin: 0.25, investment: 0.25 },
    note: NOTE_EQUAL_WEIGHT,
  },
  conservative_illustrative: {
    type: "conservative_illustrative",
    weights: { fiat: 0.45, crypto: 0.05, stablecoin: 0.30, investment: 0.20 },
    note: NOTE_RISK_DERIVED,
  },
  moderate_illustrative: {
    type: "moderate_illustrative",
    weights: { fiat: 0.30, crypto: 0.15, stablecoin: 0.20, investment: 0.35 },
    note: NOTE_RISK_DERIVED,
  },
  aggressive_illustrative: {
    type: "aggressive_illustrative",
    weights: { fiat: 0.15, crypto: 0.30, stablecoin: 0.10, investment: 0.45 },
    note: NOTE_RISK_DERIVED,
  },
  // Placeholder entry for the personalised type — actual weights are computed
  // from the client's risk-profile row at request time by
  // `resolveBenchmarkForRiskProfileRow`. This entry exists so the type system
  // sees every union member covered; callers should never read it directly.
  risk_profile_personalised: {
    type: "risk_profile_personalised",
    weights: { fiat: 0.25, crypto: 0.25, stablecoin: 0.25, investment: 0.25 },
    note: NOTE_RISK_PROFILE_PERSONALISED,
  },
};

export const DEFAULT_REBALANCING_BENCHMARK: RebalancingBenchmark =
  REBALANCING_BENCHMARKS.equal_weight_illustrative;

// Resolve a benchmark from a 1–5 risk-tolerance integer (the same scale the
// AI recommendations route already accepts). Falls back to the illustrative
// equal-weight benchmark when the input is missing or out of range so the
// caller never has to ship a magic constant.
export function resolveBenchmarkForRiskTolerance(
  riskTolerance: number | null | undefined,
): RebalancingBenchmark {
  if (typeof riskTolerance !== "number" || !Number.isFinite(riskTolerance)) {
    return DEFAULT_REBALANCING_BENCHMARK;
  }
  if (riskTolerance <= 2) return REBALANCING_BENCHMARKS.conservative_illustrative;
  if (riskTolerance <= 4) return REBALANCING_BENCHMARKS.moderate_illustrative;
  if (riskTolerance <= 5) return REBALANCING_BENCHMARKS.aggressive_illustrative;
  return DEFAULT_REBALANCING_BENCHMARK;
}

// Shape of the `allocation` JSONB stored on a `risk_profiles` row. The
// scoring service stores percentages (summing to ~100), one per asset class
// the risk model tracks. See `server/services/risk-scoring.ts`.
export interface RiskProfileAllocation {
  cash: number;
  bonds: number;
  equities: number;
  alternatives: number;
  crypto: number;
}

// Resolve a personalised benchmark from the latest risk-profile row of a
// client. The risk-profile model tracks five asset classes (cash, bonds,
// equities, alternatives, crypto) while the platform-side rebalancing
// benchmark works in four buckets (fiat, crypto, stablecoin, investment),
// so we apply the following deterministic mapping:
//
//   • fiat       ← cash               (cash is held on-platform as fiat)
//   • crypto     ← crypto             (volatile crypto stays as crypto)
//   • investment ← bonds + equities + alternatives
//   • stablecoin ← 0                  (the risk model does not recommend any
//                                      stablecoin allocation; any stablecoin
//                                      holding therefore shows up as a real
//                                      deviation in the rebalancing gap)
//
// The function falls back to the illustrative equal-weight benchmark when
// no profile is supplied or the stored allocation is malformed (e.g. all
// zeroes or non-finite). Returning the default in those cases keeps the
// caller free of magic constants.
export function resolveBenchmarkForRiskProfileRow(
  profile: { allocation: RiskProfileAllocation } | null | undefined,
): RebalancingBenchmark {
  if (!profile || !profile.allocation) return DEFAULT_REBALANCING_BENCHMARK;
  const a = profile.allocation;

  const cash         = Number(a.cash)         || 0;
  const bonds        = Number(a.bonds)        || 0;
  const equities     = Number(a.equities)     || 0;
  const alternatives = Number(a.alternatives) || 0;
  const crypto       = Number(a.crypto)       || 0;

  const total = cash + bonds + equities + alternatives + crypto;
  if (!Number.isFinite(total) || total <= 0) return DEFAULT_REBALANCING_BENCHMARK;

  const fiat       = cash / total;
  const cryptoFrac = crypto / total;
  const investment = (bonds + equities + alternatives) / total;
  const stablecoin = 0;

  return {
    type: "risk_profile_personalised",
    weights: { fiat, crypto: cryptoFrac, stablecoin, investment },
    note: NOTE_RISK_PROFILE_PERSONALISED,
  };
}

// Resolve the canonical per-client benchmark that every read-only platform
// surface (the portfolio allocation API, the AI-recommendations route, and
// the real-metrics route) must agree on for a given user.
//
// Resolution order:
//   1. The client's latest recorded risk-profile allocation (if one exists)
//      — produces a `risk_profile_personalised` benchmark.
//   2. Otherwise the equal-weight illustrative default — so two surfaces
//      can never disagree for a profile-less user.
//
// The 1–5 `riskTolerance` band is intentionally NOT used as a fallback
// here. Routes that accept it (e.g. /api/ai-recommendations/generate) may
// still consume it for other recommendation logic, but the benchmark
// itself is resolved purely from durable per-client state so the same
// user gets the same target everywhere.
export function resolvePerClientBenchmark(
  latestRiskProfile: { allocation: RiskProfileAllocation } | null | undefined,
): RebalancingBenchmark {
  if (latestRiskProfile) {
    return resolveBenchmarkForRiskProfileRow(latestRiskProfile);
  }
  return DEFAULT_REBALANCING_BENCHMARK;
}

// Compute the one-sided turnover distance between an allocation (fractions
// summing to ~1) and a benchmark. Result is in the [0, 1] range — multiply by
// 100 at the route layer if the consumer expects a percent.
export function computeRebalancingGap(
  allocation: { fiat: number; crypto: number; stablecoin: number; investment: number },
  benchmark: RebalancingBenchmark = DEFAULT_REBALANCING_BENCHMARK,
): number {
  const w = benchmark.weights;
  return 0.5 * (
    Math.abs(allocation.fiat       - w.fiat) +
    Math.abs(allocation.crypto     - w.crypto) +
    Math.abs(allocation.stablecoin - w.stablecoin) +
    Math.abs(allocation.investment - w.investment)
  );
}
