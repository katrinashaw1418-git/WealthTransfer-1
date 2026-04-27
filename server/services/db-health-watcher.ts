// =============================================================================
// TASK #145 — DB connection health watcher
// =============================================================================
// A standalone watchdog that pings the DB on a fixed interval and dispatches
// an operator alert when N consecutive pings have failed within an M-second
// window. The point is to catch repeated connection drops — flapping single
// failures (transient network blips, replica swaps) are noise; a sustained
// pattern is a real outage operators need to wake up for.
//
// Hard rules:
//   - This service NEVER calls `withBackgroundJobRunRecord`. That helper
//     itself writes to the DB; if connectivity is broken, the recorder write
//     will throw and mask the alert we are trying to fire. Instead we rely on
//     the operator-alerts dispatcher's own try/catch and the ack lookup
//     re-throwing on its own.
//   - Counter resets on the FIRST successful ping after a failure streak,
//     and again immediately AFTER an alert fires. The latter means a re-fire
//     requires another full N consecutive failures — operators are paged
//     once per "bad outage", not on every ping during it.
//   - Suppression key is fixed (`"db-connection-failure"`): there is only
//     one DB to be down at a time, so an ack is "yes I know the DB is down,
//     stop paging me until I clear it".
// =============================================================================

import { sql } from "drizzle-orm";
import { db } from "../db";
import { notifyOperatorWithSuppression } from "./operator-alerts";

export const DB_CONNECTION_FAILURE_SOURCE = "db-connection-failure";
export const DB_CONNECTION_FAILURE_SUPPRESSION_KEY = "db-connection-failure";

