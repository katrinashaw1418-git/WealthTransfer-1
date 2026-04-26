// =============================================================================
// OPERATOR ALERTS — Retention prune (Task #44)
// =============================================================================
// The `operator_alerts` table receives one row per dispatched alert. With the
// daily wallet ↔ ledger reconciliation potentially firing many rows per drift
// event, the table grows unbounded if nothing prunes it. This module deletes
// rows older than a configurable retention window so the audit trail stays
// useful without becoming the largest table in the database.
//
// Design rules:
//   1. Retention is configurable via the `OPERATOR_ALERT_RETENTION_DAYS` env
//      var, falling back to `DEFAULT_RETENTION_DAYS` (180). A non-positive or
//      non-numeric value is rejected (we log and use the default) so a typo
//      cannot silently disable the prune or, worse, delete everything.
//   2. The prune is a single DELETE bounded by `created_at < cutoff`, served
//      by the existing `operator_alerts_created_at_idx` index. No row-by-row
//      iteration, no per-row triggers — this stays cheap even on big tables.
//   3. Outcomes are logged on stdout (deleted count, cutoff timestamp,
//      duration). We deliberately do NOT call `notifyOperator` for routine
//      prunes — that would write a new row each day to the very table we are
//      trying to bound, defeating the purpose. Errors ARE logged loudly via
//      `console.error` so a broken prune is visible in the log stream.
//   4. The function is safe to call concurrently with `notifyOperator`: the
//      DELETE only affects rows older than the cutoff, while inserts are for
//      `now()`, so the two cannot conflict on the same row.
// =============================================================================

import { desc, eq, lt } from "drizzle-orm";
import { db } from "../db";
import {
  operatorAlertPruneRuns,
  operatorAlerts,
  type InsertOperatorAlertPruneRun,
} from "@shared/schema";
import { log } from "../vite";
import { notifyOperator, type OperatorAlertResult } from "./operator-alerts";

export const DEFAULT_RETENTION_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the retention window in days from the environment, with the
 * default as a safety net. Invalid values (non-numeric, <= 0, NaN) fall
 * back to the default and emit a warning so the misconfiguration is
 * observable.
 */
