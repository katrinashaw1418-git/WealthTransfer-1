// =============================================================================
// OPERATOR ALERTS — Session 27 (Task #25), extended Task #36, Task #156
// =============================================================================
//
// README — what this module does, in one screen
// -----------------------------------------------------------------------------
// `notifyOperator(alert)` is the one and only way to "page an operator" from
// inside this server. It is used by:
//   * the daily wallet ↔ ledger reconciliation job (drift detection),
//   * the daily ledger ↔ custodian reconciliation job,
//   * the deposit / withdraw money-movement HTTP routes (on hard failure),
//   * the posting-receipt invariant guard,
//   * the operator-alerts-prune watchdog,
//   * the admin "Send test alert" button at /api/admin/operator-alerts/test.
//
// What it does, in order, every call:
//   1. Always writes a structured log line (the durable in-process record).
//   2. If `OPERATOR_ALERT_WEBHOOK_URL` is set, POSTs a Slack-shaped payload
//      to it. If the POST returns 5xx or times out, retries ONCE after a
//      short backoff, then gives up and records an outcome of
//      `http_error`/`timeout`. 4xx responses are treated as terminal — a
//      receiver that rejects the payload will reject the retry too.
//   3. Coalesces duplicates inside a sliding window
//      (`OPERATOR_ALERT_DEDUPE_WINDOW_MIN`, default 15 minutes). The
//      coalescing key is
//         sha256(`${kind}|${subjectType}|${subjectId}|${payloadHash}`)
//      where `kind`/`subjectType`/`subjectId` come from the alert (with
//      sensible fallbacks based on `source` + payload), and `payloadHash`
//      is sha256 of the JSON-serialised `details`. Inside the window, a
//      second alert with the same key:
//         * does NOT post the webhook a second time,
//         * increments `occurrences` on the existing row,
//         * bumps `lastSeenAt` to "now",
//         * is reported back to the caller with `deliveryStatus =
//           "suppressed_duplicate"` and the original alertId.
//   4. Persists exactly one `operator_alerts` row per dispatch (or
//      coalesced update) with the per-channel outcomes and a top-level
//      `delivery_status` of `delivered` | `failed` | `suppressed_duplicate`.
//
// Configuration (all optional, all read at call time so .env edits are picked
// up by the next dispatch without a restart):
//   * OPERATOR_ALERT_WEBHOOK_URL          — destination for the webhook channel.
//   * OPERATOR_ALERT_DEDUPE_WINDOW_MIN    — sliding window in minutes; default 15.
//                                           Set to 0 to disable coalescing.
//   * OPERATOR_ALERT_WEBHOOK_TIMEOUT_MS   — per-attempt deadline; default 5000.
//
// Boot-time visibility: server/index.ts calls `logOperatorAlertsStartup()`
// during boot so the operator can see in the log stream whether the webhook
// is configured (and what window the dedupe is using). A misconfigured
// webhook URL is therefore visible BEFORE the first alert fires, not at the
// moment of an outage.
//
// Design rules (kept verbatim from Task #25 / #36 — they still hold):
//   * The log channel is ALWAYS written. A misconfigured webhook must not
//     swallow the alert.
//   * The webhook channel is fire-and-forget — webhook errors are logged
//     and surfaced via `deliveryStatus`, but they do NOT bubble up to the
//     caller. A flaky webhook can never break the cron / route that
//     triggered the alert.
//   * The DB write is wrapped in its own try/catch with the same contract.
//     A DB outage cannot break the calling cron, but it WILL be logged
//     loudly so the gap in the audit trail is itself observable.
//   * The payload schema is stable (severity/source/title/details/timestamp)
//     so a downstream Slack/PagerDuty/email forwarder can reformat without
//     re-reading job-specific code.
// =============================================================================

import { createHash } from "node:crypto";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  operatorAlerts,
  operatorAlertAcknowledgements,
  type InsertOperatorAlertRecord,
  type OperatorAlertAcknowledgement,
} from "@shared/schema";

