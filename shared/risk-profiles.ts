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

// Ordered list of the known risk profile enum values, in increasing-risk order
// (matches `RISK_PROFILE_LABELS` insertion order). Use this for filter options
// and for sorting products by risk band so adding a new band only needs an edit
// to `RISK_PROFILE_LABELS` above.
export const RISK_PROFILE_KEYS = Object.keys(RISK_PROFILE_LABELS) as KnownRiskProfile[];

const KNOWN_RISK_PROFILE_SET = new Set<string>(RISK_PROFILE_KEYS);

export function isKnownRiskProfile(value: string | null | undefined): value is KnownRiskProfile {
  return typeof value === "string" && KNOWN_RISK_PROFILE_SET.has(value);
}

// Best-effort coerce any raw risk profile string into one of the known enum
// keys. Accepts the canonical lowercase keys ("low", "very_high"), as well as
// historical sentence-case forms ("Low", "Very High") that some seed data
// still uses. Returns `null` when the value cannot be matched so callers can
// fall back gracefully.
export function toKnownRiskProfile(value: string | null | undefined): KnownRiskProfile | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  return isKnownRiskProfile(normalized) ? normalized : null;
}

export function riskProfileLabel(value: string | null | undefined): string {
  const known = toKnownRiskProfile(value);
  if (known) return RISK_PROFILE_LABELS[known];
  if (!value) return "Unrated";
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Rank for sorting by risk band (lower = less risky). Unknown profiles sort
// after all known bands so they remain visible but don't disrupt ordering.
export function riskProfileRank(value: string | null | undefined): number {
  const known = toKnownRiskProfile(value);
  if (!known) return RISK_PROFILE_KEYS.length;
  return RISK_PROFILE_KEYS.indexOf(known);
}

// Shadcn Badge variant for each known risk band. Defined here (rather than in
// each consumer) so adding a new band in `RISK_PROFILE_LABELS` becomes a
// TypeScript error until a colour is chosen, satisfying the "only edit one
// file to add a band" rule. Values are plain string literals so this module
// stays UI-framework-free.
export type RiskBadgeVariant = "default" | "secondary" | "outline" | "destructive";

export const RISK_BADGE_VARIANTS: Record<KnownRiskProfile, RiskBadgeVariant> = {
  low: "secondary",
  conservative: "secondary",
  moderate: "outline",
  high: "default",
  very_high: "destructive",
};

export function riskProfileBadgeVariant(value: string | null | undefined): RiskBadgeVariant {
  const known = toKnownRiskProfile(value);
  return known ? RISK_BADGE_VARIANTS[known] : "outline";
}
