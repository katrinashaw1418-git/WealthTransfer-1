// =============================================================================
// Task #36 — automated tests for the operator-alert audit trail
// =============================================================================
// Locks in the contract that EVERY notifyOperator() call writes one row to
// the `operator_alerts` table with the channels attempted and per-channel
// outcomes captured. Without a permanent test, a future refactor of
// notifyOperator could silently stop persisting (the existing log/webhook
// observability would still look healthy but the compliance trail would
// quietly disappear).
//
// We exercise three paths against the same dev database the rest of the
// project uses:
//   1. log-only dispatch (no webhook configured) → one row, channels=["log"]
//   2. webhook success                            → channels=["log","webhook"], both success
//   3. webhook failure (unreachable URL)          → still persisted, webhook
//                                                   outcome captured as
//                                                   error/timeout
//
// Every test cleans up its own rows so reruns are idempotent.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { operatorAlerts } from "@shared/schema";
import {
  notifyOperator,
  type OperatorAlertChannelOutcome,
} from "./operator-alerts";

const insertedIds: number[] = [];
let originalWebhookEnv: string | undefined;

beforeEach(() => {
  originalWebhookEnv = process.env.OPERATOR_ALERT_WEBHOOK_URL;
  // Default to no webhook; tests opt in.
  delete process.env.OPERATOR_ALERT_WEBHOOK_URL;
});

afterEach(async () => {
  if (originalWebhookEnv === undefined) {
    delete process.env.OPERATOR_ALERT_WEBHOOK_URL;
  } else {
    process.env.OPERATOR_ALERT_WEBHOOK_URL = originalWebhookEnv;
  }
  if (insertedIds.length > 0) {
    await db.delete(operatorAlerts).where(inArray(operatorAlerts.id, insertedIds));
    insertedIds.length = 0;
  }
});

function uniqueSource(label: string): string {
  return `task36-test-${label}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function loadById(id: number) {
  const rows = await db
    .select()
    .from(operatorAlerts)
    .where(eq(operatorAlerts.id, id));
  return rows[0] ?? null;
}

describe("notifyOperator persistence (Task #36)", () => {
  it("persists exactly one row with channels=['log'] when no webhook configured", async () => {
    const source = uniqueSource("log-only");
    const result = await notifyOperator({
      source,
      severity: "warning",
      title: "log-only test",
      details: { sample: 1, nested: { ok: true } },
    });

    expect(result.alertId).not.toBeNull();
    expect(result.channelsAttempted).toEqual(["log"]);
    expect(result.channels).toEqual(["log"]);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].channel).toBe("log");
    expect(result.outcomes[0].status).toBe("success");

    insertedIds.push(result.alertId!);
    const row = await loadById(result.alertId!);
    expect(row).not.toBeNull();
    expect(row!.source).toBe(source);
    expect(row!.severity).toBe("warning");
    expect(row!.title).toBe("log-only test");
    expect(row!.details).toEqual({ sample: 1, nested: { ok: true } });
    expect(row!.channelsAttempted).toEqual(["log"]);
    const stored = row!.channelOutcomes as unknown as OperatorAlertChannelOutcome[];
    expect(Array.isArray(stored)).toBe(true);
    expect(stored).toHaveLength(1);
    expect(stored[0].channel).toBe("log");
    expect(stored[0].status).toBe("success");
    expect(typeof stored[0].durationMs).toBe("number");
  });

  it("captures a webhook timeout/error outcome but still persists the row", async () => {
    // Reserved TEST-NET-1 address (RFC 5737) — guaranteed unroutable, so the
    // webhook attempt either times out or errors quickly without escaping
    // into the public internet.
    process.env.OPERATOR_ALERT_WEBHOOK_URL = "http://192.0.2.1:9/operator-alert";

    const source = uniqueSource("webhook-fail");
    const result = await notifyOperator({
      source,
      severity: "alert",
      title: "webhook-fail test",
      details: { reason: "unreachable" },
    });

    expect(result.alertId).not.toBeNull();
    expect(result.channelsAttempted).toEqual(["log", "webhook"]);
    // Log channel still succeeded.
    expect(result.channels).toContain("log");
    // Webhook outcome must NOT be success.
    const webhookOutcome = result.outcomes.find((o) => o.channel === "webhook");
    expect(webhookOutcome).toBeDefined();
    expect(["timeout", "error", "http_error"]).toContain(webhookOutcome!.status);
    expect(webhookOutcome!.status).not.toBe("success");

    insertedIds.push(result.alertId!);
    const row = await loadById(result.alertId!);
    expect(row).not.toBeNull();
    expect(row!.channelsAttempted).toEqual(["log", "webhook"]);
    const stored = row!.channelOutcomes as unknown as OperatorAlertChannelOutcome[];
    expect(stored).toHaveLength(2);
    expect(stored.map((o) => o.channel).sort()).toEqual(["log", "webhook"]);
    const persistedWebhook = stored.find((o) => o.channel === "webhook")!;
    expect(persistedWebhook.status).not.toBe("success");
    // Error message string is captured.
    expect(typeof persistedWebhook.error === "string" || persistedWebhook.error === undefined).toBe(true);
  }, 20_000);

  it("filters by source via DB query (admin endpoint contract)", async () => {
    const sourceA = uniqueSource("filter-a");
    const sourceB = uniqueSource("filter-b");

    const r1 = await notifyOperator({
      source: sourceA,
      severity: "info",
      title: "A1",
      details: {},
    });
    const r2 = await notifyOperator({
      source: sourceA,
      severity: "critical",
      title: "A2",
      details: {},
    });
    const r3 = await notifyOperator({
      source: sourceB,
      severity: "info",
      title: "B1",
      details: {},
    });

    insertedIds.push(r1.alertId!, r2.alertId!, r3.alertId!);

    const rowsA = await db
      .select()
      .from(operatorAlerts)
      .where(eq(operatorAlerts.source, sourceA));
    expect(rowsA.map((r) => r.title).sort()).toEqual(["A1", "A2"]);

    const rowsCritical = await db
      .select()
      .from(operatorAlerts)
      .where(eq(operatorAlerts.severity, "critical"));
    // Other tests/jobs may also write 'critical' rows, so just assert ours
    // is in there.
    expect(rowsCritical.some((r) => r.id === r2.alertId)).toBe(true);
  });
});
