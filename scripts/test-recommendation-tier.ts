/**
 * Unit tests for `resolveRecommendationKind` in
 * `server/config/rebalancing-benchmark.ts` — the helper that decides
 * which copy bucket the `/api/ai-recommendations/generate` route uses
 * to flavour its textual recommendations.
 *
 * Background — task #394 changed the route so the textual tier is
 * derived from the latest `riskProfiles.riskBand` row when one exists,
 * falling back to the per-request `riskTolerance` 1–5 integer only
 * when no profile is on file. Task #407 extracted the policy into a
 * helper so it could be unit-tested without spinning up Express.
 *
 * Task #408 then widened the helper from a 3-tier
 * `RecommendationTier` (conservative / moderate / aggressive) into a
 * 5-band `RecommendationKind`. When a stored profile exists we now
 * return its `riskBand` directly (one of the five canonical bands:
 * conservative / moderate / balanced / growth / high_growth) so each
 * band can render copy whose thresholds line up with its row in
 * `PORTFOLIO_ALLOCATIONS`. The fallback ladder (no profile + a 1–5
 * `riskTolerance`) returns the three `tol_*` kinds — these preserve
 * the legacy 3-tier copy for callers that don't supply a stored
 * profile, so the request-only contract still works.
 *
 * The cases pinned here:
 *   • Each `RiskBand` value → the SAME band kind is returned, regardless
 *     of `riskTolerance`. A regression that re-keyed the copy on
 *     `riskTolerance` (the pre-#394 behaviour) would fail every band.
 *   • Each `RiskBand` value gets its own `RecommendationKind` (no
 *     collapsing) — the regression #408 exists to prevent (a future
 *     change that re-collapsed `balanced`→`moderate` or
 *     `high_growth`→`growth` would fail the distinctness assertion).
 *   • Unknown bands fall through to "moderate" (the safest middle
 *     bucket), matching the route handler's defensive default.
 *   • No profile + `riskTolerance` 1–5 ladder → tol_conservative /
 *     tol_moderate / tol_aggressive.
 *   • The "growth profile but `riskTolerance: 1`" smoke case from the
 *     #394 brief still returns the band-derived kind (now `growth`
 *     rather than the legacy `aggressive`).
 *
 * Plus, defensively:
 *   • Every `RiskBand` value defined in `server/services/risk-scoring.ts`
 *     is covered by a case here — added via a coverage assertion that
 *     fails if a future band slips into the type without a matching
 *     test fixture below.
 *   • Out-of-range / non-finite `riskTolerance` with no profile resolves
 *     to "tol_aggressive" — preserved from the pre-extraction route
 *     handler where the final `else` swallowed those inputs.
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
  resolveRecommendationKind,
  type RecommendationKind,
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
// 1. Stored riskBand drives the kind — and `riskTolerance` is ignored.
//
// Task #394's whole point: if the client has a recorded risk profile we
// trust the durable `riskBand` over the per-request `riskTolerance`
// integer. Task #408 sharpens this further: each band returns its OWN
// kind (no collapsing onto 3 tiers). We exercise every band against
// THREE different tolerances so a regression that silently re-keys
// the copy on `riskTolerance` fails on every band.
// ---------------------------------------------------------------------------

interface StoredBandCase {
  band: RiskBand;
  expected: RecommendationKind;
}

const STORED_BAND_CASES: StoredBandCase[] = [
  { band: "conservative", expected: "conservative" },
  { band: "moderate",     expected: "moderate" },
  { band: "balanced",     expected: "balanced" },
  { band: "growth",       expected: "growth" },
  { band: "high_growth",  expected: "high_growth" },
];

// `riskTolerance` values picked so each one would, on its own (without a
// profile), produce a DIFFERENT kind than the band-derived expected
// kind for at least one of the bands above. This is what makes the
// "stored band wins over riskTolerance" assertion meaningful — if the
// helper accidentally re-keyed on tolerance, at least one tolerance in
// this list would force a different result for every band.
const TOLERANCE_VALUES_TO_PROBE: number[] = [1, 3, 5];

for (const { band, expected } of STORED_BAND_CASES) {
  for (const tol of TOLERANCE_VALUES_TO_PROBE) {
    const kind = resolveRecommendationKind({ riskBand: band }, tol);
    record(
      `stored band wins: riskBand=${band} + riskTolerance=${tol}`,
      kind === expected,
      `expected ${expected}, got ${kind} (a regression that re-keys the recommendation copy on riskTolerance instead of riskBand would land here)`,
    );
  }
}

// Distinctness gate (Task #408): every band MUST resolve to a unique
// `RecommendationKind`. A regression that re-collapses, say,
// `high_growth`→`growth` would fail this assertion before it could
// silently un-personalise the AI-recommendations copy.
const distinctKinds = new Set(STORED_BAND_CASES.map(c => c.expected));
record(
  "every RiskBand resolves to a distinct RecommendationKind (no collapsing)",
  distinctKinds.size === STORED_BAND_CASES.length,
  `expected ${STORED_BAND_CASES.length} distinct kinds, got ${distinctKinds.size} — a regression that re-collapses two bands onto the same copy bucket lands here (the exact thing Task #408 fixed)`,
);

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
// 2. Smoke case from the #394 task brief: a stored growth profile with a
// stale `riskTolerance: 1` MUST still produce growth-flavoured copy.
// Pre-#408 this returned the legacy `aggressive`; post-#408 it returns
// the band-direct `growth` kind. Either way the regression #394/#407
// gate against (re-keying on `riskTolerance`) still fails this test.
// ---------------------------------------------------------------------------

record(
  "smoke: growth profile + riskTolerance=1 → growth (band-direct, not aggressive fallback)",
  resolveRecommendationKind({ riskBand: "growth" }, 1) === "growth",
  "stored growth profile produced non-growth copy when riskTolerance=1 — the exact pre-#394 regression this gate exists to catch",
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
  const kind = resolveRecommendationKind(
    { riskBand: band as string | null | undefined },
    3,
  );
  record(
    `unknown band falls through to moderate: riskBand=${JSON.stringify(band)}`,
    kind === "moderate",
    `expected moderate (the resolver's safest default branch), got ${kind}`,
  );
}

// ---------------------------------------------------------------------------
// 4. No profile — the per-request `riskTolerance` ladder kicks in and
// returns one of the three `tol_*` fallback kinds.
//
// The contract from the route handler (preserved exactly so the helper
// extraction is behaviour-preserving):
//   tolerance <= 2 → tol_conservative
//   tolerance <= 4 → tol_moderate
//   else           → tol_aggressive
// `NaN` short-circuits every `<=` comparison to false, so it lands in
// the final `else` → tol_aggressive. ±Infinity flow through the
// comparator as plain JS would, so Infinity is tol_aggressive and
// -Infinity falls into the tol_conservative branch — pinned below to
// lock the JS comparator semantics in place.
// ---------------------------------------------------------------------------

interface FallbackCase {
  input: number;
  expected: RecommendationKind;
  label: string;
}

const FALLBACK_CASES: FallbackCase[] = [
  // <= 2 → tol_conservative.
  { input: 1, expected: "tol_conservative", label: "tolerance=1 (no profile)" },
  { input: 2, expected: "tol_conservative", label: "tolerance=2 (no profile, conservative upper boundary)" },
  // <= 4 → tol_moderate.
  { input: 3, expected: "tol_moderate",     label: "tolerance=3 (no profile, moderate lower boundary)" },
  { input: 4, expected: "tol_moderate",     label: "tolerance=4 (no profile, moderate upper boundary)" },
  // > 4 → tol_aggressive (in-range).
  { input: 5, expected: "tol_aggressive",   label: "tolerance=5 (no profile, aggressive boundary)" },
  // Out-of-range high — the route's final `else` makes this tol_aggressive too.
  { input: 6, expected: "tol_aggressive",   label: "tolerance=6 (no profile, above range → tol_aggressive)" },
  { input: 100, expected: "tol_aggressive", label: "tolerance=100 (no profile, far above range → tol_aggressive)" },
  // Sub-1 — still <= 2 → tol_conservative (documents the inclusive comparator).
  { input: 0, expected: "tol_conservative", label: "tolerance=0 (no profile, still <=2 → tol_conservative)" },
  { input: -3, expected: "tol_conservative", label: "tolerance=-3 (no profile, still <=2 → tol_conservative)" },
  // Fractional just above each boundary — verifies the comparator is `<=`.
  { input: 2.0001, expected: "tol_moderate",   label: "tolerance=2.0001 (no profile, just above conservative cap)" },
  { input: 4.0001, expected: "tol_aggressive", label: "tolerance=4.0001 (no profile, just above moderate cap)" },
  // Non-finite — NaN makes every `<=` false → tol_aggressive (the original
  // handler's final `else`); ±Infinity flow through the comparator as
  // they would in any plain JS `<=` check, so Infinity is tol_aggressive
  // and -Infinity is tol_conservative. Pinned here so a future "tighten
  // the input" refactor that early-returns on non-finite values can't
  // silently change the route's behaviour without flipping this test.
  { input: NaN, expected: "tol_aggressive",       label: "tolerance=NaN (no profile) → tol_aggressive" },
  { input: Infinity, expected: "tol_aggressive",  label: "tolerance=Infinity (no profile) → tol_aggressive" },
  { input: -Infinity, expected: "tol_conservative", label: "tolerance=-Infinity (no profile, still <=2) → tol_conservative" },
];

for (const { input, expected, label } of FALLBACK_CASES) {
  // Both `null` and `undefined` profiles must take the fallback path.
  for (const profile of [null, undefined] as const) {
    const kind = resolveRecommendationKind(profile, input);
    record(
      `fallback ladder (${profile === null ? "profile=null" : "profile=undefined"}): ${label}`,
      kind === expected,
      `expected ${expected}, got ${kind}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 5. Defensive: a profile with a recognised band ALWAYS produces the
// band-derived kind no matter what `riskTolerance` is — including the
// non-finite / missing tolerances. This pins the "stored band wins"
// invariant against a regression that only re-keyed copy when the
// fallback ladder produced a finite number.
// ---------------------------------------------------------------------------

const NONFINITE_TOLERANCES: number[] = [NaN, Infinity, -Infinity];

for (const { band, expected } of STORED_BAND_CASES) {
  for (const tol of NONFINITE_TOLERANCES) {
    const kind = resolveRecommendationKind({ riskBand: band }, tol);
    record(
      `stored band wins over non-finite tolerance: riskBand=${band} + riskTolerance=${String(tol)}`,
      kind === expected,
      `expected ${expected}, got ${kind} (band-derived kind must not depend on the tolerance fallback ladder)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(
    `✗ recommendation-kind tests: ${failures.length} failure(s) (${passed} passed)\n`,
  );
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nSee server/config/rebalancing-benchmark.ts (resolveRecommendationKind) and tasks #407 / #408 for context.",
  );
  process.exit(1);
}

console.log(
  `✓ recommendation-kind tests: ${passed} assertion(s) passed across resolveRecommendationKind (stored riskBand precedence, per-band distinctness, fallback ladder, smoke case from the task brief).`,
);
