// =============================================================================
// Task #208 — server-side gating contract for /api/admin/fee-exceptions
// -----------------------------------------------------------------------------
// `projectFeeExceptionRow` is the single point that strips the four IF-only
// bookkeeping columns (failureReason, lastRecheckedAt, clientNotifiedAt,
// clientNotificationCount) from every non-`held` row before the exceptions
// endpoint ships the response. Without this projection, a stuck/failed/
// role_corruption row that previously cycled through `insufficient_funds`
// would carry forward stale "client pinged 3 times" / "Insufficient client
// balance" text into a future admin surface that consumes the same payload.
//
// This suite locks the round-trip in place so a future refactor that drops
// the projection from one branch is caught immediately.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  projectFeeExceptionRow,
  type FeeExceptionKind,
} from "./fee-deduction-status";

const STAMP = new Date("2026-04-01T12:00:00.000Z");

function seed(status: string) {
  return {
    id: 42,
    status,
    failureReason: "Insufficient client balance",
    lastRecheckedAt: STAMP,
    clientNotifiedAt: STAMP,
    clientNotificationCount: 3,
    // A few sibling fields the helper must NOT touch — pinning them in the
    // assertions guards against an over-eager projection that nukes
    // unrelated columns.
    totalAccrued: "100.0000",
    currency: "USD",
    createdAt: STAMP,
  };
}

describe("projectFeeExceptionRow", () => {
  it("preserves IF metadata on a held row", () => {
    const out = projectFeeExceptionRow(seed("insufficient_funds"), "held");
    expect(out.failureReason).toBe("Insufficient client balance");
    expect(out.lastRecheckedAt).toEqual(STAMP);
    expect(out.clientNotifiedAt).toEqual(STAMP);
    expect(out.clientNotificationCount).toBe(3);
    // Sibling fields untouched.
    expect(out.totalAccrued).toBe("100.0000");
    expect(out.currency).toBe("USD");
  });

  for (const [kind, status] of [
    ["stuck", "pending_approval"],
    ["failed", "settled"],
    ["role_corruption", "reversed"],
  ] as ReadonlyArray<readonly [FeeExceptionKind, string]>) {
    it(`strips all four IF-only fields on a ${kind} row`, () => {
      const out = projectFeeExceptionRow(seed(status), kind);
      expect(out.failureReason).toBeNull();
      expect(out.lastRecheckedAt).toBeNull();
      expect(out.clientNotifiedAt).toBeNull();
      expect(out.clientNotificationCount).toBe(0);
      // Sibling fields untouched — only IF bookkeeping is cleared.
      expect(out.totalAccrued).toBe("100.0000");
      expect(out.currency).toBe("USD");
      expect(out.status).toBe(status);
    });
  }

  it("does not mutate the input row", () => {
    const original = seed("settled");
    const snapshot = { ...original };
    projectFeeExceptionRow(original, "failed");
    expect(original).toEqual(snapshot);
  });
});
