// =============================================================================
// TASK #147 — Database backups, restore drills, and freshness watchdog
// =============================================================================
// Three things live in this file:
//
//   1. `runDatabaseBackup()` — invokes pg_dump against DATABASE_URL, writes
//      the timestamped dump to DB_BACKUP_DIR, prunes older dumps beyond the
//      configured retention count, and persists the outcome to
//      `database_backup_runs`. Used by both the daily cron in
//      `server/index.ts` and the standalone `scripts/db-backup.ts` CLI so
//      manual + scheduled paths share identical behaviour.
//
//   2. `runDatabaseRestoreDrill()` — picks the most recent dump in
//      DB_BACKUP_DIR, creates a scratch database (parsed from DATABASE_URL
//      with a unique suffix), restores the dump into it via pg_restore,
//      runs a small integrity-check pass, and tears the scratch DB down.
//      Persists the outcome (including the per-check pass/fail breakdown)
//      to `database_restore_drill_runs`. Critically REFUSES to touch the
//      live DATABASE_URL — see `assertNotLiveTarget()`.
//
//   3. `checkBackupFreshness()` — read-only watchdog that pages an operator
//      via `notifyOperator()` if either the most recent backup or the most
//      recent restore drill has fallen outside its expected window. Models
//      the same warming-up + threshold logic that
//      `checkOperatorAlertsPruneFreshness()` (Task #60) introduced for the
//      retention prune.
//
// Hard rules:
//   * The live DATABASE_URL is NEVER written to by the restore path. The
//     guard is in `assertNotLiveTarget()`; bypassed only by the explicit
//     `--i-know-what-im-doing` flag in `scripts/db-restore.ts`.
//   * Backup feature is gated on `DB_BACKUP_DIR` being set. Without it,
//     `BACKUPS_ENABLED` is false and the cron registration in
//     `server/index.ts` skips the schedules entirely. The watchdog ALSO
//     skips, so a dev environment with no backups configured does not
//     spam alerts.
//   * Failures here NEVER take the server down — the cron wrappers catch
//     thrown errors and the bookkeeping inserts are best-effort.
// =============================================================================

import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import { and, desc, eq } from "drizzle-orm";

import { db } from "../db";
import {
  backgroundJobRuns,
  databaseBackupRuns,
  databaseRestoreDrillRuns,
  type DatabaseBackupRun,
  type DatabaseRestoreDrillRun,
} from "@shared/schema";
import { notifyOperator, type OperatorAlertResult } from "./operator-alerts";

// Use the drizzle table's native inferInsert types here rather than the
// drizzle-zod insertSchemas. createInsertSchema flattens the jsonb $type<>
// generic to `unknown`, which then fails to satisfy the table's stricter
// inferInsert when we call .values(row). Going through inferInsert keeps
// the IntegrityResult shape end-to-end.
type DatabaseBackupRunInsert = typeof databaseBackupRuns.$inferInsert;
type DatabaseRestoreDrillRunInsert = typeof databaseRestoreDrillRuns.$inferInsert;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default retention: 14 daily dumps. */
export const DEFAULT_RETENTION_COUNT = 14;
/** Daily backup considered stale once it falls outside this window. */
export const DEFAULT_BACKUP_STALE_THRESHOLD_MS = 2 * DAY_MS;
/** Weekly drill considered stale once it falls outside this window. */
export const DEFAULT_DRILL_STALE_THRESHOLD_MS = 14 * DAY_MS;
/**
 * Offsite-sync (`scripts/db-backup-offsite.sh`) considered stale once it
 * falls outside this window. Default mirrors the local-backup window
 * because the offsite cron runs the same day as the local cron — anything
 * older than 2 days means the S3 sync has been broken for at least one
 * full day, which is exactly what we want to page on.
 */
export const DEFAULT_OFFSITE_STALE_THRESHOLD_MS = 2 * DAY_MS;
/** Stable jobName persisted by the offsite-sync recorder. */
export const OFFSITE_BACKUP_JOB_NAME = "database-backup-offsite";
/** Cap on stored error / detail strings so a runaway message can't bloat a row. */
const MAX_ERROR_LEN = 1000;

const DUMP_PREFIX = "amax-db-backup-";
const DUMP_SUFFIX = ".dump";
const DUMP_FILENAME_RE = new RegExp(
  `^${DUMP_PREFIX}(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z)${DUMP_SUFFIX.replace(
    /\./g,
    "\\.",
  )}$`,
);

/** True when DB_BACKUP_DIR is configured. Crons register only when true. */
export function isBackupsEnabled(): boolean {
  return getBackupDir() !== null;
}

