// =============================================================================
// Task #297 — guards the deterministic ADI/FCS detection used by the adviser
// product shelf. Regression boundary: the seeded structure copy in
// `server/storage.ts` and `scripts/seed-missing-products.ts` is what the
// adviser UI parses, so each canonical phrase the seeder writes today is
// pinned here. If the copy changes, this test must change in lock-step or
// the FCS badge will silently regress to "unprotected".
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  detectCashDepositProtection,
  FCS_CAP_PER_ADI_AUD,
} from "./cash-deposit-protection";

describe("detectCashDepositProtection", () => {
  it("recognises a seeded ADI savings deposit as ADI + FCS-protected", () => {
    const out = detectCashDepositProtection(
      "ADI-issued savings deposit · FCS-protected (covered up to $250,000 per ADI under the Financial Claims Scheme)",
    );
    expect(out).toEqual({ isAdi: true, isFcsProtected: true });
  });

  it("recognises a seeded ADI term deposit as ADI + FCS-protected", () => {
    const out = detectCashDepositProtection(
      "ADI-issued term deposit · FCS-protected (covered up to $250,000 per ADI under the Financial Claims Scheme) · 30-day notice",
    );
    expect(out).toEqual({ isAdi: true, isFcsProtected: true });
  });

  it("treats a money market fund as neither ADI nor FCS-protected even though both tokens appear", () => {
    const out = detectCashDepositProtection(
      "Registered money market fund · Not an ADI deposit, not FCS-protected",
    );
    expect(out).toEqual({ isAdi: false, isFcsProtected: false });
  });

  it("returns false/false for null, undefined, or empty structure text", () => {
    expect(detectCashDepositProtection(null)).toEqual({
      isAdi: false,
      isFcsProtected: false,
    });
    expect(detectCashDepositProtection(undefined)).toEqual({
      isAdi: false,
      isFcsProtected: false,
    });
    expect(detectCashDepositProtection("")).toEqual({
      isAdi: false,
      isFcsProtected: false,
    });
  });

  it("ignores case differences in the structure copy", () => {
    expect(
      detectCashDepositProtection("adi-ISSUED savings · fcs-PROTECTED"),
    ).toEqual({ isAdi: true, isFcsProtected: true });
  });

  it("exposes the AUD 250,000 per-ADI cap as a shared constant", () => {
    expect(FCS_CAP_PER_ADI_AUD).toBe(250_000);
  });
});
