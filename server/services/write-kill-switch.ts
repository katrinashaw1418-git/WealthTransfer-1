// =============================================================================
// TASK #155 — Global write kill switch service
// =============================================================================
// One central state owner that the request middleware AND every background
// job consult before performing a write. Two contributing inputs:
//
//   1. The `system_settings` row (id=1, persistent, settable by admins).
//   2. The WRITE_KILL_SWITCH=on env var (boot-time forced ON; cannot be
//      cleared from the admin UI — admins must remove the env var and
//      restart). This gives operators an emergency path that does NOT
//      depend on the DB being healthy enough to read a row.
//
// Caching:
//   The flag is read on every non-GET request, so we keep a tiny in-process
//   cache (~5s TTL) to avoid a DB round-trip per write. The toggle endpoint
//   calls `invalidateWriteKillSwitchCache()` on every mutation so the new
//   state is visible to the next request without waiting for the TTL.
//
// Public surface:
//   * `getWriteKillSwitchState()` — full snapshot for the admin status page
//   * `isWriteBlocked()` — fast boolean for the request middleware
//   * `setWriteKillSwitch({ enabled, reason, actorUserId })` — admin write
//   * `assertWritesAllowed(jobName?)` — for background jobs; returns
//     `{ allowed: true }` or `{ allowed: false, reason }`. We return a
//     value rather than throwing so the cron's wrapper records the run as
//     a normal "skipped" outcome rather than a failure.
//   * `WriteKillSwitchError` — thrown by HTTP middleware to surface the
//     stable JSON shape via the central error handler.
// =============================================================================

import { eq, sql as drizzleSql } from "drizzle-orm";
import { db } from "../db";
import { systemSettings, type SystemSettings } from "@shared/schema";

// ---------------------------------------------------------------------------
// Stable error shape the wire returns for every blocked write. Keeping the
// `code` constant lets clients and tests pattern-match without parsing the
// human-readable `error` string.
// ---------------------------------------------------------------------------
export const WRITE_KILL_SWITCH_ERROR_CODE = "WRITE_KILL_SWITCH_ENABLED" as const;
export const WRITE_KILL_SWITCH_DEFAULT_MESSAGE =
  "Writes are temporarily disabled by an administrator. Please try again shortly.";

export interface WriteKillSwitchErrorBody {
  error: string;
  code: typeof WRITE_KILL_SWITCH_ERROR_CODE;
  reason: string | null;
}

export class WriteKillSwitchError extends Error {
  status = 503;
  code = WRITE_KILL_SWITCH_ERROR_CODE;
  reason: string | null;
  constructor(reason: string | null) {
    super(WRITE_KILL_SWITCH_DEFAULT_MESSAGE);
    this.reason = reason;
  }
  toJSON(): WriteKillSwitchErrorBody {
    return {
      error: this.message,
      code: this.code,
      reason: this.reason,
    };
  }
}

// ---------------------------------------------------------------------------
// Env override — evaluated once at module load. WRITE_KILL_SWITCH=on (case
// insensitive) forces the switch ON regardless of the DB row. Anything else
// (unset, "off", "0", "false", "") leaves DB state in charge.
// ---------------------------------------------------------------------------
function parseEnvOverride(): boolean {
  const raw = process.env.WRITE_KILL_SWITCH;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "on" || v === "true" || v === "1" || v === "yes";
}

// Captured once at boot — the env var is part of the operator's runbook,
// not a runtime dial. A test helper below allows refreshing it for the
// dedicated test suite.
let envOverrideEnabled: boolean = parseEnvOverride();

/** Test-only — re-read the env var after the test mutates process.env. */
export function _refreshEnvOverrideForTests(): void {
  envOverrideEnabled = parseEnvOverride();
}

// ---------------------------------------------------------------------------
// In-process cache. ~5s TTL is short enough that the human-perceived delay
// between flipping the switch in another process and writes being blocked
// stays under a typical incident-response handoff. Toggle endpoint calls
// the invalidate helper so admins on the same node see immediate effect.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 5_000;
let cachedRow: SystemSettings | null = null;
let cachedAt = 0;

export function invalidateWriteKillSwitchCache(): void {
  cachedRow = null;
  cachedAt = 0;
}

