// =============================================================================
// Task #44 — automated tests for the operator-alert retention prune
// =============================================================================
// Locks in three guarantees of pruneOperatorAlerts():
//
//   1. Rows older than the retention window are deleted; rows within the
//      window are kept. This is the core contract; without it, the table
//      either grows forever (under-prune) or loses recent forensics
//      (over-prune).
//
//   2. The function rejects an obviously dangerous retentionDays argument
//      (0 or negative) instead of wiping the table. Defence-in-depth: the
//      env-var path already guards this, but a future caller could pass it
//      explicitly.
//
//   3. The env-var resolver (getRetentionDays) honours valid values and
//      falls back to the default for invalid ones. This is the surface area
//      operators tweak in production.
//
// All inserted rows are tracked and removed in afterEach so the test file
// is idempotent on reruns and never leaves test data behind.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { operatorAlertPruneRuns, operatorAlerts } from "@shared/schema";
import {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_STALE_THRESHOLD_MS,
  DEFAULT_SUPPRESSION_WINDOW_MS,
  checkOperatorAlertsPruneFreshness,
  getRetentionDays,
  getWatchdogSuppressionMs,
  pruneOperatorAlerts,
  pruneOperatorAlertsAndRecord,
} from "./operator-alerts-prune";

const insertedIds: number[] = [];
let originalEnv: string | undefined;
// Capture the wall-clock time the test started so we can scrub any
// prune-run rows the test caused to be persisted (Task #59) without
// disturbing rows from earlier real prune runs.
let testStartedAt: Date;

beforeEach(() => {
  originalEnv = process.env.OPERATOR_ALERT_RETENTION_DAYS;
  delete process.env.OPERATOR_ALERT_RETENTION_DAYS;
  testStartedAt = new Date();
});

afterEach(async () => {
  if (originalEnv === undefined) {
    delete process.env.OPERATOR_ALERT_RETENTION_DAYS;
  } else {
    process.env.OPERATOR_ALERT_RETENTION_DAYS = originalEnv;
  }
  if (insertedIds.length > 0) {
    await db.delete(operatorAlerts).where(inArray(operatorAlerts.id, insertedIds));
    insertedIds.length = 0;
  }
  // Task #59: prune now persists a row into operator_alert_prune_runs on every
  // call. Scrub anything the test produced so reruns stay idempotent.
  await db
    .delete(operatorAlertPruneRuns)
    .where(gte(operatorAlertPruneRuns.startedAt, testStartedAt));
});

