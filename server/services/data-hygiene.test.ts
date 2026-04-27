// =============================================================================
// Task #283 — data hygiene unit tests
// -----------------------------------------------------------------------------
// Pin two contracts:
//   1. The placeholder allowlist contains only the documented entries.
//      Future entries must be added deliberately, with an audit trail.
//   2. The pure helper export shape is stable so the boot wrapper can
//      keep calling it without a refactor.
// =============================================================================
import { describe, expect, it } from "vitest";
import { PLACEHOLDER_NAME_PAIRS, runStartupDataHygiene, clearPlaceholderClientNames } from "./data-hygiene";

describe("PLACEHOLDER_NAME_PAIRS — allowlist of dev-fixture names", () => {
  it("contains the Linked / Client placeholder", () => {
    const flattened = PLACEHOLDER_NAME_PAIRS.map(([f, l]) => `${f}|${l}`);
    expect(flattened).toContain("Linked|Client");
  });

  it("is small — every entry is a deliberate decision", () => {
    // If this fails, audit the new entries before bumping the bound.
    expect(PLACEHOLDER_NAME_PAIRS.length).toBeLessThanOrEqual(10);
  });

  it("contains no entries that look like real human names (e.g. 'John', 'Smith')", () => {
    const realLooking = ["John", "Jane", "Smith", "Doe", "Williams"];
    for (const [first, last] of PLACEHOLDER_NAME_PAIRS) {
      // Each entry must include at least one obviously synthetic token,
      // so we never accidentally NULL a real client's name.
      const synthetic = ["Linked", "Test", "Fixture", "Placeholder", "Demo", "Sample"];
      const hasSynthetic = synthetic.some(
        (s) => first.includes(s) || last.includes(s),
      );
      expect(
        hasSynthetic,
        `placeholder pair (${first}, ${last}) does not contain an obviously synthetic token`,
      ).toBe(true);
      // And not look like a common real name pair.
      expect(realLooking).not.toContain(first);
      expect(realLooking).not.toContain(last);
    }
  });
});

describe("runStartupDataHygiene / clearPlaceholderClientNames — exports", () => {
  it("exports the boot wrapper as an async function", () => {
    expect(typeof runStartupDataHygiene).toBe("function");
    expect(runStartupDataHygiene.constructor.name).toBe("AsyncFunction");
  });

  it("exports the pure helper as an async function", () => {
    expect(typeof clearPlaceholderClientNames).toBe("function");
    expect(clearPlaceholderClientNames.constructor.name).toBe("AsyncFunction");
  });
});
