// =============================================================================
// isTestFixtureEmail / matchTestFixtureEmail — pattern regression cover
// -----------------------------------------------------------------------------
// Locks in the pattern list documented in Task #286 ("Done looks like"). If
// someone widens or narrows the matcher in the future, these cases force them
// to think about each pattern explicitly rather than silently regressing the
// adviser-surface filter.
// =============================================================================
import { describe, expect, it } from "vitest";

import { isTestFixtureEmail, matchTestFixtureEmail } from "./test-fixture-emails";

describe("isTestFixtureEmail", () => {
  it("matches any address ending in @example.com", () => {
    expect(isTestFixtureEmail("anyone@example.com")).toBe(true);
    expect(isTestFixtureEmail("ANYONE@EXAMPLE.COM")).toBe(true);
    expect(isTestFixtureEmail("  user@example.com  ")).toBe(true);
  });

  it("matches local-part substrings __prelaunch_, __feegate_, __txsafety_", () => {
    expect(isTestFixtureEmail("__prelaunch_alpha@clients.test")).toBe(true);
    expect(isTestFixtureEmail("user__feegate_b@clients.test")).toBe(true);
    expect(isTestFixtureEmail("__txsafety_x@clients.test")).toBe(true);
  });

  it("matches local-part prefixes adviser-race-, adviser-ok-, okadv-", () => {
    expect(isTestFixtureEmail("adviser-race-1777203777300@clients.test")).toBe(true);
    expect(isTestFixtureEmail("adviser-ok-1777203778096@clients.test")).toBe(true);
    expect(isTestFixtureEmail("okadv-1777203811341@clients.test")).toBe(true);
  });

  it("does NOT match real-looking addresses", () => {
    expect(isTestFixtureEmail("alice@clients.test")).toBe(false);
    expect(isTestFixtureEmail("bob@amaxwealth.com.au")).toBe(false);
    expect(isTestFixtureEmail("planner-adviser@test.invalid")).toBe(false);
    expect(isTestFixtureEmail("gateb-client@test.invalid")).toBe(false);
  });

  it("treats empty / null / whitespace-only emails as non-fixture (no false drops)", () => {
    expect(isTestFixtureEmail(null)).toBe(false);
    expect(isTestFixtureEmail(undefined)).toBe(false);
    expect(isTestFixtureEmail("")).toBe(false);
    expect(isTestFixtureEmail("   ")).toBe(false);
  });

  it("only treats `adviser-race-` etc. as a prefix, not a substring", () => {
    // A real email that happens to contain "adviser-ok-" mid-string is NOT a
    // fixture (the patterns are deliberately *prefix* matches per the task).
    expect(isTestFixtureEmail("real-adviser-ok-stuff@clients.test")).toBe(false);
  });
});

describe("matchTestFixtureEmail", () => {
  it("returns the matched pattern for diagnostic logging", () => {
    expect(matchTestFixtureEmail("foo@example.com")).toEqual({
      matched: true,
      pattern: "domain:@example.com",
    });
    expect(matchTestFixtureEmail("__prelaunch_a@clients.test")).toEqual({
      matched: true,
      pattern: "local-substring:__prelaunch_",
    });
    expect(matchTestFixtureEmail("adviser-race-1@clients.test")).toEqual({
      matched: true,
      pattern: "local-prefix:adviser-race-",
    });
    expect(matchTestFixtureEmail("alice@clients.test")).toEqual({
      matched: false,
    });
  });
});
