import type { InvestmentProduct } from "@shared/schema";

// Session 1 — internal/draft products that must never render on
// investor/adviser client-facing surfaces.
export const INTERNAL_DRAFT_PRODUCT_NAMES = [
  "Smoke Test Fund",
  "DraftProduct",
  "InRange825",
] as const;

const INTERNAL_NAME_SET = new Set<string>(INTERNAL_DRAFT_PRODUCT_NAMES);

export function isInternalDraftProductName(name: string): boolean {
  return INTERNAL_NAME_SET.has(name);
}

export function isClientFacingVisibleProduct(
  product: Pick<InvestmentProduct, "name" | "isActive" | "isPublished">,
): boolean {
  return (
    product.isActive !== false &&
    product.isPublished !== false &&
    !isInternalDraftProductName(product.name)
  );
}