// Read the singleton row, creating it (id=1, all defaults) on first ever
// call so callers never have to special-case "table empty". The CHECK
// constraint pins id=1; the upsert below cannot accidentally create a
// second row.
async function loadSystemSettingsRow(): Promise<SystemSettings> {
  // ON CONFLICT DO NOTHING + RETURNING does not return the existing row,
  // so we attempt a select first and only fall back to the seed insert
  // when truly empty.
  const existing = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.id, 1))
    .limit(1);
  if (existing.length > 0) return existing[0];

  // Seed the row. Race-safe: a parallel insert by another process will
  // hit the primary-key conflict; we recover by re-selecting.
  try {
    const [row] = await db
      .insert(systemSettings)
      .values({ id: 1, writeKillSwitchEnabled: false })
      .returning();
    return row;
  } catch {
    const reread = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.id, 1))
      .limit(1);
    if (reread.length > 0) return reread[0];
    // If we still can't read it, surface the error — the middleware will
    // 503 with a generic message rather than silently allowing writes.
    throw new Error("system_settings row id=1 missing and seed failed");
  }
}

async function loadCachedRow(): Promise<SystemSettings> {
  const now = Date.now();
  if (cachedRow && now - cachedAt < CACHE_TTL_MS) return cachedRow;
  const row = await loadSystemSettingsRow();
  cachedRow = row;
  cachedAt = now;
  return row;
}

// ---------------------------------------------------------------------------
// Public read APIs
// ---------------------------------------------------------------------------
export interface WriteKillSwitchState {
  /** Effective flag — true if EITHER the env override OR the DB row is on. */
  enabled: boolean;
  /** Did the env override force this on? Surfaced so admins know they
   *  cannot turn it off via the UI without first removing the env var. */
  envOverride: boolean;
  /** Reason captured at toggle time. Null when off or never set. */
  reason: string | null;
  /** User who last flipped the switch (null for env-forced or never-set). */
  enabledByUserId: number | null;
  /** Timestamp the switch was last flipped on (null for env-forced or off). */
  enabledAt: Date | null;
  /** Last update to the settings row, regardless of which field changed. */
  updatedAt: Date | null;
}

