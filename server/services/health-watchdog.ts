// =============================================================================
// TASK #164 — In-process /health watchdog
// =============================================================================
// Task #144 added the structured /health endpoint and Task #157 wired up the
// admin "lastSuccessfulHealthProbeAt" tile, but nothing inside the server
// actually pages an operator when /health stays red. We were relying on
// whoever the deployment team hooked up as an external uptime monitor —
// classic "did anyone wire that up?" failure mode.
//
// This module closes that loop by running `buildHealthReport()` itself on a
// short cadence and dispatching an operator alert when the report has been
// "degraded" for longer than a configurable threshold (default 10 minutes).
// Recovery (back to ok) clears the in-flight alert and dispatches an info
// recovery notice so the operator can see the outage closed.
//
// Hard rules (mirroring db-health-watcher and operator-alerts-prune):
//   - In-memory state debounces re-pages: a 24h outage produces ONE alert,
//     not 1440. The dispatcher's own dedupe window (15m default) is too
//     short to absorb a long outage at the watchdog's short tick cadence,
//     so we keep an `alertFired` flag that is reset only on recovery.
//   - The probe runs in its own try/catch so a thrown buildHealthReport()
//     does not crash the interval. A throw is treated as a degraded signal
//     (the watchdog cannot tell the system is fine if the probe itself
//     fails) and counts toward the staleness threshold.
//   - The watchdog is scheduling-only. It never writes to background_job_runs
//     and never wraps itself in withBackgroundJobRunRecord — that helper
//     would write to the same DB whose connectivity might be the very thing
//     /health is reporting on.
//   - State is RESET on (re)start so a stale module-level counter from a
//     prior process incarnation cannot leak into the new one in tests.
// =============================================================================

import { buildHealthReport, type HealthReport } from "./health";
import {
  notifyOperator,
  type OperatorAlertResult,
} from "./operator-alerts";

export const HEALTH_WATCHDOG_SOURCE = "health-watchdog";

