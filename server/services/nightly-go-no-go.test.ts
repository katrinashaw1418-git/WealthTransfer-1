// =============================================================================
// Task #217 — Nightly launch readiness gate runner tests
// =============================================================================
// Locks in the contracts the cron + admin dashboard rely on:
//
//   1. GO verdict: persists an info-level `operator_alerts` row with the
//      full report under details.report and DOES NOT call notifyOperator
//      (i.e. does not page the on-call webhook).
//
//   2. NO-GO verdict: calls notifyOperator with severity="alert", source
//      "nightly-go-no-go", and the full report under details.report. Also
//      marks `paged: true` in the returned summary.
//
//   3. Spawn failure: still calls notifyOperator (we want to know if the
//      gate itself can't even start) and returns verdict="NO-GO" with
//      exitCode=-1, paged=true.
//
//   4. Truncation: a report larger than MAX_REPORT_BYTES_IN_DETAILS is
//      truncated in details.report and details.reportTruncated=true; the
//      runner-side report file on disk is untouched.
//
//   5. Missing report file: the runner survives. The dashboard summary
//      mentions the missing report and details.reportLength=0.
//
// All persisted rows are scrubbed in afterEach so reruns are idempotent.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { eq, gte } from "drizzle-orm";
import { db } from "../db";
import { operatorAlerts } from "@shared/schema";
import {
  NIGHTLY_GO_NO_GO_SOURCE,
  NIGHTLY_GO_NO_GO_SPAWN_ARGS,
  NIGHTLY_GO_NO_GO_SPAWN_COMMAND,
  recordGoNoGoReportRow,
  runNightlyGoNoGo,
  type NightlyGoNoGoSpawner,
} from "./nightly-go-no-go";
import type { OperatorAlert, OperatorAlertResult } from "./operator-alerts";

const REPORT_DIR = path.resolve(process.cwd(), "docs", "golive");

let testStartedAt: Date;
let createdReportPaths: string[] = [];

beforeEach(() => {
  testStartedAt = new Date();
  createdReportPaths = [];
});

afterEach(async () => {
  // Scrub operator_alerts rows the test produced.
  await db
    .delete(operatorAlerts)
    .where(gte(operatorAlerts.createdAt, testStartedAt));
  // And any report files we wrote into REPORT_DIR.
  for (const p of createdReportPaths) {
    await fs.unlink(p).catch(() => undefined);
  }
});

/**
 * Build a stub spawner that pretends to be `scripts/go-no-go.ts`: writes
 * a report into REPORT_DIR (so runNightlyGoNoGo's snapshot-and-diff finds
 * it) and returns the requested exit code.
 */
function makeSpawner(opts: {
  exitCode: number;
  reportContent?: string | null;
  outputTail?: string;
}): NightlyGoNoGoSpawner {
  return async () => {
    if (opts.reportContent !== null && opts.reportContent !== undefined) {
      await fs.mkdir(REPORT_DIR, { recursive: true });
      const stamp = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const reportPath = path.join(REPORT_DIR, `go-no-go-${stamp}.md`);
      await fs.writeFile(reportPath, opts.reportContent, "utf8");
      createdReportPaths.push(reportPath);
    }
    return {
      exitCode: opts.exitCode,
      outputTail: opts.outputTail ?? "",
    };
  };
}