export type OperatorAlertSeverity = "info" | "warning" | "alert" | "critical";

export type OperatorAlertChannel = "log" | "webhook";

/**
 * Discrete outcome categories for a single channel attempt.
 *   - success    : channel accepted the alert (log written / webhook 2xx)
 *   - http_error : webhook responded with a non-2xx status code
 *   - timeout    : channel call exceeded its hard deadline (AbortError)
 *   - error      : any other failure (network error, DNS, thrown exception)
 *
 * Kept narrow on purpose: the admin viewer renders these as fixed badges, so
 * adding a new outcome requires updating both this union AND the UI.
 */
export type OperatorAlertChannelStatus =
  | "success"
  | "http_error"
  | "timeout"
  | "error";

/**
 * Top-level status for the dispatch. Rolls up the per-channel outcomes plus
 * the dedupe decision so the admin UI can render a single badge per row.
 */
export type OperatorAlertDeliveryStatus =
  | "delivered"
  | "failed"
  | "suppressed_duplicate";

export interface OperatorAlertChannelOutcome {
  channel: OperatorAlertChannel;
  status: OperatorAlertChannelStatus;
  /** HTTP status code for webhook outcomes (success or http_error). */
  httpStatus?: number;
  /** Truncated error message for non-success outcomes. */
  error?: string;
  /** Wall-clock duration of the channel attempt in milliseconds. */
  durationMs: number;
  /** Webhook attempt number (1 = first try, 2 = retry). Omitted for log. */
  attempt?: number;
}

export interface OperatorAlert {
  /**
   * Free-form identifier for the originating job (e.g. "wallet-ledger-reconciliation").
   * Used as the log-line prefix and the webhook payload `source` field so
   * downstream routing can fan out by source.
   */
  source: string;
  /** Severity drives whether the log line uses warn/error/log. */
  severity: OperatorAlertSeverity;
  /** Short human-readable summary, e.g. "Wallet cache drift detected". */
  title: string;
  /** Structured payload. Keys/values are surfaced verbatim in the log line. */
  details: Record<string, unknown>;
  /**
   * Optional dedupe inputs (Task #156). When omitted the dispatcher derives
   * sensible defaults from `source` + `details` (see `deriveDedupeKey`). The
   * dedupe key is `sha256(kind|subjectType|subjectId|payloadHash)`.
   */
  kind?: string;
  subjectType?: string;
  subjectId?: string | number | null;
}

export interface OperatorAlertResult {
  /**
   * Channels we attempted to dispatch to, in dispatch order. Always contains
   * "log"; contains "webhook" too when OPERATOR_ALERT_WEBHOOK_URL is set
   * AND the alert was not suppressed as a duplicate.
   */
  channelsAttempted: OperatorAlertChannel[];
  /** Per-channel outcomes (one entry per attempted channel). */
  outcomes: OperatorAlertChannelOutcome[];
  /**
   * Backwards-compatible convenience: the subset of attempted channels that
   * succeeded. Pre-Task-#36 callers used this field; left in place so a
   * future change to OperatorAlertResult does not silently shift behaviour
   * for any consumer that destructured `channels`.
   */
  channels: OperatorAlertChannel[];
  /**
   * Primary key of the persisted `operator_alerts` row, or null if the
   * audit-log insert failed. A null here is a real ops signal — the alert
   * itself was still dispatched, but the durable record was not written.
   * On a suppressed-as-duplicate dispatch this is the id of the EARLIER
   * row that absorbed the new firing.
   */
  alertId: number | null;
  /** Top-level outcome (delivered / failed / suppressed_duplicate). */
  deliveryStatus: OperatorAlertDeliveryStatus;
  /** Total firings the persisted row has now seen (>= 1). */
  occurrences: number;
  /** Hex-encoded dedupe key actually used for this dispatch. */
  dedupeKey: string;
}

