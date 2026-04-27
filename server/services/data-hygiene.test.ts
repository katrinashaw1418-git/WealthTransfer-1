import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER_NAME_PAIRS,
  runStartupDataHygiene,
  clearPlaceholderClientNames,
} from "./data-hygiene";

describe("PLACEHOLDER_NAME_PAIRS", () => {
  it("contains the Linked/Client placeholder", () => {
    expect(PLACEHOLDER_NAME_PAIRS.map(([f, l]) => `${f}|${l}`)).toContain("Linked|Client");
  });

  it("stays a small allowlist", () => {
    expect(PLACEHOLDER_NAME_PAIRS.length).toBeLessThanOrEqual(10);
  });

  it("contains only obviously synthetic names", () => {
    const synthetic = ["Linked", "Test", "Fixture", "Placeholder", "Demo", "Sample"];
    const realLooking = ["John", "Jane", "Smith", "Doe", "Williams"];
    for (const [first, last] of PLACEHOLDER_NAME_PAIRS) {
      expect(synthetic.some((s) => first.includes(s) || last.includes(s))).toBe(true);
      expect(realLooking).not.toContain(first);
      expect(realLooking).not.toContain(last);
    }
  });
});

describe("data-hygiene exports", () => {
  it("exports an async boot wrapper", () => {
    expect(runStartupDataHygiene.constructor.name).toBe("AsyncFunction");
  });

  it("exports an async pure helper", () => {
    expect(clearPlaceholderClientNames.constructor.name).toBe("AsyncFunction");
  });
});