describe("runNightlyGoNoGo", () => {
  it("GO path: persists info row, does NOT page on-call", async () => {
    const notifySpy = vi.fn<
      [OperatorAlert],
      Promise<OperatorAlertResult>
    >();
    const goReport = `# Pre-launch GO/NO-GO report\n\n**Verdict:** **GO**\n\nA fake report from the nightly cron test.\n`;
    const spawner = makeSpawner({ exitCode: 0, reportContent: goReport });

    const result = await runNightlyGoNoGo({
      spawner,
      notifyOperator: notifySpy as unknown as typeof import("./operator-alerts").notifyOperator,
    });

    expect(result.verdict).toBe("GO");
    expect(result.exitCode).toBe(0);
    expect(result.paged).toBe(false);
    expect(notifySpy).not.toHaveBeenCalled();
    expect(result.alertId).not.toBeNull();
    expect(result.summary).toMatch(/verdict=GO/);
    expect(result.reportPath).toBeTruthy();

    const [row] = await db
      .select()
      .from(operatorAlerts)
      .where(eq(operatorAlerts.id, result.alertId!));
    expect(row.source).toBe(NIGHTLY_GO_NO_GO_SOURCE);
    expect(row.severity).toBe("info");
    expect(row.title).toBe("Nightly launch readiness gate: GO");
    expect(row.channelsAttempted).toEqual(["log"]);
    expect(row.deliveryStatus).toBe("delivered");
    const details = row.details as Record<string, unknown>;
    expect(details.verdict).toBe("GO");
    expect(details.exitCode).toBe(0);
    expect(details.report).toBe(goReport);
    expect(details.reportTruncated).toBe(false);
    expect(details.reportPath).toBe(result.reportPath);
  });

  it("NO-GO path: pages via notifyOperator with severity=alert and full report", async () => {
    const notifyArgs: OperatorAlert[] = [];
    const notifySpy = vi.fn(async (alert: OperatorAlert) => {
      notifyArgs.push(alert);
      return {
        channelsAttempted: ["log", "webhook"],
        outcomes: [],
        channels: ["log", "webhook"],
        alertId: 9999,
        deliveryStatus: "delivered",
        occurrences: 1,
        dedupeKey: "fake-dedupe-key",
      } satisfies OperatorAlertResult;
    });
    const noGoReport = `# Pre-launch GO/NO-GO report\n\n**Verdict:** **NO-GO**\n\nFAIL — Latest successful backup is fresh\n`;
    const spawner = makeSpawner({
      exitCode: 1,
      reportContent: noGoReport,
      outputTail: "[go-no-go] Verdict: NO-GO ❌",
    });

    const result = await runNightlyGoNoGo({
      spawner,
      notifyOperator: notifySpy as unknown as typeof import("./operator-alerts").notifyOperator,
    });

    expect(result.verdict).toBe("NO-GO");
    expect(result.exitCode).toBe(1);
    expect(result.paged).toBe(true);
    expect(result.alertId).toBe(9999);
    expect(result.summary).toMatch(/verdict=NO-GO.*exit=1.*paged=true/);

    expect(notifySpy).toHaveBeenCalledTimes(1);
    const dispatched = notifyArgs[0];
    expect(dispatched.source).toBe(NIGHTLY_GO_NO_GO_SOURCE);
    expect(dispatched.severity).toBe("alert");
    expect(dispatched.title).toBe("Nightly launch readiness gate: NO-GO");
    const dispatchDetails = dispatched.details as Record<string, unknown>;
    expect(dispatchDetails.verdict).toBe("NO-GO");
    expect(dispatchDetails.exitCode).toBe(1);
    expect(dispatchDetails.report).toBe(noGoReport);
    expect(dispatchDetails.reportTruncated).toBe(false);
    expect(dispatchDetails.outputTail).toContain("Verdict: NO-GO");
    expect(dispatchDetails.whatToDo).toMatch(/docs\/runbooks\/go-no-go\.md/);
  });

  it("spawn failure: pages on-call with verdict=NO-GO and exitCode=-1", async () => {
    const notifyArgs: OperatorAlert[] = [];
    const notifySpy = vi.fn(async (alert: OperatorAlert) => {
      notifyArgs.push(alert);
      return {
        channelsAttempted: ["log", "webhook"],
        outcomes: [],
        channels: ["log", "webhook"],
        alertId: 1234,
        deliveryStatus: "delivered",
        occurrences: 1,
        dedupeKey: "fake",
      } satisfies OperatorAlertResult;
    });
    const failingSpawner: NightlyGoNoGoSpawner = async () => {
      throw new Error("npx not found on PATH");
    };

    const result = await runNightlyGoNoGo({
      spawner: failingSpawner,
      notifyOperator: notifySpy as unknown as typeof import("./operator-alerts").notifyOperator,
    });

    expect(result.verdict).toBe("NO-GO");
    expect(result.exitCode).toBe(-1);
    expect(result.paged).toBe(true);
    expect(result.alertId).toBe(1234);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    const details = notifyArgs[0].details as Record<string, unknown>;
    expect(details.spawnError).toBe("npx not found on PATH");
    expect(details.verdict).toBe("NO-GO");
  });

  it("truncates the report in details when it exceeds the cap", async () => {
    // Build a report larger than the in-details cap (200KB). Using ASCII so
    // byte length == char length.
    const huge = "x".repeat(220_000);
    const spawner = makeSpawner({ exitCode: 0, reportContent: huge });

    const result = await runNightlyGoNoGo({ spawner });

    const [row] = await db
      .select()
      .from(operatorAlerts)
      .where(eq(operatorAlerts.id, result.alertId!));
    const details = row.details as Record<string, unknown>;
    expect(details.reportTruncated).toBe(true);
    expect(details.reportLength).toBe(220_000);
    expect(typeof details.report).toBe("string");
    expect((details.report as string).length).toBeLessThan(220_000);
    expect(details.report as string).toContain("[truncated to 200000 bytes");
  });

  it("missing report file: still records the run and surfaces it in the summary", async () => {
    // Spawner exits cleanly but doesn't write a report (simulates the gate
    // crashing AFTER setting exit code but BEFORE writeReport).
    const spawner = makeSpawner({ exitCode: 0, reportContent: null });

    const result = await runNightlyGoNoGo({ spawner });

    expect(result.reportPath).toBeNull();
    expect(result.alertId).not.toBeNull();
    const [row] = await db
      .select()
      .from(operatorAlerts)
      .where(eq(operatorAlerts.id, result.alertId!));
    const details = row.details as Record<string, unknown>;
    expect(details.reportLength).toBe(0);
    expect(details.report).toBe("");
  });
});

