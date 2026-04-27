// =============================================================================
// TASK #146 — Operator kill switches
// -----------------------------------------------------------------------------
// Four named switches let operators stop money-movement classes of API calls
// without a redeploy:
//
//   * transactions      — generic money-movement (FX exchange, wallet
//                         transfer, investment buy). Also acts as a master:
//                         deposits/withdrawals/fee deductions all create
//                         `transactions` rows, so when this switch is on
//                         every money-movement endpoint refuses.
//   * deposits          — POST /api/deposit + /api/wallets/deposit
//   * withdrawals       — POST /api/withdraw + /api/wallets/withdraw
//   * fee_deductions    — adviser fee deduction settle/reverse + scheduled
//                         fee accrual + insufficient-funds sweep
//
// Two control planes:
//   1. Env var (DISABLE_TRANSACTIONS, etc.). Truthy values force the switch
//      ON and CANNOT be cleared from the admin UI — ops escape hatch when
//      the DB itself is suspect or the admin shell isn't reachable.
//   2. DB row (`kill_switches`). The admin "Kill switches" page upserts
//      this row through `setKillSwitchState`, which also writes an audit
//      log entry and pages an operator alert.
//
// Guard contract (assertKillSwitchOff):
//   On a hit, throw KillSwitchActiveError. The route handlers map that
//   into HTTP 503 + body `{ error: "operation_disabled", switch: <key> }`.
//   Cron jobs catch it and bail with a clean info-level summary instead.
// =============================================================================

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  auditLogs,
  killSwitchKeyValues,
  killSwitches,
  type KillSwitch,
  type KillSwitchKey,
} from "@shared/schema";
import { writeAuditLog } from "./audit";
import { notifyOperator } from "./operator-alerts";

export { killSwitchKeyValues } from "@shared/schema";
export type { KillSwitchKey } from "@shared/schema";

// Cache so guards on hot paths don't issue a SELECT on every request. The
// admin toggle invalidates the cache directly; otherwise it expires every
// few seconds. A short TTL is sufficient because turning a switch ON is
// fail-closed (the env var override gives a redeploy-free escape hatch).
const CACHE_TTL_MS = 5_000;
let cache: Map<KillSwitchKey, KillSwitchState> | null = null;
let cacheLoadedAt = 0;
let inFlightLoad: Promise<Map<KillSwitchKey, KillSwitchState>> | null = null;

export interface KillSwitchState {
  key: KillSwitchKey;
  enabled: boolean;
  reason: string | null;
  lastToggledByUserId: number | null;
  lastToggledAt: Date | null;
  envForced: boolean;
}

const ENV_VAR_NAMES: Record<KillSwitchKey, string> = {
  transactions: "DISABLE_TRANSACTIONS",
  deposits: "DISABLE_DEPOSITS",
  withdrawals: "DISABLE_WITHDRAWALS",
  fee_deductions: "DISABLE_FEE_DEDUCTIONS",
};

const HUMAN_LABELS: Record<KillSwitchKey, string> = {
  transactions: "Transactions",
  deposits: "Deposits",
  withdrawals: "Withdrawals",
  fee_deductions: "Fee deductions",
};

export function killSwitchLabel(key: KillSwitchKey): string {
  return HUMAN_LABELS[key];
}

export function killSwitchEnvVarName(key: KillSwitchKey): string {
  return ENV_VAR_NAMES[key];
}

export function isKillSwitchKey(value: unknown): value is KillSwitchKey {
  return (
    typeof value === "string" &&
    (killSwitchKeyValues as readonly string[]).includes(value)
  );
}

