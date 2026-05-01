import { describe, expect, it } from "vitest";
import { PRODUCT_CATALOGUE } from "@shared/product-catalogue";
import {
  INTERNAL_DRAFT_PRODUCT_NAMES,
  isClientFacingVisibleProduct,
  isInternalDraftProductName,
} from "./product-visibility";

describe("product visibility guardrails", () => {
  it("blocks the known internal/draft product names", () => {
    for (const name of INTERNAL_DRAFT_PRODUCT_NAMES) {
      expect(isInternalDraftProductName(name)).toBe(true);
      expect(
        isClientFacingVisibleProduct({
          name,
          isActive: true,
          isPublished: true,
        }),
      ).toBe(false);
    }
  });

  it("keeps all 14 canonical catalogue products client-facing visible", () => {
    const visible = PRODUCT_CATALOGUE.filter((p) =>
      isClientFacingVisibleProduct({
        name: p.name,
        isActive: p.isActive,
        isPublished: true,
      }),
    );
    expect(visible).toHaveLength(14);
  });
});