describe("NIGHTLY_GO_NO_GO_SPAWN_ARGS contract", () => {
  it("invokes scripts/go-no-go.ts with --deploy-gate to suppress nightly per-source webhook drills", () => {
    // This is a behavioral contract — without --deploy-gate, every
    // nightly tick would dispatch ~9 per-source drill alerts through
    // OPERATOR_ALERT_WEBHOOK_URL on top of our own NO-GO page, training
    // operators to ignore the channel. See scripts/go-no-go.ts modes
    // header (Task #218) and recordGoNoGoReportRow GO-path comment.
    expect(NIGHTLY_GO_NO_GO_SPAWN_COMMAND).toBe("npx");
    expect(NIGHTLY_GO_NO_GO_SPAWN_ARGS).toEqual([
      "tsx",
      "scripts/go-no-go.ts",
      "--deploy-gate",
    ]);
  });
});

describe("recordGoNoGoReportRow", () => {
  it("inserts a row with channelsAttempted=['log'] and severity=info", async () => {
    const id = await recordGoNoGoReportRow({
      verdict: "GO",
      report: "# fake report",
      reportPath: "/tmp/fake.md",
      exitCode: 0,
      durationMs: 12345,
    });
    expect(id).not.toBeNull();
    const [row] = await db
      .select()
      .from(operatorAlerts)
      .where(eq(operatorAlerts.id, id!));
    expect(row.severity).toBe("info");
    expect(row.channelsAttempted).toEqual(["log"]);
    const details = row.details as Record<string, unknown>;
    expect(details.report).toBe("# fake report");
    expect(details.durationMs).toBe(12345);
    expect(details.scheduledBy).toBe("server/services/nightly-go-no-go.ts");
  });
});
