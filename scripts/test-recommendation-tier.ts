/**
 * Unit tests for `resolveRecommendationTier` in
 * `server/config/rebalancing-benchmark.ts` — the helper that decides
 * which copy bucket ("conservative" / "moderate" / "aggressive") the
 * `/api/ai-recommendations/generate` route uses to flavour its textual
 * recommendations.
 *
 * Background — task #394 changed the route so the textual tier is
 * derived from the latest `riskProfiles.riskBand` row when one exists,
 * falling back to the per-request `riskTolerance` 1–5 integer only when
 * no profile is on file. The behaviour was verified manually but had
 * no automated coverage, so a regression that re-keyed the copy on
 * `riskTolerance` (the pre-#394 behaviour, where a stored "growth"
 * profile + stale `riskTolerance: 1` would emit conservative copy)
 * would slip through CI. Task #407 adds this gate.
 *
 * The cases pinned here are exactly those listed in the task brief:
 *   • `riskBand: "conservative"`         → conservative copy regardless of `riskTolerance`
 *   • `riskBand: "moderate" | "balanced"` → moderate copy
 *   • `riskBand: "growth" | "high_growth"` → aggressive copy
 *   • No profile + `riskTolerance <= 2 / <= 4 / else` → conservative / moderate / aggressive
 *   • The "growth profile but `riskTolerance: 1`" smoke case from the brief
 *
 * Plus, defensively:
 *   • Every `RiskBand` value defined in `server/services/risk-scoring.ts`
 *     is covered by a case here — added via a coverage assertion that
 *     fails if a future band slips into the type without a matching
 *     test fixture below. (This is the same self-healing pattern used
 *     by `scripts/test-rebalancing-benchmark.ts` for the canonical
 *     `PORTFOLIO_ALLOCATIONS` map.)
 *   • An unknown band falls through to "moderate" (the safest middle
 *     bucket), matching the route handler's `default:` branch.
 *   • Out-of-range / non-finite `riskTolerance` with no profile resolves
 *     to "aggressive" — preserved from the pre-extraction route handler
 *     where the final `else` swallowed those inputs.
 *
 * The script is purely static — it does not hit the database or any
 * external service — so it can be wired into the same CI surface as
 * `scripts/test-rebalancing-benchmark.ts` (the existing static-
 * regression test pattern in this repo) without leak-gate concerns.
 *
 * Run with: `npx tsx scripts/test-recommendation-tier.ts`
 *
 * Exits non-zero on the first failure with an actionable message.
 */

import {
  resolveRecommendationTier,
  type RecommendationTier,
} from "../server/config/rebalancing-benchmark";
import type { RiskBand } from "../server/services/risk-scoring";

// ---------------------------------------------------------------------------
// Tiny assertion helpers — kept local so this script has no test-runner
// dependency, matching the style of the other `scripts/test-*.ts` files
// (see `scripts/test-rebalancing-benchmark.ts`).
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

// ---------------------------------------------------------------------------
// 1. Stored riskBand drives the tier — and `riskTolerance` is ignored.
//
// Task #394's whole point: if the client has a recorded risk profile we
// trust the durable `riskBand` over the per-request `riskTolerance`
// integer. We exercise every band against THREE different tolerances
// (the conservative-tier value, the moderate-tier value, and the
// aggressive-tier value from the fallback ladder) so a regression that
// silently re-keys the copy on `riskTolerance` fails on every band.
// ---------------------------------------------------------------------------

interface StoredBandCase {
  band: RiskBand;
  expected: RecommendationTier;
}

const STORED_BAND_CASES: StoredBandCase[] = [
  { band: "conservative", expected: "conservative" },
  { band: "moderate",     expected: "moderate" },
  { band: "balanced",     expected: "moderate" },
  { band: "growth",       expected: "aggressive" },
  { band: "high_growth",  expected: "aggressive" },
];

