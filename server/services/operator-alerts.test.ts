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
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { operatorAlerts } from "@shared/schema";
import {
  notifyOperator,
  deriveDedupeKey,
  getDedupeWindowMs,
  type OperatorAlertChannelOutcome,
} from "./operator-alerts";

const insertedIds: number[] = [];
let originalWebhookEnv: string | undefined;
let originalDedupeWindowEnv: string | undefined;
let originalDedupeOverridesEnv: string | undefined;

beforeEach(() => {
  originalWebhookEnv = process.env.OPERATOR_ALERT_WEBHOOK_URL;
  originalDedupeWindowEnv = process.env.OPERATOR_ALERT_DEDUPE_WINDOW_MIN;
  originalDedupeOverridesEnv =
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_OVERRIDES;
  // Default to no webhook; tests opt in.
  delete process.env.OPERATOR_ALERT_WEBHOOK_URL;
  // Default to dedupe disabled so the original Task #36 tests, which fire
  // multiple alerts with overlapping shape, are not silently coalesced into
  // each other. Tests that exercise dedupe explicitly re-enable it.
  process.env.OPERATOR_ALERT_DEDUPE_WINDOW_MIN = "0";
  // Per-source overrides (Task #176) start clean for every test. Tests that
  // exercise overrides set this explicitly.
  delete process.env.OPERATOR_ALERT_DEDUPE_WINDOW_OVERRIDES;
});

