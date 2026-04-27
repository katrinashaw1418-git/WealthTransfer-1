// =============================================================================
// PLATFORM-LEG INVARIANT GATE (Task #202 helper, extracted in Task #209)
// =============================================================================
// Per-scenario invariant check originally introduced inline in
// scripts/pre-launch-safety.ts. Extracted into this lib so that
// scripts/test-platform-leg-gate.ts can exercise the gate in isolation
// (the failure path — proving the gate actually catches a contaminated
// platform-side leg) without side-effect-running the entire pre-launch
// suite via a top-level import.
//
// Following the precedent set by scripts/lib/clean-room-gate.ts, this
// file is deliberately DB-agnostic: callers inject the small set of
// callbacks the helper needs (lookup the fixture user id, scrub the
// fixture user, read a per-(user,currency) ledger balance) plus a
// reporter object that takes pass / fail / skip events. That keeps the
// gate's decision logic and message wording in one place — both the
// live pre-launch run and the regression test exercise the EXACT same
// helper, with no inlined copy that can drift out of sync.
// =============================================================================

import Decimal from "decimal.js";

// Epsilon: 0.00000001 — one unit at the schema's 8-decimal-place precision.
// Postgres SUM over the `decimal` ledger amounts is exact, so a clean
// scenario produces an exact zero delta; the epsilon is a defensive
// cushion against any future column-type or rounding change, not a real
// tolerance.
export const PLATFORM_LEG_EPSILON = new Decimal("0.00000001");

export type PlatformPerCurrency = Map<string, string>;

export interface PlatformLegGateReporter {
  pass(name: string, details: string): void;
  fail(name: string, details: string): void;
  skip(name: string, reason: string): void;
}

export type GetUserCurrencyBalanceFn = (
  userId: number,
  currency: string,
) => Promise<string>;

export async function snapshotPlatformPerCurrency(
  platformUserId: number,
  currencies: string[],
  getBalance: GetUserCurrencyBalanceFn,
): Promise<PlatformPerCurrency> {
  const out: PlatformPerCurrency = new Map();
  for (const cur of currencies) {
    out.set(cur, await getBalance(platformUserId, cur));
  }
  return out;
}

export interface AssertPlatformLegInvariantInput {
  /** Reporter gate name (e.g. "platform-leg: lifecycle 1 (happy path)"). */
  gateName: string;
  /** Human-readable scenario name embedded in pass/fail messages. */
  scenarioName: string;
  /** Fixture user whose transactions are scrubbed before the AFTER snapshot. */
  fixtureUsername: string;
  /** Currencies the scenario was expected to touch (snapshotted in baseline). */
  currencies: string[];
  /** PLATFORM_USER_ID's per-currency signed ledger sum captured BEFORE the scenario. */
  baseline: PlatformPerCurrency;
  /** Resolved PLATFORM_USER_ID (<=0 means unresolvable → SKIP). */
  platformUserId: number;
  /** True if the BEFORE snapshot succeeded. False → SKIP. */
  baselineCaptured: boolean;
  /** Optional error string from the BEFORE snapshot, surfaced in the SKIP reason. */
  baselineError: string | null;
  /** Reporter that records the gate's outcome (pass/fail/skip). */
  reporter: PlatformLegGateReporter;
  /**
   * Look up the fixture user's PK by username. Returns null if the user
   * does not exist (which means the scenario was skipped before creating
   * it — nothing to scrub, gate SKIPs).
   */
  lookupFixtureUserId: (username: string) => Promise<number | null>;
  /**
   * Scrub the fixture user's transactions. The pre-launch caller passes
   * its existing `resetScenarioState([fixtureUserId])` which deletes the
   * fixture user's transactions (cascading to delete the scenario's
   * platform-side legs by tx_id). The regression test passes a smaller
   * scrub scoped to its own fixture.
   */
  scrubFixture: (fixtureUserId: number) => Promise<void>;
  /** Read a per-(user, currency) balance — same shape as getUserCurrencyBalance. */
  getBalance: GetUserCurrencyBalanceFn;
}

export async function assertPlatformLegInvariantAndScrub(
  input: AssertPlatformLegInvariantInput,
): Promise<void> {
  const { reporter } = input;
  try {
    if (input.platformUserId <= 0) {
      reporter.skip(
        input.gateName,
        `PLATFORM_USER_ID not resolvable; cannot assert platform-leg invariant for "${input.scenarioName}"`,
      );
      return;
    }
    if (!input.baselineCaptured) {
      reporter.skip(
        input.gateName,
        `pre-snapshot of platform ledger failed for "${input.scenarioName}": ` +
          `${input.baselineError ?? "see error above"}`,
      );
      return;
    }

    const fixtureUserId = await input.lookupFixtureUserId(input.fixtureUsername);
    if (fixtureUserId == null) {
      // Scenario was skipped before creating the fixture user (e.g. a
      // route handler wasn't registered, or a precondition like an FX
      // rate seed failed). Nothing to scrub, nothing to assert.
      reporter.skip(
        input.gateName,
        `fixture user "${input.fixtureUsername}" does not exist (scenario "${input.scenarioName}" likely skipped before creating it)`,
      );
      return;
    }

    // Per-scenario scrub: delete the fixture user's transactions, which
    // cascades to delete the scenario's platform-side legs (they share
    // the same transaction_id). This is the per-scenario counterpart to
    // the (now-removed) bulk Stage-2.5 platform-leg scrub.
    await input.scrubFixture(fixtureUserId);

    const after = await snapshotPlatformPerCurrency(
      input.platformUserId,
      input.currencies,
      input.getBalance,
    );

    const drifted: string[] = [];
    for (const cur of input.currencies) {
      const baselineVal = new Decimal(input.baseline.get(cur) ?? "0");
      const afterVal = new Decimal(after.get(cur) ?? "0");
      const delta = afterVal.minus(baselineVal);
      if (delta.abs().gt(PLATFORM_LEG_EPSILON)) {
        drifted.push(
          `${cur}: ${baselineVal.toString()} -> ${afterVal.toString()} ` +
            `(delta ${delta.gte(0) ? "+" : ""}${delta.toString()})`,
        );
      }
    }

    if (drifted.length === 0) {
      reporter.pass(
        input.gateName,
        `scenario "${input.scenarioName}" produced no net drift vs pre-scenario ` +
          `baseline on platform user (id=${input.platformUserId}) ` +
          `(within ±${PLATFORM_LEG_EPSILON.toString()}) for ` +
          `currencies [${input.currencies.join(", ")}]`,
      );
    } else {
      reporter.fail(
        input.gateName,
        `scenario "${input.scenarioName}" contaminated platform user (id=${input.platformUserId}) ` +
          `vs pre-scenario baseline: ` +
          drifted.join("; ") +
          ` — the per-fixture-user scrub did not neutralise these legs, ` +
          `meaning the scenario posted platform-user ledger entries via a ` +
          `transaction NOT owned by fixture user "${input.fixtureUsername}" (or via ` +
          `a single-leg posting that bypassed the double-entry primitive). ` +
          `Inspect the scenario's ledger writes for the offending currency.`,
      );
    }
  } catch (err: any) {
    reporter.fail(input.gateName, `threw: ${err?.message ?? err}`);
  }
}
