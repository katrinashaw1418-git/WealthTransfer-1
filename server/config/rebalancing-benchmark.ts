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
  | "risk_profile_personalised"
  | "soa_personalised";

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

const NOTE_SOA_PERSONALISED =
  "Compared against the personalised target your adviser set in your Statement of Advice.";

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
  // Task #405 — placeholder for the SOA-set personalised type. Actual
  // weights are computed from the SoA target stored on the adviceRecords
  // row by `resolveBenchmarkForSoaTarget`. Same caveat as above: this
  // entry exists for type-system completeness only — callers should never
  // read these placeholder weights directly.
  soa_personalised: {
    type: "soa_personalised",
    weights: { fiat: 0.25, crypto: 0.25, stablecoin: 0.25, investment: 0.25 },
    note: NOTE_SOA_PERSONALISED,
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

// The five asset classes the risk-profile model tracks. Kept as an exported
// string-literal union so the derivation payload sent to the client is
// statically typed end-to-end and the UI can format labels from the same
// vocabulary the math uses.
export type RiskProfileClass = keyof RiskProfileAllocation;

// One source-of-truth mapping that projects the risk-profile model's five
// classes (cash, bonds, equities, alternatives, crypto) onto the platform's
// four rebalancing buckets (fiat, crypto, stablecoin, investment).
//
// Each bucket carries:
//   • `components` — the risk-profile classes that contribute to it, with
//     a `weight` in (0, 1] describing what fraction of that class flows
//     into the bucket. An empty array means "the risk model does not
//     allocate anything to this bucket" (current case for stablecoin).
//   • `explanation` — the human-readable copy the UI popover shows next to
//     the formula. Living here next to the components keeps the math and
//     the explanation in lockstep: if a future change splits investment
//     into separate equities/alternatives buckets, the explanation has to
//     be updated in the same place.
//
// `resolveBenchmarkForRiskProfileRow` and `buildBenchmarkDerivation` both
// derive their output from this table, which is the property task #402
// requires: the popover shown to the client can never drift from the
// math the rebalancing-gap calculation actually uses. The route-level
// test pins this self-healing property by recomputing the math from the
// derivation components and asserting equality with the resolver's
// weights.
type Bucket = "fiat" | "crypto" | "stablecoin" | "investment";

interface BenchmarkBucketDerivationConfig {
  components: ReadonlyArray<{ sourceClass: RiskProfileClass; weight: number }>;
  explanation: string;
}

export const RISK_PROFILE_BENCHMARK_DERIVATION: Record<
  Bucket,
  BenchmarkBucketDerivationConfig
> = {
  fiat: {
    components: [{ sourceClass: "cash", weight: 1 }],
    explanation:
      "Cash from your risk profile maps to fiat because cash held on the platform sits in fiat wallets.",
  },
  crypto: {
    components: [{ sourceClass: "crypto", weight: 1 }],
    explanation:
      "The crypto weight from your risk profile maps directly to volatile (non-stablecoin) crypto holdings.",
  },
  stablecoin: {
    components: [],
    explanation:
      "The risk-profile model does not allocate to stablecoins, so the benchmark stablecoin weight is always 0%. Any stablecoin holdings you have will therefore show up as a real deviation in the rebalancing gap.",
  },
  investment: {
    components: [
      { sourceClass: "bonds", weight: 1 },
      { sourceClass: "equities", weight: 1 },
      { sourceClass: "alternatives", weight: 1 },
    ],
    explanation:
      "The risk-profile model tracks bonds, equities and alternatives as three separate classes. The platform groups them into a single 'investment' bucket, so the benchmark weight here is the sum of those three.",
  },
};

const BUCKETS: ReadonlyArray<Bucket> = ["fiat", "crypto", "stablecoin", "investment"];

const BUCKET_LABELS: Record<Bucket, string> = {
  fiat: "Fiat",
  crypto: "Crypto",
  stablecoin: "Stablecoin",
  investment: "Investment",
};

const RISK_PROFILE_CLASS_LABELS: Record<RiskProfileClass, string> = {
  cash: "Cash",
  bonds: "Bonds",
  equities: "Equities",
  alternatives: "Alternatives",
  crypto: "Crypto",
};

function formatComponent(component: { sourceClass: RiskProfileClass; weight: number }): string {
  const label = RISK_PROFILE_CLASS_LABELS[component.sourceClass];
  if (component.weight === 1) return label;
  const pct = +(component.weight * 100).toFixed(1);
  return `${pct}% of ${label}`;
}

function formatFormula(bucket: Bucket): string {
  const { components } = RISK_PROFILE_BENCHMARK_DERIVATION[bucket];
  const lhs = BUCKET_LABELS[bucket];
  if (components.length === 0) return `${lhs} ← 0%`;
  return `${lhs} ← ${components.map(formatComponent).join(" + ")}`;
}

// Wire shape for the benchmark-derivation payload returned by the
// /api/portfolio/real-metrics endpoint when the personalised benchmark is in
// use. Mirrors the shape the AI Advisory popover renders directly — keeping
// the formula + explanation server-side ensures the UI can never silently
// disagree with the math (task #402).
export interface BenchmarkBucketDerivation {
  components: Array<{ sourceClass: RiskProfileClass; weight: number }>;
  formula: string;
  explanation: string;
}

export interface BenchmarkDerivation {
  fiat: BenchmarkBucketDerivation;
  crypto: BenchmarkBucketDerivation;
  stablecoin: BenchmarkBucketDerivation;
  investment: BenchmarkBucketDerivation;
}

// Build the per-bucket derivation payload from the same source-of-truth
// mapping table the math uses, so the popover the client renders can never
// drift from `resolveBenchmarkForRiskProfileRow`. Returned as a fresh
// object each call so callers can serialise it without worrying about
// shared mutable state.
export function buildBenchmarkDerivation(): BenchmarkDerivation {
  const out = {} as BenchmarkDerivation;
  for (const bucket of BUCKETS) {
    out[bucket] = {
      components: RISK_PROFILE_BENCHMARK_DERIVATION[bucket].components.map((c) => ({
        sourceClass: c.sourceClass,
        weight: c.weight,
      })),
      formula: formatFormula(bucket),
      explanation: RISK_PROFILE_BENCHMARK_DERIVATION[bucket].explanation,
    };
  }
  return out;
}

// Resolve a personalised benchmark from the latest risk-profile row of a
// client. The risk-profile model tracks five asset classes (cash, bonds,
// equities, alternatives, crypto) while the platform-side rebalancing
// benchmark works in four buckets — see `RISK_PROFILE_BENCHMARK_DERIVATION`
// above for the mapping. This function derives its weights from that table
// rather than hardcoding the projection, so changing the mapping in one
// place automatically updates both the math and the UI explanation.
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

  const sources: Record<RiskProfileClass, number> = {
    cash:         Number(a.cash)         || 0,
    bonds:        Number(a.bonds)        || 0,
    equities:     Number(a.equities)     || 0,
    alternatives: Number(a.alternatives) || 0,
    crypto:       Number(a.crypto)       || 0,
  };

  const total =
    sources.cash + sources.bonds + sources.equities + sources.alternatives + sources.crypto;
  if (!Number.isFinite(total) || total <= 0) return DEFAULT_REBALANCING_BENCHMARK;

  const weights = { fiat: 0, crypto: 0, stablecoin: 0, investment: 0 };
  for (const bucket of BUCKETS) {
    let sum = 0;
    for (const c of RISK_PROFILE_BENCHMARK_DERIVATION[bucket].components) {
      sum += sources[c.sourceClass] * c.weight;
    }
    weights[bucket] = sum / total;
  }

  return {
    type: "risk_profile_personalised",
    weights,
    note: NOTE_RISK_PROFILE_PERSONALISED,
  };
}

