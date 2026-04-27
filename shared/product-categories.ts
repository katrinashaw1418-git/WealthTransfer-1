// =============================================================================
// KNOWN INVESTMENT PRODUCT CATEGORIES
// -----------------------------------------------------------------------------
// Single source of truth for the human-readable label and the icon associated
// with each `investment_products.category` enum value. The adviser products
// list filters out any product whose category is not in this map, so
// test-fixture rows like the historical `InRange825` (category `x`) can never
// appear in adviser dropdowns or be referenced from a new investment
// instruction.
//
// Adding a new category? Add the (enum value -> label) pair here, the matching
// icon below, and every adviser- and client-facing surface picks it up
// automatically.
// =============================================================================

import {
  Building,
  CreditCard,
  Rocket,
  Bitcoin,
  DollarSign,
  type LucideIcon,
} from "lucide-react";

export const PRODUCT_CATEGORY_LABELS = {
  cash_deposit: "Cash & Fixed Income",
  digital_assets: "Digital Assets",
  venture_capital: "Venture Capital",
  real_estate: "Real Estate",
  corporate_credit: "Corporate Credit",
} as const;

export type KnownProductCategory = keyof typeof PRODUCT_CATEGORY_LABELS;

export const PRODUCT_CATEGORY_ICONS: Record<KnownProductCategory, LucideIcon> = {
  cash_deposit: DollarSign,
  digital_assets: Bitcoin,
  venture_capital: Rocket,
  real_estate: Building,
  corporate_credit: CreditCard,
};

const KNOWN_CATEGORY_SET = new Set<string>(Object.keys(PRODUCT_CATEGORY_LABELS));

export function isKnownProductCategory(value: string | null | undefined): value is KnownProductCategory {
  return typeof value === "string" && KNOWN_CATEGORY_SET.has(value);
}

export function productCategoryLabel(value: string | null | undefined): string {
  if (isKnownProductCategory(value)) return PRODUCT_CATEGORY_LABELS[value];
  // Fall back to a humanised version of whatever we got so we never render a
  // raw enum to the user. Filtered-out categories should never reach the UI.
  if (!value) return "Uncategorised";
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function productCategoryIcon(value: string | null | undefined): LucideIcon {
  return isKnownProductCategory(value) ? PRODUCT_CATEGORY_ICONS[value] : Building;
}