function uniqueSource(label: string): string {
  return `task44-test-${label}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

/**
 * Insert one operator_alerts row with an explicit createdAt. We bypass the
 * normal `notifyOperator` dispatcher because we need to set createdAt to a
 * point in the past, which the dispatcher does not allow.
 */
async function insertAlertAt(source: string, createdAt: Date): Promise<number> {
  const [row] = await db
    .insert(operatorAlerts)
    .values({
      source,
      severity: "info",
      title: `prune-test ${source}`,
      details: {},
      channelsAttempted: ["log"],
      channelOutcomes: [{ channel: "log", status: "success", durationMs: 0 }],
      // Use a raw SQL fragment so the timestamp lands as Postgres expects it
      // regardless of the column's underlying type binding.
      createdAt: sql`${createdAt.toISOString()}::timestamp`,
    })
    .returning({ id: operatorAlerts.id });
  insertedIds.push(row.id);
  return row.id;
}

describe("pruneOperatorAlerts (Task #44)", () => {
  it("deletes rows older than the retention window and keeps newer rows", async () => {
    const source = uniqueSource("retention");
    const now = new Date("2026-04-26T12:00:00.000Z");
    const retentionDays = 30;

    // 31 days old → MUST be pruned (strictly older than the cutoff).
    const oldId = await insertAlertAt(
      source,
      new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000),
    );
    // 29 days old → MUST be kept (still within the window).
    const newId = await insertAlertAt(
      source,
      new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000),
    );

    const result = await pruneOperatorAlerts({ retentionDays, now });

    expect(result.retentionDays).toBe(retentionDays);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(typeof result.cutoffIso).toBe("string");
    expect(typeof result.durationMs).toBe("number");

    const remaining = await db
      .select({ id: operatorAlerts.id })
      .from(operatorAlerts)
      .where(inArray(operatorAlerts.id, [oldId, newId]));
    const remainingIds = remaining.map((r) => r.id);
    expect(remainingIds).not.toContain(oldId);
    expect(remainingIds).toContain(newId);

    // Drop the already-deleted id from the cleanup tracker so afterEach does
    // not try to delete it twice (harmless, but keeps the count honest).
    const idx = insertedIds.indexOf(oldId);
    if (idx >= 0) insertedIds.splice(idx, 1);
  });

  it("refuses a non-positive retentionDays so a typo cannot wipe the table", async () => {
    await expect(
      pruneOperatorAlerts({ retentionDays: 0 }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      pruneOperatorAlerts({ retentionDays: -5 }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      pruneOperatorAlerts({ retentionDays: 1.5 }),
    ).rejects.toThrow(/positive integer/);
  });

  it("getRetentionDays honours valid env values and falls back on invalid", () => {
    delete process.env.OPERATOR_ALERT_RETENTION_DAYS;
    expect(getRetentionDays()).toBe(DEFAULT_RETENTION_DAYS);

    process.env.OPERATOR_ALERT_RETENTION_DAYS = "90";
    expect(getRetentionDays()).toBe(90);

    process.env.OPERATOR_ALERT_RETENTION_DAYS = "0";
    expect(getRetentionDays()).toBe(DEFAULT_RETENTION_DAYS);

    process.env.OPERATOR_ALERT_RETENTION_DAYS = "-30";
    expect(getRetentionDays()).toBe(DEFAULT_RETENTION_DAYS);

    process.env.OPERATOR_ALERT_RETENTION_DAYS = "not-a-number";
    expect(getRetentionDays()).toBe(DEFAULT_RETENTION_DAYS);

    process.env.OPERATOR_ALERT_RETENTION_DAYS = "12.5";
    expect(getRetentionDays()).toBe(DEFAULT_RETENTION_DAYS);

    process.env.OPERATOR_ALERT_RETENTION_DAYS = "   ";
    expect(getRetentionDays()).toBe(DEFAULT_RETENTION_DAYS);
  });
});

// ============================================================================
// Task #60 — stalled-prune watchdog tests
// ============================================================================
// Locks in the watchdog's contract:
//   1. A successful run is recorded with status='success' and prune metadata.
//   2. A failed run is recorded with status='error' (and re-thrown so the
//      caller's existing handler still fires).
//   3. The watchdog fires when the most-recent SUCCESS row is older than the
//      configured threshold; failed runs alone do not refresh the clock.
//   4. The watchdog stays quiet when a fresh success row exists.
//   5. Empty-table behaviour: warming-up server stays quiet; long-running
//      server with no successes EVER fires.
//
// The watchdog's notify dispatcher is injected so we can assert exactly
// what would have been paged to operators without writing extra rows to
// `operator_alerts`.
// ============================================================================

const insertedPruneRunIds: number[] = [];

async function insertPruneRunRow(opts: {
  status: "success" | "error";
  startedAt?: Date;
}): Promise<number> {
  const startedAt = opts.startedAt ?? new Date();
  const [row] = await db
    .insert(operatorAlertPruneRuns)
    .values({
      status: opts.status,
      retentionDays: 30,
      cutoff: new Date(startedAt.getTime() - 30 * 24 * 60 * 60 * 1000),
      deleted: opts.status === "success" ? 0 : null,
      durationMs: 1,
      finishedAt: new Date(startedAt.getTime() + 1),
      errorMessage: opts.status === "error" ? "synthetic test error" : null,
      // Force startedAt explicitly so the watchdog sees the age we want.
      startedAt: sql`${startedAt.toISOString()}::timestamp`,
    })
    .returning({ id: operatorAlertPruneRuns.id });
  insertedPruneRunIds.push(row.id);
  return row.id;
}

afterEach(async () => {
  if (insertedPruneRunIds.length > 0) {
    await db
      .delete(operatorAlertPruneRuns)
      .where(inArray(operatorAlertPruneRuns.id, insertedPruneRunIds));
    insertedPruneRunIds.length = 0;
  }
});

describe("pruneOperatorAlertsAndRecord (Task #60)", () => {
  it("records a 'success' row with metadata when the prune completes", async () => {
    const before = new Date();
    const result = await pruneOperatorAlertsAndRecord({ retentionDays: 30 });

    expect(result.success).toBe(true);
    expect(result.recordId).not.toBeNull();
    expect(result.prune).not.toBeNull();
    expect(result.prune!.retentionDays).toBe(30);

    const [row] = await db
      .select()
      .from(operatorAlertPruneRuns)
      .where(eq(operatorAlertPruneRuns.id, result.recordId!));
    insertedPruneRunIds.push(result.recordId!);

    expect(row.status).toBe("success");
    expect(row.retentionDays).toBe(30);
    expect(row.deleted).toBe(result.prune!.deleted);
    expect(row.cutoff).not.toBeNull();
    expect(row.errorMessage).toBeNull();
    expect(row.startedAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
  });

  it("records an 'error' row and re-throws when the prune throws", async () => {
    // retentionDays=0 is rejected synchronously by pruneOperatorAlerts.
    await expect(
      pruneOperatorAlertsAndRecord({ retentionDays: 0 }),
    ).rejects.toThrow(/positive integer/);

    // We can't capture the recordId via the throwing call, so look it up
    // by the most recent error row with retentionDays=0. That uniquely
    // identifies the synthetic insertion above.
    const [row] = await db
      .select()
      .from(operatorAlertPruneRuns)
      .where(eq(operatorAlertPruneRuns.status, "error"))
      .orderBy(sql`${operatorAlertPruneRuns.startedAt} DESC`)
      .limit(1);
    expect(row).toBeDefined();
    expect(row.retentionDays).toBe(0);
    expect(row.deleted).toBeNull();
    expect(row.cutoff).toBeNull();
    expect(row.errorMessage).toMatch(/positive integer/);
    insertedPruneRunIds.push(row.id);
  });
});

describe("checkOperatorAlertsPruneFreshness (Task #60)", () => {
  // Simple injection seam: capture every alert handed to the watchdog so we
  // can assert source/severity/details without writing to operator_alerts.
  type CapturedAlert = {
    source: string;
    severity: string;
    title: string;
    details: Record<string, unknown>;
  };
  function makeNotifyStub() {
    const calls: CapturedAlert[] = [];
    const notify = async (alert: CapturedAlert) => {
      calls.push(alert);
      return {
        channelsAttempted: ["log" as const],
        outcomes: [],
        channels: ["log" as const],
        alertId: 999,
      };
    };
    return { notify, calls };
  }

  it("stays quiet when a recent successful run exists", async () => {
    const now = new Date("2026-04-26T12:00:00.000Z");
    // 12h-old success — well within the 48h threshold.
    await insertPruneRunRow({
      status: "success",
      startedAt: new Date(now.getTime() - 12 * 60 * 60 * 1000),
    });

    const { notify, calls } = makeNotifyStub();
    const result = await checkOperatorAlertsPruneFreshness({
      now,
      notify,
      // Uptime irrelevant when a row exists, but pin it so the test is
      // deterministic regardless of the actual process uptime.
      serverUptimeMs: 60 * 60 * 1000,
    });

    expect(result.fired).toBe(false);
    expect(result.reason).toBe("fresh");
    expect(result.suppressed).toBe(false);
    expect(result.previousAlertAt).toBeNull();
    expect(calls).toHaveLength(0);
    expect(result.thresholdMs).toBe(DEFAULT_STALE_THRESHOLD_MS);
    expect(result.alertId).toBeNull();
  });

  it("fires a warning when the most recent success is older than the threshold", async () => {
    const now = new Date("2026-04-26T12:00:00.000Z");
    // 3-day-old success — beyond the 2-day threshold.
    await insertPruneRunRow({
      status: "success",
      startedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
    });
    // A more recent FAILURE must NOT refresh the freshness clock.
    await insertPruneRunRow({
      status: "error",
      startedAt: new Date(now.getTime() - 1 * 60 * 60 * 1000),
    });

    const { notify, calls } = makeNotifyStub();
    const result = await checkOperatorAlertsPruneFreshness({
      now,
      notify,
      serverUptimeMs: 30 * 24 * 60 * 60 * 1000,
      // Disable suppression so this test stays focused on the
      // staleness-detection path. Suppression is exercised separately
      // below.
      suppressionWindowMs: 0,
    });

    expect(result.fired).toBe(true);
    expect(result.reason).toBe("stale");
    expect(result.suppressed).toBe(false);
    expect(result.alertId).toBe(999);
    expect(calls).toHaveLength(1);
    const alert = calls[0];
    expect(alert.severity).toBe("warning");
    expect(alert.source).toBe("operator-alerts-prune-watchdog");
    expect(alert.details.ageHours as number).toBeGreaterThanOrEqual(48);
    // Task #83: persisted detail must include the reason so the next tick
    // can compare and decide whether to suppress.
    expect(alert.details.reason).toBe("stale");
  });

  it("stays quiet on a fresh deploy (empty table, low uptime)", async () => {
    // No rows inserted at all. Uptime well under the 48h threshold.
    const { notify, calls } = makeNotifyStub();
    const result = await checkOperatorAlertsPruneFreshness({
      now: new Date("2026-04-26T12:00:00.000Z"),
      notify,
      serverUptimeMs: 30 * 60 * 1000,
    });

    expect(result.fired).toBe(false);
    expect(result.reason).toBe("warming-up");
    expect(result.suppressed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("fires on a long-running deploy with no successful runs ever", async () => {
    // Need to ensure no PRIOR successful rows survived from earlier in this
    // test file. The first describe-block tests that exercise
    // `pruneOperatorAlertsAndRecord` insert real success rows; their
    // afterEach cleans those up. To stay independent of test-order, we
    // verify by querying the table directly.
    const successCount = await db
      .select({ id: operatorAlertPruneRuns.id })
      .from(operatorAlertPruneRuns)
      .where(eq(operatorAlertPruneRuns.status, "success"));
    if (successCount.length > 0) {
      // Should never happen given our cleanup contract, but guard so the
      // test fails loudly rather than silently passing for the wrong reason.
      throw new Error(
        `Expected zero pre-existing success rows, found ${successCount.length}`,
      );
    }

    const { notify, calls } = makeNotifyStub();
    const result = await checkOperatorAlertsPruneFreshness({
      now: new Date("2026-04-26T12:00:00.000Z"),
      notify,
      // 5 days uptime — well past the 48h threshold.
      serverUptimeMs: 5 * 24 * 60 * 60 * 1000,
      // Disable suppression so this test exercises the never-run path
      // independent of any prior watchdog row that might exist.
      suppressionWindowMs: 0,
    });

    expect(result.fired).toBe(true);
    expect(result.reason).toBe("never-run");
    expect(result.suppressed).toBe(false);
    expect(calls).toHaveLength(1);
    const alert = calls[0];
    expect(alert.severity).toBe("warning");
    expect(alert.source).toBe("operator-alerts-prune-watchdog");
    expect(alert.title).toMatch(/never recorded a successful run/);
    // Task #83: reason carried in details for cross-tick comparison.
    expect(alert.details.reason).toBe("never-run");
  });
});

// ============================================================================
// Task #83 — alert-suppression tests
// ============================================================================
// Locks in the new contract:
//   1. The first stale tick fires.
//   2. A subsequent tick inside the suppression window stays quiet.
//   3. A tick AFTER the suppression window expires re-fires.
//   4. A tick where the staleness reason has changed re-fires immediately
//      (e.g. "never-run" → "stale", or vice versa) regardless of the window.
//   5. A successful prune naturally clears suppression because the watchdog
//      returns reason="fresh" without ever consulting the suppression
//      bookkeeping.
//   6. The env-var resolver honours valid values and falls back on invalid.
// ============================================================================

const insertedWatchdogAlertIds: number[] = [];

/**
 * Insert a pre-existing watchdog alert row into operator_alerts, with an
 * explicit createdAt and reason in details. We bypass notifyOperator so
 * we can backdate `createdAt` and pin the dedupe key to a unique value
 * per test (avoiding cross-test interference with the dedupe coalescer).
 */
async function insertWatchdogAlertAt(opts: {
  reason: string | null;
  createdAt: Date;
}): Promise<number> {
  const detailsObj: Record<string, unknown> = {};
  if (opts.reason !== null) detailsObj.reason = opts.reason;
  const [row] = await db
    .insert(operatorAlerts)
    .values({
      source: "operator-alerts-prune-watchdog",
      severity: "warning",
      title: `task83-test ${opts.reason ?? "no-reason"}`,
      details: detailsObj,
      channelsAttempted: ["log"],
      channelOutcomes: [{ channel: "log", status: "success", durationMs: 0 }],
      createdAt: sql`${opts.createdAt.toISOString()}::timestamp`,
    })
    .returning({ id: operatorAlerts.id });
  insertedWatchdogAlertIds.push(row.id);
  return row.id;
}

afterEach(async () => {
  if (insertedWatchdogAlertIds.length > 0) {
    await db
      .delete(operatorAlerts)
      .where(inArray(operatorAlerts.id, insertedWatchdogAlertIds));
    insertedWatchdogAlertIds.length = 0;
  }
});

describe("checkOperatorAlertsPruneFreshness suppression (Task #83)", () => {
  type CapturedAlert = {
    source: string;
    severity: string;
    title: string;
    details: Record<string, unknown>;
  };
  function makeNotifyStub() {
    const calls: CapturedAlert[] = [];
    const notify = async (alert: CapturedAlert) => {
      calls.push(alert);
      return {
        channelsAttempted: ["log" as const],
        outcomes: [],
        channels: ["log" as const],
        alertId: 999,
      };
    };
    return { notify, calls };
  }

  // The shared dev Postgres has long-lived production rows in
  // `operator_alert_prune_runs` (real cron successes) and may also have
  // `operator_alerts` rows from the watchdog itself. To keep these tests
  // independent of that real history, every Task #83 test pins "now" to a
  // far-future timestamp and inserts its fixtures relative to that. The
  // most-recent successful prune run by `startedAt` is therefore the
  // test-controlled row, regardless of how many production rows exist.
  const FUTURE_NOW = new Date("2099-01-01T12:00:00.000Z");

  /**
   * Belt-and-braces guard: scrub any watchdog alert rows in the time
   * vicinity of `now` that other tests in this file may have left
   * behind. Bounded to a small window around the synthetic "now" so we
   * never touch real production rows.
   */
  async function clearRecentWatchdogAlerts(now: Date): Promise<void> {
    await db
      .delete(operatorAlerts)
      .where(
        and(
          eq(operatorAlerts.source, "operator-alerts-prune-watchdog"),
          gte(
            operatorAlerts.createdAt,
            new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
          ),
        ),
      );
  }

  it("fires once, then suppresses follow-up ticks inside the window", async () => {
    const now = FUTURE_NOW;
    await clearRecentWatchdogAlerts(now);
    // 3-day-old success — definitely stale (threshold is 2 days). Because
    // `now` is in the year 2099, this row is the most recent success row
    // in the table even with real prod history present.
    await insertPruneRunRow({
      status: "success",
      startedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
    });
    // Simulate a watchdog alert that fired ~6h ago for the same reason.
    const priorAt = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    const priorId = await insertWatchdogAlertAt({
      reason: "stale",
      createdAt: priorAt,
    });

    const { notify, calls } = makeNotifyStub();
    const result = await checkOperatorAlertsPruneFreshness({
      now,
      notify,
      serverUptimeMs: 30 * 24 * 60 * 60 * 1000,
      // Default 24h window: prior alert at -6h is well inside.
      suppressionWindowMs: 24 * 60 * 60 * 1000,
    });

    expect(result.fired).toBe(false);
    expect(result.suppressed).toBe(true);
    expect(result.reason).toBe("stale");
    expect(result.previousAlertAt).not.toBeNull();
    expect(result.previousAlertAt!.toISOString()).toBe(priorAt.toISOString());
    expect(calls).toHaveLength(0);
    // Sanity: the existing row id we inserted should still be the one
    // suppression matched against.
    expect(priorId).toBeGreaterThan(0);
  });

  it("re-fires when the suppression window has elapsed", async () => {
    const now = FUTURE_NOW;
    await clearRecentWatchdogAlerts(now);
    await insertPruneRunRow({
      status: "success",
      startedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
    });
    // Prior alert was 26h ago — outside a 24h window.
    await insertWatchdogAlertAt({
      reason: "stale",
      createdAt: new Date(now.getTime() - 26 * 60 * 60 * 1000),
    });

    const { notify, calls } = makeNotifyStub();
    const result = await checkOperatorAlertsPruneFreshness({
      now,
      notify,
      serverUptimeMs: 30 * 24 * 60 * 60 * 1000,
      suppressionWindowMs: 24 * 60 * 60 * 1000,
    });

    expect(result.fired).toBe(true);
    expect(result.suppressed).toBe(false);
    expect(result.reason).toBe("stale");
    expect(result.previousAlertAt).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].details.reason).toBe("stale");
  });

  it("re-fires inside the window when the staleness reason has changed", async () => {
    // We exercise the reason-change path WITHOUT requiring an empty
    // prune-runs table (which is impossible on the shared dev DB). The
    // current state is "stale" (3-day-old success) and the prior
    // watchdog alert claimed "never-run" — different reasons, so the
    // watchdog must re-page even inside the suppression window.
    const now = FUTURE_NOW;
    await clearRecentWatchdogAlerts(now);
    await insertPruneRunRow({
      status: "success",
      startedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
    });
    await insertWatchdogAlertAt({
      reason: "never-run",
      createdAt: new Date(now.getTime() - 1 * 60 * 60 * 1000),
    });

    const { notify, calls } = makeNotifyStub();
    const result = await checkOperatorAlertsPruneFreshness({
      now,
      notify,
      serverUptimeMs: 30 * 24 * 60 * 60 * 1000,
      suppressionWindowMs: 24 * 60 * 60 * 1000,
    });

    expect(result.fired).toBe(true);
    expect(result.suppressed).toBe(false);
    expect(result.reason).toBe("stale");
    expect(calls).toHaveLength(1);
    expect(calls[0].details.reason).toBe("stale");
  });

  it("a successful prune appearing later naturally clears suppression", async () => {
    // A prior watchdog alert exists, AND a fresh successful prune has
    // since landed. The watchdog must return reason="fresh" without
    // even consulting suppression — the alert isn't withheld, it just
    // isn't applicable.
    const now = FUTURE_NOW;
    await clearRecentWatchdogAlerts(now);
    // Fresh success 1h ago → well within the 48h threshold.
    await insertPruneRunRow({
      status: "success",
      startedAt: new Date(now.getTime() - 60 * 60 * 1000),
    });
    // Stale prior watchdog alert from before the prune recovered.
    await insertWatchdogAlertAt({
      reason: "stale",
      createdAt: new Date(now.getTime() - 5 * 60 * 60 * 1000),
    });

    const { notify, calls } = makeNotifyStub();
    const result = await checkOperatorAlertsPruneFreshness({
      now,
      notify,
      serverUptimeMs: 30 * 24 * 60 * 60 * 1000,
      suppressionWindowMs: 24 * 60 * 60 * 1000,
    });

    expect(result.fired).toBe(false);
    expect(result.suppressed).toBe(false);
    expect(result.reason).toBe("fresh");
    expect(result.previousAlertAt).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("suppressionWindowMs=0 disables suppression entirely (legacy behaviour)", async () => {
    const now = FUTURE_NOW;
    await clearRecentWatchdogAlerts(now);
    await insertPruneRunRow({
      status: "success",
      startedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
    });
    // Prior alert 1 minute ago — would normally suppress.
    await insertWatchdogAlertAt({
      reason: "stale",
      createdAt: new Date(now.getTime() - 60 * 1000),
    });

    const { notify, calls } = makeNotifyStub();
    const result = await checkOperatorAlertsPruneFreshness({
      now,
      notify,
      serverUptimeMs: 30 * 24 * 60 * 60 * 1000,
      suppressionWindowMs: 0,
    });

    expect(result.fired).toBe(true);
    expect(result.suppressed).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("getWatchdogSuppressionMs honours valid env values and falls back on invalid", () => {
    const originalSupp =
      process.env.OPERATOR_ALERTS_PRUNE_WATCHDOG_SUPPRESSION_HOURS;
    try {
      delete process.env.OPERATOR_ALERTS_PRUNE_WATCHDOG_SUPPRESSION_HOURS;
      expect(getWatchdogSuppressionMs()).toBe(DEFAULT_SUPPRESSION_WINDOW_MS);

      process.env.OPERATOR_ALERTS_PRUNE_WATCHDOG_SUPPRESSION_HOURS = "12";
      expect(getWatchdogSuppressionMs()).toBe(12 * 60 * 60 * 1000);

      // 0 is allowed — explicitly disables suppression.
      process.env.OPERATOR_ALERTS_PRUNE_WATCHDOG_SUPPRESSION_HOURS = "0";
      expect(getWatchdogSuppressionMs()).toBe(0);

      // Negative → fall back to default.
      process.env.OPERATOR_ALERTS_PRUNE_WATCHDOG_SUPPRESSION_HOURS = "-1";
      expect(getWatchdogSuppressionMs()).toBe(DEFAULT_SUPPRESSION_WINDOW_MS);

      // Non-numeric → fall back to default.
      process.env.OPERATOR_ALERTS_PRUNE_WATCHDOG_SUPPRESSION_HOURS = "abc";
      expect(getWatchdogSuppressionMs()).toBe(DEFAULT_SUPPRESSION_WINDOW_MS);

      // Whitespace → fall back to default.
      process.env.OPERATOR_ALERTS_PRUNE_WATCHDOG_SUPPRESSION_HOURS = "   ";
      expect(getWatchdogSuppressionMs()).toBe(DEFAULT_SUPPRESSION_WINDOW_MS);
    } finally {
      if (originalSupp === undefined) {
        delete process.env.OPERATOR_ALERTS_PRUNE_WATCHDOG_SUPPRESSION_HOURS;
      } else {
        process.env.OPERATOR_ALERTS_PRUNE_WATCHDOG_SUPPRESSION_HOURS =
          originalSupp;
      }
    }
  });
});
