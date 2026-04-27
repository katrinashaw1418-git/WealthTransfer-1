// =============================================================================
// TASK #174 — Operator-alerts webhook failover state
// =============================================================================
// Runtime override that lets an admin promote the env-configured
// OPERATOR_ALERT_WEBHOOK_URL_BACKUP into the "primary" webhook role
// without restarting the server. Used when the original primary webhook
// is in outage (receiver down, expired secret, mis-rotated URL) and every
// alert has been rolling up to "failed". Flipping the toggle restores
// the normal "delivered" rollup as long as the env backup URL is healthy.
//
// Persisted in the same `system_settings` singleton row that holds the
// write-kill-switch state, so we get the same audit shape (actor +
// timestamp + free-text reason) for free. The four columns added by
// Task #174 are guarded by `ensureOperatorAlertFailoverColumns()` below
// (idempotent ALTER TABLE IF NOT EXISTS), called from server/index.ts at
// boot, so a fresh dev DB or a missed `db:push` does not crash the
// dispatcher on the first alert.
//
// Caching: the dispatcher reads the failover state on every notifyOperator
// call, so we keep the same ~5s TTL the kill-switch uses. The toggle
// endpoint calls `invalidateOperatorAlertFailoverCache()` so admins on the
// same node see immediate effect.
// =============================================================================

import { eq, sql as drizzleSql } from "drizzle-orm";
import { db } from "../db";
import { systemSettings, type SystemSettings } from "@shared/schema";

const CACHE_TTL_MS = 5_000;
let cachedRow: SystemSettings | null = null;
let cachedAt = 0;

export function invalidateOperatorAlertFailoverCache(): void {
  cachedRow = null;
  cachedAt = 0;
}

/**
 * Idempotent ALTER TABLE for the four Task #174 columns. Mirrors
 * `ensureSystemSettingsTable` in write-kill-switch.ts; called once at
 * boot so a fresh DB or a missed `db:push` does not break the
 * dispatcher. Each column statement is independent (no transaction)
 * so a partial run still makes forward progress.
 */
export async function ensureOperatorAlertFailoverColumns(): Promise<void> {
  await db.execute(drizzleSql`
    ALTER TABLE system_settings
      ADD COLUMN IF NOT EXISTS operator_alert_webhook_failover_active boolean NOT NULL DEFAULT false
  `);
  await db.execute(drizzleSql`
    ALTER TABLE system_settings
      ADD COLUMN IF NOT EXISTS operator_alert_webhook_failover_reason text
  `);
  await db.execute(drizzleSql`
    ALTER TABLE system_settings
      ADD COLUMN IF NOT EXISTS operator_alert_webhook_failover_engaged_by integer REFERENCES users(id)
  `);
  await db.execute(drizzleSql`
    ALTER TABLE system_settings
      ADD COLUMN IF NOT EXISTS operator_alert_webhook_failover_engaged_at timestamp
  `);
  invalidateOperatorAlertFailoverCache();
}

/**
 * Read the singleton row, seeding it via the write-kill-switch path when
 * the table is freshly created. We re-use the kill-switch loader by
 * inlining the same SELECT/INSERT pair here so this module does not have
 * to import from write-kill-switch (avoids a circular surface area).
 */
async function loadSystemSettingsRow(): Promise<SystemSettings | null> {
  try {
    const existing = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.id, 1))
      .limit(1);
    if (existing.length > 0) return existing[0];
    // Defensive seed — write-kill-switch already does this at boot, but
    // in tests/utilities that import this module first we still want a
    // usable row.
    try {
      const [row] = await db
        .insert(systemSettings)
        .values({ id: 1, writeKillSwitchEnabled: false })
        .returning();
      return row ?? null;
    } catch {
      const reread = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.id, 1))
        .limit(1);
      return reread[0] ?? null;
    }
  } catch (err) {
    // A read failure here is non-fatal for the dispatcher — we fall back
    // to "failover disabled" so alerts still go to the env-primary URL.
    // The error is logged so the missing settings row is itself visible.
    console.error(
      "[operator-alert-failover] settings row read failed",
      (err as Error)?.message ?? err,
    );
    return null;
  }
}