// Conservative defaults — 10-minute threshold matches the task spec, and a
// 60s tick cadence is fast enough that a real outage is paged within ~1
// tick of the threshold but slow enough not to swamp the DB with extra
// SELECTs (the probe issues a SELECT 1 plus three background_job_runs
// lookups per tick).
const DEFAULTS = {
  thresholdMinutes: 10,
  probeIntervalSeconds: 60,
};

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[health-watchdog] invalid ${name}=${raw}, falling back to ${fallback}`,
    );
    return fallback;
  }
  return Math.floor(n);
}

export interface HealthWatchdogConfig {
  /** Minimum minutes the report must stay 'degraded' before paging. */
  thresholdMinutes: number;
  /** How often to run buildHealthReport(). */
  probeIntervalSeconds: number;
}

export function resolveHealthWatchdogConfig(): HealthWatchdogConfig {
  return {
    thresholdMinutes: readEnvInt(
      "HEALTH_WATCHDOG_THRESHOLD_MINUTES",
      DEFAULTS.thresholdMinutes,
    ),
    probeIntervalSeconds: readEnvInt(
      "HEALTH_WATCHDOG_PROBE_INTERVAL_SECONDS",
      DEFAULTS.probeIntervalSeconds,
    ),
  };
}

export interface HealthWatchdogState {
  /**
   * The first tick of the current degraded episode. null when the most
   * recent observed status was 'ok' (or no tick has run yet).
   */
  degradedSince: Date | null;
  /**
   * True once we've paged for the CURRENT degraded episode. Cleared on
   * recovery so a new outage will page again, but stays true through the
   * episode so we never re-page on every tick.
   */
  alertFired: boolean;
  /** When the most recent dispatched alert went out (null if never). */
  lastAlertAt: Date | null;
  /** Last observed status — handy for the admin debug surface. */
  lastStatus: "ok" | "degraded" | "probe_error" | null;
  /** Truncated error message when the probe itself threw. */
  lastProbeError: string | null;
  /** Cumulative count of "outage opened" alerts since process start. */
  totalAlertsFired: number;
  /** Cumulative count of "recovered" alerts since process start. */
  totalRecoveriesFired: number;
}

let currentState: HealthWatchdogState = freshState();

function freshState(): HealthWatchdogState {
  return {
    degradedSince: null,
    alertFired: false,
    lastAlertAt: null,
    lastStatus: null,
    lastProbeError: null,
    totalAlertsFired: 0,
    totalRecoveriesFired: 0,
  };
}

export function getHealthWatchdogState(): HealthWatchdogState {
  return { ...currentState };
}

/**
 * Reset the in-memory state. Production code never calls this — it exists
 * so test files can isolate ticks without bleed-through between cases.
 */
export function resetHealthWatchdogStateForTests(): void {
  currentState = freshState();
}

const MAX_PROBE_ERR_LEN = 500;
function truncate(msg: string): string {
  return msg.length > MAX_PROBE_ERR_LEN
    ? msg.slice(0, MAX_PROBE_ERR_LEN) + "…"
    : msg;
}

export interface TickHealthWatchdogOptions {
  config?: HealthWatchdogConfig;
  /** Override "now" for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
  /**
   * Injection seam: by default we call the real buildHealthReport(), but
   * tests stub it out so they don't have to drive the underlying DB into
   * the various failure modes.
   */
  buildReport?: () => Promise<HealthReport>;
  /**
   * Injection seam: by default we call the real notifyOperator. Tests
   * capture the dispatched alerts here so we don't have to read
   * operator_alerts back out.
   */
  notify?: (
    alert: Parameters<typeof notifyOperator>[0],
  ) => Promise<OperatorAlertResult>;
}

export type TickOutcome =
  | "ok"
  | "degraded_under_threshold"
  | "degraded_alerted"
  | "degraded_already_alerted"
  | "recovered"
  | "ok_no_episode"
  | "probe_error_under_threshold"
  | "probe_error_alerted"
  | "probe_error_already_alerted";

export interface TickHealthWatchdogResult {
  outcome: TickOutcome;
  /** Snapshot of state AFTER this tick. */
  state: HealthWatchdogState;
  /** The report observed this tick, or null when the probe itself threw. */
  report: HealthReport | null;
  /** Operator-alert id if a page was dispatched this tick; null otherwise. */
  alertId: number | null;
}

/**
 * Run one tick: probe /health, update state, and decide whether to dispatch
 * an "outage opened" or "recovered" operator alert.
 *
 * Exported so tests (and a future admin "run watchdog now" button) can drive
 * single ticks without waiting for the timer.
 */
export async function tickHealthWatchdog(
  options: TickHealthWatchdogOptions = {},
): Promise<TickHealthWatchdogResult> {
  const config = options.config ?? resolveHealthWatchdogConfig();
  const now = options.now ?? new Date();
  const buildReport = options.buildReport ?? buildHealthReport;
  const notify = options.notify ?? notifyOperator;
  const thresholdMs = config.thresholdMinutes * 60_000;

  // ---- Probe ---------------------------------------------------------------
  let report: HealthReport | null = null;
  let probeError: string | null = null;
  try {
    report = await buildReport();
  } catch (err) {
    probeError = truncate(
      err instanceof Error ? err.message || err.name : String(err),
    );
    console.error(
      "[health-watchdog] buildHealthReport threw — treating as degraded",
      err,
    );
  }

  // A probe that threw is itself a "degraded" signal — we cannot tell the
  // server is fine if the probe fails. We synthesise a degraded report-shape
  // for the rest of the code path, but track lastStatus separately so the
  // admin surface can distinguish "probe failed" from "probe says degraded".
  const isOk = report !== null && report.status === "ok";
  const observedStatus: "ok" | "degraded" | "probe_error" =
    report === null ? "probe_error" : report.status === "ok" ? "ok" : "degraded";

  // ---- Recovery path -------------------------------------------------------
  if (isOk) {
    const wasInDegradedEpisode = currentState.degradedSince !== null;
    const wasAlerted = currentState.alertFired;
    const episodeStart = currentState.degradedSince;
    const episodeMs =
      wasInDegradedEpisode && episodeStart
        ? now.getTime() - episodeStart.getTime()
        : 0;

    // Reset state immediately — even if the recovery dispatch fails below
    // (e.g. webhook outage), the next degraded tick should be evaluated
    // fresh instead of being treated as an extension of the closed episode.
    currentState = {
      ...currentState,
      degradedSince: null,
      alertFired: false,
      lastStatus: "ok",
      lastProbeError: null,
    };

    if (!wasInDegradedEpisode) {
      return {
        outcome: "ok_no_episode",
        state: getHealthWatchdogState(),
        report,
        alertId: null,
      };
    }

    if (!wasAlerted) {
      // Episode never crossed the page-the-operator threshold. Don't bother
      // sending a "recovery" alert — operators were never told about the
      // outage in the first place, so a recovery row would just be noise.
      console.log(
        `[health-watchdog] degraded episode closed without paging ` +
          `(durationMs=${episodeMs}, threshold=${thresholdMs}ms)`,
      );
      return {
        outcome: "recovered",
        state: getHealthWatchdogState(),
        report,
        alertId: null,
      };
    }

    // Alerted episode closed — page a recovery row so the operator sees
    // the outage ended.
    let alertId: number | null = null;
    try {
      const result = await notify({
        source: HEALTH_WATCHDOG_SOURCE,
        severity: "info",
        title: "/health recovered after sustained degraded period",
        details: {
          status: "recovered",
          episodeStartedAt: episodeStart?.toISOString() ?? null,
          recoveredAt: now.toISOString(),
          episodeDurationMinutes: Math.round(episodeMs / 60_000),
          thresholdMinutes: config.thresholdMinutes,
          checks: report?.checks.map((c) => ({
            name: c.name,
            status: c.status,
          })) ?? [],
        },
      });
      alertId = result?.alertId ?? null;
    } catch (alertErr) {
      console.error(
        "[health-watchdog] failed to dispatch recovery alert",
        alertErr,
      );
    }
    currentState = {
      ...currentState,
      totalRecoveriesFired: currentState.totalRecoveriesFired + 1,
      lastAlertAt: now,
    };
    return {
      outcome: "recovered",
      state: getHealthWatchdogState(),
      report,
      alertId,
    };
  }

  // ---- Degraded / probe-error path -----------------------------------------
  // Either the report came back degraded OR the probe itself threw. Both
  // count toward the staleness clock — a /health endpoint that throws on
  // every probe is just as worth paging about as one that returns degraded.
  const previouslyDegraded = currentState.degradedSince !== null;
  const degradedSince = currentState.degradedSince ?? now;
  const ageMs = now.getTime() - degradedSince.getTime();

  currentState = {
    ...currentState,
    degradedSince,
    lastStatus: observedStatus,
    lastProbeError: probeError,
  };

  // Under-threshold: just track and move on. We deliberately do NOT
  // log every degraded tick — at a 60s cadence that would be 60 noisy
  // lines per hour for the duration of any outage.
  if (ageMs < thresholdMs) {
    if (!previouslyDegraded) {
      console.warn(
        `[health-watchdog] /health entered degraded state ` +
          `(threshold=${config.thresholdMinutes}m before paging, ` +
          `observed=${observedStatus})`,
      );
    }
    return {
      outcome:
        observedStatus === "probe_error"
          ? "probe_error_under_threshold"
          : "degraded_under_threshold",
      state: getHealthWatchdogState(),
      report,
      alertId: null,
    };
  }

  // Over threshold. If we've already paged for this episode, do nothing —
  // debounce so a 24h outage produces one alert, not one per tick.
  if (currentState.alertFired) {
    return {
      outcome:
        observedStatus === "probe_error"
          ? "probe_error_already_alerted"
          : "degraded_already_alerted",
      state: getHealthWatchdogState(),
      report,
      alertId: null,
    };
  }

  // First page for this episode. Mark alertFired BEFORE the dispatch so a
  // throwing notify() does not let us re-page on the next tick.
  currentState = {
    ...currentState,
    alertFired: true,
    totalAlertsFired: currentState.totalAlertsFired + 1,
    lastAlertAt: now,
  };

  let alertId: number | null = null;
  try {
    const failingChecks =
      report?.checks
        .filter((c) => c.status !== "ok")
        .map((c) => ({
          name: c.name,
          status: c.status,
          detail: c.detail,
          ageMs: c.ageMs ?? null,
          thresholdMs: c.thresholdMs ?? null,
        })) ?? [];
    const result = await notify({
      source: HEALTH_WATCHDOG_SOURCE,
      severity: "alert",
      title:
        observedStatus === "probe_error"
          ? "/health probe has been failing for longer than the threshold"
          : "/health has been degraded for longer than the threshold",
      details: {
        status: observedStatus,
        degradedSince: degradedSince.toISOString(),
        ageMinutes: Math.round(ageMs / 60_000),
        thresholdMinutes: config.thresholdMinutes,
        probeIntervalSeconds: config.probeIntervalSeconds,
        failingChecks,
        probeError,
        hint:
          "An external uptime monitor would have flagged this by now. " +
          "Investigate database connectivity and the daily cron freshness reported above.",
      },
    });
    alertId = result?.alertId ?? null;
  } catch (alertErr) {
    console.error(
      "[health-watchdog] failed to dispatch degraded alert",
      alertErr,
    );
  }

  return {
    outcome:
      observedStatus === "probe_error"
        ? "probe_error_alerted"
        : "degraded_alerted",
    state: getHealthWatchdogState(),
    report,
    alertId,
  };
}

let intervalHandle: NodeJS.Timeout | null = null;

/**
 * Start the periodic watchdog loop. Idempotent — calling twice is a no-op
 * (the second call logs and returns the existing config). Exported so the
 * cron wiring in `server/index.ts` and test harnesses can both invoke it.
 */
export function startHealthWatchdog(
  config: HealthWatchdogConfig = resolveHealthWatchdogConfig(),
): { config: HealthWatchdogConfig; alreadyRunning: boolean } {
  if (intervalHandle) {
    console.log(
      "[health-watchdog] already running; ignoring duplicate start",
    );
    return { config, alreadyRunning: true };
  }
  // Reset state on (re)start so a leftover module-level counter from a
  // prior process incarnation can't leak into this one in tests.
  currentState = freshState();
  intervalHandle = setInterval(() => {
    void tickHealthWatchdog({ config }).catch((err) => {
      // tickHealthWatchdog already swallows expected errors; this is a
      // defensive catch for an unexpected throw (e.g. the alerter itself).
      console.error("[health-watchdog] unexpected tick error", err);
    });
  }, config.probeIntervalSeconds * 1000);
  console.log(
    `[health-watchdog] started: probeIntervalSeconds=${config.probeIntervalSeconds}, ` +
      `thresholdMinutes=${config.thresholdMinutes}`,
  );
  return { config, alreadyRunning: false };
}

/** Stop the loop. Used by tests; no production caller stops the watcher. */
export function stopHealthWatchdog(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
