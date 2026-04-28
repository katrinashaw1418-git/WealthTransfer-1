// =============================================================================
// Task #307 — consent-integrity service unit tests
// =============================================================================
// Locks in the contract for `validateRuleAmountAgainstConsent`, the pure
// function that enforces "a fee rule's monetary parameter MUST equal the
// signed consent it derives from" — the $150-vs-$495 drift bug class.
//
// The same equality is also enforced at the DB layer by the trigger
// installed in `installFeeRuleAmountEqualityTrigger` (exercised at every
// server boot via the routes.ts startup path); these tests cover the
// service-layer behaviour that produces the friendly 400 callers see
// from `createFeeRule` and `activateFeeRule`.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  FeeRuleConsentDriftError,
  validateRuleAmountAgainstConsent,
  type RuleAmountFields,
} from "./consent-integrity";

// Minimal consent shape — `validateRuleAmountAgainstConsent` only reads
// amountType + amount, so we narrow down the FeeConsent type to those two
// fields and avoid having to construct the full ~25-column row.
type ConsentLite = { amountType: string; amount: string | null };

const fixedConsent = (amount: string | null): ConsentLite => ({
  amountType: "fixed",
  amount,
});

const percentageConsent = (amount: string | null): ConsentLite => ({
  amountType: "percentage",
  amount,
});

const calcConsent = (): ConsentLite => ({
  amountType: "calculation_method",
  amount: null,
});

const fixedRule = (fixedAmount: string | number | null): RuleAmountFields => ({
  amountType: "fixed",
  fixedAmount,
  rateBps: null,
});

const pctRule = (rateBps: number | null): RuleAmountFields => ({
  amountType: "percentage",
  fixedAmount: null,
  rateBps,
});

describe("validateRuleAmountAgainstConsent (Task #307)", () => {
  // -------------------------------------------------------------------------
  // Happy paths.
  // -------------------------------------------------------------------------

  it("accepts a fixed rule whose amount matches the consent exactly", () => {
    expect(() =>
      validateRuleAmountAgainstConsent(fixedRule("495.00"), fixedConsent("495.0000")),
    ).not.toThrow();
  });

  it("accepts a percentage rule when bps/100 equals the consent percentage", () => {
    // 150 bps == 1.5% — the consent stores the %, the rule stores bps.
    expect(() =>
      validateRuleAmountAgainstConsent(pctRule(150), percentageConsent("1.5000")),
    ).not.toThrow();
  });

  it("is exempt for calculation_method consents (no equality enforced)", () => {
    // calculation_method consents carry a free-text basis. The rule's
    // monetary figure is the regulator-reviewed amount the operator
    // entered following the agreed method — there is no machine-checkable
    // equality to enforce. Both fixed and percentage rules pass through.
    expect(() =>
      validateRuleAmountAgainstConsent(fixedRule("250.00"), calcConsent()),
    ).not.toThrow();
    expect(() =>
      validateRuleAmountAgainstConsent(pctRule(75), calcConsent()),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Drift detection — the actual compliance-critical path.
  // -------------------------------------------------------------------------

  it("rejects a fixed rule whose amount differs from the consent ($150 vs $495)", () => {
    // The canonical bug from Task #307: the rule says $150 but the signed
    // consent says $495. Without this check the engine would silently
    // accrue the $150 and a regulator would have a field day.
    expect(() =>
      validateRuleAmountAgainstConsent(fixedRule("150.00"), fixedConsent("495.0000")),
    ).toThrow(FeeRuleConsentDriftError);
  });

  it("rejects a percentage rule whose bps does not equal the consent percent", () => {
    // 150 bps == 1.5%; consent says 2.0% — drift.
    expect(() =>
      validateRuleAmountAgainstConsent(pctRule(150), percentageConsent("2.0000")),
    ).toThrow(FeeRuleConsentDriftError);
  });

  it("rejects when the rule amountType differs from the consent amountType", () => {
    // A consent signed as a flat-fee cannot anchor a percentage rule, and
    // vice versa — these are different legal instruments.
    expect(() =>
      validateRuleAmountAgainstConsent(pctRule(150), fixedConsent("495.0000")),
    ).toThrow(FeeRuleConsentDriftError);
    expect(() =>
      validateRuleAmountAgainstConsent(fixedRule("495.00"), percentageConsent("1.5000")),
    ).toThrow(FeeRuleConsentDriftError);
  });

  it("rejects when the consent has no amount but the rule expects one", () => {
    // A fixed/percentage consent with a NULL amount is a malformed record —
    // refuse to derive a rule from it rather than silently zeroing.
    expect(() =>
      validateRuleAmountAgainstConsent(fixedRule("100.00"), fixedConsent(null)),
    ).toThrow(FeeRuleConsentDriftError);
    expect(() =>
      validateRuleAmountAgainstConsent(pctRule(100), percentageConsent(null)),
    ).toThrow(FeeRuleConsentDriftError);
  });

  it("rejects when the rule's monetary field is missing for its amountType", () => {
    // A fixed rule with no fixed_amount or a percentage rule with no
    // rate_bps cannot be reconciled — both blow up.
    expect(() =>
      validateRuleAmountAgainstConsent(fixedRule(null), fixedConsent("495.0000")),
    ).toThrow(FeeRuleConsentDriftError);
    expect(() =>
      validateRuleAmountAgainstConsent(pctRule(null), percentageConsent("1.5000")),
    ).toThrow(FeeRuleConsentDriftError);
  });

  // -------------------------------------------------------------------------
  // Tolerance + provenance contract.
  // -------------------------------------------------------------------------

  it("accepts equality within the 4dp decimal tolerance (no false drift)", () => {
    // Both columns are decimal(14,4); a sub-0.0001 jitter from
    // string<->number coercion must NOT register as drift.
    expect(() =>
      validateRuleAmountAgainstConsent(fixedRule("495.0000"), fixedConsent("495.0000")),
    ).not.toThrow();
    // 150 bps -> 1.5 exact; consent stores 1.5000.
    expect(() =>
      validateRuleAmountAgainstConsent(pctRule(150), percentageConsent("1.5000")),
    ).not.toThrow();
  });

  it("populates the FeeRuleConsentDriftError with both sides of the comparison", () => {
    // The audit row downstream of this throw needs both sides so an
    // operator can read the audit trail and immediately see what the
    // rule said vs what the consent said. Verify the error carries them.
    let caught: unknown;
    try {
      validateRuleAmountAgainstConsent(fixedRule("150.00"), fixedConsent("495.0000"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FeeRuleConsentDriftError);
    const err = caught as FeeRuleConsentDriftError;
    expect(err.status).toBe(400);
    expect(err.code).toBe("rule_consent_amount_drift");
    expect(err.ruleAmountType).toBe("fixed");
    expect(err.consentAmountType).toBe("fixed");
    expect(String(err.ruleAmount)).toContain("150");
    expect(String(err.consentAmount)).toContain("495");
  });
});
