// =============================================================================
// Task #471 — Canonical six-term consent vocabulary tests
// -----------------------------------------------------------------------------
// Pin every (DB enum value, expected display label) pair so a future change
// to the helper or DB enum surfaces as a visible test failure rather than a
// silently-wrong pill on adviser surfaces.
//
// Renders for at least one row of each canonical status — the brief asks for
// "the new vocabulary renders for at least one row of each status".
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  CONSENT_DISPLAY_STATUSES,
  CONSENT_STATUS_LABELS,
  consentContextDisplayStatus,
  consentRenewalDisplayStatus,
  consentRequestDisplayStatus,
  consentStatusBadgeVariant,
  consentStatusLabel,
} from "./consent-status";

describe("CONSENT_DISPLAY_STATUSES", () => {
  it("contains exactly the six canonical terms", () => {
    expect(CONSENT_DISPLAY_STATUSES).toEqual([
      "active",
      "sent",
      "pending_signature",
      "superseded",
      "expired",
      "revoked",
    ]);
  });

  it("renders the exact six labels the spec mandates", () => {
    expect(Object.values(CONSENT_STATUS_LABELS).sort()).toEqual(
      ["Active", "Expired", "Pending signature", "Revoked", "Sent", "Superseded"],
    );
  });

  it("never returns a label outside the canonical set", () => {
    for (const s of CONSENT_DISPLAY_STATUSES) {
      const label = consentStatusLabel(s);
      expect([
        "Active",
        "Sent",
        "Pending signature",
        "Superseded",
        "Expired",
        "Revoked",
      ]).toContain(label);
      // every status also resolves to a valid badge variant
      expect(["default", "secondary", "outline", "destructive"]).toContain(
        consentStatusBadgeVariant(s),
      );
    }
  });
});

describe("consentRequestDisplayStatus", () => {
  // Pinning every fee_consent_requests.status value in one table so a
  // future column rename or new enum value forces an explicit decision.
  const cases: Array<[input: string, expected: string]> = [
    ["pending", "pending_signature"],
    ["consented", "active"],
    ["declined", "revoked"],
    ["withdrawn_by_adviser", "revoked"],
    ["superseded", "superseded"],
    // Defensive — unknown DB value should not leak through to the pill.
    ["something_unknown", "pending_signature"],
  ];
  for (const [input, expected] of cases) {
    it(`maps "${input}" -> ${expected}`, () => {
      expect(consentRequestDisplayStatus(input)).toBe(expected);
    });
  }
});

describe("consentRenewalDisplayStatus", () => {
  const FIXED_NOW = new Date("2026-04-28T00:00:00Z");
  const FUTURE_DATE = "2027-01-01T00:00:00Z";
  const PAST_DATE = "2025-01-01T00:00:00Z";

  it("active + future expiry -> active", () => {
    expect(
      consentRenewalDisplayStatus("active", FUTURE_DATE, FIXED_NOW),
    ).toBe("active");
  });

  it("renewal_due + future expiry -> active", () => {
    expect(
      consentRenewalDisplayStatus("renewal_due", FUTURE_DATE, FIXED_NOW),
    ).toBe("active");
  });

  // Computed expiry beats stale "active" rows that haven't been swept.
  it("active + past expiry -> expired", () => {
    expect(
      consentRenewalDisplayStatus("active", PAST_DATE, FIXED_NOW),
    ).toBe("expired");
  });

  it("expired -> expired", () => {
    expect(
      consentRenewalDisplayStatus("expired", FUTURE_DATE, FIXED_NOW),
    ).toBe("expired");
  });

  it("withdrawn -> revoked", () => {
    expect(
      consentRenewalDisplayStatus("withdrawn", FUTURE_DATE, FIXED_NOW),
    ).toBe("revoked");
  });

  it("renewed -> superseded", () => {
    expect(
      consentRenewalDisplayStatus("renewed", FUTURE_DATE, FIXED_NOW),
    ).toBe("superseded");
  });

  it("superseded -> superseded", () => {
    expect(
      consentRenewalDisplayStatus("superseded", FUTURE_DATE, FIXED_NOW),
    ).toBe("superseded");
  });
});

describe("consentContextDisplayStatus (rules-page join)", () => {
  it("returns null when every consent column is empty", () => {
    expect(
      consentContextDisplayStatus({
        renewalStatus: null,
        expiryDate: null,
        withdrawnAt: null,
      }),
    ).toBeNull();
  });

  it("withdrawnAt set -> revoked even when renewalStatus is active", () => {
    expect(
      consentContextDisplayStatus({
        renewalStatus: "active",
        expiryDate: "2027-01-01T00:00:00Z",
        withdrawnAt: "2026-04-01T00:00:00Z",
      }),
    ).toBe("revoked");
  });

  it("active + future expiry -> active", () => {
    expect(
      consentContextDisplayStatus({
        renewalStatus: "active",
        expiryDate: "2027-01-01T00:00:00Z",
        withdrawnAt: null,
      }),
    ).toBe("active");
  });

  it("renewalStatus expired -> expired", () => {
    expect(
      consentContextDisplayStatus({
        renewalStatus: "expired",
        expiryDate: "2025-01-01T00:00:00Z",
        withdrawnAt: null,
      }),
    ).toBe("expired");
  });
});
