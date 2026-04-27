import { describe, it, expect } from "vitest";
import { nextChargeDate, formatNextChargeCell } from "./fee-rule-helpers";

describe("nextChargeDate", () => {
  it("returns the effective date itself when it is in the future", () => {
    const eff = "2026-12-15";
    const now = new Date("2026-04-01T00:00:00Z");
    const r = nextChargeDate(eff, "monthly", now);
    expect(r?.toISOString().slice(0, 10)).toBe("2026-12-15");
  });

  it("advances monthly correctly", () => {
    const eff = "2026-01-15";
    const now = new Date("2026-04-10T00:00:00Z");
    // From Jan 15 → next charge after Apr 10 is Apr 15.
    const r = nextChargeDate(eff, "monthly", now);
    expect(r?.toISOString().slice(0, 10)).toBe("2026-04-15");
  });

  it("clamps day-of-month when target month is shorter (Jan 31 → Feb 28)", () => {
    const eff = "2027-01-31"; // 2027 is NOT a leap year — Feb has 28 days.
    const now = new Date("2027-02-01T00:00:00Z");
    const r = nextChargeDate(eff, "monthly", now);
    expect(r?.toISOString().slice(0, 10)).toBe("2027-02-28");
  });

  it("advances quarterly correctly", () => {
    const eff = "2026-01-10";
    const now = new Date("2026-05-01T00:00:00Z");
    // Jan 10 → Apr 10 → Jul 10. Apr 10 < May 1, so next is Jul 10.
    const r = nextChargeDate(eff, "quarterly", now);
    expect(r?.toISOString().slice(0, 10)).toBe("2026-07-10");
  });

  it("returns null for unknown frequency", () => {
    const eff = "2026-01-10";
    const r = nextChargeDate(eff, null, new Date("2026-05-01T00:00:00Z"));
    expect(r).toBeNull();
  });

  it("returns null when effectiveDate is missing", () => {
    expect(nextChargeDate(null, "monthly", new Date("2026-05-01"))).toBeNull();
  });

  it("formatNextChargeCell returns YYYY-MM-DD or em-dash", () => {
    expect(formatNextChargeCell(null, "monthly")).toBe("—");
    expect(formatNextChargeCell("2026-01-15", null)).toBe("—");
    expect(formatNextChargeCell("2099-01-15", "monthly")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