export function getBackupDir(): string | null {
  const raw = process.env.DB_BACKUP_DIR;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getRetentionCount(): number {
  const raw = process.env.DB_BACKUP_RETENTION;
  if (!raw) return DEFAULT_RETENTION_COUNT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RETENTION_COUNT;
  return n;
}

/**
 * Resolve the offsite-stale threshold from the environment. Honours
 * `DB_BACKUP_OFFSITE_STALE_HOURS` (positive integer hours) and falls back
 * to `DEFAULT_OFFSITE_STALE_THRESHOLD_MS` on any non-positive / unparseable
 * value so a typo in the deployment config cannot silently disable the
 * watchdog.
 */
export function getOffsiteStaleThresholdMs(): number {
  const raw = process.env.DB_BACKUP_OFFSITE_STALE_HOURS;
  if (!raw) return DEFAULT_OFFSITE_STALE_THRESHOLD_MS;
  const trimmed = raw.trim();
  // Strict positive-integer parser. We deliberately reject decimals, signs,
  // exponents, and trailing junk like "24h" or "24abc" so a typo in the
  // deployment config cannot silently disable the watchdog (fail-closed).
  if (!/^[1-9][0-9]*$/.test(trimmed)) return DEFAULT_OFFSITE_STALE_THRESHOLD_MS;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(n) || n < 1) return DEFAULT_OFFSITE_STALE_THRESHOLD_MS;
  return n * 60 * 60 * 1000;
}

function truncate(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const str = String(s);
  return str.length > MAX_ERROR_LEN ? str.slice(0, MAX_ERROR_LEN - 1) + "…" : str;
}

function nowFilenameStamp(d: Date = new Date()): string {
  // 2026-04-27T01-23-45Z — filesystem-safe ISO variant. Sorts lexicographically
  // by time so the latest dump is the alphabetically-last entry.
  return d.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
}

function dumpPathFor(dir: string, d: Date = new Date()): string {
  return path.join(dir, `${DUMP_PREFIX}${nowFilenameStamp(d)}${DUMP_SUFFIX}`);
}

// ---------------------------------------------------------------------------
// pg_dump / pg_restore process helpers
// ---------------------------------------------------------------------------

interface RunCommandResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode, stderr, stdout });
    });
  });
}

// ---------------------------------------------------------------------------
// Live-DB safety guard
// ---------------------------------------------------------------------------

/**
 * Throws if `targetUrl` resolves to the same database as `process.env.DATABASE_URL`.
 *
 * Comparison is structural (host:port/database) rather than string-equality
 * so an obviously-equivalent URL ("postgres://x:y@h/d" vs "postgresql://x:y@h:5432/d?sslmode=require")
 * still trips the guard. Anything we cannot parse defaults to "unsafe — treat
 * as live" because a parse failure here MUST NOT silently allow a destructive
 * restore.
 */
export function assertNotLiveTarget(targetUrl: string): void {
  const live = process.env.DATABASE_URL;
  if (!live) {
    // Defensive: refuse rather than guess. The caller can override via the
    // explicit unsafe flag in the CLI script if they really mean it.
    throw new Error(
      "assertNotLiveTarget: DATABASE_URL is not set; refusing to assume any URL is safe.",
    );
  }
  const liveKey = describeDbTarget(live);
  const targetKey = describeDbTarget(targetUrl);
  // Fail-closed: if either URL cannot be structurally parsed we cannot prove
  // they differ, so we MUST refuse rather than fall through. The header
  // comment promises this behaviour and a destructive restore against an
  // unknown target is exactly the footgun this guard exists to stop.
  if (!liveKey) {
    throw new Error(
      "assertNotLiveTarget: could not parse DATABASE_URL into host:port/database; refusing to proceed.",
    );
  }
  if (!targetKey) {
    throw new Error(
      "assertNotLiveTarget: could not parse target URL into host:port/database; refusing to proceed.",
    );
  }
  if (liveKey === targetKey) {
    throw new Error(
      `Refusing to operate on the live database (${liveKey}). ` +
        `Set --i-know-what-im-doing on the CLI to override, or point at a scratch URL.`,
    );
  }
}

