// =============================================================================
// Task #297 — Detect ADI / FCS-protection status from a cash-deposit product's
// `structure` text and surface the per-ADI Australian Financial Claims Scheme
// cap to the adviser product shelf.
// =============================================================================
// The investment_products table does not carry an explicit `isAdi` /
// `isFcsProtected` flag (see `shared/schema.ts`). The information is encoded
// in the `structure` text on each cash_deposit product (e.g.
//   "ADI-issued savings deposit · FCS-protected (covered up to $250,000 per
//    ADI under the Financial Claims Scheme)"
// vs.
//   "Registered money market fund · Not an ADI deposit, not FCS-protected"
// ).
//
// This module provides a single, deterministic parser the adviser UI uses to
// render the "ADI / FCS-protected" badge and the per-client coverage hint on
// each cash deposit card. The negative phrase is checked first so a product
// that explicitly opts out cannot be mis-classified by the bare positive
// keywords appearing inside the same sentence.
// =============================================================================

export interface CashDepositProtection {
  isAdi: boolean;
  isFcsProtected: boolean;
}

/**
 * The Australian Financial Claims Scheme caps protection at AUD 250,000 per
 * ADI per customer. Centralised here so the adviser UI and any downstream
 * coverage warnings stay in lock-step if the cap is ever changed.
 */
export const FCS_CAP_PER_ADI_AUD = 250_000;

export function detectCashDepositProtection(
  structure: string | null | undefined,
): CashDepositProtection {
  const text = (structure ?? "").toLowerCase();
  if (text.length === 0) {
    return { isAdi: false, isFcsProtected: false };
  }

  // Explicit opt-out wins. Money market funds carry "Not an ADI deposit, not
  // FCS-protected" and must never be tagged as protected even though the bare
  // tokens "adi" and "fcs" appear inside that very sentence.
  const explicitlyNotAdi = text.includes("not an adi");
  const explicitlyNotFcs = text.includes("not fcs-protected");

  const isAdi = explicitlyNotAdi
    ? false
    : text.includes("adi-issued") || text.includes("adi deposit");

  const isFcsProtected = explicitlyNotFcs ? false : text.includes("fcs-protected");

  return { isAdi, isFcsProtected };
}
