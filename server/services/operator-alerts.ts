// =============================================================================
// OPERATOR ALERTS — Session 27 (Task #25), extended for Task #36
// =============================================================================
// Lightweight dispatcher for "page an operator" events emitted by background
// jobs (currently the daily wallet-vs-ledger reconciliation; future callers
// can reuse it for any cron that needs to break out of the silent log stream).
//
// Design rules:
//   1. The log channel is ALWAYS written. It is the durable record that an
//      alert was raised, and it must not depend on optional configuration
//      (a misconfigured webhook should never silently swallow the alert).
//   2. The webhook channel is OPTIONAL — enabled when `OPERATOR_ALERT_WEBHOOK_URL`
//      is set. It is fire-and-forget: webhook errors are logged but do NOT
//      bubble up to the caller, so a flaky webhook can never break the
//      reconciliation job that triggered the alert.
//   3. The payload schema is stable (severity/source/title/details/timestamp)
//      so a downstream Slack/PagerDuty/email forwarder can reformat it
//      without re-reading job-specific code.
//   4. No deduplication is performed here. Each scheduled run that finds
//      drift fires one notification per mismatched (user, currency) pair —
//      this is intentional: drift that survives across days is a real ops
//      signal and should keep paging until resolved.
//
// Task #36 — durable audit trail:
//   5. Every dispatch attempts to insert one row into `operator_alerts`
//      capturing the channels attempted and the per-channel outcome
//      (success / http_error / timeout / error). The DB write is wrapped in
//      its own try/catch with the same fire-and-forget contract as the
//      webhook — a DB outage cannot break the calling cron, but it WILL be
//      logged loudly so the gap in the audit trail is itself observable.
// =============================================================================

import { db } from "../db";
import { operatorAlerts, type InsertOperatorAlertRecord } from "@shared/schema";

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

export interface OperatorAlertChannelOutcome {
  channel: OperatorAlertChannel;
  status: OperatorAlertChannelStatus;
  /** HTTP status code for webhook outcomes (success or http_error). */
  httpStatus?: number;
  /** Truncated error message for non-success outcomes. */
  error?: string;
  /** Wall-clock duration of the channel attempt in milliseconds. */
  durationMs: number;
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
}

export interface OperatorAlertResult {
  /**
   * Channels we attempted to dispatch to, in dispatch order. Always contains
   * "log"; contains "webhook" too when OPERATOR_ALERT_WEBHOOK_URL is set.
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
   */
  alertId: number | null;
}

const WEBHOOK_TIMEOUT_MS = 5000;
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

async function postWebhook(
  url: string,
  alert: OperatorAlert,
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
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(
        `[operator-alerts] webhook responded ${res.status} ${res.statusText} for source=${alert.source}`,
      );
      return {
        channel: "webhook",
        status: "http_error",
        httpStatus: res.status,
        error: `${res.status} ${res.statusText}`.trim(),
        durationMs: Date.now() - startedAt,
      };
    }
    return {
      channel: "webhook",
      status: "success",
      httpStatus: res.status,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    // AbortError surfaces as DOMException("AbortError") in Node 20+.
    const isAbort =
      (err as { name?: string })?.name === "AbortError" ||
      (err as Error)?.message?.toLowerCase?.().includes("aborted");
    console.error(
      `[operator-alerts] webhook dispatch failed for source=${alert.source}`,
      (err as Error)?.message ?? err,
    );
    return {
      channel: "webhook",
      status: isAbort ? "timeout" : "error",
      error: truncateError(err),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
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
): Promise<number | null> {
  const row: InsertOperatorAlertRecord = {
    source: alert.source,
    severity: alert.severity,
    title: alert.title,
    details: alert.details as Record<string, unknown>,
    channelsAttempted,
    channelOutcomes: outcomes as unknown as Record<string, unknown>,
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
 * Dispatch an operator alert.
 *
 * Always writes to the log channel; additionally POSTs to the configured
 * webhook (if any). After all channels resolve, persists one audit-trail
 * row to `operator_alerts` with the per-channel outcomes. Channel and DB
 * failures are logged but never thrown — a broken notification path must
 * not stop the calling job from completing.
 */
export async function notifyOperator(alert: OperatorAlert): Promise<OperatorAlertResult> {
  const channelsAttempted: OperatorAlertChannel[] = [];
  const outcomes: OperatorAlertChannelOutcome[] = [];

  // --- Log channel (always) ---------------------------------------------
  channelsAttempted.push("log");
  outcomes.push(logAlert(alert));

  // --- Webhook channel (when configured) --------------------------------
  const webhookUrl = getWebhookUrl();
  if (webhookUrl) {
    channelsAttempted.push("webhook");
    // postWebhook captures its own failures into the outcome — the
    // belt-and-braces try/catch here is for any synchronous throw before
    // the inner try/finally takes over (impossible today, but cheap).
    try {
      outcomes.push(await postWebhook(webhookUrl, alert));
    } catch (err) {
      outcomes.push({
        channel: "webhook",
        status: "error",
        error: truncateError(err),
        durationMs: 0,
      });
    }
  }

  const successfulChannels = outcomes
    .filter((o) => o.status === "success")
    .map((o) => o.channel);

  // --- Audit trail (Task #36) -------------------------------------------
  const alertId = await persistAlert(alert, channelsAttempted, outcomes);

  return {
    channelsAttempted,
    outcomes,
    channels: successfulChannels,
    alertId,
  };
}
