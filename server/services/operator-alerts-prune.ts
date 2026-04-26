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

import { lt } from "drizzle-orm";
import { db } from "../db";
import { operatorAlerts, operatorAlertPruneRuns } from "@shared/schema";
import { log } from "../vite";

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

  // Task #59: persist a small audit row so the admin UI can show recent
  // prune outcomes without operators having to grep server logs. We log
  // failures but do NOT throw — the prune itself succeeded; failing to
  // record the bookkeeping row should not surface as a failed retention
  // run to the cron caller.
  try {
    await db.insert(operatorAlertPruneRuns).values({
      startedAt: new Date(startedAt),
      retentionDays,
      cutoff,
      deleted,
      durationMs,
    });
  } catch (e) {
    console.error(
      "[operator-alerts-prune] failed to persist prune run history",
      e,
    );
  }

  log(
    `[operator-alerts-prune] deleted ${result.deleted} row(s) older than ` +
      `${result.cutoffIso} (retention=${retentionDays}d) in ${durationMs}ms`,
  );

  return result;
}
