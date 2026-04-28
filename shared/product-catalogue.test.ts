import { describe, expect, it } from "vitest";
import {
  PRODUCT_CATALOGUE,
  PRODUCT_CATALOGUE_NAMES,
  type CatalogueProduct,
  assertCatalogueIsClean,
  catalogueCategoriesAreKnown,
  findCatalogueViolations,
} from "./product-catalogue";
import { PRODUCT_CATEGORY_VALUES } from "./product-categories";
import { RISK_PROFILE_KEYS } from "./risk-profiles";

describe("PRODUCT_CATALOGUE", () => {
  it("contains exactly the 14 canonical adviser-shelf products", () => {
    expect(PRODUCT_CATALOGUE).toHaveLength(14);
    expect(PRODUCT_CATALOGUE_NAMES).toEqual(PRODUCT_CATALOGUE.map((p) => p.name));
  });

  it("uses only category values declared in shared/product-categories.ts", () => {
    expect(catalogueCategoriesAreKnown()).toBe(true);
    for (const p of PRODUCT_CATALOGUE) {
      expect(PRODUCT_CATEGORY_VALUES).toContain(p.category);
    }
  });

  it("uses only canonical lowercase risk-profile keys", () => {
    for (const p of PRODUCT_CATALOGUE) {
      expect(RISK_PROFILE_KEYS).toContain(p.riskProfile);
    }
  });

  it("has unique product names (the seed/cleanup pipeline keys on name)", () => {
    const names = new Set(PRODUCT_CATALOGUE.map((p) => p.name));
    expect(names.size).toBe(PRODUCT_CATALOGUE.length);
  });
});

describe("findCatalogueViolations on the live catalogue", () => {
  it("returns no violations for the shipped 14 products", () => {
    expect(findCatalogueViolations()).toEqual([]);
  });

  it("assertCatalogueIsClean does not throw on the shipped 14 products", () => {
    expect(() => assertCatalogueIsClean()).not.toThrow();
  });
});

// The four rules below are the lint/CI gate the task asks for: every new
// product entry is run through `findCatalogueViolations` and the build fails
// if any of them trip. The fixtures here clone the first canonical product
// and corrupt one field at a time so each rule is exercised independently.
const CLEAN_FIXTURE: CatalogueProduct = {
  name: "Test Fixture Fund",
  category: "real_estate",
  subCategory: "equity_fund",
  investmentStrategy: "Test strategy.",
  targetNetIrr: "10–12% p.a.",
  term: "2–3 years",
  structure: "Test structure",
  distributions: "Quarterly",
  liquidity: "Locked term",
  minimumInvestment: "100000.00",
  riskProfile: "moderate",
  returnType: "income",
  isActive: true,
};

describe("findCatalogueViolations rules", () => {
  it("flags a tilde in any user-visible label field", () => {
    const v = findCatalogueViolations([
      { ...CLEAN_FIXTURE, term: "~3 years" },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe("tilde");
    expect(v[0].field).toBe("term");
  });

  it("does not flag a tilde inside the lvr field (operator-curated mid-points)", () => {
    const v = findCatalogueViolations([
      { ...CLEAN_FIXTURE, lvr: "40–80% (typ. ~70%)" },
    ]);
    expect(v).toEqual([]);
  });

  it('flags any "FDIC" mention (the platform uses FCS, not FDIC)', () => {
    const v = findCatalogueViolations([
      {
        ...CLEAN_FIXTURE,
        investmentStrategy: "Insured up to $250,000 by FDIC.",
      },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe("fdic");
    expect(v[0].field).toBe("investmentStrategy");
  });

  it('flags lowercase / mixed-case "fdic" too — the rule is case-insensitive', () => {
    for (const variant of ["fdic", "Fdic", "fDic", "FDIC"]) {
      const v = findCatalogueViolations([
        {
          ...CLEAN_FIXTURE,
          investmentStrategy: `Insured up to $250,000 by ${variant}.`,
        },
      ]);
      expect(v.map((x) => x.rule)).toEqual(["fdic"]);
    }
  });

  it('does not match "fdic" inside a longer word (word-boundary matched)', () => {
    const v = findCatalogueViolations([
      { ...CLEAN_FIXTURE, investmentStrategy: "Refdiction risk modelling." },
    ]);
    expect(v).toEqual([]);
  });

  it("flags a non-canonical risk-profile label (sentence case, etc.)", () => {
    const v = findCatalogueViolations([
      { ...CLEAN_FIXTURE, riskProfile: "Very High" as never },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe("non-canonical-risk-profile");
    expect(v[0].field).toBe("riskProfile");
  });

  it('flags a numeric targetNetIrr missing the "p.a." suffix', () => {
    const v = findCatalogueViolations([
      { ...CLEAN_FIXTURE, targetNetIrr: "10–12%" },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe("missing-pa-suffix");
    expect(v[0].field).toBe("targetNetIrr");
  });

  it("does not flag a non-numeric targetNetIrr label", () => {
    const v = findCatalogueViolations([
      {
        ...CLEAN_FIXTURE,
        targetNetIrr: "Market-linked — no target return",
      },
    ]);
    expect(v).toEqual([]);
  });

  it("collects multiple violations from the same product", () => {
    const v = findCatalogueViolations([
      {
        ...CLEAN_FIXTURE,
        targetNetIrr: "~10–12%",
        riskProfile: "Very High" as never,
      },
    ]);
    const rules = v.map((x) => x.rule).sort();
    expect(rules).toEqual([
      "missing-pa-suffix",
      "non-canonical-risk-profile",
      "tilde",
    ]);
  });

  it("assertCatalogueIsClean throws with a descriptive message when violations exist", () => {
    expect(() =>
      assertCatalogueIsClean([
        { ...CLEAN_FIXTURE, targetNetIrr: "10–12%" },
      ]),
    ).toThrowError(/missing-pa-suffix|p\.a\./);
  });
});
