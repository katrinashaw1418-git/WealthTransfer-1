// =============================================================================
// TASK #163 — Rate-limiter trip recorder + repeat-offender operator alert
// =============================================================================
// The login / forgot-password / reset-password limiters added earlier return
// HTTP 429 once an attacker exceeds the per-IP window, but until this module
// landed we did not record those events anywhere. A real credential-stuffing
// or token-fuzzing attempt trips the limiter over and over — exactly the
// pattern security wants to see — and that pattern was invisible.
//
// What this module does, per limiter trip:
//   1. Writes one structured row to `audit_logs` with action
//      `rate_limit_exceeded`. The row carries the IP, the (lower-cased)
//      username if the request body had one, the route, and the limiter
//      name. We deliberately reuse the existing `audit_logs` table rather
//      than introducing a new one — auditors already trust that table as
//      the canonical security event log.
//   2. Aggregates: counts how many `rate_limit_exceeded` rows for the same
//      `(ip, route)` AND for the same `(username, route)` exist in the
//      last `RATE_LIMIT_ALERT_WINDOW_MINUTES` (default 60).
//   3. When either count is >= `RATE_LIMIT_ALERT_THRESHOLD` (default 20),
//      dispatches an operator alert via `notifyOperator` with source
//      `rate-limit-abuse`. The payload includes a `tripCountBucket` rounded
//      DOWN to the nearest multiple of the threshold so the dispatcher's
//      built-in payload-hash dedupe collapses identical-bucket repeats but
//      re-fires when the next multiple is crossed (20, 40, 60, ...). This
//      keeps the operator inbox quiet for steady-state abuse while still
//      surfacing escalations.
//
// All of step 2/3 is best-effort. A failure in the aggregation or the
// notify call must never crash the 429 path the caller is about to send;
// failures are logged loudly and the function returns with `alerted=false`.
//
// Configuration (all optional, all read at call time so .env edits are
// picked up by the next trip without a restart):
//   * RATE_LIMIT_ALERT_THRESHOLD       — N+ trips inside the window that
//                                        triggers an alert. Default 20.
//   * RATE_LIMIT_ALERT_WINDOW_MINUTES  — sliding aggregation window.
//                                        Default 60.
//
// The notification target is configured through the existing operator-alert
// pipeline (`OPERATOR_ALERT_WEBHOOK_URL` for Slack/email forwarders); no
// rate-limit-specific destination knob — the security team already has one
// place to look.
// =============================================================================

import type { Request } from "express";
import { sql } from "drizzle-orm";

import { db } from "../db";
import { auditLogs } from "../../shared/schema";
import { notifyOperator } from "./operator-alerts";

export const RATE_LIMIT_AUDIT_ACTION = "rate_limit_exceeded";
export const RATE_LIMIT_ALERT_SOURCE = "rate-limit-abuse";

const DEFAULT_WINDOW_MINUTES = 60;
const DEFAULT_THRESHOLD = 20;

// Cap the username we store / count on. The audit row is queryable by an
// admin so an oversized free-form value would bloat the metadata jsonb and
// the equality check below.
const MAX_USERNAME_LEN = 256;

function resolveWindowMinutes(): number {
  const raw = process.env.RATE_LIMIT_ALERT_WINDOW_MINUTES;
  if (!raw) return DEFAULT_WINDOW_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[rate-limit-alerts] invalid RATE_LIMIT_ALERT_WINDOW_MINUTES=${raw}, ` +
        `falling back to default ${DEFAULT_WINDOW_MINUTES}`,
    );
    return DEFAULT_WINDOW_MINUTES;
  }
  return Math.floor(n);
}

function resolveThreshold(): number {
  const raw = process.env.RATE_LIMIT_ALERT_THRESHOLD;
  if (!raw) return DEFAULT_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[rate-limit-alerts] invalid RATE_LIMIT_ALERT_THRESHOLD=${raw}, ` +
        `falling back to default ${DEFAULT_THRESHOLD}`,
    );
    return DEFAULT_THRESHOLD;
  }
  return Math.floor(n);
}