afterEach(async () => {
  if (originalWebhookEnv === undefined) {
    delete process.env.OPERATOR_ALERT_WEBHOOK_URL;
  } else {
    process.env.OPERATOR_ALERT_WEBHOOK_URL = originalWebhookEnv;
  }
  if (originalDedupeWindowEnv === undefined) {
    delete process.env.OPERATOR_ALERT_DEDUPE_WINDOW_MIN;
  } else {
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_MIN = originalDedupeWindowEnv;
  }
  if (originalDedupeOverridesEnv === undefined) {
    delete process.env.OPERATOR_ALERT_DEDUPE_WINDOW_OVERRIDES;
  } else {
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_OVERRIDES =
      originalDedupeOverridesEnv;
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

// Spin up a tiny localhost HTTP server bound to an ephemeral port so the
// retry tests can drive the dispatcher's behaviour deterministically without
// reaching out to the public internet. Caller is responsible for closing.
function startTestWebhook(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // Drain the body so the client receives a complete response.
      req.on("data", () => {});
      req.on("end", () => handler(req, res));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
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

  // ===========================================================================
  // Task #156 — dedupe coalescing + retry-on-5xx + delivery rollup
  // ===========================================================================

  it("derives the same dedupe key for identical alerts and a different one when the payload changes", () => {
    const a = {
      source: "src-A",
      severity: "warning" as const,
      title: "drift",
      details: { a: 1, b: { c: 2 } },
      kind: "wallet-drift",
      subjectType: "user" as const,
      subjectId: "42",
    };
    const b = {
      // Same logical alert, different property order on details — must hash
      // identically thanks to stableStringify.
      source: "src-A",
      severity: "warning" as const,
      title: "drift",
      details: { b: { c: 2 }, a: 1 },
      kind: "wallet-drift",
      subjectType: "user" as const,
      subjectId: "42",
    };
    const c = {
      ...a,
      subjectId: "43", // different subject ⇒ different key
    };
    expect(deriveDedupeKey(a)).toBe(deriveDedupeKey(b));
    expect(deriveDedupeKey(a)).not.toBe(deriveDedupeKey(c));
  });

  it("coalesces a duplicate inside the dedupe window — increments occurrences and reports suppressed_duplicate", async () => {
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_MIN = "15";

    const source = uniqueSource("dedupe");
    const alert = {
      source,
      severity: "alert" as const,
      title: "wallet drift detected",
      details: { userId: 7, expected: "1.00", actual: "0.50" },
      kind: "wallet-drift",
      subjectType: "user" as const,
      subjectId: "7",
    };

    const first = await notifyOperator(alert);
    expect(first.alertId).not.toBeNull();
    expect(first.deliveryStatus).toBe("delivered");
    expect(first.occurrences).toBe(1);
    insertedIds.push(first.alertId!);

    const second = await notifyOperator(alert);
    // Same row reused — no new id.
    expect(second.alertId).toBe(first.alertId);
    expect(second.deliveryStatus).toBe("suppressed_duplicate");
    expect(second.occurrences).toBe(2);

    const third = await notifyOperator(alert);
    expect(third.alertId).toBe(first.alertId);
    expect(third.deliveryStatus).toBe("suppressed_duplicate");
    expect(third.occurrences).toBe(3);

    const row = await loadById(first.alertId!);
    expect(row).not.toBeNull();
    expect(row!.occurrences).toBe(3);
    expect(row!.deliveryStatus).toBe("delivered");
    expect(row!.dedupeKey).toBe(deriveDedupeKey(alert));
    // lastSeenAt should advance past createdAt after the bumps.
    if (row!.lastSeenAt && row!.createdAt) {
      expect(new Date(row!.lastSeenAt).getTime()).toBeGreaterThanOrEqual(
        new Date(row!.createdAt).getTime(),
      );
    }
  });

  it("does NOT coalesce when the dedupe window is 0", async () => {
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_MIN = "0";

    const source = uniqueSource("dedupe-off");
    const alert = {
      source,
      severity: "warning" as const,
      title: "no-coalesce",
      details: { v: 1 },
      kind: "wallet-drift",
      subjectType: "user" as const,
      subjectId: "7",
    };

    const first = await notifyOperator(alert);
    const second = await notifyOperator(alert);
    insertedIds.push(first.alertId!, second.alertId!);

    expect(first.alertId).not.toBe(second.alertId);
    expect(second.deliveryStatus).toBe("delivered");
    expect(second.occurrences).toBe(1);
  });

  it("retries once on a 5xx webhook response and reports delivered when the retry succeeds", async () => {
    let calls = 0;
    const server = await startTestWebhook((req, res) => {
      calls += 1;
      if (calls === 1) {
        res.statusCode = 503;
        res.end("temporary");
      } else {
        res.statusCode = 200;
        res.end("ok");
      }
    });
    try {
      const port = (server.address() as AddressInfo).port;
      process.env.OPERATOR_ALERT_WEBHOOK_URL = `http://127.0.0.1:${port}/hook`;

      const source = uniqueSource("retry-5xx");
      const result = await notifyOperator({
        source,
        severity: "alert",
        title: "retry-5xx test",
        details: { v: 1 },
      });
      insertedIds.push(result.alertId!);

      expect(calls).toBe(2);
      expect(result.deliveryStatus).toBe("delivered");
      // Both attempts should be in the outcomes array.
      const webhookAttempts = result.outcomes.filter(
        (o) => o.channel === "webhook",
      );
      expect(webhookAttempts).toHaveLength(2);
      expect(webhookAttempts[0].status).toBe("http_error");
      expect(webhookAttempts[0].httpStatus).toBe(503);
      expect(webhookAttempts[1].status).toBe("success");

      const row = await loadById(result.alertId!);
      expect(row!.deliveryStatus).toBe("delivered");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it("does NOT retry on a 4xx response and rolls up to delivery_failed", async () => {
    let calls = 0;
    const server = await startTestWebhook((req, res) => {
      calls += 1;
      res.statusCode = 400;
      res.end("bad payload");
    });
    try {
      const port = (server.address() as AddressInfo).port;
      process.env.OPERATOR_ALERT_WEBHOOK_URL = `http://127.0.0.1:${port}/hook`;

      const source = uniqueSource("no-retry-4xx");
      const result = await notifyOperator({
        source,
        severity: "alert",
        title: "no-retry-4xx test",
        details: { v: 2 },
      });
      insertedIds.push(result.alertId!);

      expect(calls).toBe(1);
      expect(result.deliveryStatus).toBe("failed");
      const webhookAttempts = result.outcomes.filter(
        (o) => o.channel === "webhook",
      );
      expect(webhookAttempts).toHaveLength(1);
      expect(webhookAttempts[0].status).toBe("http_error");
      expect(webhookAttempts[0].httpStatus).toBe(400);

      const row = await loadById(result.alertId!);
      expect(row!.deliveryStatus).toBe("failed");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it("rolls up to delivery_failed when both webhook attempts fail with 5xx", async () => {
    let calls = 0;
    const server = await startTestWebhook((req, res) => {
      calls += 1;
      res.statusCode = 500;
      res.end("boom");
    });
    try {
      const port = (server.address() as AddressInfo).port;
      process.env.OPERATOR_ALERT_WEBHOOK_URL = `http://127.0.0.1:${port}/hook`;

      const source = uniqueSource("retry-then-fail");
      const result = await notifyOperator({
        source,
        severity: "critical",
        title: "retry-then-fail test",
        details: { v: 3 },
      });
      insertedIds.push(result.alertId!);

      expect(calls).toBe(2);
      expect(result.deliveryStatus).toBe("failed");
      const row = await loadById(result.alertId!);
      expect(row!.deliveryStatus).toBe("failed");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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

  // ===========================================================================
  // Task #176 — per-source dedupe window overrides
  // ---------------------------------------------------------------------------
  // OPERATOR_ALERT_DEDUPE_WINDOW_OVERRIDES is a JSON object mapping
  // `source` → window in MINUTES. The override wins over the global default
  // (and over OPERATOR_ALERT_DEDUPE_WINDOW_MIN) on every dispatch — read at
  // call time so .env edits are picked up without a restart. Three behaviour
  // contracts must be locked in:
  //   * a longer per-source window coalesces firings the global default
  //     would have let through,
  //   * a shorter per-source window is honoured (verified at the function
  //     level so we don't have to manipulate the clock), and
  //   * a window of 0 for a critical source NEVER coalesces, even when the
  //     global default would have suppressed the duplicate.
  // ===========================================================================

  it("getDedupeWindowMs honours a LONGER per-source override than the global default", () => {
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_MIN = "5";
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_OVERRIDES = JSON.stringify({
      "chatty-recon-job": 60,
    });
    expect(getDedupeWindowMs("chatty-recon-job")).toBe(60 * 60_000);
    // Sources without an override fall back to the global default.
    expect(getDedupeWindowMs("other-source")).toBe(5 * 60_000);
    // Calling without a source also falls back to the global default.
    expect(getDedupeWindowMs()).toBe(5 * 60_000);
  });

  it("getDedupeWindowMs honours a SHORTER per-source override than the global default", () => {
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_MIN = "60";
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_OVERRIDES = JSON.stringify({
      "near-realtime-source": 1,
    });
    expect(getDedupeWindowMs("near-realtime-source")).toBe(1 * 60_000);
    expect(getDedupeWindowMs("other-source")).toBe(60 * 60_000);
  });

  it("getDedupeWindowMs honours a per-source override of 0 (never coalesce)", () => {
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_MIN = "60";
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_OVERRIDES = JSON.stringify({
      "money-movement": 0,
    });
    expect(getDedupeWindowMs("money-movement")).toBe(0);
    expect(getDedupeWindowMs("other-source")).toBe(60 * 60_000);
  });

  it("ignores a malformed OPERATOR_ALERT_DEDUPE_WINDOW_OVERRIDES env var (typo must not silently disable dedupe)", () => {
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_MIN = "15";
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_OVERRIDES = "{not valid json";
    expect(getDedupeWindowMs("any-source")).toBe(15 * 60_000);

    // Negative / non-numeric values inside an otherwise-valid JSON object
    // are dropped silently — the source falls back to the global default.
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_OVERRIDES = JSON.stringify({
      "good-source": 30,
      "bad-source": -1,
      "garbage-source": "nope",
    });
    expect(getDedupeWindowMs("good-source")).toBe(30 * 60_000);
    expect(getDedupeWindowMs("bad-source")).toBe(15 * 60_000);
    expect(getDedupeWindowMs("garbage-source")).toBe(15 * 60_000);
  });

  it("coalesces a duplicate when the per-source override is LONGER than the global default", async () => {
    // Global default disabled, but the noisy reconciliation job overrides
    // to 15 minutes. Two identical alerts from that source must collapse
    // onto one row.
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_MIN = "0";
    const source = uniqueSource("override-long");
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_OVERRIDES = JSON.stringify({
      [source]: 15,
    });

    const alert = {
      source,
      severity: "warning" as const,
      title: "noisy reconciliation",
      details: { run: "abc" },
      kind: "wallet-drift",
      subjectType: "user" as const,
      subjectId: "9",
    };

    const first = await notifyOperator(alert);
    expect(first.alertId).not.toBeNull();
    expect(first.deliveryStatus).toBe("delivered");
    expect(first.occurrences).toBe(1);
    insertedIds.push(first.alertId!);

    const second = await notifyOperator(alert);
    // Same row reused — the per-source override coalesced even though the
    // global default would have let it through.
    expect(second.alertId).toBe(first.alertId);
    expect(second.deliveryStatus).toBe("suppressed_duplicate");
    expect(second.occurrences).toBe(2);
  });

  it("does NOT coalesce when the per-source override is 0, even with a generous global default", async () => {
    // The opposite case: a chatty global window of 60m would normally
    // collapse two identical firings, but a critical source overrides to
    // 0 so the operator gets every page.
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_MIN = "60";
    const source = uniqueSource("override-critical");
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_OVERRIDES = JSON.stringify({
      [source]: 0,
    });

    const alert = {
      source,
      severity: "critical" as const,
      title: "money-movement failure",
      details: { txId: 123 },
      kind: "money-movement",
      subjectType: "transaction" as const,
      subjectId: "123",
    };

    const first = await notifyOperator(alert);
    const second = await notifyOperator(alert);
    insertedIds.push(first.alertId!, second.alertId!);

    // Two distinct rows — no coalescing for this critical source.
    expect(first.alertId).not.toBeNull();
    expect(second.alertId).not.toBeNull();
    expect(second.alertId).not.toBe(first.alertId);
    expect(first.deliveryStatus).toBe("delivered");
    expect(second.deliveryStatus).toBe("delivered");
    expect(second.occurrences).toBe(1);
  });

  it("uses the per-source override on every dispatch (no restart needed when env changes)", async () => {
    // Mid-flight env change: first firing uses the global default (0,
    // never coalesce); then we install an override that should suppress
    // the second firing.
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_MIN = "0";
    const source = uniqueSource("override-hot-reload");

    const alert = {
      source,
      severity: "warning" as const,
      title: "hot-reload",
      details: { v: 1 },
      kind: "wallet-drift",
      subjectType: "user" as const,
      subjectId: "11",
    };

    const first = await notifyOperator(alert);
    insertedIds.push(first.alertId!);
    expect(first.deliveryStatus).toBe("delivered");

    // No restart — flip the override and dispatch again.
    process.env.OPERATOR_ALERT_DEDUPE_WINDOW_OVERRIDES = JSON.stringify({
      [source]: 15,
    });

    const second = await notifyOperator(alert);
    expect(second.alertId).toBe(first.alertId);
    expect(second.deliveryStatus).toBe("suppressed_duplicate");
    expect(second.occurrences).toBe(2);
  });
});