// Defaults if no env vars are set. Conservative enough to catch a ~1-minute
// outage at a 30s ping cadence (3 consecutive failures within 60s).
const DEFAULTS = {
  failThreshold: 3,
  failWindowSeconds: 60,
  pingIntervalSeconds: 30,
};

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[db-health-watcher] invalid ${name}=${raw}, falling back to ${fallback}`,
    );
    return fallback;
  }
  return Math.floor(n);
}

export interface DbHealthWatcherConfig {
  failThreshold: number;
  failWindowSeconds: number;
  pingIntervalSeconds: number;
}

export function resolveDbHealthWatcherConfig(): DbHealthWatcherConfig {
  return {
    failThreshold: readEnvInt(
      "DB_HEALTH_FAIL_THRESHOLD",
      DEFAULTS.failThreshold,
    ),
    failWindowSeconds: readEnvInt(
      "DB_HEALTH_FAIL_WINDOW_SECONDS",
      DEFAULTS.failWindowSeconds,
    ),
    pingIntervalSeconds: readEnvInt(
      "DB_HEALTH_PING_INTERVAL_SECONDS",
      DEFAULTS.pingIntervalSeconds,
    ),
  };
}

export interface DbHealthState {
  consecutiveFailures: number;
  firstFailureAt: Date | null;
  lastResult: "success" | "failure" | null;
  lastFailureMessage: string | null;
  totalAlertsFired: number;
  /**
   * Rolling buffer of the most recent failure timestamps, capped at
   * `failThreshold`. We fire when this buffer is full AND the span between
   * its oldest and newest entry is within `failWindowSeconds`. Tracking the
   * window this way (rather than off a single `firstFailureAt` anchor)
   * means a SUSTAINED outage keeps firing eligibility — e.g. a 30s ping
   * cadence with threshold=3 / window=60s where the 3rd consecutive
   * failure happens at firstFailure+90s would be incorrectly ignored
   * under the old anchor-from-first scheme even though the DB is clearly
   * still down.
   */
  recentFailureTimestamps: Date[];
}

// Module-level state lives only inside `startDbHealthWatcher` to keep tests
// honest; we still expose a getter for the most-recent snapshot in case a
// future health endpoint wants to surface it.
let currentState: DbHealthState = {
  consecutiveFailures: 0,
  firstFailureAt: null,
  lastResult: null,
  lastFailureMessage: null,
  totalAlertsFired: 0,
  recentFailureTimestamps: [],
};

export function getDbHealthState(): DbHealthState {
  return {
    ...currentState,
    recentFailureTimestamps: [...currentState.recentFailureTimestamps],
  };
}

/**
 * Run one ping and update the in-memory failure counter. Exported so a test
 * harness (or a manual admin probe) can drive ticks without waiting for the
 * timer. Returns the post-tick state snapshot for assertion.
 */
export async function tickDbHealthWatcher(
  config: DbHealthWatcherConfig = resolveDbHealthWatcherConfig(),
  now: Date = new Date(),
): Promise<DbHealthState> {
  let success = false;
  let errorMessage: string | null = null;
  try {
    // SELECT 1 is the canonical "is the connection alive" probe. Cheap; no
    // table scan; no locks. Wrapping in `sql` keeps Drizzle from inferring
    // a row shape we don't care about.
    await db.execute(sql`SELECT 1`);
    success = true;
  } catch (err) {
    errorMessage =
      err instanceof Error
        ? err.message.slice(0, 500)
        : String(err).slice(0, 500);
  }

  if (success) {
    // First success after one or more failures resets the streak AND the
    // rolling-window buffer. We deliberately do NOT log on every successful
    // tick — that would be pure noise at a 30s cadence.
    if (currentState.consecutiveFailures > 0) {
      console.log(
        `[db-health-watcher] connection recovered after ` +
          `${currentState.consecutiveFailures} consecutive failure(s)`,
      );
    }
    currentState = {
      consecutiveFailures: 0,
      firstFailureAt: null,
      lastResult: "success",
      lastFailureMessage: null,
      totalAlertsFired: currentState.totalAlertsFired,
      recentFailureTimestamps: [],
    };
    return getDbHealthState();
  }

  // Failure path — increment the streak, push into the rolling-window
  // buffer (cap at failThreshold), then decide whether to fire.
  const ringBuffer = [...currentState.recentFailureTimestamps, now];
  while (ringBuffer.length > config.failThreshold) {
    ringBuffer.shift();
  }
  const next: DbHealthState = {
    consecutiveFailures: currentState.consecutiveFailures + 1,
    firstFailureAt: currentState.firstFailureAt ?? now,
    lastResult: "failure",
    lastFailureMessage: errorMessage,
    totalAlertsFired: currentState.totalAlertsFired,
    recentFailureTimestamps: ringBuffer,
  };
  currentState = next;

  console.warn(
    `[db-health-watcher] ping failed (${next.consecutiveFailures} consecutive): ${errorMessage}`,
  );

  // Fire eligibility: the rolling buffer is at threshold capacity AND the
  // span between its oldest and newest entry is within the configured
  // window. This is the literal "N failures within M seconds" definition
  // and — critically — keeps firing eligible during a SUSTAINED outage
  // where the absolute first failure may have been more than M seconds
  // ago. (The previous anchor-from-first scheme could permanently suppress
  // a re-fire during a long outage with timer jitter.)
  const windowMs = config.failWindowSeconds * 1000;
  const bufferFull = next.recentFailureTimestamps.length >= config.failThreshold;
  const span = bufferFull
    ? next.recentFailureTimestamps[next.recentFailureTimestamps.length - 1].getTime() -
      next.recentFailureTimestamps[0].getTime()
    : 0;
  if (bufferFull && span <= windowMs) {
    // Fire — and immediately reset so a re-fire requires another full
    // streak. The ack on `db-connection-failure` keeps re-pages off until
    // the operator clears it.
    try {
      await notifyOperatorWithSuppression(
        {
          source: DB_CONNECTION_FAILURE_SOURCE,
          severity: "critical",
          title: "Repeated database connection failures",
          details: {
            consecutiveFailures: next.consecutiveFailures,
            firstFailureAt: next.firstFailureAt?.toISOString() ?? null,
            windowSpanMs: span,
            lastFailureMessage: errorMessage,
            failThreshold: config.failThreshold,
            failWindowSeconds: config.failWindowSeconds,
            pingIntervalSeconds: config.pingIntervalSeconds,
            message:
              `${next.consecutiveFailures} consecutive DB pings have failed; the most ` +
              `recent ${config.failThreshold} happened within ${Math.round(span / 1000)}s ` +
              `(threshold=${config.failThreshold}/${config.failWindowSeconds}s). ` +
              `Investigate connectivity, pool exhaustion, or upstream provider status.`,
          },
        },
        DB_CONNECTION_FAILURE_SUPPRESSION_KEY,
      );
      currentState = {
        ...next,
        consecutiveFailures: 0,
        firstFailureAt: null,
        totalAlertsFired: next.totalAlertsFired + 1,
        recentFailureTimestamps: [],
      };
    } catch (alertErr) {
      // The ack lookup or operator-alert insert itself failed — almost
      // certainly because the DB is down, which is what we are trying to
      // page about. We log loudly but leave the streak counters in place
      // so the next tick will re-evaluate (and likely re-attempt the
      // alert once connectivity flickers back).
      console.error(
        "[db-health-watcher] failed to dispatch db-connection-failure alert",
        alertErr,
      );
    }
  }

  return getDbHealthState();
}

let intervalHandle: NodeJS.Timeout | null = null;

/**
 * Start the periodic ping loop. Idempotent — calling twice is a no-op (the
 * second call logs and returns the existing timer). Exported so the cron
 * wiring in `server/index.ts` and test harnesses can both invoke it.
 */
export function startDbHealthWatcher(
  config: DbHealthWatcherConfig = resolveDbHealthWatcherConfig(),
): { config: DbHealthWatcherConfig; alreadyRunning: boolean } {
  if (intervalHandle) {
    console.log("[db-health-watcher] already running; ignoring duplicate start");
    return { config, alreadyRunning: true };
  }
  // Reset state on (re)start so a stale module-level counter from a prior
  // process incarnation can't leak into this one in tests.
  currentState = {
    consecutiveFailures: 0,
    firstFailureAt: null,
    lastResult: null,
    lastFailureMessage: null,
    totalAlertsFired: 0,
    recentFailureTimestamps: [],
  };
  intervalHandle = setInterval(() => {
    void tickDbHealthWatcher(config).catch((err) => {
      // tickDbHealthWatcher already swallows expected errors; this is a
      // defensive catch for an unexpected throw (e.g. the alerter itself).
      console.error("[db-health-watcher] unexpected tick error", err);
    });
  }, config.pingIntervalSeconds * 1000);
  console.log(
    `[db-health-watcher] started: pingIntervalSeconds=${config.pingIntervalSeconds}, ` +
      `failThreshold=${config.failThreshold}, failWindowSeconds=${config.failWindowSeconds}`,
  );
  return { config, alreadyRunning: false };
}

/** Stop the loop. Used by tests; no production caller stops the watcher. */
export function stopDbHealthWatcher(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