const DEFAULT_WEBHOOK_TIMEOUT_MS = 5000;
const DEFAULT_DEDUPE_WINDOW_MIN = 15;
const RETRY_BACKOFF_MS = 250;
// Cap on stored error strings so a runaway stack trace can't bloat a row.
const MAX_ERROR_LEN = 500;

function truncateError(err: unknown): string {
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
  return raw.length > MAX_ERROR_LEN ? raw.slice(0, MAX_ERROR_LEN) + "…" : raw;
}

/**
 * Resolve the configured webhook URL at call time so test harnesses /
 * deployments that set the env var after import still see it. Returns null
 * when unset so we know to skip the webhook channel quietly.
 */
function getWebhookUrl(): string | null {
  const raw = process.env.OPERATOR_ALERT_WEBHOOK_URL;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getWebhookTimeoutMs(): number {
  const raw = process.env.OPERATOR_ALERT_WEBHOOK_TIMEOUT_MS;
  if (!raw) return DEFAULT_WEBHOOK_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WEBHOOK_TIMEOUT_MS;
  return Math.floor(n);
}

/**
 * Sliding window in milliseconds. 0 disables coalescing entirely (every
 * firing inserts a fresh row and re-posts the webhook). Negative / NaN env
 * values fall back to the default rather than throwing — a typo must never
 * silently disable the dispatcher.
 */
export function getDedupeWindowMs(): number {
  const raw = process.env.OPERATOR_ALERT_DEDUPE_WINDOW_MIN;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_DEDUPE_WINDOW_MIN * 60_000;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return DEFAULT_DEDUPE_WINDOW_MIN * 60_000;
  }
  return Math.floor(n) * 60_000;
}

/**
 * Boot-time line so operators can see whether the webhook is wired without
 * waiting for the first real alert to fire. Called once from server/index.ts
 * during startup. Safe to call multiple times.
 */
export function logOperatorAlertsStartup(): void {
  const url = getWebhookUrl();
  const windowMs = getDedupeWindowMs();
  const windowDesc = windowMs === 0 ? "disabled" : `${Math.round(windowMs / 60_000)}m`;
  if (url) {
    // Don't log the URL itself — webhook URLs are credentials.
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      host = "(unparseable URL)";
    }
    console.log(
      `[operator-alerts] webhook configured (host=${host}, dedupe=${windowDesc}, timeout=${getWebhookTimeoutMs()}ms)`,
    );
  } else {
    console.warn(
      `[operator-alerts] webhook NOT configured — alerts will write to the log channel only. ` +
        `Set OPERATOR_ALERT_WEBHOOK_URL to enable webhook delivery (dedupe=${windowDesc}).`,
    );
  }
}