// `riskTolerance` values picked so each one would, on its own (without a
// profile), produce a DIFFERENT tier than the band-derived expected
// tier for at least one of the bands above. This is what makes the
// "stored band wins over riskTolerance" assertion meaningful — if the
// helper accidentally re-keyed on tolerance, at least one tolerance in
// this list would force a different result for every band.
const TOLERANCE_VALUES_TO_PROBE: number[] = [1, 3, 5];

for (const { band, expected } of STORED_BAND_CASES) {
  for (const tol of TOLERANCE_VALUES_TO_PROBE) {
    const tier = resolveRecommendationTier({ riskBand: band }, tol);
    record(
      `stored band wins: riskBand=${band} + riskTolerance=${tol}`,
      tier === expected,
      `expected ${expected}, got ${tier} (a regression that re-keys the recommendation copy on riskTolerance instead of riskBand would land here)`,
    );
  }
}

// Self-healing coverage: if a future change adds a new `RiskBand` value
// without updating the resolver AND this test, the assertion below
// fires with a "band coverage drift" message. We use a `satisfies`-shaped
// exhaustive switch (Record<RiskBand, true>) to drive the expected set
// from the type itself, so the test surface widens automatically.
const COVERED_BANDS: Record<RiskBand, true> = {
  conservative: true,
  moderate:     true,
  balanced:     true,
  growth:       true,
  high_growth:  true,
};
const expectedBandCount = Object.keys(COVERED_BANDS).length;
record(
  "stored band coverage matches RiskBand union",
  STORED_BAND_CASES.length === expectedBandCount,
  `expected ${expectedBandCount} STORED_BAND_CASES (one per RiskBand value), got ${STORED_BAND_CASES.length} — band coverage drifted; update STORED_BAND_CASES and the resolver in lockstep`,
);

// ---------------------------------------------------------------------------
// 2. Smoke case from the task brief: a stored growth profile with a
// stale `riskTolerance: 1` MUST still produce aggressive copy. This is
// the regression Task #394 fixed and Task #407 pins.
// ---------------------------------------------------------------------------

record(
  "smoke: growth profile + riskTolerance=1 → aggressive",
  resolveRecommendationTier({ riskBand: "growth" }, 1) === "aggressive",
  "stored growth profile produced non-aggressive copy when riskTolerance=1 — the exact pre-#394 regression this gate exists to catch",
);

// ---------------------------------------------------------------------------
// 3. Unknown bands fall through to "moderate" (the safest middle copy).
// ---------------------------------------------------------------------------

const UNKNOWN_BAND_INPUTS: Array<string | null | undefined> = [
  "speculative",
  "ULTRA_GROWTH",
  "",
  null,
  undefined,
];

for (const band of UNKNOWN_BAND_INPUTS) {
  const tier = resolveRecommendationTier(
    { riskBand: band as string | null | undefined },
    3,
  );
  record(
    `unknown band falls through to moderate: riskBand=${JSON.stringify(band)}`,
    tier === "moderate",
    `expected moderate (the resolver's safest default branch), got ${tier}`,
  );
}

// ---------------------------------------------------------------------------
// 4. No profile — the per-request `riskTolerance` ladder kicks in.
//
// The contract from the route handler (preserved exactly so the helper
// extraction is behaviour-preserving):
//   tolerance <= 2 → conservative
//   tolerance <= 4 → moderate
//   else           → aggressive
// `NaN` short-circuits every `<=` comparison to false, so it lands in
// the final `else` → aggressive. ±Infinity flow through the comparator
// as plain JS would, so Infinity is aggressive and -Infinity falls into
// the conservative branch — pinned below to lock the JS comparator
// semantics in place.
// ---------------------------------------------------------------------------

interface FallbackCase {
  input: number;
  expected: RecommendationTier;
  label: string;
}