async function loadCachedRow(): Promise<SystemSettings | null> {
  const now = Date.now();
  if (cachedRow && now - cachedAt < CACHE_TTL_MS) return cachedRow;
  const row = await loadSystemSettingsRow();
  if (row) {
    cachedRow = row;
    cachedAt = now;
  }
  return row;
}

export interface OperatorAlertFailoverState {
  /** Effective failover flag — true means backup is promoted to primary. */
  active: boolean;
  /** Free-text reason captured at toggle time. Null when inactive. */
  reason: string | null;
  /** User who last engaged failover (null when inactive or never set). */
  engagedByUserId: number | null;
  /** Timestamp the toggle was last engaged (null when inactive). */
  engagedAt: Date | null;
}

function rowToState(row: SystemSettings | null): OperatorAlertFailoverState {
  if (!row) {
    return { active: false, reason: null, engagedByUserId: null, engagedAt: null };
  }
  const active = row.operatorAlertWebhookFailoverActive === true;
  return {
    active,
    reason: active ? row.operatorAlertWebhookFailoverReason ?? null : null,
    engagedByUserId: active ? row.operatorAlertWebhookFailoverEngagedBy ?? null : null,
    engagedAt: active ? row.operatorAlertWebhookFailoverEngagedAt ?? null : null,
  };
}

/** Snapshot for the admin status endpoint. */
export async function getOperatorAlertFailoverState(): Promise<OperatorAlertFailoverState> {
  const row = await loadCachedRow();
  return rowToState(row);
}

/**
 * Fast-path boolean for the dispatcher. Reads the same cache so a tight
 * loop of alerts does not re-query the DB. Failure to read returns false
 * (no failover) so a DB outage does not silently swap webhook roles.
 */
export async function isOperatorAlertFailoverActive(): Promise<boolean> {
  const row = await loadCachedRow();
  if (!row) return false;
  return row.operatorAlertWebhookFailoverActive === true;
}

export interface SetOperatorAlertFailoverInput {
  active: boolean;
  reason: string | null;
  actorUserId: number;
}

export interface SetOperatorAlertFailoverResult {
  before: OperatorAlertFailoverState;
  after: OperatorAlertFailoverState;
  changed: boolean;
}

/**
 * Toggle endpoint helper — writes the row, captures actor+timestamp on
 * an OFF→ON transition, clears them on ON→OFF. Bypasses the cache so
 * the audit before/after pair reflects committed state.
 */
export async function setOperatorAlertFailover(
  input: SetOperatorAlertFailoverInput,
): Promise<SetOperatorAlertFailoverResult> {
  const beforeRow = await loadSystemSettingsRow();
  const before = rowToState(beforeRow);

  const now = new Date();
  const reason =
    input.reason && input.reason.trim().length > 0 ? input.reason.trim() : null;
  const wasActive = beforeRow?.operatorAlertWebhookFailoverActive === true;
  const goingOn = !wasActive && input.active;

  const [afterRow] = await db
    .update(systemSettings)
    .set({
      operatorAlertWebhookFailoverActive: input.active,
      operatorAlertWebhookFailoverReason: input.active ? reason : null,
      operatorAlertWebhookFailoverEngagedBy: input.active
        ? goingOn
          ? input.actorUserId
          : beforeRow?.operatorAlertWebhookFailoverEngagedBy ?? null
        : null,
      operatorAlertWebhookFailoverEngagedAt: input.active
        ? goingOn
          ? now
          : beforeRow?.operatorAlertWebhookFailoverEngagedAt ?? null
        : null,
      updatedAt: now,
    })
    .where(eq(systemSettings.id, 1))
    .returning();

  invalidateOperatorAlertFailoverCache();
  const after = rowToState(afterRow ?? null);

  return {
    before,
    after,
    changed: before.active !== after.active,
  };
}