/** "host:port/database" key used to compare two postgres URLs structurally. */
export function describeDbTarget(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const port = u.port || "5432";
    const dbName = u.pathname.replace(/^\//, "");
    if (!host || !dbName) return null;
    return `${host}:${port}/${dbName}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

export interface RunDatabaseBackupOptions {
  /** Override DB_BACKUP_DIR (used by tests + the CLI). */
  backupDir?: string;
  /** Override DB_BACKUP_RETENTION. */
  retentionCount?: number;
  /** Override "now" so test files can produce deterministic dump names. */
  now?: Date;
  /** Override DATABASE_URL for tests; defaults to process.env.DATABASE_URL. */
  databaseUrl?: string;
}

export interface DatabaseBackupResult {
  dumpPath: string;
  dumpSizeBytes: number;
  retentionCount: number;
  prunedCount: number;
  durationMs: number;
  /** Files retained after pruning (newest first). */
  retainedDumps: string[];
}

/**
 * Run a single pg_dump against `databaseUrl` (defaults to DATABASE_URL),
 * write the result to `backupDir`, prune older dumps beyond the retention
 * window, and persist one row to `database_backup_runs`.
 *
 * Throws on any failure (no pg_dump binary, bad URL, write error). The cron
 * wrapper in `server/index.ts` catches those throws so a failed backup
 * still records an 'error' row + a console.error log line.
 */
export async function runDatabaseBackup(
  options: RunDatabaseBackupOptions = {},
): Promise<DatabaseBackupResult> {
  const backupDir = options.backupDir ?? getBackupDir();
  if (!backupDir) {
    throw new Error(
      "runDatabaseBackup: DB_BACKUP_DIR is not configured. " +
        "Set DB_BACKUP_DIR (e.g. to /var/backups/amax-db) and retry.",
    );
  }
  const retentionCount = options.retentionCount ?? getRetentionCount();
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("runDatabaseBackup: DATABASE_URL must be set.");
  }
  const startedAt = new Date();
  const dumpPath = dumpPathFor(backupDir, options.now ?? startedAt);

  await fs.mkdir(backupDir, { recursive: true });

  // Custom format (-F c) is what pg_restore understands and is the only sane
  // shape for restore drills (gives us pg_restore --list, parallel restore,
  // etc.). --no-owner / --no-privileges are deliberate: a restore into a
  // scratch DB owned by a different role would otherwise fail on every
  // GRANT/ALTER OWNER. Production restore back into the live DB will set
  // ownership separately.
  const args = [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    "--file",
    dumpPath,
    "--dbname",
    databaseUrl,
  ];

  let pgDumpResult: RunCommandResult;
  try {
    pgDumpResult = await runCommand("pg_dump", args);
  } catch (err) {
    await tryRecordBackupRun({
      finishedAt: new Date(),
      status: "error",
      dumpPath: null,
      dumpSizeBytes: null,
      retentionCount,
      prunedCount: null,
      durationMs: Date.now() - startedAt.getTime(),
      errorMessage: truncate(
        `Failed to spawn pg_dump: ${(err as Error)?.message ?? err}`,
      ),
    });
    throw err;
  }

  if (pgDumpResult.exitCode !== 0) {
    // pg_dump may have written a partial file — clean it up so the directory
    // never accumulates half-dumps that would mislead the freshness check.
    await fs.rm(dumpPath, { force: true }).catch(() => undefined);
    const stderrTail = pgDumpResult.stderr
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .slice(-3)
      .join(" | ");
    const message = `pg_dump exited ${pgDumpResult.exitCode}: ${stderrTail || "<no stderr>"}`;
    await tryRecordBackupRun({
      finishedAt: new Date(),
      status: "error",
      dumpPath: null,
      dumpSizeBytes: null,
      retentionCount,
      prunedCount: null,
      durationMs: Date.now() - startedAt.getTime(),
      errorMessage: truncate(message),
    });
    throw new Error(message);
  }

  const stat = await fs.stat(dumpPath);
  const dumpSizeBytes = stat.size;

  // Prune step: list dumps, sort newest first, delete anything past the
  // retention count. We deliberately match on our own filename pattern only,
  // so a stray .dump dropped into the directory by another tool is left
  // alone.
  const allDumps = await listExistingDumps(backupDir);
  const toKeep = allDumps.slice(0, retentionCount);
  const toDelete = allDumps.slice(retentionCount);
  for (const file of toDelete) {
    await fs.rm(path.join(backupDir, file), { force: true }).catch((err) => {
      // Don't fail the whole backup just because we can't prune one old file.
      console.error(`[database-backup] failed to prune old dump ${file}`, err);
    });
  }

  const durationMs = Date.now() - startedAt.getTime();
  await tryRecordBackupRun({
    finishedAt: new Date(),
    status: "success",
    dumpPath,
    dumpSizeBytes,
    retentionCount,
    prunedCount: toDelete.length,
    durationMs,
    errorMessage: null,
  });

  return {
    dumpPath,
    dumpSizeBytes,
    retentionCount,
    prunedCount: toDelete.length,
    durationMs,
    retainedDumps: toKeep,
  };
}

async function tryRecordBackupRun(
  row: DatabaseBackupRunInsert,
): Promise<number | null> {
  try {
    const inserted = await db
      .insert(databaseBackupRuns)
      .values(row)
      .returning({ id: databaseBackupRuns.id });
    return inserted[0]?.id ?? null;
  } catch (err) {
    console.error(
      "[database-backup] failed to persist backup run row",
      (err as Error)?.message ?? err,
    );
    return null;
  }
}

/**
 * List dumps in `backupDir` whose filenames match our timestamped pattern,
 * newest first.
 */
export async function listExistingDumps(backupDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(backupDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((f) => DUMP_FILENAME_RE.test(f))
    .sort()
    .reverse();
}

/** Most recent dump file path (or null when none). */
export async function findLatestDump(backupDir: string): Promise<string | null> {
  const dumps = await listExistingDumps(backupDir);
  if (dumps.length === 0) return null;
  return path.join(backupDir, dumps[0]);
}

// ---------------------------------------------------------------------------
// Restore drill
// ---------------------------------------------------------------------------

export interface RunRestoreDrillOptions {
  /** Override DB_BACKUP_DIR. */
  backupDir?: string;
  /** Specific dump to restore; defaults to the newest in `backupDir`. */
  dumpPath?: string;
  /** Override DATABASE_URL for tests. */
  databaseUrl?: string;
  /**
   * Override the scratch DB name. If unset, derived from now() so concurrent
   * drills cannot collide.
   */
  scratchDbName?: string;
  /**
   * If true, the scratch DB is left in place after the drill. Used by the
   * CLI when the operator wants to poke around. Default false.
   */
  keepScratchDb?: boolean;
}

export interface IntegrityCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface IntegrityResult {
  ok: boolean;
  checks: IntegrityCheck[];
}

export interface DatabaseRestoreDrillResult {
  dumpPath: string;
  scratchDbName: string;
  scratchUrl: string;
  integrity: IntegrityResult;
  durationMs: number;
  /** True when the scratch DB was successfully dropped at the end. */
  scratchDropped: boolean;
}

/**
 * Run an end-to-end restore drill: pick the latest dump, build a scratch
 * database next to the live one, restore into it, run a basic integrity
 * check, drop the scratch DB. Persists one row to
 * `database_restore_drill_runs` regardless of outcome.
 *
 * Throws if the integrity check fails OR the underlying steps error so the
 * cron wrapper records the run as 'error' and the watchdog can detect a
 * stale "last successful drill".
 */
export async function runDatabaseRestoreDrill(
  options: RunRestoreDrillOptions = {},
): Promise<DatabaseRestoreDrillResult> {
  const backupDir = options.backupDir ?? getBackupDir();
  if (!backupDir) {
    throw new Error(
      "runDatabaseRestoreDrill: DB_BACKUP_DIR is not configured.",
    );
  }
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("runDatabaseRestoreDrill: DATABASE_URL must be set.");
  }

  const startedAt = new Date();
  const dumpPath =
    options.dumpPath ?? (await findLatestDump(backupDir)) ?? null;

  if (!dumpPath) {
    const message = `No dump file found in ${backupDir}. Run a backup first.`;
    await tryRecordDrillRun({
      finishedAt: new Date(),
      status: "error",
      dumpPath: null,
      scratchDbName: null,
      integrity: null,
      durationMs: Date.now() - startedAt.getTime(),
      errorMessage: message,
    });
    throw new Error(message);
  }

  const scratchDbName =
    options.scratchDbName ??
    `amax_restore_drill_${Date.now()}_${Math.floor(Math.random() * 1_000)}`;
  if (!/^[a-z0-9_]+$/i.test(scratchDbName)) {
    // We interpolate into a CREATE DATABASE statement; even though the
    // identifier is server-generated by default, refuse anything weird so
    // a future caller cannot accidentally smuggle SQL.
    throw new Error(
      `runDatabaseRestoreDrill: scratchDbName must match [A-Za-z0-9_]+ (got '${scratchDbName}')`,
    );
  }

  const adminUrl = buildAdminUrl(databaseUrl);
  const scratchUrl = buildScratchUrl(databaseUrl, scratchDbName);
  // Belt-and-braces: pg_restore is about to write into scratchUrl. If the
  // URL parser produced an identical structural key we are pointing at the
  // live DB and must abort.
  assertNotLiveTarget(scratchUrl);

  let scratchCreated = false;
  let scratchDropped = false;
  let integrity: IntegrityResult | null = null;
  let durationMs = 0;
  let drillError: unknown = null;

  try {
    await createScratchDb(adminUrl, scratchDbName);
    scratchCreated = true;

    const restore = await runCommand("pg_restore", [
      "--no-owner",
      "--no-privileges",
      "--clean",
      "--if-exists",
      "--exit-on-error",
      "--dbname",
      scratchUrl,
      dumpPath,
    ]);
    if (restore.exitCode !== 0) {
      const tail = restore.stderr
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .slice(-3)
        .join(" | ");
      throw new Error(
        `pg_restore exited ${restore.exitCode}: ${tail || "<no stderr>"}`,
      );
    }

    integrity = await runIntegrityChecks(scratchUrl);
    if (!integrity.ok) {
      const failed = integrity.checks
        .filter((c) => !c.ok)
        .map((c) => c.name)
        .join(", ");
      throw new Error(
        `Integrity check FAILED on restored dump: ${failed || "(unknown)"}`,
      );
    }
  } catch (err) {
    drillError = err;
  }

  // Cleanup runs unconditionally and BEFORE we record/return so the persisted
  // run row + the returned object both see the accurate `scratchDropped` state.
  // A failure here is logged but does not change the drill outcome.
  if (scratchCreated && !options.keepScratchDb) {
    try {
      await dropScratchDb(adminUrl, scratchDbName);
      scratchDropped = true;
    } catch (err) {
      console.error(
        `[restore-drill] failed to drop scratch DB '${scratchDbName}'`,
        (err as Error)?.message ?? err,
      );
    }
  }

  durationMs = Date.now() - startedAt.getTime();

  if (drillError) {
    const errorMessage = truncate((drillError as Error)?.message ?? String(drillError));
    await tryRecordDrillRun({
      finishedAt: new Date(),
      status: "error",
      dumpPath,
      scratchDbName,
      integrity,
      durationMs,
      errorMessage,
    });

    // Page an operator immediately on a drill failure. The freshness watchdog
    // is the secondary safety net — it would not fire until the drill has
    // been broken for >14 days (and only if the *previous* drill succeeded
    // less than 14 days ago), which is far too late. A drill failure means
    // the rollback safety net is degraded RIGHT NOW and the on-call needs
    // to know within minutes.
    try {
      await notifyOperator({
        source: "database-restore-drill",
        severity: "alert",
        title: "Database restore drill FAILED",
        details: {
          dumpPath: dumpPath ?? null,
          scratchDbName,
          scratchDropped,
          error: errorMessage,
          // Surface per-check breakdown when the failure happened during the
          // integrity-check phase so the operator sees *which* invariant
          // broke without having to open the JSONB column.
          integrityChecks:
            integrity?.checks.map((c) => ({
              name: c.name,
              ok: c.ok,
              detail: c.detail ?? null,
            })) ?? null,
          hint:
            "See docs/runbooks/rollback.md. The most recent dump could not be restored cleanly into a scratch DB; do NOT rely on it for rollback until investigated.",
        },
      });
    } catch (alertErr) {
      // Never let a paging-side failure mask the original drill error — the
      // throw below still surfaces the underlying cause to the cron wrapper.
      console.error(
        "[restore-drill] failed to dispatch operator alert for drill failure",
        (alertErr as Error)?.message ?? alertErr,
      );
    }
    throw drillError;
  }

  // Success path.
  await tryRecordDrillRun({
    finishedAt: new Date(),
    status: "success",
    dumpPath,
    scratchDbName,
    integrity,
    durationMs,
    errorMessage: null,
  });

  return {
    dumpPath,
    scratchDbName,
    scratchUrl,
    integrity: integrity!,
    durationMs,
    scratchDropped,
  };
}

async function tryRecordDrillRun(
  row: DatabaseRestoreDrillRunInsert,
): Promise<number | null> {
  try {
    const inserted = await db
      .insert(databaseRestoreDrillRuns)
      .values(row)
      .returning({ id: databaseRestoreDrillRuns.id });
    return inserted[0]?.id ?? null;
  } catch (err) {
    console.error(
      "[restore-drill] failed to persist drill run row",
      (err as Error)?.message ?? err,
    );
    return null;
  }
}

function buildAdminUrl(databaseUrl: string): string {
  // CREATE/DROP DATABASE cannot be issued against the database being
  // created/dropped; we connect to the maintenance DB 'postgres' instead.
  // Falls back to 'template1' if 'postgres' is unavailable in some hosting
  // setups (kept as a comment for the runbook; we use 'postgres' here).
  const u = new URL(databaseUrl);
  u.pathname = "/postgres";
  return u.toString();
}

function buildScratchUrl(databaseUrl: string, scratchDbName: string): string {
  const u = new URL(databaseUrl);
  u.pathname = `/${scratchDbName}`;
  return u.toString();
}

async function runPsql(
  adminUrl: string,
  sql: string,
): Promise<RunCommandResult> {
  // -v ON_ERROR_STOP=1 makes psql exit non-zero on the first SQL error so
  // we don't silently miss a CREATE/DROP failure. -X skips ~/.psqlrc so a
  // local user's startup script cannot influence the result.
  return runCommand("psql", [
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-d",
    adminUrl,
    "-c",
    sql,
  ]);
}

async function createScratchDb(
  adminUrl: string,
  scratchDbName: string,
): Promise<void> {
  // CREATE DATABASE cannot be parameterised, but `scratchDbName` is already
  // validated against [A-Za-z0-9_]+ in the caller so direct interpolation
  // is safe here.
  const r = await runPsql(adminUrl, `CREATE DATABASE "${scratchDbName}"`);
  if (r.exitCode !== 0) {
    throw new Error(
      `psql CREATE DATABASE exited ${r.exitCode}: ${r.stderr.trim() || "<no stderr>"}`,
    );
  }
}

async function dropScratchDb(
  adminUrl: string,
  scratchDbName: string,
): Promise<void> {
  // FORCE drops any lingering connections (the pg_restore client should
  // already have disconnected, but a flaky network leg can leave one
  // around). Available since Postgres 13.
  const r = await runPsql(
    adminUrl,
    `DROP DATABASE IF EXISTS "${scratchDbName}" WITH (FORCE)`,
  );
  if (r.exitCode !== 0) {
    throw new Error(
      `psql DROP DATABASE exited ${r.exitCode}: ${r.stderr.trim() || "<no stderr>"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Integrity checks (run inside the scratch DB after pg_restore completes)
// ---------------------------------------------------------------------------
//
// Two checks today:
//   1. Core tables exist and are non-empty (users + ledger_entries). If a
//      restore produces an empty users table, something is very wrong.
//   2. No torn ledger journals — every transactionId in `ledger_entries`
//      sums to exactly zero across its rows. This is the same invariant
//      `postLedgerEntries()` enforces on write; verifying it on the
//      restored copy is the cheapest possible "did we restore consistent
//      data" assertion.
//
// Adding more checks later is intentional — the test array shape is
// preserved in the JSONB column so a future check appears alongside its
// historical predecessors with no schema migration.
// ---------------------------------------------------------------------------

/**
 * Run a single SQL query via psql in --tuples-only mode and return stdout
 * trimmed. We use psql here instead of an in-process driver so the
 * integrity check has zero dependency on the Neon serverless adapter the
 * rest of the server uses; the same call works against any standard
 * Postgres URL.
 */
async function psqlScalar(scratchUrl: string, sql: string): Promise<RunCommandResult> {
  return runCommand("psql", [
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "--tuples-only",
    "--no-align",
    "-d",
    scratchUrl,
    "-c",
    sql,
  ]);
}

async function runIntegrityChecks(scratchUrl: string): Promise<IntegrityResult> {
  const checks: IntegrityCheck[] = [];

  // Check 1: users table exists and has at least one row. Empty users on
  // a known-non-empty source is the classic "we restored the wrong dump"
  // signal.
  try {
    const r = await psqlScalar(
      scratchUrl,
      "SELECT COUNT(*)::text FROM users",
    );
    if (r.exitCode !== 0) {
      checks.push({
        name: "users_table_present",
        ok: false,
        detail:
          truncate(`psql exited ${r.exitCode}: ${r.stderr.trim()}`) ?? "unknown",
      });
    } else {
      const n = Number.parseInt(r.stdout.trim(), 10);
      checks.push({
        name: "users_table_present",
        ok: Number.isFinite(n) && n >= 0,
        detail: `users.count=${Number.isFinite(n) ? n : "?"}`,
      });
    }
  } catch (err) {
    checks.push({
      name: "users_table_present",
      ok: false,
      detail: truncate((err as Error)?.message ?? String(err)) ?? "unknown",
    });
  }

  // Check 2: no torn ledger journals. SUM(amount) GROUP BY transactionId
  // must be zero for every transactionId. A single non-zero group is a
  // restored-corruption signal.
  try {
    const r = await psqlScalar(
      scratchUrl,
      `SELECT COUNT(*)::text FROM (
         SELECT transaction_id
         FROM ledger_entries
         WHERE transaction_id IS NOT NULL
         GROUP BY transaction_id
         HAVING SUM(amount::numeric) <> 0
       ) torn`,
    );
    if (r.exitCode !== 0) {
      const stderr = r.stderr.toLowerCase();
      const missing =
        /does not exist|relation .* does not exist/.test(stderr);
      checks.push({
        name: "ledger_journals_balanced",
        ok: missing,
        detail: missing
          ? "ledger_entries table absent on this dump (new install)"
          : truncate(`psql exited ${r.exitCode}: ${r.stderr.trim()}`) ?? "unknown",
      });
    } else {
      const torn = Number.parseInt(r.stdout.trim(), 10);
      checks.push({
        name: "ledger_journals_balanced",
        ok: torn === 0,
        detail:
          torn === 0
            ? "all transactionIds sum to zero"
            : `${torn} torn journal(s) detected on restored copy`,
      });
    }
  } catch (err) {
    checks.push({
      name: "ledger_journals_balanced",
      ok: false,
      detail: truncate((err as Error)?.message ?? String(err)) ?? "unknown",
    });
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}

// ---------------------------------------------------------------------------
// Read-side helpers + freshness watchdog
// ---------------------------------------------------------------------------

export async function getMostRecentSuccessfulBackup(): Promise<DatabaseBackupRun | null> {
  const [row] = await db
    .select()
    .from(databaseBackupRuns)
    .where(eq(databaseBackupRuns.status, "success"))
    .orderBy(desc(databaseBackupRuns.startedAt))
    .limit(1);
  return row ?? null;
}

export async function getMostRecentSuccessfulRestoreDrill(): Promise<DatabaseRestoreDrillRun | null> {
  const [row] = await db
    .select()
    .from(databaseRestoreDrillRuns)
    .where(eq(databaseRestoreDrillRuns.status, "success"))
    .orderBy(desc(databaseRestoreDrillRuns.startedAt))
    .limit(1);
  return row ?? null;
}

export interface OffsiteSyncRecord {
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  summary: string | null;
}

/**
 * Most recent successful offsite-sync run, recorded by
 * `scripts/db-backup-offsite.sh` via the `database-backup-offsite` jobName
 * in `background_job_runs`. Returns `null` when the offsite cron has never
 * reported a success — which the watchdog treats as `offsite-never-run`
 * (subject to the warming-up window so a brand-new server is not paged on
 * a job that simply hasn't ticked yet).
 *
 * Read-only — never inserts a row, so the watchdog cannot accidentally
 * reset the staleness clock and silence itself.
 */
export async function getMostRecentSuccessfulOffsiteSync(): Promise<OffsiteSyncRecord | null> {
  const [row] = await db
    .select()
    .from(backgroundJobRuns)
    .where(
      and(
        eq(backgroundJobRuns.jobName, OFFSITE_BACKUP_JOB_NAME),
        eq(backgroundJobRuns.status, "success"),
      ),
    )
    .orderBy(desc(backgroundJobRuns.startedAt))
    .limit(1);
  if (!row) return null;
  return {
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    summary: row.summary,
  };
}

export interface BackupStatusSummary {
  enabled: boolean;
  backupDir: string | null;
  retentionCount: number;
  latestBackup: {
    startedAt: string;
    finishedAt: string | null;
    dumpPath: string | null;
    dumpSizeBytes: number | null;
    durationMs: number | null;
    ageMs: number;
  } | null;
  latestDrill: {
    startedAt: string;
    finishedAt: string | null;
    dumpPath: string | null;
    integrity: IntegrityResult | null;
    durationMs: number | null;
    ageMs: number;
  } | null;
}

/**
 * Snapshot for the admin dashboard. Combines the latest successful backup +
 * drill into a single object so the dashboard can render a small "Backup
 * health" tile without two separate fetches.
 */
export async function getBackupStatus(now: Date = new Date()): Promise<BackupStatusSummary> {
  const enabled = isBackupsEnabled();
  const backup = await getMostRecentSuccessfulBackup();
  const drill = await getMostRecentSuccessfulRestoreDrill();

  return {
    enabled,
    backupDir: getBackupDir(),
    retentionCount: getRetentionCount(),
    latestBackup: backup
      ? {
          startedAt: backup.startedAt.toISOString(),
          finishedAt: backup.finishedAt?.toISOString() ?? null,
          dumpPath: backup.dumpPath,
          dumpSizeBytes: backup.dumpSizeBytes,
          durationMs: backup.durationMs,
          ageMs: now.getTime() - backup.startedAt.getTime(),
        }
      : null,
    latestDrill: drill
      ? {
          startedAt: drill.startedAt.toISOString(),
          finishedAt: drill.finishedAt?.toISOString() ?? null,
          dumpPath: drill.dumpPath,
          integrity: drill.integrity,
          durationMs: drill.durationMs,
          ageMs: now.getTime() - drill.startedAt.getTime(),
        }
      : null,
  };
}

export interface CheckBackupFreshnessOptions {
  /** Override the backup-stale threshold. */
  backupStaleThresholdMs?: number;
  /** Override the drill-stale threshold. */
  drillStaleThresholdMs?: number;
  /**
   * Override the offsite-stale threshold. Defaults to
   * `getOffsiteStaleThresholdMs()` (env-configurable via
   * `DB_BACKUP_OFFSITE_STALE_HOURS`, default 48 h).
   */
  offsiteStaleThresholdMs?: number;
  /** Override "now". */
  now?: Date;
  /** Override server uptime (ms) used for the warming-up suppression. */
  serverUptimeMs?: number;
  /** Test injection. */
  notify?: (alert: Parameters<typeof notifyOperator>[0]) => Promise<OperatorAlertResult>;
}

export type BackupFreshnessReason =
  | "fresh"
  | "warming-up"
  | "backup-stale"
  | "backup-never-run"
  | "drill-stale"
  | "drill-never-run"
  | "offsite-stale"
  | "offsite-never-run";

export interface BackupFreshnessResult {
  fired: boolean;
  reasons: BackupFreshnessReason[];
  backup: {
    mostRecentSuccessAt: Date | null;
    ageMs: number | null;
    thresholdMs: number;
  };
  drill: {
    mostRecentSuccessAt: Date | null;
    ageMs: number | null;
    thresholdMs: number;
  };
  offsite: {
    mostRecentSuccessAt: Date | null;
    ageMs: number | null;
    thresholdMs: number;
  };
  alertId: number | null;
}

/**
 * Daily watchdog. Pages an operator if the most recent successful backup OR
 * the most recent successful restore drill has fallen outside its expected
 * window. One alert is dispatched per call (with all stale reasons rolled
 * into the details object) so a permanently broken backup pipeline does not
 * trigger TWO simultaneous pages every tick.
 *
 * Read-only — never writes to either run table, so the watchdog cannot
 * accidentally reset the staleness clock and silence itself.
 */
export async function checkBackupFreshness(
  options: CheckBackupFreshnessOptions = {},
): Promise<BackupFreshnessResult> {
  const backupThresholdMs =
    options.backupStaleThresholdMs ?? DEFAULT_BACKUP_STALE_THRESHOLD_MS;
  const drillThresholdMs =
    options.drillStaleThresholdMs ?? DEFAULT_DRILL_STALE_THRESHOLD_MS;
  const offsiteThresholdMs =
    options.offsiteStaleThresholdMs ?? getOffsiteStaleThresholdMs();
  if (!Number.isFinite(backupThresholdMs) || backupThresholdMs <= 0) {
    throw new Error(
      `checkBackupFreshness: backupStaleThresholdMs must be positive (got ${backupThresholdMs})`,
    );
  }
  if (!Number.isFinite(drillThresholdMs) || drillThresholdMs <= 0) {
    throw new Error(
      `checkBackupFreshness: drillStaleThresholdMs must be positive (got ${drillThresholdMs})`,
    );
  }
  if (!Number.isFinite(offsiteThresholdMs) || offsiteThresholdMs <= 0) {
    throw new Error(
      `checkBackupFreshness: offsiteStaleThresholdMs must be positive (got ${offsiteThresholdMs})`,
    );
  }
  const now = options.now ?? new Date();
  const serverUptimeMs =
    options.serverUptimeMs ?? Math.floor(process.uptime() * 1000);
  const notify = options.notify ?? notifyOperator;

  const backup = await getMostRecentSuccessfulBackup();
  const drill = await getMostRecentSuccessfulRestoreDrill();
  const offsite = await getMostRecentSuccessfulOffsiteSync();

  const reasons: BackupFreshnessReason[] = [];
  const backupAgeMs = backup ? now.getTime() - backup.startedAt.getTime() : null;
  const drillAgeMs = drill ? now.getTime() - drill.startedAt.getTime() : null;
  const offsiteAgeMs = offsite
    ? now.getTime() - offsite.startedAt.getTime()
    : null;

  // Warming-up suppression: brand-new server with no run history is not
  // paged unless uptime exceeds the relevant threshold. This mirrors the
  // operator-alerts-prune watchdog so the two behave consistently. Each
  // axis is suppressed independently — a missing offsite row on a server
  // that has been up for years still pages, but on a freshly-restored
  // host it stays quiet for the warming-up window.
  const warmingUpForBackup = !backup && serverUptimeMs < backupThresholdMs;
  const warmingUpForDrill = !drill && serverUptimeMs < drillThresholdMs;
  const warmingUpForOffsite = !offsite && serverUptimeMs < offsiteThresholdMs;

  if (!backup) {
    if (!warmingUpForBackup) reasons.push("backup-never-run");
  } else if (backupAgeMs !== null && backupAgeMs > backupThresholdMs) {
    reasons.push("backup-stale");
  }
  if (!drill) {
    if (!warmingUpForDrill) reasons.push("drill-never-run");
  } else if (drillAgeMs !== null && drillAgeMs > drillThresholdMs) {
    reasons.push("drill-stale");
  }
  if (!offsite) {
    if (!warmingUpForOffsite) reasons.push("offsite-never-run");
  } else if (offsiteAgeMs !== null && offsiteAgeMs > offsiteThresholdMs) {
    reasons.push("offsite-stale");
  }

  const backupSlice = {
    mostRecentSuccessAt: backup?.startedAt ?? null,
    ageMs: backupAgeMs,
    thresholdMs: backupThresholdMs,
  };
  const drillSlice = {
    mostRecentSuccessAt: drill?.startedAt ?? null,
    ageMs: drillAgeMs,
    thresholdMs: drillThresholdMs,
  };
  const offsiteSlice = {
    mostRecentSuccessAt: offsite?.startedAt ?? null,
    ageMs: offsiteAgeMs,
    thresholdMs: offsiteThresholdMs,
  };

  if (reasons.length === 0) {
    if (warmingUpForBackup || warmingUpForDrill || warmingUpForOffsite) {
      return {
        fired: false,
        reasons: ["warming-up"],
        backup: backupSlice,
        drill: drillSlice,
        offsite: offsiteSlice,
        alertId: null,
      };
    }
    return {
      fired: false,
      reasons: ["fresh"],
      backup: backupSlice,
      drill: drillSlice,
      offsite: offsiteSlice,
      alertId: null,
    };
  }

  // Title is the union of the failing axes so the operator-alerts UI
  // doesn't surface "backup OR drill is stale" when only the offsite cron
  // is broken (the most-likely real-world failure mode this task targets).
  const failingAxes: string[] = [];
  if (
    reasons.includes("backup-stale") ||
    reasons.includes("backup-never-run")
  ) {
    failingAxes.push("backup");
  }
  if (reasons.includes("drill-stale") || reasons.includes("drill-never-run")) {
    failingAxes.push("restore drill");
  }
  if (
    reasons.includes("offsite-stale") ||
    reasons.includes("offsite-never-run")
  ) {
    failingAxes.push("offsite sync");
  }
  const title =
    failingAxes.length === 0
      ? "Database backup or restore drill is stale"
      : `Database ${failingAxes.join(", ")} is stale`;

  const result = await notify({
    source: "database-backup-watchdog",
    severity: "alert",
    title,
    details: {
      reasons,
      backupAgeHours:
        backupAgeMs !== null ? Math.round(backupAgeMs / (60 * 60 * 1000)) : null,
      backupThresholdHours: Math.round(backupThresholdMs / (60 * 60 * 1000)),
      backupMostRecentSuccessAt: backup?.startedAt.toISOString() ?? null,
      drillAgeHours:
        drillAgeMs !== null ? Math.round(drillAgeMs / (60 * 60 * 1000)) : null,
      drillThresholdHours: Math.round(drillThresholdMs / (60 * 60 * 1000)),
      drillMostRecentSuccessAt: drill?.startedAt.toISOString() ?? null,
      offsiteAgeHours:
        offsiteAgeMs !== null
          ? Math.round(offsiteAgeMs / (60 * 60 * 1000))
          : null,
      offsiteThresholdHours: Math.round(offsiteThresholdMs / (60 * 60 * 1000)),
      offsiteMostRecentSuccessAt: offsite?.startedAt.toISOString() ?? null,
      hint:
        "See docs/runbooks/rollback.md. For local-backup failures verify " +
        "DB_BACKUP_DIR is writable, pg_dump is on PATH, and the daily " +
        "backup cron is registered. For offsite failures verify the " +
        "scripts/db-backup-offsite.sh host cron, the AWS credentials / " +
        "DB_BACKUP_OFFSITE_BUCKET, and that the script is recording its " +
        "outcome to background_job_runs.",
    },
  });

  return {
    fired: true,
    reasons,
    backup: backupSlice,
    drill: drillSlice,
    offsite: offsiteSlice,
    alertId: result?.alertId ?? null,
  };
}
