import { describe, expect, it } from "vitest";
import {
  RISK_PROFILE_KEYS,
  RISK_PROFILE_LABELS,
  isKnownRiskProfile,
  riskProfileLabel,
  riskProfileRank,
  toKnownRiskProfile,
} from "./risk-profiles";

describe("isKnownRiskProfile", () => {
  it("accepts every canonical key", () => {
    for (const key of RISK_PROFILE_KEYS) {
      expect(isKnownRiskProfile(key)).toBe(true);
    }
  });

  it("rejects sentence-case forms (only canonical keys are 'known')", () => {
    expect(isKnownRiskProfile("Low")).toBe(false);
    expect(isKnownRiskProfile("Very High")).toBe(false);
  });

  it("rejects unknown / empty / non-string values", () => {
    expect(isKnownRiskProfile("medium")).toBe(false);
    expect(isKnownRiskProfile("")).toBe(false);
    expect(isKnownRiskProfile(null)).toBe(false);
    expect(isKnownRiskProfile(undefined)).toBe(false);
  });
});

describe("toKnownRiskProfile", () => {
  it("returns canonical keys unchanged", () => {
    expect(toKnownRiskProfile("low")).toBe("low");
    expect(toKnownRiskProfile("conservative")).toBe("conservative");
    expect(toKnownRiskProfile("moderate")).toBe("moderate");
    expect(toKnownRiskProfile("high")).toBe("high");
    expect(toKnownRiskProfile("very_high")).toBe("very_high");
  });

  it("normalises historical sentence-case forms", () => {
    expect(toKnownRiskProfile("Low")).toBe("low");
    expect(toKnownRiskProfile("Conservative")).toBe("conservative");
    expect(toKnownRiskProfile("Moderate")).toBe("moderate");
    expect(toKnownRiskProfile("High")).toBe("high");
    expect(toKnownRiskProfile("Very High")).toBe("very_high");
  });

  it("trims whitespace and collapses internal spaces to underscores", () => {
    expect(toKnownRiskProfile("  Low  ")).toBe("low");
    expect(toKnownRiskProfile("very   high")).toBe("very_high");
    expect(toKnownRiskProfile("VERY HIGH")).toBe("very_high");
  });

  it("returns null for unknown values", () => {
    expect(toKnownRiskProfile("medium")).toBeNull();
    expect(toKnownRiskProfile("ultra")).toBeNull();
    expect(toKnownRiskProfile("")).toBeNull();
    expect(toKnownRiskProfile("   ")).toBeNull();
  });

  it("returns null for non-string inputs", () => {
    expect(toKnownRiskProfile(null)).toBeNull();
    expect(toKnownRiskProfile(undefined)).toBeNull();
  });
});

describe("riskProfileLabel", () => {
  it("resolves canonical keys to their canonical label", () => {
    expect(riskProfileLabel("low")).toBe("Low");
    expect(riskProfileLabel("conservative")).toBe("Conservative");
    expect(riskProfileLabel("moderate")).toBe("Moderate");
    expect(riskProfileLabel("high")).toBe("High");
    expect(riskProfileLabel("very_high")).toBe("Very High");
  });

  it("resolves historical sentence-case forms to the canonical label", () => {
    expect(riskProfileLabel("Low")).toBe("Low");
    expect(riskProfileLabel("Very High")).toBe("Very High");
    expect(riskProfileLabel("very high")).toBe("Very High");
  });

  it("falls back to title-case for unknown strings", () => {
    expect(riskProfileLabel("medium")).toBe("Medium");
    expect(riskProfileLabel("ultra_high")).toBe("Ultra High");
    expect(riskProfileLabel("speculative grade")).toBe("Speculative Grade");
  });

  it("returns 'Unrated' for empty / null / undefined", () => {
    expect(riskProfileLabel("")).toBe("Unrated");
    expect(riskProfileLabel(null)).toBe("Unrated");
    expect(riskProfileLabel(undefined)).toBe("Unrated");
  });
});

describe("riskProfileRank", () => {
  it("returns a strictly increasing rank across RISK_PROFILE_KEYS", () => {
    const ranks = RISK_PROFILE_KEYS.map((key) => riskProfileRank(key));
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
    }
    expect(ranks).toEqual(RISK_PROFILE_KEYS.map((_, i) => i));
  });

  it("normalises sentence-case forms to the same rank as their canonical key", () => {
    for (const key of RISK_PROFILE_KEYS) {
      const label = RISK_PROFILE_LABELS[key];
      expect(riskProfileRank(label)).toBe(riskProfileRank(key));
    }
  });

  it("pushes unknown values to the end (rank === RISK_PROFILE_KEYS.length)", () => {
    const tail = RISK_PROFILE_KEYS.length;
    expect(riskProfileRank("medium")).toBe(tail);
    expect(riskProfileRank("unknown")).toBe(tail);
    expect(riskProfileRank("")).toBe(tail);
    expect(riskProfileRank(null)).toBe(tail);
    expect(riskProfileRank(undefined)).toBe(tail);
  });

  it("ranks every known band strictly before any unknown band", () => {
    const tail = RISK_PROFILE_KEYS.length;
    for (const key of RISK_PROFILE_KEYS) {
      expect(riskProfileRank(key)).toBeLessThan(tail);
    }
  });
});

describe("RISK_PROFILE_KEYS", () => {
  it("matches Object.keys(RISK_PROFILE_LABELS) order", () => {
    expect(RISK_PROFILE_KEYS).toEqual(Object.keys(RISK_PROFILE_LABELS));
  });

  it("is ordered from least to most risky (low -> very_high)", () => {
    expect(RISK_PROFILE_KEYS).toEqual([
      "low",
      "conservative",
      "moderate",
      "high",
      "very_high",
    ]);
  });
});
