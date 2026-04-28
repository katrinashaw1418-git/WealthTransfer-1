// =============================================================================
// TASK #366 — fixture-data-guard regression cover
// -----------------------------------------------------------------------------
// Locks in the production-refusal matrix so a future env change can't quietly
// re-enable fixture insertion against a real database.
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  evaluateFixtureGuard,
  assertFixtureInsertionAllowed,
  FixtureInsertionRefusedError,
} from "./fixture-data-guard";

function envOf(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  // Build a clean env object so the test isn't dependent on the ambient
  // process.env values that vitest happens to inherit. We start from an
  // empty bag and layer overrides on top — explicit `undefined` deletes.
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) out[k] = v;
  }
  return out as NodeJS.ProcessEnv;
}

describe("evaluateFixtureGuard — production-refusal matrix", () => {
  it("refuses NODE_ENV=production unconditionally", () => {
    const d = evaluateFixtureGuard(envOf({ NODE_ENV: "production" }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/production refuses/);
  });

  it("refuses NODE_ENV=production even when ALLOW_FIXTURE_INSERTION=1", () => {
    // The opt-in flag must NOT be able to override the production refusal —
    // that's the whole point of the guard.
    const d = evaluateFixtureGuard(
      envOf({ NODE_ENV: "production", ALLOW_FIXTURE_INSERTION: "1" }),
    );
    expect(d.allowed).toBe(false);
  });

  it("refuses NODE_ENV=production even with NODE_ENV=development AND ALLOW_LOCAL_DEV_AUTH=true layered", () => {
    // Belt-and-braces: if NODE_ENV is production, no other signal opens it.
    const d = evaluateFixtureGuard(
      envOf({
        NODE_ENV: "production",
        APP_ENV: "local",
        ALLOW_LOCAL_DEV_AUTH: "true",
        ALLOW_FIXTURE_INSERTION: "1",
      }),
    );
    expect(d.allowed).toBe(false);
  });

  it("permits NODE_ENV=test (default for the test runner)", () => {
    const d = evaluateFixtureGuard(envOf({ NODE_ENV: "test" }));
    expect(d.allowed).toBe(true);
    expect(d.reason).toMatch(/test runner/);
  });

  it("permits NODE_ENV=development with APP_ENV=local", () => {
    const d = evaluateFixtureGuard(
      envOf({ NODE_ENV: "development", APP_ENV: "local" }),
    );
    expect(d.allowed).toBe(true);
  });

  it("permits NODE_ENV=development with ALLOW_LOCAL_DEV_AUTH=true", () => {
    const d = evaluateFixtureGuard(
      envOf({ NODE_ENV: "development", ALLOW_LOCAL_DEV_AUTH: "true" }),
    );
    expect(d.allowed).toBe(true);
  });

  it("REFUSES NODE_ENV=development without a local-dev signal (shared-staging case)", () => {
    // This is the regression that motivates the guard: a NODE_ENV=development
    // value sitting on a shared staging environment must NOT be enough to
    // unlock fixture insertion. Either ALLOW_FIXTURE_INSERTION=1 or one of
    // the explicit local-dev flags must be present.
    const d = evaluateFixtureGuard(envOf({ NODE_ENV: "development" }));
    expect(d.allowed).toBe(false);
  });

  it("REFUSES when NODE_ENV is unset", () => {
    const d = evaluateFixtureGuard(envOf({}));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/<unset>/);
  });

  it("permits ALLOW_FIXTURE_INSERTION=1 outside production (explicit dev opt-in)", () => {
    const d = evaluateFixtureGuard(
      envOf({ NODE_ENV: "development", ALLOW_FIXTURE_INSERTION: "1" }),
    );
    expect(d.allowed).toBe(true);
    expect(d.reason).toMatch(/explicit opt-in/);
  });
});

describe("assertFixtureInsertionAllowed — throw shape", () => {
  it("throws FixtureInsertionRefusedError under NODE_ENV=production", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => assertFixtureInsertionAllowed("test-context")).toThrow(
        FixtureInsertionRefusedError,
      );
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("does NOT throw under NODE_ENV=test (the default for vitest)", () => {
    // vitest runs with NODE_ENV=test by default; the bootstrap also sets
    // it. Guard must be a no-op here.
    expect(() => assertFixtureInsertionAllowed("test-context")).not.toThrow();
  });
});