function isEnvForced(key: KillSwitchKey): boolean {
  const raw = process.env[ENV_VAR_NAMES[key]];
  if (!raw) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function rowToState(row: KillSwitch): KillSwitchState {
  const key = row.switchKey as KillSwitchKey;
  const env = isEnvForced(key);
  return {
    key,
    enabled: env || row.enabled,
    reason: row.reason ?? null,
    lastToggledByUserId: row.lastToggledByUserId ?? null,
    lastToggledAt: row.lastToggledAt ?? null,
    envForced: env,
  };
}

function defaultState(key: KillSwitchKey): KillSwitchState {
  const env = isEnvForced(key);
  return {
    key,
    enabled: env,
    reason: null,
    lastToggledByUserId: null,
    lastToggledAt: null,
    envForced: env,
  };
}

async function loadAllStatesFromDb(): Promise<
  Map<KillSwitchKey, KillSwitchState>
> {
  const rows = await db.select().from(killSwitches);
  const map = new Map<KillSwitchKey, KillSwitchState>();
  for (const k of killSwitchKeyValues) map.set(k, defaultState(k));
  for (const r of rows) {
    if (isKillSwitchKey(r.switchKey)) map.set(r.switchKey, rowToState(r));
  }
  return map;
}

async function ensureCache(): Promise<Map<KillSwitchKey, KillSwitchState>> {
  const now = Date.now();
  if (cache && now - cacheLoadedAt < CACHE_TTL_MS) return cache;
  if (inFlightLoad) return inFlightLoad;
  inFlightLoad = (async () => {
    try {
      const m = await loadAllStatesFromDb();
      cache = m;
      cacheLoadedAt = Date.now();
      return m;
    } finally {
      inFlightLoad = null;
    }
  })();
  return inFlightLoad;
}

export function invalidateKillSwitchCache(): void {
  cache = null;
  cacheLoadedAt = 0;
}

// ---------------------------------------------------------------------------
// Public read API
// ---------------------------------------------------------------------------
export async function getKillSwitchState(
  key: KillSwitchKey,
): Promise<KillSwitchState> {
  const m = await ensureCache();
  return m.get(key) ?? defaultState(key);
}

export async function getAllKillSwitchStates(): Promise<KillSwitchState[]> {
  const m = await ensureCache();
  return killSwitchKeyValues.map((k) => m.get(k) ?? defaultState(k));
}

export async function isKillSwitchActive(key: KillSwitchKey): Promise<boolean> {
  // Always check env first so an ops kill works even if the cache load
  // fails (e.g. DB outage).
  if (isEnvForced(key)) return true;
  const s = await getKillSwitchState(key);
  return s.enabled;
}

// ---------------------------------------------------------------------------
// Guard error + helper
// ---------------------------------------------------------------------------
export class KillSwitchActiveError extends Error {
  readonly status = 503;
  readonly switchKey: KillSwitchKey;
  constructor(switchKey: KillSwitchKey) {
    super(`Operation disabled by kill switch: ${switchKey}`);
    this.name = "KillSwitchActiveError";
    this.switchKey = switchKey;
  }
}

/**
 * Throws KillSwitchActiveError when the named switch is engaged. Checks
 * the keys in order, so a master switch (transactions) can be passed
 * alongside a specific one (deposits) and the most-specific match wins
 * the error message.
 */
export async function assertKillSwitchOff(
  ...keys: KillSwitchKey[]
): Promise<void> {
  for (const k of keys) {
    if (await isKillSwitchActive(k)) {
      throw new KillSwitchActiveError(k);
    }
  }
}

/**
 * Map a thrown error into the canonical 503 response envelope. Returns
 * true if the response was sent so callers can `if (handled) return`.
 */
export function sendKillSwitchResponse(
  res: { status: (code: number) => any },
  err: unknown,
): boolean {
  if (err instanceof KillSwitchActiveError) {
    res
      .status(503)
      .json({ error: "operation_disabled", switch: err.switchKey });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Toggle (admin path)
// ---------------------------------------------------------------------------
export interface SetKillSwitchOpts {
  key: KillSwitchKey;
  enabled: boolean;
  reason: string;
  actorUserId: number;
  ipAddress: string | null;
}

export async function setKillSwitchState(
  opts: SetKillSwitchOpts,
): Promise<KillSwitchState> {
  const reason = (opts.reason ?? "").trim();
  if (!reason) {
    throw Object.assign(new Error("Reason is required"), { status: 400 });
  }
  if (reason.length > 1000) {
    throw Object.assign(
      new Error("Reason must be 1000 characters or fewer"),
      { status: 400 },
    );
  }

  // Env-forced switches cannot be cleared (or "re-enabled to same value")
  // through the admin API — the env var is the source of truth and an
  // accepted DB write would mislead the audit trail into showing a clear
  // that didn't actually take effect. Operators must remove the env var
  // and redeploy to release it. We reject BOTH directions because even an
  // "engage" while already env-forced is misleading: the row would say
  // user X engaged it, when in reality it has been engaged by the env
  // var since boot. Returns 409 (conflict — the underlying state is
  // pinned by env var, not the supplied desired state).
  if (isEnvForced(opts.key)) {
    throw Object.assign(
      new Error(
        `Kill switch ${opts.key} is forced ON by env var ${ENV_VAR_NAMES[opts.key]} ` +
          `and cannot be toggled from the admin UI. Clear the env var and redeploy to release.`,
      ),
      { status: 409 },
    );
  }

  // Read previous state for the audit before/after diff. Use the raw DB
  // row (not the cached state) so the env-forced flag does not pollute the
  // diff — the audit captures what the admin actually changed in the DB.
  const [existing] = await db
    .select()
    .from(killSwitches)
    .where(eq(killSwitches.switchKey, opts.key));

  const before = existing
    ? {
        enabled: existing.enabled,
        reason: existing.reason ?? null,
        lastToggledByUserId: existing.lastToggledByUserId ?? null,
        lastToggledAt: existing.lastToggledAt
          ? existing.lastToggledAt.toISOString()
          : null,
      }
    : { enabled: false, reason: null, lastToggledByUserId: null, lastToggledAt: null };

  const now = new Date();
  const [row] = await db
    .insert(killSwitches)
    .values({
      switchKey: opts.key,
      enabled: opts.enabled,
      reason,
      lastToggledByUserId: opts.actorUserId,
      lastToggledAt: now,
    })
    .onConflictDoUpdate({
      target: killSwitches.switchKey,
      set: {
        enabled: opts.enabled,
        reason,
        lastToggledByUserId: opts.actorUserId,
        lastToggledAt: now,
      },
    })
    .returning();

  // Drop the cache so the next guard read picks up the new state without
  // waiting for the TTL to expire.
  invalidateKillSwitchCache();

  await writeAuditLog({
    userId: opts.actorUserId,
    action: opts.enabled ? "kill_switch_enabled" : "kill_switch_disabled",
    entityType: "kill_switch",
    entityId: opts.key,
    before,
    after: {
      enabled: row.enabled,
      reason: row.reason ?? null,
      lastToggledByUserId: row.lastToggledByUserId ?? null,
      lastToggledAt: row.lastToggledAt
        ? row.lastToggledAt.toISOString()
        : null,
    },
    extra: { switchKey: opts.key, reason },
    ipAddress: opts.ipAddress,
  });

  // Page the operators so an off-hours flip doesn't go unnoticed. A flip
  // back to disabled is still notable — surfaces in the on-call channel.
  await notifyOperator({
    source: "kill-switch",
    severity: opts.enabled ? "warning" : "info",
    title: opts.enabled
      ? `Kill switch ENGAGED: ${killSwitchLabel(opts.key)}`
      : `Kill switch CLEARED: ${killSwitchLabel(opts.key)}`,
    details: {
      switchKey: opts.key,
      enabled: opts.enabled,
      actorUserId: opts.actorUserId,
      reason,
    },
  });

  return rowToState(row);
}

// ---------------------------------------------------------------------------
// History (audit log read)
// ---------------------------------------------------------------------------
export interface KillSwitchAuditEntry {
  id: number;
  userId: number | null;
  action: string;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: Date | null;
}

export async function getKillSwitchHistory(
  key: KillSwitchKey,
  limit = 50,
): Promise<KillSwitchAuditEntry[]> {
  const rows = await db
    .select({
      id: auditLogs.id,
      userId: auditLogs.userId,
      action: auditLogs.action,
      metadata: auditLogs.metadata,
      ipAddress: auditLogs.ipAddress,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.entityType, "kill_switch"),
        eq(auditLogs.entityId, key),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(Math.max(1, Math.min(limit, 200)));
  return rows;
}

// `sql` is intentionally re-exported so the unit tests can poke the cache
// without re-importing from drizzle-orm.
export { sql };
