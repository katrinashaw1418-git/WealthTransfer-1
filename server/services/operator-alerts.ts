// =============================================================================
// OPERATOR ALERTS — Session 27 (Task #25)
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
// =============================================================================

export type OperatorAlertSeverity = "info" | "warning" | "alert" | "critical";

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
  /** Channels the alert was successfully dispatched to. */
  channels: Array<"log" | "webhook">;
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

function logAlert(alert: OperatorAlert): void {
  const line = `[OPERATOR ALERT] [${alert.source}] [${alert.severity}] ${alert.title}`;
  if (alert.severity === "critical" || alert.severity === "alert") {
    console.error(line, alert.details);
  } else if (alert.severity === "warning") {
    console.warn(line, alert.details);
  } else {
    console.log(line, alert.details);
  }
}

async function postWebhook(url: string, alert: OperatorAlert): Promise<void> {
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
  const timeout = setTimeout(() => controller.abort(), 5000);
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
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Dispatch an operator alert.
 *
 * Always writes to the log channel; additionally POSTs to the configured
 * webhook (if any). Webhook failures are logged but never thrown — a broken
 * notification path must not stop the calling job from completing.
 */
export async function notifyOperator(alert: OperatorAlert): Promise<OperatorAlertResult> {
  const channels: Array<"log" | "webhook"> = [];

  logAlert(alert);
  channels.push("log");

  const webhookUrl = getWebhookUrl();
  if (webhookUrl) {
    try {
      await postWebhook(webhookUrl, alert);
      channels.push("webhook");
    } catch (err) {
      console.error(
        `[operator-alerts] webhook dispatch failed for source=${alert.source}`,
        (err as Error)?.message ?? err,
      );
    }
  }

  return { channels };
}
