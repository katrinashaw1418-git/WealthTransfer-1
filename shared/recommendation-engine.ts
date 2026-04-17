// Deterministic recommendation engine for Flow A.
// Pure lookup over (risk × horizon) → strategy. Capital determines private-access gating.
// No scoring, no ML, no confidence claims — those would risk being construed as personal advice.

export type RiskTolerance = "conservative" | "balanced" | "growth" | "high_growth";
export type TimeHorizon = "short" | "medium" | "long"; // <3y | 3-7y | 7+y
export type CapitalRange = "under_10k" | "10k_100k" | "100k_500k" | "500k_plus";
export type ProfileType = "individual" | "family_office" | "corporate" | "international";

export interface WizardAnswers {
  profileType: ProfileType;
  goals: string[];
  riskTolerance: RiskTolerance;
  timeHorizon: TimeHorizon;
  capitalRange: CapitalRange;
}

export interface Recommendation {
  strategy: string;
  summary: string;
  allocation: { label: string; pct: number }[];
  privateAccess: boolean;
  showFeaturedDeal: boolean;
  caveat?: string;
}

const PRIVATE_ACCESS_CAPITAL: CapitalRange[] = ["100k_500k", "500k_plus"];

// 4 risk × 3 horizon = 12 cells
const TABLE: Record<RiskTolerance, Record<TimeHorizon, Omit<Recommendation, "privateAccess" | "showFeaturedDeal">>> = {
  conservative: {
    short: {
      strategy: "Income & Capital Preservation",
      summary: "Capital protection with stable income. Short-dated credit and cash-equivalent allocations.",
      allocation: [
        { label: "Stablecoin / Cash", pct: 60 },
        { label: "First-Mortgage Credit", pct: 30 },
        { label: "Investment Grade Bonds", pct: 10 },
      ],
    },
    medium: {
      strategy: "Stable Income Plus",
      summary: "Income-led portfolio with modest growth. Senior credit and real estate income strategies.",
      allocation: [
        { label: "First-Mortgage Credit", pct: 50 },
        { label: "Real Estate Income", pct: 30 },
        { label: "Stablecoin / Cash", pct: 20 },
      ],
    },
    long: {
      strategy: "Stable Income & Modest Growth",
      summary: "Long-dated income strategies with a small allocation to defensive growth assets.",
      allocation: [
        { label: "Real Estate Income", pct: 45 },
        { label: "Corporate Credit", pct: 35 },
        { label: "Defensive Equity", pct: 20 },
      ],
    },
  },
  balanced: {
    short: {
      strategy: "Defensive Balanced",
      summary: "Short horizons with balanced risk warrant heavier income allocation than a typical balanced sleeve.",
      caveat: "A short horizon with balanced risk usually means more income, less growth. We'll lean defensive.",
      allocation: [
        { label: "First-Mortgage Credit", pct: 45 },
        { label: "Stablecoin / Cash", pct: 30 },
        { label: "Real Estate Income", pct: 25 },
      ],
    },
    medium: {
      strategy: "Balanced Income & Growth",
      summary: "Diversified across income-producing credit, real estate, and growth equity.",
      allocation: [
        { label: "Corporate Credit", pct: 35 },
        { label: "Real Estate", pct: 35 },
        { label: "Growth Equity", pct: 30 },
      ],
    },
    long: {
      strategy: "Diversified Growth",
      summary: "Long-horizon balanced portfolio tilted toward growth assets while retaining an income base.",
      allocation: [
        { label: "Growth Equity", pct: 40 },
        { label: "Real Estate", pct: 35 },
        { label: "Corporate Credit", pct: 25 },
      ],
    },
  },
  growth: {
    short: {
      strategy: "Tactical Growth",
      summary: "Short horizons with growth appetite need careful sizing — volatility risk is real over <3 years.",
      caveat: "Growth assets typically need 5+ years to ride out volatility. We've trimmed equity weight accordingly.",
      allocation: [
        { label: "Growth Equity", pct: 40 },
        { label: "Real Estate", pct: 30 },
        { label: "Credit", pct: 30 },
      ],
    },
    medium: {
      strategy: "Growth Portfolio",
      summary: "Equity-led portfolio with real estate and selective venture exposure.",
      allocation: [
        { label: "Growth Equity", pct: 50 },
        { label: "Real Estate", pct: 25 },
        { label: "Venture / Private Markets", pct: 15 },
        { label: "Credit", pct: 10 },
      ],
    },
    long: {
      strategy: "Long-term Growth Portfolio",
      summary: "Long-horizon growth with meaningful private market and venture allocations.",
      allocation: [
        { label: "Growth Equity", pct: 45 },
        { label: "Venture / Private Markets", pct: 25 },
        { label: "Real Estate", pct: 20 },
        { label: "Credit", pct: 10 },
      ],
    },
  },
  high_growth: {
    short: {
      strategy: "Capital at Risk — Reconsider Horizon",
      summary: "High-growth strategies are not suitable for sub-3-year horizons. We've defaulted to a tactical growth mix.",
      caveat: "High-growth allocations need 7+ years to absorb drawdowns. Consider extending your horizon or moderating risk.",
      allocation: [
        { label: "Growth Equity", pct: 50 },
        { label: "Credit", pct: 30 },
        { label: "Stablecoin / Cash", pct: 20 },
      ],
    },
    medium: {
      strategy: "Aggressive Growth",
      summary: "High-conviction equity and venture allocations with limited defensive ballast.",
      allocation: [
        { label: "Growth Equity", pct: 55 },
        { label: "Venture / Private Markets", pct: 30 },
        { label: "Digital Assets", pct: 15 },
      ],
    },
    long: {
      strategy: "Aggressive Long-term Growth",
      summary: "Maximum growth allocation across listed equity, venture, private markets, and digital assets.",
      allocation: [
        { label: "Growth Equity", pct: 45 },
        { label: "Venture / Private Markets", pct: 30 },
        { label: "Digital Assets", pct: 15 },
        { label: "Real Estate", pct: 10 },
      ],
    },
  },
};