export interface RateLimitTripContext {
  /** Stable name of the limiter for the audit/alert payload, e.g. `loginLimiter`. */
  limiter: string;
  /** Express route the limiter guards, e.g. `/api/auth/login`. */
  route: string;
}

interface ParsedOffender {
  ip: string | null;
  username: string | null;
}

/**
 * Pull the offender identity off the request. IP comes from `req.ip` (Express
 * already resolves it through `trust proxy`). The username is read from the
 * request body when the route's schema carries one — for login/forgot-password
 * the field is `username`; reset-password has no username (only a token), so
 * the username remains null and only the IP axis is used.
 *
 * We lower-case the username and slice it to a reasonable length so the
 * subsequent equality check is case-insensitive (matches login behaviour) and
 * a malicious 100KB body field cannot bloat the audit row.
 */
function parseOffender(req: Request): ParsedOffender {
  const ip = typeof req.ip === "string" && req.ip.length > 0 ? req.ip : null;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw = body.username;
  const username =
    typeof raw === "string" && raw.trim().length > 0
      ? raw.trim().toLowerCase().slice(0, MAX_USERNAME_LEN)
      : null;
  return { ip, username };
}

export interface RecordRateLimitTripResult {
  ip: string | null;
  username: string | null;
  /** Trips for `(ip, route)` inside the window AFTER this trip, or null when no IP / aggregation failed. */
  ipCount: number | null;
  /** Trips for `(username, route)` inside the window AFTER this trip, or null when no username / aggregation failed. */
  usernameCount: number | null;
  /** Whether at least one operator alert was dispatched for this trip. */
  alerted: boolean;
  /** Threshold actually applied (after env-var resolution). */
  thresholdApplied: number;
  /** Window actually applied (after env-var resolution). */
  windowMinutesApplied: number;
}

/**
 * Record one limiter trip. Safe to call from inside an `express-rate-limit`
 * `handler` callback — failures are swallowed and logged so the surrounding
 * 429 response is never blocked.
 */
