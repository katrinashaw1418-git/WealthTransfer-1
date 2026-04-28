// =============================================================================
// TASK #366 — FIXTURE / SEED INSERTION GUARD
// -----------------------------------------------------------------------------
// Hard environment guard: refuses to run fixture/seed insertion code when the
// active database is the production one (or any database real users
// authenticate against). Read-time filters are necessary but not sufficient —
// any new view, export, email or future feature that bypasses the filter will
// leak again. This guard plugs the hole by stopping fixture rows from ever
// being INSERTED into a production-reachable database in the first place.
//
// Usage:
//   import { assertFixtureInsertionAllowed } from "../server/services/fixture-data-guard";
//   assertFixtureInsertionAllowed("scripts/test-transaction-safety.ts");
//
// Decision logic (deny by default in any production-like environment):
//   - If `ALLOW_FIXTURE_INSERTION=1` is set, the guard always permits insertion.
//     Use this only on isolated dev/test databases where you understand what
//     you are doing.
//   - If `NODE_ENV=production`, the guard ALWAYS refuses, regardless of
//     ALLOW_FIXTURE_INSERTION. We do not let any combination of env vars
//     override the production refusal.
//   - If `NODE_ENV=test`, the guard permits insertion (vitest / tsx test
//     scripts run with NODE_ENV=test by default via _bootstrap-test-env.ts).
//   - If `NODE_ENV=development` AND the local-dev signals from
//     `server/auth.ts` are present (`APP_ENV=local` or
//     `ALLOW_LOCAL_DEV_AUTH=true`), the guard permits insertion.
//   - In any other case (including unset NODE_ENV in a real deploy, or a
//     bare `NODE_ENV=development` on a shared staging environment), the
//     guard refuses.
//
// The guard intentionally couples to the SAME signals the auth layer uses to
// decide "is this a local dev box?" so a single env-var change cannot
// silently unlock fixture insertion against a shared environment.
// =============================================================================

export class FixtureInsertionRefusedError extends Error {
  constructor(public readonly context: string, public readonly nodeEnv: string | undefined) {
    super(
      `[fixture-data-guard] Refusing to insert fixture/seed data — active environment ` +
        `(NODE_ENV=${nodeEnv ?? "<unset>"}) is production-like. ` +
        `Context: ${context}. ` +
        `If this is a deliberate run on an isolated dev/test database, set ` +
        `ALLOW_FIXTURE_INSERTION=1 in the environment. ` +
        `Production NODE_ENV always refuses regardless.`,
    );
    this.name = "FixtureInsertionRefusedError";
  }
}

export interface FixtureGuardDecision {
  allowed: boolean;
  reason: string;
  nodeEnv: string | undefined;
}

/**
 * Pure decision function — returns { allowed, reason } without throwing.
 * Used by the assertion below and by tests that want to drive the matrix
 * directly without try/catch around an exception.
 */
export function evaluateFixtureGuard(env: NodeJS.ProcessEnv = process.env): FixtureGuardDecision {
  const nodeEnv = env.NODE_ENV;

  // Production NEVER allows fixture insertion. ALLOW_FIXTURE_INSERTION cannot
  // override this — that would defeat the entire point of the guard.
  if (nodeEnv === "production") {
    return {
      allowed: false,
      reason: "NODE_ENV=production refuses fixture insertion unconditionally",
      nodeEnv,
    };
  }

  if (env.ALLOW_FIXTURE_INSERTION === "1") {
    return {
      allowed: true,
      reason: "ALLOW_FIXTURE_INSERTION=1 explicit opt-in",
      nodeEnv,
    };
  }

  if (nodeEnv === "test") {
    return {
      allowed: true,
      reason: "NODE_ENV=test (test runner)",
      nodeEnv,
    };
  }

  // Mirror the isLocalDev signal from server/auth.ts so the guard can never
  // drift away from "is this a real local dev box?".
  const isLocalDev =
    nodeEnv === "development" &&
    (env.APP_ENV === "local" || env.ALLOW_LOCAL_DEV_AUTH === "true");
  if (isLocalDev) {
    return {
      allowed: true,
      reason: "NODE_ENV=development with explicit local-dev signal",
      nodeEnv,
    };
  }

  return {
    allowed: false,
    reason: `NODE_ENV=${nodeEnv ?? "<unset>"} is treated as production-like (no local-dev signal, no ALLOW_FIXTURE_INSERTION=1)`,
    nodeEnv,
  };
}

/**
 * Throw a FixtureInsertionRefusedError unless the active environment permits
 * fixture / seed data insertion. Call this at script init AND/OR before any
 * insertion path; the cost is one env-var read.
 */
export function assertFixtureInsertionAllowed(context: string): void {
  const decision = evaluateFixtureGuard();
  if (!decision.allowed) {
    throw new FixtureInsertionRefusedError(context, decision.nodeEnv);
  }
}