// Shape of the `soaTargetAllocation` JSONB stored on an adviceRecords row.
// Stored as percentages 0–100 summing to ~100, in the four platform buckets
// the rebalancing benchmark already works in. The resolver below normalises
// them to fractions and surfaces a `soa_personalised` benchmark.
export interface SoaTargetAllocation {
  fiat: number;
  crypto: number;
  stablecoin: number;
  investment: number;
}

// Resolve a personalised benchmark from the SoA target an adviser stored
// against the client's latest live advice record. Returns null when the
// stored allocation is missing or malformed (all zeroes / non-finite) so the
// caller can fall through to the next preference (risk-profile, then
// equal-weight). Returning null rather than the equal-weight default lets
// `resolvePerClientBenchmark` cleanly express the resolution order without
// double-checking malformed-input semantics here.
export function resolveBenchmarkForSoaTarget(
  target: SoaTargetAllocation | null | undefined,
): RebalancingBenchmark | null {
  if (!target) return null;

  const fiat       = Number(target.fiat)       || 0;
  const crypto     = Number(target.crypto)     || 0;
  const stablecoin = Number(target.stablecoin) || 0;
  const investment = Number(target.investment) || 0;

  const total = fiat + crypto + stablecoin + investment;
  if (!Number.isFinite(total) || total <= 0) return null;

  return {
    type: "soa_personalised",
    weights: {
      fiat:       fiat       / total,
      crypto:     crypto     / total,
      stablecoin: stablecoin / total,
      investment: investment / total,
    },
    note: NOTE_SOA_PERSONALISED,
  };
}