const FALLBACK_CASES: FallbackCase[] = [
  // <= 2 → conservative.
  { input: 1, expected: "conservative", label: "tolerance=1 (no profile)" },
  { input: 2, expected: "conservative", label: "tolerance=2 (no profile, conservative upper boundary)" },
  // <= 4 → moderate.
  { input: 3, expected: "moderate",     label: "tolerance=3 (no profile, moderate lower boundary)" },
  { input: 4, expected: "moderate",     label: "tolerance=4 (no profile, moderate upper boundary)" },
  // > 4 → aggressive (in-range).
  { input: 5, expected: "aggressive",   label: "tolerance=5 (no profile, aggressive boundary)" },
  // Out-of-range high — the route's final `else` makes this aggressive too.
  { input: 6, expected: "aggressive",   label: "tolerance=6 (no profile, above range → aggressive)" },
  { input: 100, expected: "aggressive", label: "tolerance=100 (no profile, far above range → aggressive)" },
  // Sub-1 — still <= 2 → conservative (documents the inclusive comparator).
  { input: 0, expected: "conservative", label: "tolerance=0 (no profile, still <=2 → conservative)" },
  { input: -3, expected: "conservative", label: "tolerance=-3 (no profile, still <=2 → conservative)" },
  // Fractional just above each boundary — verifies the comparator is `<=`.
  { input: 2.0001, expected: "moderate",   label: "tolerance=2.0001 (no profile, just above conservative cap)" },
  { input: 4.0001, expected: "aggressive", label: "tolerance=4.0001 (no profile, just above moderate cap)" },
  // Non-finite — NaN makes every `<=` false → aggressive (the original
  // handler's final `else`); ±Infinity flow through the comparator as
  // they would in any plain JS `<=` check, so Infinity is aggressive
  // and -Infinity is conservative. Pinned here so a future "tighten
  // the input" refactor that early-returns on non-finite values can't
  // silently change the route's behaviour without flipping this test.
  { input: NaN, expected: "aggressive",       label: "tolerance=NaN (no profile) → aggressive" },
  { input: Infinity, expected: "aggressive",  label: "tolerance=Infinity (no profile) → aggressive" },
  { input: -Infinity, expected: "conservative", label: "tolerance=-Infinity (no profile, still <=2) → conservative" },
];

for (const { input, expected, label } of FALLBACK_CASES) {
  // Both `null` and `undefined` profiles must take the fallback path.
  for (const profile of [null, undefined] as const) {
    const tier = resolveRecommendationTier(profile, input);
    record(
      `fallback ladder (${profile === null ? "profile=null" : "profile=undefined"}): ${label}`,
      tier === expected,
      `expected ${expected}, got ${tier}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 5. Defensive: a profile with a recognised band ALWAYS produces the
// band-derived tier no matter what `riskTolerance` is — including the
// non-finite / missing tolerances. This pins the "stored band wins"
// invariant against a regression that only re-keyed copy when the
// fallback ladder produced a finite number.
// ---------------------------------------------------------------------------

const NONFINITE_TOLERANCES: number[] = [NaN, Infinity, -Infinity];

for (const { band, expected } of STORED_BAND_CASES) {
  for (const tol of NONFINITE_TOLERANCES) {
    const tier = resolveRecommendationTier({ riskBand: band }, tol);
    record(
      `stored band wins over non-finite tolerance: riskBand=${band} + riskTolerance=${String(tol)}`,
      tier === expected,
      `expected ${expected}, got ${tier} (band-derived tier must not depend on the tolerance fallback ladder)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(
    `✗ recommendation-tier tests: ${failures.length} failure(s) (${passed} passed)\n`,
  );
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nSee server/config/rebalancing-benchmark.ts (resolveRecommendationTier) and task #407 for context.",
  );
  process.exit(1);
}

console.log(
  `✓ recommendation-tier tests: ${passed} assertion(s) passed across resolveRecommendationTier (stored riskBand precedence, fallback ladder, smoke case from the task brief).`,
);