export async function recordRateLimitTrip(
  req: Request,
  ctx: RateLimitTripContext,
): Promise<RecordRateLimitTripResult> {
  const offender = parseOffender(req);
  const thresholdApplied = resolveThreshold();
  const windowMinutesApplied = resolveWindowMinutes();

  const result: RecordRateLimitTripResult = {
    ip: offender.ip,
    username: offender.username,
    ipCount: null,
    usernameCount: null,
    alerted: false,
    thresholdApplied,
    windowMinutesApplied,
  };

  // ---- Step 1 — durable audit row -----------------------------------------
  // Metadata shape is fixed and documented at the top of the file. Drizzle
  // declares the `metadata` jsonb column as `unknown`; we narrow to a
  // concrete object literal so a future caller cannot accidentally drop a
  // field by relying on the column's loose typing.
  const auditMetadata: {
    limiter: string;
    route: string;
    ip: string | null;
    username: string | null;
  } = {
    limiter: ctx.limiter,
    route: ctx.route,
    ip: offender.ip,
    username: offender.username,
  };
  try {
    await db.insert(auditLogs).values({
      userId: null,
      action: RATE_LIMIT_AUDIT_ACTION,
      entityType: "rate_limiter",
      entityId: ctx.route,
      metadata: auditMetadata,
      ipAddress: offender.ip,
    });
  } catch (err) {
    console.error(
      `[rate-limit-alerts] failed to record audit row for route=${ctx.route}`,
      (err as Error)?.message ?? err,
    );
    // Without the audit row we cannot count accurately — bail out, but
    // still let the caller send the 429 response.
    return result;
  }

  // ---- Step 2 — aggregate within the window -------------------------------
  // We query against the columns we just wrote; the just-inserted row IS
  // counted here, which is intentional — the threshold reflects "Nth trip in
  // window has just landed".
  //
  // db.execute() returns a postgres-driver result whose ambient typing is
  // intentionally loose (drizzle does not know the SELECT shape). We narrow
  // through a single concrete shape `CountQueryResult` so the count parsing
  // below has a real type — no `any` casts.
  type CountQueryResult = { rows?: ReadonlyArray<{ c?: number | string | null }> };
  const cutoffSql = sql`now() - (${windowMinutesApplied}::text || ' minutes')::interval`;

  function extractCount(result: unknown): number {
    const rows = (result as CountQueryResult).rows ?? [];
    const first = rows[0];
    if (!first) return 0;
    const c = first.c;
    if (typeof c === "number" && Number.isFinite(c)) return c;
    const n = Number(c);
    return Number.isFinite(n) ? n : 0;
  }

  let ipCount: number | null = null;
  let usernameCount: number | null = null;
  try {
    if (offender.ip) {
      const r = await db.execute(sql`
        SELECT COUNT(*)::int AS c
          FROM audit_logs
         WHERE action = ${RATE_LIMIT_AUDIT_ACTION}
           AND entity_id = ${ctx.route}
           AND ip_address = ${offender.ip}
           AND created_at >= ${cutoffSql}
      `);
      ipCount = extractCount(r);
    }
    if (offender.username) {
      const r = await db.execute(sql`
        SELECT COUNT(*)::int AS c
          FROM audit_logs
         WHERE action = ${RATE_LIMIT_AUDIT_ACTION}
           AND entity_id = ${ctx.route}
           AND (metadata ->> 'username') = ${offender.username}
           AND created_at >= ${cutoffSql}
      `);
      usernameCount = extractCount(r);
    }
  } catch (err) {
    console.error(
      `[rate-limit-alerts] aggregation query failed for route=${ctx.route}`,
      (err as Error)?.message ?? err,
    );
    result.ipCount = ipCount;
    result.usernameCount = usernameCount;
    return result;
  }

  result.ipCount = ipCount;
  result.usernameCount = usernameCount;

  // ---- Step 3 — operator alert (per offender axis) ------------------------
  // For each axis whose count crossed the threshold, dispatch one alert.
  // The `tripCountBucket` is rounded DOWN to the nearest multiple of the
  // threshold so the dispatcher's payload-hash dedupe (15-min window by
  // default) collapses repeats inside a bucket but re-fires when the next
  // multiple is crossed (20 → 40 → 60 …). This pattern keeps a steady-state
  // attacker from carpet-bombing the inbox while still escalating growth.
  const targets: Array<{
    offenderType: "ip" | "username";
    offenderValue: string;
    count: number;
    bucket: number;
  }> = [];
  if (offender.ip && ipCount !== null && ipCount >= thresholdApplied) {
    targets.push({
      offenderType: "ip",
      offenderValue: offender.ip,
      count: ipCount,
      bucket: Math.floor(ipCount / thresholdApplied) * thresholdApplied,
    });
  }
  if (
    offender.username &&
    usernameCount !== null &&
    usernameCount >= thresholdApplied
  ) {
    targets.push({
      offenderType: "username",
      offenderValue: offender.username,
      count: usernameCount,
      bucket:
        Math.floor(usernameCount / thresholdApplied) * thresholdApplied,
    });
  }

  for (const t of targets) {
    try {
      await notifyOperator({
        source: RATE_LIMIT_ALERT_SOURCE,
        severity: "warning",
        title: `Rate limiter tripped ${t.bucket}+ times for ${t.offenderType}=${t.offenderValue}`,
        details: {
          route: ctx.route,
          limiter: ctx.limiter,
          offenderType: t.offenderType,
          offenderValue: t.offenderValue,
          tripCountBucket: t.bucket,
          windowMinutes: windowMinutesApplied,
          thresholdApplied,
          message:
            `${t.offenderType}=${t.offenderValue} has been blocked by ${ctx.limiter} ` +
            `at ${ctx.route} ${t.count} time(s) in the last ${windowMinutesApplied} minute(s) ` +
            `(>= threshold ${thresholdApplied}). Investigate for credential-stuffing ` +
            `or token-fuzzing abuse.`,
        },
      });
      result.alerted = true;
    } catch (err) {
      console.error(
        `[rate-limit-alerts] notifyOperator failed for route=${ctx.route} ` +
          `${t.offenderType}=${t.offenderValue}`,
        (err as Error)?.message ?? err,
      );
    }
  }

  return result;
}
