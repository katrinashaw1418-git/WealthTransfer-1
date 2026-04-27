// =============================================================================
// KNOWN INVESTMENT PRODUCT RISK PROFILES
// -----------------------------------------------------------------------------
// Single source of truth for the human-readable label associated with each
// `investment_products.risk_profile` enum value. The investments page filter
// dropdown and the badge colour map both derive from this so adding or
// renaming a risk band stays in sync everywhere.
//
// Adding a new risk profile? Add the (enum value -> label) pair here and the
// matching badge colour in any consumer (e.g. `riskProfileColors` on the
// investments page) becomes a type error until it's filled in.
// =============================================================================

export const RISK_PROFILE_LABELS = {
  low: "Low",
  conservative: "Conservative",
  moderate: "Moderate",
  high: "High",
  very_high: "Very High",
} as const;

export type KnownRiskProfile = keyof typeof RISK_PROFILE_LABELS;

const KNOWN_RISK_PROFILE_SET = new Set<string>(Object.keys(RISK_PROFILE_LABELS));

export function isKnownRiskProfile(value: string | null | undefined): value is KnownRiskProfile {
  return typeof value === "string" && KNOWN_RISK_PROFILE_SET.has(value);
}

export function riskProfileLabel(value: string | null | undefined): string {
  if (isKnownRiskProfile(value)) return RISK_PROFILE_LABELS[value];
  if (!value) return "Unrated";
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