export function getRecommendation(answers: WizardAnswers): Recommendation {
  const cell = TABLE[answers.riskTolerance][answers.timeHorizon];
  const privateAccess = PRIVATE_ACCESS_CAPITAL.includes(answers.capitalRange);
  return {
    ...cell,
    privateAccess,
    showFeaturedDeal: privateAccess,
  };
}

export const PROFILE_OPTIONS: { value: ProfileType; label: string; desc: string }[] = [
  { value: "individual", label: "Individual investor", desc: "Personal wholesale-investor capacity" },
  { value: "family_office", label: "Family office", desc: "Multi-generational wealth structure" },
  { value: "corporate", label: "Corporate / SMSF", desc: "Company, trust, or self-managed super" },
  { value: "international", label: "International investor", desc: "Cross-border wholesale investor" },
];

export const GOAL_OPTIONS: { value: string; label: string }[] = [
  { value: "income", label: "Generate income" },
  { value: "growth", label: "Long-term growth" },
  { value: "preservation", label: "Capital preservation" },
  { value: "diversification", label: "Diversification" },
  { value: "private_markets", label: "Access to private deals" },
  { value: "tax_efficient", label: "Tax-efficient structures" },
];

export const RISK_OPTIONS: { value: RiskTolerance; label: string; desc: string }[] = [
  { value: "conservative", label: "Conservative", desc: "Protect capital. Accept low single-digit returns." },
  { value: "balanced", label: "Balanced", desc: "Moderate volatility for steady mid-single-digit returns." },
  { value: "growth", label: "Growth", desc: "Tolerate drawdowns for higher long-term returns." },
  { value: "high_growth", label: "High Growth", desc: "Maximum return potential, significant volatility." },
];

export const HORIZON_OPTIONS: { value: TimeHorizon; label: string; desc: string }[] = [
  { value: "short", label: "Under 3 years", desc: "Short term — capital may be needed soon" },
  { value: "medium", label: "3 – 7 years", desc: "Medium term" },
  { value: "long", label: "7+ years", desc: "Long term — full economic cycle" },
];

export const CAPITAL_OPTIONS: { value: CapitalRange; label: string; desc: string }[] = [
  { value: "under_10k", label: "Under $10,000", desc: "Getting started" },
  { value: "10k_100k", label: "$10,000 – $100,000", desc: "Building a portfolio" },
  { value: "100k_500k", label: "$100,000 – $500,000", desc: "Wholesale investor range" },
  { value: "500k_plus", label: "$500,000+", desc: "Sophisticated investor" },
];
