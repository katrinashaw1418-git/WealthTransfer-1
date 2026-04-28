// =============================================================================
// Task #363 — schema-level guard against bad investment-product categories
// =============================================================================
// Task #341 closed the validation gap that previously let test fixtures
// with `category: "x"` slip into `investment_products` (the historical
// `DraftProduct` / `InRange825` rows that `scripts/cleanup-product-shelf.ts`
// then had to scrub). The fix tightened `insertInvestmentProductSchema` in
// `shared/schema.ts` to `z.enum(PRODUCT_CATEGORY_VALUES, ...)` so anything
// outside the canonical list from `shared/product-categories.ts` is
// rejected at parse time.
//
// This file pins that contract at the SCHEMA layer:
//
//   * `insertInvestmentProductSchema.safeParse({ ...validProduct,
//     category: "x" })` MUST fail with at least one issue on the
//     `category` path whose message lists every canonical enum value.
//   * Every value in `PRODUCT_CATEGORY_VALUES` MUST be accepted (so a
//     future addition to the enum can't silently be dropped — adding it
//     here is the regression boundary).
//
// The companion HTTP-level test for `adminUpdateProductSchema` lives in
// `server/admin-routes-product-category-validation.test.ts` because that
// schema is declared inside the `registerAdminRoutes` closure and is not
// exported.
// =============================================================================

import { describe, expect, it } from "vitest";

import { insertInvestmentProductSchema } from "./schema";
import { PRODUCT_CATEGORY_VALUES } from "./product-categories";

// A complete, schema-valid product payload with `category` as the only
// variable. Mirrors the shape used by `buildProductPayload` in
// `server/admin-routes-product-risk-profile.test.ts` so the two test
// files stay in lockstep on what a "valid product" looks like.
//
// `isActive: false` keeps the `annualReturn`-required activation rule
// (enforced by `adminCreateProductSchema`, NOT by this base schema)
// out of scope — this test is about the category enum guard only.
function buildValidProduct(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "Task #363 category-guard test product",
    category: "real_estate",
    subCategory: "equity_fund",
    investmentStrategy: "Schema-level test fixture for the category enum guard.",
    targetNetIrr: "10% p.a.",
    term: "2 years",
    structure: "Test structure",
    distributions: "Quarterly",
    liquidity: "Fixed-term, no early redemptions",
    minimumInvestment: "100000.00",
    riskProfile: "moderate",
    returnType: "income",
    isActive: false,
    isPublished: false,
    ...overrides,
  };
}

describe("insertInvestmentProductSchema — category enum guard (Task #363)", () => {
  it("rejects the historical bad category 'x' with an issue on the `category` path", () => {
    const parsed = insertInvestmentProductSchema.safeParse(
      buildValidProduct({ category: "x" }),
    );

    expect(parsed.success).toBe(false);
    if (parsed.success) return; // narrow the type for the rest of the test

    // Exactly one issue should be raised, and it must point at the
    // `category` field — not at `name`, `subCategory`, etc. If a future
    // refactor moves the validation up to a `superRefine` that drops the
    // path, this assertion fires.
    const categoryIssues = parsed.error.issues.filter(
      (i) => i.path.length === 1 && i.path[0] === "category",
    );
    expect(categoryIssues.length).toBeGreaterThan(0);

    // The message must enumerate every canonical value, so an operator
    // staring at the parse error knows exactly what is permitted.
    // Matching against the joined string (rather than each value
    // individually) also pins the order that
    // `shared/product-categories.ts` declares them in.
    for (const issue of categoryIssues) {
      for (const canonical of PRODUCT_CATEGORY_VALUES) {
        expect(issue.message).toContain(canonical);
      }
    }
  });

  it("accepts every value in PRODUCT_CATEGORY_VALUES", () => {
    // Iterating the canonical tuple (rather than hand-typing each value)
    // means a new category added to `shared/product-categories.ts` is
    // automatically exercised here — there's no second place to remember
    // to update. If a future change tightens the enum past the canonical
    // list, this loop catches it on the dropped value.
    for (const category of PRODUCT_CATEGORY_VALUES) {
      const parsed = insertInvestmentProductSchema.safeParse(
        buildValidProduct({ category }),
      );
      expect(parsed.success, `category '${category}' should parse OK`).toBe(true);
      if (parsed.success) {
        expect(parsed.data.category).toBe(category);
      }
    }
  });
});