function rowToState(row: SystemSettings): WriteKillSwitchState {
  // The env override OR'd in. We deliberately do NOT clear the DB-side
  // reason when the env var forces it — both pieces of context can be
  // useful in an incident.
  const dbEnabled = row.writeKillSwitchEnabled === true;
  return {
    enabled: envOverrideEnabled || dbEnabled,
    envOverride: envOverrideEnabled,
    reason: row.writeKillSwitchReason ?? (envOverrideEnabled && !dbEnabled ? "Forced ON via WRITE_KILL_SWITCH env var" : null),
    enabledByUserId: row.writeKillSwitchEnabledBy ?? null,
    enabledAt: row.writeKillSwitchEnabledAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

export async function getWriteKillSwitchState(): Promise<WriteKillSwitchState> {
  const row = await loadCachedRow();
  return rowToState(row);
}

/** Fast-path boolean for the request middleware. Reads the cache. */
export async function isWriteBlocked(): Promise<boolean> {
  if (envOverrideEnabled) return true;
  const row = await loadCachedRow();
  return row.writeKillSwitchEnabled === true;
}

// ---------------------------------------------------------------------------
// Public write API — used by the admin toggle route
// ---------------------------------------------------------------------------
export interface SetWriteKillSwitchInput {
  enabled: boolean;
  reason: string | null;
  actorUserId: number;
}

export interface SetWriteKillSwitchResult {
  /** State BEFORE the toggle (for audit_logs.metadata.before). */
  before: WriteKillSwitchState;
  /** State AFTER the toggle (for audit_logs.metadata.after). */
  after: WriteKillSwitchState;
  /** True iff the effective enabled flag changed. Useful for tests +
   *  for the audit log to avoid recording no-op toggles. */
  changed: boolean;
}

export async function setWriteKillSwitch(
  input: SetWriteKillSwitchInput,
): Promise<SetWriteKillSwitchResult> {
  // Always re-read the current state directly (bypass cache) so the audit
  // before/after pair reflects what the row actually held at the moment
  // of the toggle.
  const beforeRow = await loadSystemSettingsRow();
  const before = rowToState(beforeRow);

  const now = new Date();
  const reason = input.reason && input.reason.trim().length > 0 ? input.reason.trim() : null;

  // We update enabledBy + enabledAt only on an OFF→ON transition. An
  // ON→OFF transition clears them so the next ON cycle records fresh
  // attribution. updatedAt is always bumped.
  const goingOn = !beforeRow.writeKillSwitchEnabled && input.enabled;

  const [afterRow] = await db
    .update(systemSettings)
    .set({
      writeKillSwitchEnabled: input.enabled,
      writeKillSwitchReason: input.enabled ? reason : null,
      writeKillSwitchEnabledBy: input.enabled
        ? (goingOn ? input.actorUserId : beforeRow.writeKillSwitchEnabledBy)
        : null,
      writeKillSwitchEnabledAt: input.enabled
        ? (goingOn ? now : beforeRow.writeKillSwitchEnabledAt)
        : null,
      updatedAt: now,
    })
    .where(eq(systemSettings.id, 1))
    .returning();

  invalidateWriteKillSwitchCache();
  const after = rowToState(afterRow);

  return {
    before,
    after,
    changed: before.enabled !== after.enabled,
  };
}

// ---------------------------------------------------------------------------
// Background-job guard
// ---------------------------------------------------------------------------
// Crons that perform writes call this at the top of their tick. A blocked
// state returns `{ allowed: false }`; the caller logs a structured "skip"
// line and returns early — the cron tick still records as 'success' in
// `background_job_runs` so the dashboard does not flag a healthy skip as
// a failure.
//
// We do NOT throw, deliberately: throwing would mark the cron's run as a
// failure and could cascade into the prune-watchdog, and the kill switch
// is supposed to be a benign "pause" not a "everything is broken" signal.
// ---------------------------------------------------------------------------
export interface AssertWritesAllowedResult {
  allowed: boolean;
  reason: string | null;
  /** Human-friendly source label included in the structured log line. */
  source: "env_override" | "db_setting" | null;
}

export async function assertWritesAllowed(
  jobName?: string,
): Promise<AssertWritesAllowedResult> {
  const state = await getWriteKillSwitchState();
  if (!state.enabled) {
    return { allowed: true, reason: null, source: null };
  }
  // Log once per call so the operator-visible cron stream shows the skip.
  const tag = jobName ? `[${jobName}] ` : "";
  console.log(
    `${tag}write-kill-switch is ON — skipping background write tick ` +
      `(source=${state.envOverride ? "env_override" : "db_setting"}, ` +
      `reason=${state.reason ?? "none"})`,
  );
  return {
    allowed: false,
    reason: state.reason,
    source: state.envOverride ? "env_override" : "db_setting",
  };
}

// ---------------------------------------------------------------------------
// One-time table bootstrap. Called at boot from server/index.ts before any
// request middleware runs. Drizzle's runtime does not auto-create tables;
// production uses `npm run db:push` for schema migrations, but the runtime
// guard below ensures a fresh dev DB or a missed push does not leave the
// table absent and crash the middleware on every request.
// ---------------------------------------------------------------------------
export async function ensureSystemSettingsTable(): Promise<void> {
  await db.execute(drizzleSql`
    CREATE TABLE IF NOT EXISTS system_settings (
      id integer PRIMARY KEY NOT NULL,
      write_kill_switch_enabled boolean NOT NULL DEFAULT false,
      write_kill_switch_reason text,
      write_kill_switch_enabled_by integer REFERENCES users(id),
      write_kill_switch_enabled_at timestamp,
      updated_at timestamp DEFAULT NOW(),
      CONSTRAINT system_settings_singleton_id CHECK (id = 1)
    )
  `);
  // Seed the singleton row if missing — independent INSERT so the CREATE
  // TABLE above stays idempotent on re-runs.
  await db.execute(drizzleSql`
    INSERT INTO system_settings (id, write_kill_switch_enabled)
    VALUES (1, false)
    ON CONFLICT (id) DO NOTHING
  `);
  invalidateWriteKillSwitchCache();
}
