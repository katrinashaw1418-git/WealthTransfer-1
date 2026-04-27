// =============================================================================
// TASK #144 — /health probe
// =============================================================================
// Single source of truth for "is this server healthy enough that an external
// uptime monitor should consider it up?". We probe four things, in this
// order, and short-circuit nothing — we always return ALL check results so
// the operator sees the full picture even when one check fails:
//
//   1. database_connectivity     — `SELECT 1` round-trip
//   2. fee_accruals              — daily fee accrual cron ran within freshness
//   3. wallet_ledger_recon       — daily wallet/ledger recon cron ran within freshness
//   4. operator_alerts_prune     — daily operator-alert prune ran within freshness
//
// The cron jobs each write one row per invocation to `background_job_runs`
// (Task #79), so freshness reduces to "MAX(started_at) WHERE job_name=…
// AND status='success'". Reading that table is cheap (composite index on
// jobName, startedAt) and the same source of truth the admin Background
// Jobs page already uses.
//
// Freshness windows are intentionally generous (36h for daily jobs) — the
// task spec asked for the "expected freshness window", and our daily jobs
// can legitimately drift several hours due to startup stagger + retry
// after one bad day. A 503 from /health should mean "something is genuinely
// wrong", not "the cron ran 25 hours ago instead of 24".
// =============================================================================

import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  recordSuccessfulHealthProbe,
  getLastSuccessfulHealthProbeAt,
} from "./error-log";

export type HealthCheckStatus = "ok" | "fail" | "skip";

export interface HealthCheckResult {
  name: string;
  status: HealthCheckStatus;
  /** Freshness window in ms used for this check, when applicable. */
  thresholdMs?: number;
  /** Wall-clock age of the most recent signal, when applicable. */
  ageMs?: number | null;
  /** ISO timestamp the most recent signal arrived, when applicable. */
  lastSuccessAt?: string | null;
  /** Short human-readable detail; surfaced verbatim in the JSON payload. */
  detail?: string;
}

export interface HealthReport {
  status: "ok" | "degraded";
  generatedAt: string;
  /** Wall-clock duration of the entire probe, for slow-DB diagnostics. */
  durationMs: number;
  checks: HealthCheckResult[];
  lastSuccessfulProbeAt: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Freshness window for any daily cron — 1.5x the cadence covers retry slop. */
export const DAILY_JOB_FRESHNESS_MS = 36 * 60 * 60 * 1000;

/** Round-trip the DB so we don't blindly trust the pool's internal cache. */
async function checkDatabase(now: Date): Promise<HealthCheckResult> {
  try {
    // `SELECT 1` is the lowest-cost connectivity probe and surfaces a real
    // network/auth issue (vs. "the pool says it's fine but every query
    // hangs"). 5s deadline is generous — anything slower IS a problem.
    const start = Date.now();
    await Promise.race([
      db.execute(sql`SELECT 1 AS ok`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("db_probe_timeout")), 5000),
      ),
    ]);
    const elapsed = Date.now() - start;
    return {
      name: "database_connectivity",
      status: "ok",
      detail: `SELECT 1 round-trip ${elapsed}ms`,
    };
  } catch (err) {
    return {
      name: "database_connectivity",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

interface JobFreshnessRow {
  startedAt: Date | string | null;
}

async function getMostRecentSuccessAt(
  jobName: string,
): Promise<Date | null> {
  // Defensive against the two driver shapes Drizzle's neon-serverless uses
  // (object with .rows / direct array). We mirror the helper used in
  // background-jobs.ts to stay consistent.
  const result = await db.execute(sql`
    SELECT started_at AS "startedAt"
    FROM background_job_runs
    WHERE job_name = ${jobName} AND status = 'success'
    ORDER BY started_at DESC
    LIMIT 1
  `);
  const rows: JobFreshnessRow[] = (() => {
    const r = result as { rows?: unknown };
    if (r && Array.isArray(r.rows)) return r.rows as JobFreshnessRow[];
    if (Array.isArray(result)) return result as JobFreshnessRow[];
    return [];
  })();
  if (rows.length === 0 || !rows[0].startedAt) return null;
  return new Date(rows[0].startedAt);
}

async function checkJobFreshness(
  name: string,
  jobName: string,
  now: Date,
  thresholdMs: number,
): Promise<HealthCheckResult> {
  try {
    const last = await getMostRecentSuccessAt(jobName);
    if (last === null) {
      // No success row yet — that is genuinely "not healthy" because every
      // daily cron self-fires on boot via setTimeout, so a fresh server
      // SHOULD have at least one success after the longest stagger (~6 min).
      // We do NOT distinguish "never ran" from "stale" in /health: both
      // mean a downstream invariant might be drifting unobserved.
      return {
        name,
        status: "fail",
        thresholdMs,
        ageMs: null,
        lastSuccessAt: null,
        detail: "no successful run recorded",
      };
    }
    const ageMs = now.getTime() - last.getTime();
    return {
      name,
      status: ageMs <= thresholdMs ? "ok" : "fail",
      thresholdMs,
      ageMs,
      lastSuccessAt: last.toISOString(),
      detail:
        ageMs <= thresholdMs
          ? `last success ${Math.round(ageMs / 60_000)}m ago`
          : `last success ${Math.round(ageMs / 60_000)}m ago (over ${Math.round(thresholdMs / 3_600_000)}h threshold)`,
    };
  } catch (err) {
    // A DB read failure here is itself a health signal — surface it as
    // 'fail' for the named job rather than crashing the whole probe.
    return {
      name,
      status: "fail",
      thresholdMs,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build the structured health report. The HTTP status code (200 vs 503) is
 * the caller's responsibility — see the route handler in `server/index.ts`.
 *
 * The entire probe is wrapped so any unexpected throw becomes a 'degraded'
 * report rather than a 500 — uptime monitors must always get a structured
 * response they can parse.
 */
export async function buildHealthReport(): Promise<HealthReport> {
  const startedAt = Date.now();
  const now = new Date();

  // Run the four checks in parallel — they're independent and the DB pool
  // has plenty of slack for four concurrent SELECTs.
  const checks = await Promise.all([
    checkDatabase(now),
    checkJobFreshness(
      "fee_accruals",
      "fee-accruals",
      now,
      DAILY_JOB_FRESHNESS_MS,
    ),
    checkJobFreshness(
      "wallet_ledger_reconciliation",
      "wallet-ledger-reconciliation",
      now,
      DAILY_JOB_FRESHNESS_MS,
    ),
    checkJobFreshness(
      "operator_alerts_prune",
      "operator-alerts-prune",
      now,
      DAILY_JOB_FRESHNESS_MS,
    ),
  ]);

  const overall = checks.every((c) => c.status === "ok") ? "ok" : "degraded";

  // Only successful probes refresh the "last successful health probe"
  // signal — a degraded probe is exactly what we DON'T want to count.
  if (overall === "ok") {
    recordSuccessfulHealthProbe();
  }

  return {
    status: overall,
    generatedAt: now.toISOString(),
    durationMs: Date.now() - startedAt,
    checks,
    lastSuccessfulProbeAt: (() => {
      const t = getLastSuccessfulHealthProbeAt();
      return t ? new Date(t).toISOString() : null;
    })(),
  };
}
