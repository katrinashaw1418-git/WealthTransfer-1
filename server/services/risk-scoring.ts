// ---------------------------------------------------------------------------
// Phase 2.1 — Risk-profile scoring service.
//
// Pure function. No I/O, no DB access, no side effects. The route layer is
// responsible for persisting both the input fact-find snapshot and the
// resulting risk-profile row. Keeping the scoring math pure means it is
// trivially testable and cheap to re-run for audit replay.
//
// Scoring model (AFSL-defensible):
//   1. Behavioural score from 5 scenario answers (range ~5..30)
//   2. Capacity adjustment from income stability, liquidity buffer,
//      dependants, and debt ratio (range ~ -8..+6)
//   3. Final score = behavioural + capacity, clamped to [5, 35]
//   4. Risk band mapped from final score
//   5. Hard overrides (mandatory caps) applied AFTER mapping:
//        - Investment horizon < 2 years          -> max Moderate
//        - High liquidity need                   -> max Balanced
//        - Full income reliance on the portfolio -> max Balanced
//
// Override reasons are stored verbatim so a regulator can reconstruct the
// decision from the persisted scoringInputs + overrideReasons alone.
// ---------------------------------------------------------------------------

export type RiskAnswers = {
  // Behavioural
  marketDropReaction: "sell_all" | "sell_some" | "hold" | "buy_more";
  volatilityTolerance: "low" | "some" | "moderate" | "high";
  lossTolerance: "under_5" | "5_10" | "10_20" | "over_20";
  investmentExperience: "none" | "basic" | "moderate" | "advanced";
  incomeReliance: "full" | "partial" | "none";

  // Capacity
  incomeStability: "stable" | "variable" | "unstable";
  liquidityBufferMonths: number;
  dependantsCount: number;
  debtRatio: "low" | "medium" | "high";
  investmentHorizon: "<2" | "2-5" | "5-10" | "10+";
  liquidityNeeds: "low" | "medium" | "high";
};

export type RiskBand = "conservative" | "moderate" | "balanced" | "growth" | "high_growth";

export type Allocation = {
  cash: number;
  bonds: number;
  equities: number;
  alternatives: number;
  crypto: number;
};

export type RiskScoringResult = {
  behaviouralScore: number;
  capacityAdjustment: number;
  finalScore: number;
  riskBand: RiskBand;
  recommendedPortfolio: RiskBand;
  overrideApplied: boolean;
  overrideReasons: string[];
  allocation: Allocation;
  scoringInputs: RiskAnswers;
};

const MARKET_DROP: Record<RiskAnswers["marketDropReaction"], number> = {
  sell_all: 0,
  sell_some: 2,
  hold: 4,
  buy_more: 6,
};

const VOLATILITY: Record<RiskAnswers["volatilityTolerance"], number> = {
  low: 1,
  some: 3,
  moderate: 5,
  high: 7,
};

const LOSS_TOLERANCE: Record<RiskAnswers["lossTolerance"], number> = {
  under_5: 1,
  "5_10": 3,
  "10_20": 5,
  over_20: 7,
};

const EXPERIENCE: Record<RiskAnswers["investmentExperience"], number> = {
  none: 1,
  basic: 3,
  moderate: 5,
  advanced: 7,
};

const INCOME_RELIANCE_BEHAVIOUR: Record<RiskAnswers["incomeReliance"], number> = {
  full: 1,
  partial: 3,
  none: 5,
};

const INCOME_STABILITY: Record<RiskAnswers["incomeStability"], number> = {
  stable: 2,
  variable: 0,
  unstable: -2,
};

const DEBT_RATIO: Record<RiskAnswers["debtRatio"], number> = {
  low: 1,
  medium: 0,
  high: -2,
};

export function scoreRiskProfile(input: RiskAnswers): RiskScoringResult {
  // ── Step 1 — behavioural score ───────────────────────────────────────────
  const behaviouralScore =
    MARKET_DROP[input.marketDropReaction] +
    VOLATILITY[input.volatilityTolerance] +
    LOSS_TOLERANCE[input.lossTolerance] +
    EXPERIENCE[input.investmentExperience] +
    INCOME_RELIANCE_BEHAVIOUR[input.incomeReliance];

  // ── Step 2 — capacity adjustment ─────────────────────────────────────────
  let capacityAdjustment = 0;

  capacityAdjustment += INCOME_STABILITY[input.incomeStability];

  if (input.liquidityBufferMonths > 12) capacityAdjustment += 2;
  else if (input.liquidityBufferMonths >= 6) capacityAdjustment += 1;
  else capacityAdjustment -= 2;

  if (input.dependantsCount === 0) capacityAdjustment += 1;
  else if (input.dependantsCount >= 3) capacityAdjustment -= 2;
  // 1–2 dependants = 0 (no adjustment)

  capacityAdjustment += DEBT_RATIO[input.debtRatio];

  // ── Step 3 — final score, clamped to [5, 35] ─────────────────────────────
  const finalScore = Math.max(5, Math.min(35, behaviouralScore + capacityAdjustment));

  // ── Step 4 — band mapping ────────────────────────────────────────────────
  let riskBand: RiskBand = scoreToRiskBand(finalScore);

  // ── Step 5 — mandatory overrides (regulator-defensible caps) ─────────────
  const overrideReasons: string[] = [];

  if (input.investmentHorizon === "<2" && riskRank(riskBand) > riskRank("moderate")) {
    riskBand = "moderate";
    overrideReasons.push(
      "Investment horizon is less than 2 years; maximum risk profile capped at Moderate.",
    );
  }

  if (input.liquidityNeeds === "high" && riskRank(riskBand) > riskRank("balanced")) {
    riskBand = "balanced";
    overrideReasons.push(
      "High liquidity need; maximum risk profile capped at Balanced.",
    );
  }

  if (input.incomeReliance === "full" && riskRank(riskBand) > riskRank("balanced")) {
    riskBand = "balanced";
    overrideReasons.push(
      "Client relies on portfolio income; maximum risk profile capped at Balanced.",
    );
  }

  const recommendedPortfolio = riskBand;
  const allocation = mapPortfolioAllocation(recommendedPortfolio);

  return {
    behaviouralScore,
    capacityAdjustment,
    finalScore,
    riskBand,
    recommendedPortfolio,
    overrideApplied: overrideReasons.length > 0,
    overrideReasons,
    allocation,
    scoringInputs: input,
  };
}

export function scoreToRiskBand(score: number): RiskBand {
  if (score <= 10) return "conservative";
  if (score <= 16) return "moderate";
  if (score <= 22) return "balanced";
  if (score <= 28) return "growth";
  return "high_growth";
}

export function riskRank(band: RiskBand): number {
  const ranks: Record<RiskBand, number> = {
    conservative: 1,
    moderate: 2,
    balanced: 3,
    growth: 4,
    high_growth: 5,
  };
  return ranks[band];
}

const PORTFOLIO_ALLOCATIONS: Record<RiskBand, Allocation> = {
  conservative: { cash: 25, bonds: 45, equities: 25, alternatives: 5, crypto: 0 },
  moderate:     { cash: 15, bonds: 35, equities: 45, alternatives: 5, crypto: 0 },
  balanced:     { cash: 10, bonds: 25, equities: 55, alternatives: 5, crypto: 5 },
  growth:       { cash:  5, bonds: 10, equities: 70, alternatives: 5, crypto: 10 },
  high_growth:  { cash:  0, bonds:  5, equities: 75, alternatives: 5, crypto: 15 },
};

export function mapPortfolioAllocation(portfolio: RiskBand): Allocation {
  return PORTFOLIO_ALLOCATIONS[portfolio];
}