function logAlert(alert: OperatorAlert): OperatorAlertChannelOutcome {
  const startedAt = Date.now();
  const line = `[OPERATOR ALERT] [${alert.source}] [${alert.severity}] ${alert.title}`;
  try {
    if (alert.severity === "critical" || alert.severity === "alert") {
      console.error(line, alert.details);
    } else if (alert.severity === "warning") {
      console.warn(line, alert.details);
    } else {
      console.log(line, alert.details);
    }
    return {
      channel: "log",
      status: "success",
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    // console.* failures are exceptionally rare (e.g. closed stdout in a
    // pathological harness), but surface them honestly rather than crash.
    return {
      channel: "log",
      status: "error",
      error: truncateError(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function postWebhookOnce(
  url: string,
  alert: OperatorAlert,
  attempt: number,
): Promise<OperatorAlertChannelOutcome> {
  const startedAt = Date.now();
  // Slack-compatible incoming-webhook shape: a top-level `text` field is
  // rendered as the message preview, and `attachments[0].fields` becomes
  // the structured detail block in Slack. Non-Slack receivers can still
  // read the same JSON because the keys are plain strings.
  const text = `[${alert.severity.toUpperCase()}] ${alert.source}: ${alert.title}`;
  const fields = Object.entries(alert.details).map(([k, v]) => ({
    title: k,
    value: typeof v === "string" ? v : JSON.stringify(v),
    short: true,
  }));
  const body = {
    text,
    attachments: [
      {
        color:
          alert.severity === "critical"
            ? "danger"
            : alert.severity === "alert"
              ? "warning"
              : alert.severity === "warning"
                ? "#f0ad4e"
                : "good",
        fields,
        ts: Math.floor(Date.now() / 1000),
      },
    ],
    source: alert.source,
    severity: alert.severity,
    title: alert.title,
    details: alert.details,
  };

  // Hard-cap the webhook call so a slow receiver cannot stall the cron.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getWebhookTimeoutMs());
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(
        `[operator-alerts] webhook responded ${res.status} ${res.statusText} for source=${alert.source} (attempt ${attempt})`,
      );
      return {
        channel: "webhook",
        status: "http_error",
        httpStatus: res.status,
        error: `${res.status} ${res.statusText}`.trim(),
        durationMs: Date.now() - startedAt,
        attempt,
      };
    }
    return {
      channel: "webhook",
      status: "success",
      httpStatus: res.status,
      durationMs: Date.now() - startedAt,
      attempt,
    };
  } catch (err) {
    // AbortError surfaces as DOMException("AbortError") in Node 20+.
    const isAbort =
      (err as { name?: string })?.name === "AbortError" ||
      (err as Error)?.message?.toLowerCase?.().includes("aborted");
    console.error(
      `[operator-alerts] webhook dispatch failed for source=${alert.source} (attempt ${attempt})`,
      (err as Error)?.message ?? err,
    );
    return {
      channel: "webhook",
      status: isAbort ? "timeout" : "error",
      error: truncateError(err),
      durationMs: Date.now() - startedAt,
      attempt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Webhook delivery with retry-once on 5xx / timeout / network error. Returns
 * BOTH attempts in `outcomes` so the admin UI can show that the dispatcher
 * tried twice; the most-recent attempt determines the rolled-up
 * `deliveryStatus`. 4xx responses are terminal — receivers that reject the
 * payload (bad signature, schema mismatch) will reject the retry too, and
 * a hot retry loop only doubles the noise.
 */
async function postWebhookWithRetry(
  url: string,
  alert: OperatorAlert,
): Promise<OperatorAlertChannelOutcome[]> {
  const outcomes: OperatorAlertChannelOutcome[] = [];
  const first = await postWebhookOnce(url, alert, 1);
  outcomes.push(first);
  const shouldRetry =
    first.status === "timeout" ||
    first.status === "error" ||
    (first.status === "http_error" &&
      first.httpStatus !== undefined &&
      first.httpStatus >= 500);
  if (!shouldRetry) return outcomes;

  await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
  const second = await postWebhookOnce(url, alert, 2);
  outcomes.push(second);
  return outcomes;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function stableStringify(v: unknown): string {
  // Sort object keys recursively so semantically-identical payloads always
  // hash to the same value, regardless of property insertion order.
  const seen = new WeakSet<object>();
  const walk = (x: unknown): unknown => {
    if (x === null || typeof x !== "object") return x;
    if (seen.has(x as object)) return null;
    seen.add(x as object);
    if (Array.isArray(x)) return x.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x as Record<string, unknown>).sort()) {
      out[k] = walk((x as Record<string, unknown>)[k]);
    }
    return out;
  };
  try {
    return JSON.stringify(walk(v));
  } catch {
    return String(v);
  }
}

/**
 * Compute the dedupe key the dispatcher will use. Visible for tests so
 * fixtures can assert that two alerts with the same logical identity hash
 * to the same key.
 */
export function deriveDedupeKey(alert: OperatorAlert): string {
  const kind = alert.kind ?? alert.source;
  const subjectType = alert.subjectType ?? "unknown";
  // Subject id falls back to a stable substring of the title so unrelated
  // alerts from the same source don't collapse onto each other when the
  // caller forgets to pass an explicit subjectId.
  const subjectIdRaw =
    alert.subjectId !== undefined && alert.subjectId !== null
      ? String(alert.subjectId)
      : alert.title;
  const payloadHash = sha256Hex(stableStringify(alert.details ?? {}));
  return sha256Hex(`${kind}|${subjectType}|${subjectIdRaw}|${payloadHash}`);
}

/**
 * Find the most-recent `operator_alerts` row inside the dedupe window with
 * the given key, or null if none exists. Returned row shape is intentionally
 * narrow — we only need the id + occurrences counter to update it.
 */
async function findRecentDuplicate(
  dedupeKey: string,
  windowMs: number,
): Promise<{ id: number; occurrences: number } | null> {
  if (windowMs <= 0) return null;
  const cutoff = new Date(Date.now() - windowMs);
  try {
    const rows = await db
      .select({
        id: operatorAlerts.id,
        occurrences: operatorAlerts.occurrences,
      })
      .from(operatorAlerts)
      .where(
        and(
          eq(operatorAlerts.dedupeKey, dedupeKey),
          gte(operatorAlerts.lastSeenAt, cutoff),
        ),
      )
      .orderBy(desc(operatorAlerts.lastSeenAt), desc(operatorAlerts.id))
      .limit(1);
    return rows[0] ?? null;
  } catch (err) {
    // A read failure here is annoying but not fatal — fall through to a
    // fresh insert so the alert still reaches the operator. The DB error
    // is logged so the dropped dedupe is observable.
    console.error(
      `[operator-alerts] dedupe lookup failed for key=${dedupeKey.slice(0, 12)}…`,
      (err as Error)?.message ?? err,
    );
    return null;
  }
}

/**
 * Increment an existing row's occurrence counter and bump its lastSeenAt.
 * Returns the new occurrences value, or null on failure (the caller will
 * fall back to a fresh insert so the operator is not silently dropped).
 */
async function bumpDuplicate(rowId: number): Promise<number | null> {
  try {
    const updated = await db
      .update(operatorAlerts)
      .set({
        occurrences: sql`${operatorAlerts.occurrences} + 1`,
        lastSeenAt: new Date(),
      })
      .where(eq(operatorAlerts.id, rowId))
      .returning({ occurrences: operatorAlerts.occurrences });
    return updated[0]?.occurrences ?? null;
  } catch (err) {
    console.error(
      `[operator-alerts] failed to bump duplicate id=${rowId}`,
      (err as Error)?.message ?? err,
    );
    return null;
  }
}

/**
 * Persist the dispatched alert to `operator_alerts`. Wrapped in its own
 * try/catch so a DB outage cannot break the caller (same contract as the
 * webhook channel). Returns the new row id, or null if the insert failed.
 */
async function persistAlert(
  alert: OperatorAlert,
  channelsAttempted: OperatorAlertChannel[],
  outcomes: OperatorAlertChannelOutcome[],
  dedupeKey: string,
  deliveryStatus: OperatorAlertDeliveryStatus,
): Promise<number | null> {
  const row: InsertOperatorAlertRecord = {
    source: alert.source,
    severity: alert.severity,
    title: alert.title,
    details: alert.details as Record<string, unknown>,
    channelsAttempted,
    channelOutcomes: outcomes as unknown as Record<string, unknown>,
    dedupeKey,
    deliveryStatus,
  };
  try {
    const inserted = await db
      .insert(operatorAlerts)
      .values(row)
      .returning({ id: operatorAlerts.id });
    return inserted[0]?.id ?? null;
  } catch (err) {
    // Logging only — we already paged the operator via log/webhook. The
    // missing audit-trail row is itself an ops issue worth surfacing.
    console.error(
      `[operator-alerts] failed to persist alert for source=${alert.source}`,
      (err as Error)?.message ?? err,
    );
    return null;
  }
}

/**
 * Roll the per-channel outcomes up into a single delivery status. Rules:
 *   * "delivered"            — every attempted channel that ran ended in
 *                              success on its final attempt (for webhook,
 *                              the LAST outcome is the final attempt). When
 *                              no webhook is configured, a successful log
 *                              channel alone counts as delivered — there is
 *                              nothing else we could have tried.
 *   * "failed"               — at least one attempted channel ended in a
 *                              non-success final outcome.
 */
function rollUpDeliveryStatus(
  outcomes: OperatorAlertChannelOutcome[],
): OperatorAlertDeliveryStatus {
  // Group outcomes by channel, keep only the LAST one per channel (the
  // final retry, in webhook's case). If any channel's final outcome is not
  // "success", the whole dispatch is "failed".
  const finalByChannel = new Map<string, OperatorAlertChannelStatus>();
  for (const o of outcomes) {
    finalByChannel.set(o.channel, o.status);
  }
  let allSuccess = true;
  finalByChannel.forEach((status) => {
    if (status !== "success") allSuccess = false;
  });
  return allSuccess ? "delivered" : "failed";
}

/**
 * Dispatch an operator alert.
 *
 * Always writes to the log channel; additionally POSTs to the configured
 * webhook (with one retry on 5xx/timeout/error). Coalesces duplicates inside
 * the configured window — see file header for the full contract. Returns a
 * structured result so callers can react to suppressed-as-duplicate or
 * delivery_failed without re-querying the DB.
 */
export async function notifyOperator(alert: OperatorAlert): Promise<OperatorAlertResult> {
  const dedupeKey = deriveDedupeKey(alert);
  const windowMs = getDedupeWindowMs();

  // --- Coalescing path (Task #156) --------------------------------------
  const existing = await findRecentDuplicate(dedupeKey, windowMs);
  if (existing) {
    const newOccurrences = await bumpDuplicate(existing.id);
    if (newOccurrences !== null) {
      // Still write the log line so the suppressed firing is visible in
      // stdout — the operator can grep the log even if the webhook was
      // suppressed by design.
      const logOutcome = logAlert(alert);
      console.log(
        `[operator-alerts] suppressed duplicate for source=${alert.source} ` +
          `(alertId=${existing.id}, occurrences=${newOccurrences})`,
      );
      return {
        channelsAttempted: ["log"],
        outcomes: [logOutcome],
        channels: logOutcome.status === "success" ? ["log"] : [],
        alertId: existing.id,
        deliveryStatus: "suppressed_duplicate",
        occurrences: newOccurrences,
        dedupeKey,
      };
    }
    // Bump failed — fall through to a fresh dispatch so the operator
    // still hears about it.
  }

  // --- Fresh dispatch ---------------------------------------------------
  const channelsAttempted: OperatorAlertChannel[] = [];
  const outcomes: OperatorAlertChannelOutcome[] = [];

  // Log channel (always)
  channelsAttempted.push("log");
  outcomes.push(logAlert(alert));

  // Webhook channel (when configured)
  const webhookUrl = getWebhookUrl();
  if (webhookUrl) {
    channelsAttempted.push("webhook");
    try {
      const webhookOutcomes = await postWebhookWithRetry(webhookUrl, alert);
      outcomes.push(...webhookOutcomes);
    } catch (err) {
      // Defensive — postWebhookOnce already captures its own throws.
      outcomes.push({
        channel: "webhook",
        status: "error",
        error: truncateError(err),
        durationMs: 0,
        attempt: 1,
      });
    }
  }

  const deliveryStatus = rollUpDeliveryStatus(outcomes);
  const successfulChannels = Array.from(
    new Set(
      outcomes
        .filter((o) => o.status === "success")
        .map((o) => o.channel),
    ),
  );

  // Audit trail
  const alertId = await persistAlert(
    alert,
    channelsAttempted,
    outcomes,
    dedupeKey,
    deliveryStatus,
  );

  return {
    channelsAttempted,
    outcomes,
    channels: successfulChannels,
    alertId,
    deliveryStatus,
    occurrences: 1,
    dedupeKey,
  };
}

// =============================================================================
// TASK #145 — Generic acknowledgement-based suppression
// -----------------------------------------------------------------------------
// Mirrors the wallet-drift suppression flow but is generic over any
// (alertSource, suppressionKey) pair, so the three new alert types added in
// this task — audit-log write failures, stuck pending transactions, and DB
// connection drops — can be ack'd by operators without re-paging.
//
// Hard rule (mirroring wallet-drift): the diagnostic side-effects of the
// CALLER (logged lines, rows in service-specific run tables, etc.) are
// unchanged. Only the dispatch path is suppressed for the ack'd case. We do
// NOT write a new operator_alerts row for the suppressed case — that would
// just push noise into the very table we are trying to keep readable.
// =============================================================================

/**
 * Look up the most recent ACTIVE acknowledgement for a (source, key) pair.
 * The partial unique index `operator_alert_ack_active_uidx` guarantees at
 * most one such row exists; the LIMIT 1 here is defensive only.
 */
export async function getActiveOperatorAlertAcknowledgement(
  alertSource: string,
  suppressionKey: string,
): Promise<OperatorAlertAcknowledgement | null> {
  const [row] = await db
    .select()
    .from(operatorAlertAcknowledgements)
    .where(
      and(
        eq(operatorAlertAcknowledgements.alertSource, alertSource),
        eq(operatorAlertAcknowledgements.suppressionKey, suppressionKey),
        isNull(operatorAlertAcknowledgements.clearedAt),
      ),
    )
    .orderBy(desc(operatorAlertAcknowledgements.acknowledgedAt))
    .limit(1);
  return row ?? null;
}

export type SuppressedOperatorAlertResult =
  | {
      suppressed: true;
      ack: OperatorAlertAcknowledgement;
      result: null;
    }
  | {
      suppressed: false;
      ack: null;
      result: OperatorAlertResult;
    };

/**
 * Dispatch an operator alert ONLY when there is no active acknowledgement
 * for `(alert.source, suppressionKey)`. When suppressed, returns the
 * acknowledgement record so the caller can log a one-line "alert suppressed"
 * message with the ack id / acknowledger / date. When not suppressed,
 * delegates to `notifyOperator` and returns its result.
 *
 * Failure-mode: **fail OPEN on ack lookup errors** — if the ack lookup throws
 * (e.g. DB outage), we MUST still dispatch the alert. The two highest-stakes
 * callers of this helper are the audit-write-failure alert and the
 * db-connection-failure watcher; for both of those the DB is exactly what's
 * failing, so a fail-closed lookup would silently never page anyone in the
 * exact scenarios these alerts exist to surface. We log the lookup failure
 * loudly (so the missing suppression check is itself visible in ops logs)
 * and then dispatch via `notifyOperator` as if no ack existed.
 */
export async function notifyOperatorWithSuppression(
  alert: OperatorAlert,
  suppressionKey: string,
): Promise<SuppressedOperatorAlertResult> {
  let ack: OperatorAlertAcknowledgement | null = null;
  try {
    ack = await getActiveOperatorAlertAcknowledgement(
      alert.source,
      suppressionKey,
    );
  } catch (lookupErr) {
    console.error(
      `[operator-alerts] suppression lookup FAILED for source=${alert.source} ` +
        `key=${suppressionKey} — failing OPEN and dispatching anyway:`,
      (lookupErr as Error)?.message ?? lookupErr,
    );
    const result = await notifyOperator(alert);
    return { suppressed: false, ack: null, result };
  }
  if (ack) {
    const ackDate = ack.acknowledgedAt.toISOString().slice(0, 10);
    console.log(
      `[operator-alerts] dispatch suppressed: source=${alert.source} ` +
        `key=${suppressionKey} (acknowledged on ${ackDate}, ack id=${ack.id})`,
    );
    return { suppressed: true, ack, result: null };
  }
  const result = await notifyOperator(alert);
  return { suppressed: false, ack: null, result };
}