// Resolve the canonical per-client benchmark that every read-only platform
// surface (the portfolio allocation API, the AI-recommendations route, and
// the real-metrics route) must agree on for a given user.
//
// Resolution order (highest preference first):
//   1. Task #405 — the SoA target an adviser set on the client's latest
//      *live* advice record (status in {issued, accepted}). Produces a
//      `soa_personalised` benchmark. The route layer is responsible for
//      filtering on status before passing the row in here so this helper
//      stays a pure function of its arguments.
//   2. The client's latest recorded risk-profile allocation (if one exists)
//      — produces a `risk_profile_personalised` benchmark.
//   3. Otherwise the equal-weight illustrative default — so two surfaces
//      can never disagree for a profile-less user.
//
// The 1–5 `riskTolerance` band is intentionally NOT used as a fallback
// here. Routes that accept it (e.g. /api/ai-recommendations/generate) may
// still consume it for other recommendation logic, but the benchmark
// itself is resolved purely from durable per-client state so the same
// user gets the same target everywhere.
export function resolvePerClientBenchmark(
  latestRiskProfile: { allocation: RiskProfileAllocation } | null | undefined,
  latestSoaTarget?: SoaTargetAllocation | null,
): RebalancingBenchmark {
  const soa = resolveBenchmarkForSoaTarget(latestSoaTarget);
  if (soa) return soa;
  if (latestRiskProfile) {
    return resolveBenchmarkForRiskProfileRow(latestRiskProfile);
  }
  return DEFAULT_REBALANCING_BENCHMARK;
}

// Asset-class allocation comparison payload returned by the
// /api/portfolio/real-metrics route. Centralised here (rather than built
// inline in the route handler) so the wire shape and the rounding rule —
// percentages 0–100 with one decimal — live in one auditable place that
// the AI Advisory page test can pin without duplicating the math.
//
// `hasAllocationData` is *not* derived from the per-class numbers because a
// freshly onboarded client legitimately has zero in every bucket; the route
// supplies the flag explicitly (`totalValue > 0`) so the UI can render the
// "no allocation data yet" placeholder instead of a misleading row of zeros.
export interface AllocationComparisonPayload {
  currentAllocation: { fiat: number; crypto: number; stablecoin: number; investment: number };
  benchmarkAllocation: { fiat: number; crypto: number; stablecoin: number; investment: number };
  hasAllocationData: boolean;
}

export function buildAllocationComparisonPayload(
  allocation: { fiat: number; crypto: number; stablecoin: number; investment: number },
  benchmark: RebalancingBenchmark,
  hasAllocationData: boolean,
): AllocationComparisonPayload {
  const toPct = (n: number): number => +(n * 100).toFixed(1);
  return {
    currentAllocation: {
      fiat:       toPct(allocation.fiat),
      crypto:     toPct(allocation.crypto),
      stablecoin: toPct(allocation.stablecoin),
      investment: toPct(allocation.investment),
    },
    benchmarkAllocation: {
      fiat:       toPct(benchmark.weights.fiat),
      crypto:     toPct(benchmark.weights.crypto),
      stablecoin: toPct(benchmark.weights.stablecoin),
      investment: toPct(benchmark.weights.investment),
    },
    hasAllocationData,
  };
}

// ---------------------------------------------------------------------------
// Recommendation tier resolution (task #394 / #407).
//
// `/api/ai-recommendations/generate` flavours its textual recommendations by
// one of three copy buckets — "conservative", "moderate", "aggressive". The
// resolution policy mirrors `resolvePerClientBenchmark` above:
//
//   1. If the client has a stored `riskProfiles` row, derive the tier from
//      its 5-band `riskBand` value (see `RiskBand` in
//      `server/services/risk-scoring.ts`):
//         conservative              → conservative
//         moderate | balanced       → moderate
//         growth | high_growth      → aggressive
//      An unknown band falls through to "moderate" (the safest middle copy)
//      rather than guessing aggressive on a future band the resolver has
//      not been taught yet.
//   2. Otherwise fall back to the per-request `riskTolerance` integer
//      using the exact `<=` ladder the route handler used pre-extraction
//      so the helper is a behaviour-preserving refactor:
//         tolerance <= 2 → conservative
//         tolerance <= 4 → moderate
//         else            → aggressive
//      A `NaN` tolerance (the only common runtime input where every `<=`
//      comparison is false) lands in the final `else` → aggressive,
//      matching what the original handler did. Other numeric inputs
//      (including ±Infinity) flow through the same comparator as before.
//
// Centralising the policy here means the route handler stays thin AND the
// behaviour can be unit-tested without spinning up Express. A regression
// that re-keys the recommendation copy on `riskTolerance` instead of the
// stored `riskBand` is caught by `scripts/test-recommendation-tier.ts`.
export type RecommendationTier = "conservative" | "moderate" | "aggressive";

export function resolveRecommendationTier(
  latestRiskProfile: { riskBand: string | null | undefined } | null | undefined,
  riskTolerance: number,
): RecommendationTier {
  if (latestRiskProfile) {
    switch (latestRiskProfile.riskBand) {
      case "conservative":
        return "conservative";
      case "moderate":
      case "balanced":
        return "moderate";
      case "growth":
      case "high_growth":
        return "aggressive";
      default:
        return "moderate";
    }
  }
  if (riskTolerance <= 2) return "conservative";
  if (riskTolerance <= 4) return "moderate";
  return "aggressive";
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
