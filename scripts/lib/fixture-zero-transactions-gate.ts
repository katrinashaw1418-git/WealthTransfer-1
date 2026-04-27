// =============================================================================
// END-OF-STAGE-2 FIXTURE-USER ZERO-TRANSACTIONS GATE
// (Task #210 helper, extracted in Task #213)
// =============================================================================
// Pre-launch Stage 2 contract: every per-scenario lifecycle in
// scripts/pre-launch-safety.ts owns a `__prelaunch_<scenario>` fixture
// user and is wrapped in `runScenarioWithPlatformLegAssert`, which
// scrubs the fixture user's transactions (cascading to its platform-side
// legs) at the end of the scenario. This gate asserts that contract
// holds: at the boundary between Stage 2 and Stage 3, every fixture
// user matched by the prefix MUST own zero transactions, with the
// platform user explicitly excluded (it is shared infrastructure, not
// a per-scenario fixture).
//
// Extracted to this lib (mirroring scripts/lib/platform-leg-gate.ts so
// scripts/test-prelaunch-fixture-contract.ts can exercise the gate's
// FAIL / SKIP / platform-exclusion paths in isolation. Importing the
// gate function directly from scripts/pre-launch-safety.ts is not
// viable: that script unconditionally invokes `main()` at module-init,
// so importing it would side-effect-run the entire pre-launch suite.
//
// Pure on purpose — the only side-effects are the two read-only SELECTs
// the gate needs (fixture users matching the prefix; transactions owned
// by them). Reporting is done via the injected reporter so callers can
// either route into the live pre-launch results map or capture into a
// test-local map for assertions.
// =============================================================================

import { and, inArray, ne, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

import { transactions, users } from "../../shared/schema";

export interface FixtureZeroTxGateReporter {
  pass(name: string, details: string): void;
  fail(name: string, details: string): void;
  skip(name: string, reason: string): void;
}

export interface AssertFixtureUsersHaveZeroTransactionsInput {
  /** Reporter gate name (e.g. "lifecycle: end-of-Stage-2 fixture-user contract"). */
  gateName: string;
  /**
   * SQL LIKE prefix the gate matches against `users.username` (e.g.
   * "__prelaunch_"). Underscores and percent signs in the prefix are
   * escaped before being passed to LIKE — without that, the literal
   * underscores in `__prelaunch_` are SQL LIKE single-character
   * wildcards and would also match e.g. `xxprelaunch_foo` (a real
   * concern: scripts/test-wealth-planner-compliance.ts hit this and
   * had to add ESCAPE in the same shape).
   */
  usernamePrefix: string;
  /**
   * Resolved platform user id to EXCLUDE from the gate. The platform
   * user is shared infrastructure across the whole pre-launch run and
   * across every Stage-1 subprocess test, not a per-scenario fixture,
   * so there is no per-run "back to zero" expectation on its rows.
   * Pass NaN / <=0 if no exclusion is desired (no platform user
   * resolved); the gate then matches the bare prefix.
   */
  platformUserId: number;
  /** Reporter that records the gate's outcome (pass/fail/skip). */
  reporter: FixtureZeroTxGateReporter;
  /**
   * Drizzle DB handle. Injected so the live pre-launch caller passes
   * the production `db` and the regression test passes the same db
   * (no test double — the whole point of this gate is that its real
   * SQL behaves correctly).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>;
}

/**
 * Escape SQL LIKE wildcards (`_` and `%`) in a literal prefix so it can
 * be safely interpolated into a `LIKE '<prefix>%' ESCAPE '\\'` clause.
 */
function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/\\/g, "\\\\").replace(/_/g, "\\_").replace(/%/g, "\\%");
}

export async function assertFixtureUsersHaveZeroTransactions(
  input: AssertFixtureUsersHaveZeroTransactionsInput,
): Promise<void> {
  const { reporter, gateName, usernamePrefix, platformUserId, db } = input;
  try {
    const escapedPrefix = escapeLikePrefix(usernamePrefix);
    // Bind the LIKE pattern as a parameter (rather than inlining as a
    // SQL literal) so the prefix is treated as data, not code.
    const likePattern = `${escapedPrefix}%`;
    const prefixMatch = sql`${users.username} LIKE ${likePattern} ESCAPE '\\'`;

    const platformExclusionActive =
      Number.isInteger(platformUserId) && platformUserId > 0;
    const whereClause = platformExclusionActive
      ? and(prefixMatch, ne(users.id, platformUserId))
      : prefixMatch;

    const fixtureUsers = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(whereClause);

    if (fixtureUsers.length === 0) {
      reporter.skip(
        gateName,
        `no ${usernamePrefix}% fixture users exist (excluding the platform ` +
          `user); nothing to verify — every Stage 2 lifecycle was likely ` +
          `skipped before creating its fixture`,
      );
      return;
    }

    const fixtureUserIds = fixtureUsers.map((u) => u.id);
    const txRows = await db
      .select({ userId: transactions.userId, id: transactions.id })
      .from(transactions)
      .where(inArray(transactions.userId, fixtureUserIds));

    if (txRows.length === 0) {
      reporter.pass(
        gateName,
        `every ${usernamePrefix}% fixture user (n=${fixtureUsers.length}` +
          (platformExclusionActive
            ? `, excluding platform user id=${platformUserId}`
            : "") +
          `) owns zero transactions at end of Stage 2 — the per-scenario ` +
          `scrub contract holds`,
      );
      return;
    }

    const usernameById = new Map(fixtureUsers.map((u) => [u.id, u.username]));
    const countsByUserId = new Map<number, number>();
    for (const t of txRows) {
      countsByUserId.set(t.userId, (countsByUserId.get(t.userId) ?? 0) + 1);
    }
    const offenders = Array.from(countsByUserId.entries())
      .map(([uid, n]) => `${usernameById.get(uid) ?? `user#${uid}`}=${n}`)
      .sort()
      .join(", ");

    reporter.fail(
      gateName,
      `${txRows.length} leftover transaction row(s) on ` +
        `${countsByUserId.size} fixture user(s) at end of Stage 2: ` +
        `${offenders}. Every Stage 2 lifecycle scenario MUST self-clean ` +
        `via runScenarioWithPlatformLegAssert (which deletes the fixture ` +
        `user's transactions, cascading to its platform-side legs). A ` +
        `non-zero count here means a scenario was added that bypasses ` +
        `that wrapper, or its fixture username does not match the ` +
        `username the wrapper scrubs.`,
    );
  } catch (err: any) {
    reporter.fail(gateName, `threw: ${err?.message ?? err}`);
  }
}
