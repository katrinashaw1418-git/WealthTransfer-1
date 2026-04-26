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
import { gte, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { operatorAlerts, operatorAlertPruneRuns } from "@shared/schema";
import {
  DEFAULT_RETENTION_DAYS,
  getRetentionDays,
  pruneOperatorAlerts,
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