export function getRetentionDays(): number {
  const raw = process.env.OPERATOR_ALERT_RETENTION_DAYS;
  if (raw === undefined || raw === null || raw.trim() === "") {
    return DEFAULT_RETENTION_DAYS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[operator-alerts-prune] OPERATOR_ALERT_RETENTION_DAYS=${raw} is not a positive integer; ` +
        `falling back to default ${DEFAULT_RETENTION_DAYS}`,
    );
    return DEFAULT_RETENTION_DAYS;
  }
  return parsed;
}

export interface PruneOperatorAlertsOptions {
  /** Override the retention window. Defaults to `getRetentionDays()`. */
  retentionDays?: number;
  /** Override "now" for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
}

export interface PruneOperatorAlertsResult {
  retentionDays: number;
  /** ISO timestamp of the inclusive lower bound that was kept. */
  cutoffIso: string;
  deleted: number;
  durationMs: number;
}

/**
 * Delete `operator_alerts` rows older than the retention window. Returns a
 * structured summary (also logged) so callers — and tests — can assert what
 * happened.
 */
export async function pruneOperatorAlerts(
  options: PruneOperatorAlertsOptions = {},
): Promise<PruneOperatorAlertsResult> {
  const retentionDays = options.retentionDays ?? getRetentionDays();
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    // Defensive: getRetentionDays already guards env-var input, but a caller
    // could pass garbage explicitly. Refuse rather than risk a runaway
    // delete (e.g. retentionDays = 0 would delete everything not in the
    // future).
    throw new Error(
      `pruneOperatorAlerts: retentionDays must be a positive integer (got ${retentionDays})`,
    );
  }

  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);

  const startedAt = Date.now();
  // Use the driver's affected-row count (rowCount) rather than `.returning()`
  // so a long-overdue first run does not have to materialise every deleted
  // row id in Postgres + Node memory. For a retention job whose whole point
  // is to handle large backlogs, that would be the wrong execution shape.
  const deleteResult = await db
    .delete(operatorAlerts)
    .where(lt(operatorAlerts.createdAt, cutoff));
  const durationMs = Date.now() - startedAt;

  // pg / neon-serverless drivers expose `rowCount` on the result object; it
  // can be `null` for statements where the count is unknown, in which case
  // we report 0 rather than crash. Cast through `unknown` because Drizzle's
  // generic delete-builder return type does not surface this field.
  const deleted = (deleteResult as unknown as { rowCount: number | null })
    .rowCount ?? 0;

  const result: PruneOperatorAlertsResult = {
    retentionDays,
    cutoffIso: cutoff.toISOString(),
    deleted,
    durationMs,
  };

  // NOTE on audit recording: persistence to `operator_alert_prune_runs` is
  // performed by `pruneOperatorAlertsAndRecord` (Task #60) — the cron in
  // `server/index.ts` calls the wrapper, not this bare function. Recording
  // here would produce duplicate success rows on every cron tick. Direct
  // callers (currently: this file's tests) are intentionally not recorded.

  log(
    `[operator-alerts-prune] deleted ${result.deleted} row(s) older than ` +
      `${result.cutoffIso} (retention=${retentionDays}d) in ${durationMs}ms`,
  );

  return result;
}

// =============================================================================
// TASK #60 — Stalled-prune watchdog
// =============================================================================
// `pruneOperatorAlerts` is the worker; the rest of this file is the
// observability layer that lets a separate watchdog detect when the worker
// has stopped running.
//
// Architecture:
//   * `pruneOperatorAlertsAndRecord` wraps the worker and writes one row to
//     `operator_alert_prune_runs` per attempt — success rows carry the
//     prune metadata; failure rows carry the truncated error message. The
//     recording write is in its own try/catch so a DB hiccup at recording
//     time cannot mask a successful prune (we still surface a console
//     error so the missing audit row is observable).
//   * `checkOperatorAlertsPruneFreshness` is the actual watchdog. It is
//     deliberately INDEPENDENT of `pruneOperatorAlerts` — it only reads
//     from `operator_alert_prune_runs` and dispatches via `notifyOperator`.
//     A broken prune (the very thing we are trying to detect) cannot
//     prevent the watchdog from firing.
// =============================================================================

const PRUNE_INTERVAL_DAYS = 1;
/**
 * "More than 2× the expected interval" — the prune is scheduled daily, so
 * 48h is the threshold beyond which we page operators. Exposed so tests
 * (and a future operator override) can address it by name rather than
 * hard-coding the magic number in two places.
 */
export const DEFAULT_STALE_THRESHOLD_MS =
  2 * PRUNE_INTERVAL_DAYS * DAY_MS;

const MAX_RECORD_ERROR_LEN = 500;
function truncateForRecord(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message || err.name || "unknown error"
      : typeof err === "string"
        ? err
        : (() => {
            try {
              return JSON.stringify(err);
            } catch {
              return String(err);
            }
          })();
  return raw.length > MAX_RECORD_ERROR_LEN
    ? raw.slice(0, MAX_RECORD_ERROR_LEN) + "…"
    : raw;
}

export interface PruneRunRecord {
  id: number | null;
  status: "success" | "error";
}

/**
 * Insert one `operator_alert_prune_runs` row capturing the outcome of a
 * single prune attempt. Wrapped in its own try/catch: an audit-trail
 * write failure is logged loudly but never re-thrown — the calling cron
 * has already observed the prune itself, and we do not want a recording
 * outage to look like a prune outage to the watchdog.
 */
async function insertPruneRun(
  row: InsertOperatorAlertPruneRun,
): Promise<number | null> {
  try {
    const inserted = await db
      .insert(operatorAlertPruneRuns)
      .values(row)
      .returning({ id: operatorAlertPruneRuns.id });
    return inserted[0]?.id ?? null;
  } catch (err) {
    console.error(
      "[operator-alerts-prune] failed to record prune run",
      (err as Error)?.message ?? err,
    );
    return null;
  }
}

export interface PruneAndRecordResult {
  /** The prune outcome on success; null if the prune threw. */
  prune: PruneOperatorAlertsResult | null;
  /** The audit-trail row id, or null if recording failed. */
  recordId: number | null;
  /** Whether the underlying prune call completed successfully. */
  success: boolean;
  /** Truncated error message when success=false. */
  errorMessage?: string;
}

/**
 * Wrapper around `pruneOperatorAlerts` that records the outcome (success
 * or failure) to `operator_alert_prune_runs`. The watchdog reads that
 * table to detect a stalled prune, so this wrapper — not the bare
 * `pruneOperatorAlerts` — is what the daily cron in `server/index.ts`
 * invokes.
 *
 * Re-throws prune failures after recording them, preserving the
 * fire-and-forget contract the caller already had: the cron's existing
 * try/catch catches the throw and logs it, while the freshly inserted
 * 'error' row makes the failure visible to investigators reading the
 * admin viewer.
 */
export async function pruneOperatorAlertsAndRecord(
  options: PruneOperatorAlertsOptions = {},
): Promise<PruneAndRecordResult> {
  const startedAt = new Date();
  try {
    const prune = await pruneOperatorAlerts(options);
    const recordId = await insertPruneRun({
      finishedAt: new Date(),
      status: "success",
      retentionDays: prune.retentionDays,
      cutoff: new Date(prune.cutoffIso),
      deleted: prune.deleted,
      durationMs: prune.durationMs,
      errorMessage: null,
    });
    return { prune, recordId, success: true };
  } catch (err) {
    const errorMessage = truncateForRecord(err);
    // Best-effort record; ignored return value because we re-throw the
    // original error in any case (the cron's try/catch is the authoritative
    // failure handler).
    await insertPruneRun({
      finishedAt: new Date(),
      status: "error",
      // We don't know the resolved retentionDays if the throw happened
      // inside `getRetentionDays`/the validator; capture what we can.
      retentionDays: options.retentionDays ?? null,
      cutoff: null,
      deleted: null,
      durationMs: Date.now() - startedAt.getTime(),
      errorMessage,
    });
    // Re-throw so the cron's existing try/catch logs it — recording is
    // an addition, not a replacement, for the caller's error handling.
    throw err;
  }
}

export interface CheckPruneFreshnessOptions {
  /** Override the staleness threshold. Defaults to DEFAULT_STALE_THRESHOLD_MS. */
  staleThresholdMs?: number;
  /** Override "now" for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
  /**
   * Override the server uptime (ms) used to suppress alerts on a brand-new
   * deploy that has not yet had a chance to run the prune. Defaults to
   * `process.uptime() * 1000`. The watchdog only fires on an empty audit
   * table when uptime exceeds the staleness threshold — that way a newly
   * started server with no history is not paged as "stalled".
   */
  serverUptimeMs?: number;
  /**
   * Injection seam for tests. Defaults to the real `notifyOperator`.
   * Returning a falsy value short-circuits the audit-trail row id we
   * report back to the caller (we still consider the alert fired).
   */
  notify?: (alert: Parameters<typeof notifyOperator>[0]) => Promise<OperatorAlertResult>;
}

export type PruneFreshnessReason =
  | "fresh"
  | "stale"
  | "never-run"
  | "warming-up";

export interface PruneFreshnessResult {
  /** True if the watchdog dispatched a notifyOperator alert this call. */
  fired: boolean;
  reason: PruneFreshnessReason;
  /** Most recent successful run's startedAt, or null if none recorded. */
  mostRecentSuccessAt: Date | null;
  /** Age in ms of the most recent successful run, or null if none. */
  ageMs: number | null;
  /** Threshold (ms) used for the comparison. */
  thresholdMs: number;
  /** notifyOperator's row id when fired=true; null otherwise (or on persist failure). */
  alertId: number | null;
}

/**
 * Most recent SUCCESSFUL prune run, or null if no success has ever been
 * recorded. Failures are deliberately ignored — a long streak of error
 * rows must be visible to the watchdog as "no successful prune".
 */
export async function getMostRecentSuccessfulPruneRun(): Promise<
  { id: number; startedAt: Date } | null
> {
  const [row] = await db
    .select({
      id: operatorAlertPruneRuns.id,
      startedAt: operatorAlertPruneRuns.startedAt,
    })
    .from(operatorAlertPruneRuns)
    .where(eq(operatorAlertPruneRuns.status, "success"))
    .orderBy(desc(operatorAlertPruneRuns.startedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Watchdog: checks whether a successful prune has been recorded recently
 * enough, and dispatches a `notifyOperator` warning if not.
 *
 * Read-only with respect to `operator_alert_prune_runs` — this function
 * never writes to that table, so it cannot accidentally "reset" the
 * staleness clock and silence itself.
 *
 * Independence from the prune job: the watchdog imports
 * `pruneOperatorAlerts` only as a sibling in the same module; at runtime
 * it never calls into it. A prune that throws on every tick will leave
 * `operator_alert_prune_runs` empty (or filled with 'error' rows),
 * causing this watchdog to fire after the threshold elapses.
 */
export async function checkOperatorAlertsPruneFreshness(
  options: CheckPruneFreshnessOptions = {},
): Promise<PruneFreshnessResult> {
  const thresholdMs = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    throw new Error(
      `checkOperatorAlertsPruneFreshness: staleThresholdMs must be a positive number (got ${thresholdMs})`,
    );
  }
  const now = options.now ?? new Date();
  const serverUptimeMs =
    options.serverUptimeMs ?? Math.floor(process.uptime() * 1000);
  const notify = options.notify ?? notifyOperator;

  const latest = await getMostRecentSuccessfulPruneRun();

  if (!latest) {
    // Empty audit trail. On a fresh deploy this is normal — the prune
    // simply has not had its first scheduled tick yet. We only escalate
    // if the server has been up longer than the staleness threshold,
    // because at that point "never recorded" stops being plausibly a
    // start-up race and starts being a real outage.
    if (serverUptimeMs < thresholdMs) {
      return {
        fired: false,
        reason: "warming-up",
        mostRecentSuccessAt: null,
        ageMs: null,
        thresholdMs,
        alertId: null,
      };
    }
    const result = await notify({
      source: "operator-alerts-prune-watchdog",
      severity: "warning",
      title: "Operator-alert prune has never recorded a successful run",
      details: {
        thresholdHours: Math.round(thresholdMs / (60 * 60 * 1000)),
        serverUptimeHours: Math.round(serverUptimeMs / (60 * 60 * 1000)),
        hint:
          "The daily operator-alerts retention prune has not recorded any successful run. " +
          "Check the application logs for `[operator-alerts-prune]` errors.",
      },
    });
    return {
      fired: true,
      reason: "never-run",
      mostRecentSuccessAt: null,
      ageMs: null,
      thresholdMs,
      alertId: result?.alertId ?? null,
    };
  }

  const ageMs = now.getTime() - latest.startedAt.getTime();
  if (ageMs <= thresholdMs) {
    return {
      fired: false,
      reason: "fresh",
      mostRecentSuccessAt: latest.startedAt,
      ageMs,
      thresholdMs,
      alertId: null,
    };
  }

  const result = await notify({
    source: "operator-alerts-prune-watchdog",
    severity: "warning",
    title: "Operator-alert prune has not run successfully recently",
    details: {
      mostRecentSuccessAt: latest.startedAt.toISOString(),
      ageHours: Math.round(ageMs / (60 * 60 * 1000)),
      thresholdHours: Math.round(thresholdMs / (60 * 60 * 1000)),
      hint:
        "Check the application logs for `[operator-alerts-prune]` errors and confirm the daily cron is still scheduled.",
    },
  });
  return {
    fired: true,
    reason: "stale",
    mostRecentSuccessAt: latest.startedAt,
    ageMs,
    thresholdMs,
    alertId: result?.alertId ?? null,
  };
}
