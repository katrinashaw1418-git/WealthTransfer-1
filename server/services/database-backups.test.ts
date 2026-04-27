// =============================================================================
// Task #171 — Database backup service tests
// =============================================================================
// Locks in the pure-logic surfaces of `database-backups.ts` so a future
// refactor cannot silently weaken the rollback safety net or the freshness
// thresholds. We deliberately avoid spawning pg_dump / pg_restore here —
// those code paths are exercised by the hand-run CLI scripts; this file
// covers the logic that gates them and the watchdog that pages on them.
//
// Coverage:
//   1. `describeDbTarget` — structural URL → "host:port/database" key.
//   2. `assertNotLiveTarget` — refuses obviously-equivalent URLs across
//      scheme/port/case variants and fails closed on unparseable input.
//   3. `getRetentionCount` — env parsing with sane defaults on bad values.
//   4. `listExistingDumps` — filename pattern matching, sort order,
//      ENOENT-safety, and rejection of decoy files.
//   5. `checkBackupFreshness` — fresh / warming-up / stale paths, the
//      "single alert with all reasons" rule, default thresholds, and
//      input validation.
//   6. JSONB integrity-result shape survives an insert + read round-trip.
//
// The watchdog tests insert rows with a far-future `startedAt` so the
// "most recent successful row" select is deterministic regardless of any
// historical rows in the dev DB; cleanup deletes only the rows this file
// inserted (tracked by id).
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { eq, inArray } from "drizzle-orm";

import { db } from "../db";
import {
  backgroundJobRuns,
  databaseBackupRuns,
  databaseRestoreDrillRuns,
} from "@shared/schema";
import type { OperatorAlert, OperatorAlertResult } from "./operator-alerts";
import {
  DEFAULT_BACKUP_STALE_THRESHOLD_MS,
  DEFAULT_DRILL_STALE_THRESHOLD_MS,
  DEFAULT_OFFSITE_STALE_THRESHOLD_MS,
  DEFAULT_RETENTION_COUNT,
  OFFSITE_BACKUP_JOB_NAME,
  assertNotLiveTarget,
  checkBackupFreshness,
  describeDbTarget,
  getOffsiteStaleThresholdMs,
  getRetentionCount,
  listExistingDumps,
} from "./database-backups";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("describeDbTarget", () => {
  it("normalises scheme/port/path into a host:port/database key", () => {
    expect(describeDbTarget("postgres://u:p@h.example.com/db1")).toBe(
      "h.example.com:5432/db1",
    );
    expect(
      describeDbTarget(
        "postgresql://u:p@h.example.com:5432/db1?sslmode=require",
      ),
    ).toBe("h.example.com:5432/db1");
  });

  it("lowercases the host so case differences do not bypass the guard", () => {
    expect(describeDbTarget("postgres://u:p@H.Example.COM/db1")).toBe(
      "h.example.com:5432/db1",
    );
  });

  it("preserves a non-default port", () => {
    expect(describeDbTarget("postgres://u:p@h.example.com:6543/db1")).toBe(
      "h.example.com:6543/db1",
    );
  });

  it("returns null when the URL cannot be parsed", () => {
    expect(describeDbTarget("not a url")).toBeNull();
  });

  it("returns null when the URL has no database path component", () => {
    expect(describeDbTarget("postgres://u:p@h.example.com")).toBeNull();
    expect(describeDbTarget("postgres://u:p@h.example.com/")).toBeNull();
  });
});

describe("assertNotLiveTarget", () => {
  let originalUrl: string | undefined;

  beforeEach(() => {
    originalUrl = process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  it("rejects an obviously equivalent URL even with different scheme/port/query", () => {
    process.env.DATABASE_URL = "postgres://u:p@host.example.com/livedb";
    expect(() =>
      assertNotLiveTarget(
        "postgresql://u:p@host.example.com:5432/livedb?sslmode=require",
      ),
    ).toThrow(/live database/i);
  });

  it("rejects when only the host casing differs", () => {
    process.env.DATABASE_URL = "postgres://u:p@HOST.example.com/livedb";
    expect(() =>
      assertNotLiveTarget("postgres://u:p@host.example.com/livedb"),
    ).toThrow(/live database/i);
  });

  it("permits a different database name on the same host", () => {
    process.env.DATABASE_URL = "postgres://u:p@host.example.com/livedb";
    expect(() =>
      assertNotLiveTarget("postgres://u:p@host.example.com/scratch_db"),
    ).not.toThrow();
  });

  it("permits a different host on the same database name", () => {
    process.env.DATABASE_URL = "postgres://u:p@host.example.com/db";
    expect(() =>
      assertNotLiveTarget("postgres://u:p@scratch.example.com/db"),
    ).not.toThrow();
  });

  it("permits a different port on the same host + database", () => {
    process.env.DATABASE_URL = "postgres://u:p@host.example.com:5432/db";
    expect(() =>
      assertNotLiveTarget("postgres://u:p@host.example.com:6543/db"),
    ).not.toThrow();
  });

  it("refuses when DATABASE_URL is not set (cannot prove safety)", () => {
    delete process.env.DATABASE_URL;
    expect(() =>
      assertNotLiveTarget("postgres://u:p@h.example.com/scratch"),
    ).toThrow(/DATABASE_URL is not set/);
  });

  it("fails closed when the target URL cannot be parsed", () => {
    process.env.DATABASE_URL = "postgres://u:p@host.example.com/livedb";
    expect(() => assertNotLiveTarget("not a url")).toThrow(
      /could not parse target URL/,
    );
  });

  it("fails closed when DATABASE_URL itself cannot be parsed", () => {
    process.env.DATABASE_URL = "not a url";
    expect(() =>
      assertNotLiveTarget("postgres://u:p@host.example.com/scratch"),
    ).toThrow(/could not parse DATABASE_URL/);
  });
});

describe("getRetentionCount", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.DB_BACKUP_RETENTION;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.DB_BACKUP_RETENTION;
    else process.env.DB_BACKUP_RETENTION = original;
  });

  it("returns the documented default when the env var is unset", () => {
    delete process.env.DB_BACKUP_RETENTION;
    expect(getRetentionCount()).toBe(DEFAULT_RETENTION_COUNT);
    expect(DEFAULT_RETENTION_COUNT).toBe(14);
  });

  it("parses a positive integer override", () => {
    process.env.DB_BACKUP_RETENTION = "30";
    expect(getRetentionCount()).toBe(30);
  });

  it("parses the integer prefix of a value with a trailing suffix", () => {
    // parseInt(., 10) tolerates trailing junk; documenting that here so a
    // refactor to Number() / strict parsing is a flagged behaviour change.
    process.env.DB_BACKUP_RETENTION = "21abc";
    expect(getRetentionCount()).toBe(21);
  });

  it("falls back to the default when the value is non-numeric", () => {
    process.env.DB_BACKUP_RETENTION = "many";
    expect(getRetentionCount()).toBe(DEFAULT_RETENTION_COUNT);
  });

  it("falls back to the default when the value is zero or negative", () => {
    process.env.DB_BACKUP_RETENTION = "0";
    expect(getRetentionCount()).toBe(DEFAULT_RETENTION_COUNT);
    process.env.DB_BACKUP_RETENTION = "-5";
    expect(getRetentionCount()).toBe(DEFAULT_RETENTION_COUNT);
  });

  it("falls back to the default when the value is whitespace only", () => {
    process.env.DB_BACKUP_RETENTION = "   ";
    expect(getRetentionCount()).toBe(DEFAULT_RETENTION_COUNT);
  });
});

describe("listExistingDumps", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "amax-backup-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns an empty list when the backup directory does not exist", async () => {
    expect(await listExistingDumps(path.join(tmp, "missing"))).toEqual([]);
  });

  it("returns an empty list when the directory exists but is empty", async () => {
    expect(await listExistingDumps(tmp)).toEqual([]);
  });

  it("matches only timestamped dump filenames and sorts newest first", async () => {
    const valid = [
      "amax-db-backup-2026-04-25T01-00-00Z.dump",
      "amax-db-backup-2026-04-27T03-30-00Z.dump",
      "amax-db-backup-2026-04-26T02-15-00Z.dump",
    ];
    const decoys = [
      "random.dump",
      "amax-db-backup-2026-04-27.dump", // missing time component
      "amax-db-backup-foo.dump", // non-iso timestamp
      "amax-db-backup-2026-04-27T03-30-00Z.dump.bak", // wrong extension
      "Amax-db-backup-2026-04-27T03-30-00Z.dump", // case-sensitive prefix
      "notes.txt",
    ];
    for (const name of [...valid, ...decoys]) {
      await fs.writeFile(path.join(tmp, name), "");
    }

    const result = await listExistingDumps(tmp);
    expect(result).toEqual([
      "amax-db-backup-2026-04-27T03-30-00Z.dump",
      "amax-db-backup-2026-04-26T02-15-00Z.dump",
      "amax-db-backup-2026-04-25T01-00-00Z.dump",
    ]);
  });
});

describe("checkBackupFreshness", () => {
  // Year-3000 timestamps so the "most recent successful row" select returns
  // our row regardless of any historical state in the dev DB. Cleanup deletes
  // only the rows this file inserted (tracked by id).
  const FAR_FUTURE = new Date("3000-06-01T12:00:00Z");
  const insertedBackupIds: number[] = [];
  const insertedDrillIds: number[] = [];
  const insertedOffsiteIds: number[] = [];

  beforeEach(async () => {
    // Defensive: if a previous test (in this file or elsewhere in the dev
    // DB) left a `database-backup-offsite` row behind, the freshness check
    // would observe it and skew the result. Wipe just our jobName so we
    // never pollute the wider background_job_runs table.
    await db
      .delete(backgroundJobRuns)
      .where(eq(backgroundJobRuns.jobName, OFFSITE_BACKUP_JOB_NAME));
  });

  afterEach(async () => {
    if (insertedBackupIds.length > 0) {
      await db
        .delete(databaseBackupRuns)
        .where(inArray(databaseBackupRuns.id, insertedBackupIds.splice(0)));
    }
    if (insertedDrillIds.length > 0) {
      await db
        .delete(databaseRestoreDrillRuns)
        .where(
          inArray(databaseRestoreDrillRuns.id, insertedDrillIds.splice(0)),
        );
    }
    if (insertedOffsiteIds.length > 0) {
      await db
        .delete(backgroundJobRuns)
        .where(inArray(backgroundJobRuns.id, insertedOffsiteIds.splice(0)));
    }
    // Belt-and-braces — also clear any rows we may have inserted via the
    // shared jobName even if the per-id list got out of sync. Always
    // scoped to OUR jobName so we never touch other jobs' rows.
    await db
      .delete(backgroundJobRuns)
      .where(eq(backgroundJobRuns.jobName, OFFSITE_BACKUP_JOB_NAME));
  });

  async function insertBackup(
    startedAt: Date,
    status: "success" | "error" = "success",
  ): Promise<void> {
    const [row] = await db
      .insert(databaseBackupRuns)
      .values({
        startedAt,
        finishedAt: startedAt,
        status,
        dumpPath: status === "success" ? "/tmp/test.dump" : null,
        dumpSizeBytes: status === "success" ? 1024 : null,
        retentionCount: 14,
        prunedCount: 0,
        durationMs: 100,
        errorMessage: status === "error" ? "boom" : null,
      })
      .returning({ id: databaseBackupRuns.id });
    insertedBackupIds.push(row.id);
  }

  async function insertDrill(
    startedAt: Date,
    integrity: {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; detail?: string }>;
    } = {
      ok: true,
      checks: [
        { name: "users_table_present", ok: true, detail: "users.count=42" },
      ],
    },
    status: "success" | "error" = "success",
  ): Promise<void> {
    const [row] = await db
      .insert(databaseRestoreDrillRuns)
      .values({
        startedAt,
        finishedAt: startedAt,
        status,
        dumpPath: "/tmp/test.dump",
        scratchDbName: "scratch_test",
        integrity,
        durationMs: 200,
        errorMessage: status === "error" ? "boom" : null,
      })
      .returning({ id: databaseRestoreDrillRuns.id });
    insertedDrillIds.push(row.id);
  }

  async function insertOffsite(
    startedAt: Date,
    status: "success" | "error" = "success",
  ): Promise<void> {
    const [row] = await db
      .insert(backgroundJobRuns)
      .values({
        jobName: OFFSITE_BACKUP_JOB_NAME,
        startedAt,
        finishedAt: startedAt,
        status,
        summary: status === "success" ? "test offsite sync" : null,
        errorMessage: status === "error" ? "boom" : null,
        durationMs: 50,
      })
      .returning({ id: backgroundJobRuns.id });
    insertedOffsiteIds.push(row.id);
  }

  function makeNotifySpy(): {
    calls: OperatorAlert[];
    notify: (alert: OperatorAlert) => Promise<OperatorAlertResult>;
  } {
    const calls: OperatorAlert[] = [];
    const notify = async (alert: OperatorAlert): Promise<OperatorAlertResult> => {
      calls.push(alert);
      return {
        channelsAttempted: ["log"],
        outcomes: [],
        channels: ["log"],
        alertId: 999_001,
        deliveryStatus: "delivered",
        occurrences: 1,
        dedupeKey: "test-dedupe-key",
      };
    };
    return { calls, notify };
  }

  it("uses the documented default thresholds", () => {
    expect(DEFAULT_BACKUP_STALE_THRESHOLD_MS).toBe(2 * DAY_MS);
    expect(DEFAULT_DRILL_STALE_THRESHOLD_MS).toBe(14 * DAY_MS);
    expect(DEFAULT_OFFSITE_STALE_THRESHOLD_MS).toBe(2 * DAY_MS);
  });

  it("returns fresh and pages no one when backup, drill, and offsite are all within threshold", async () => {
    await insertBackup(new Date(FAR_FUTURE.getTime() - 60 * 60 * 1000)); // 1h old
    await insertDrill(new Date(FAR_FUTURE.getTime() - 1 * DAY_MS)); // 1d old
    await insertOffsite(new Date(FAR_FUTURE.getTime() - 60 * 60 * 1000)); // 1h old
    const { calls, notify } = makeNotifySpy();

    const r = await checkBackupFreshness({ now: FAR_FUTURE, notify });

    expect(r.fired).toBe(false);
    expect(r.reasons).toEqual(["fresh"]);
    expect(r.alertId).toBeNull();
    expect(r.backup.ageMs).toBeLessThan(DEFAULT_BACKUP_STALE_THRESHOLD_MS);
    expect(r.drill.ageMs).toBeLessThan(DEFAULT_DRILL_STALE_THRESHOLD_MS);
    expect(r.offsite.ageMs).toBeLessThan(DEFAULT_OFFSITE_STALE_THRESHOLD_MS);
    expect(r.offsite.thresholdMs).toBe(DEFAULT_OFFSITE_STALE_THRESHOLD_MS);
    expect(calls).toHaveLength(0);
  });

  it("suppresses pages while the server is still warming up with no run history", async () => {
    // The watchdog must not page a brand-new server that simply hasn't had
    // time to run its first backup yet. Wipe both tables so the read paths
    // return null (the dev backup cron is gated on DB_BACKUP_DIR being set,
    // which it is not in tests, so deleting here does not race a producer).
    await db.delete(databaseBackupRuns);
    await db.delete(databaseRestoreDrillRuns);

    const { calls, notify } = makeNotifySpy();
    const r = await checkBackupFreshness({
      now: FAR_FUTURE,
      serverUptimeMs: 60_000, // 1 minute — well under either threshold
      notify,
    });

    expect(r.fired).toBe(false);
    expect(r.reasons).toEqual(["warming-up"]);
    expect(r.alertId).toBeNull();
    expect(r.backup.mostRecentSuccessAt).toBeNull();
    expect(r.drill.mostRecentSuccessAt).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("pages once warming-up has elapsed and no run history exists", async () => {
    await db.delete(databaseBackupRuns);
    await db.delete(databaseRestoreDrillRuns);
    // Offsite rows are scoped by jobName so we don't blast the whole table.
    await db
      .delete(backgroundJobRuns)
      .where(eq(backgroundJobRuns.jobName, OFFSITE_BACKUP_JOB_NAME));

    const { calls, notify } = makeNotifySpy();
    const r = await checkBackupFreshness({
      now: FAR_FUTURE,
      // Uptime well past every threshold: warming-up suppression no longer
      // applies on any axis, so the absence of any successful run becomes
      // a real page on all three.
      serverUptimeMs: 30 * DAY_MS,
      notify,
    });

    expect(r.fired).toBe(true);
    expect(r.reasons.slice().sort()).toEqual([
      "backup-never-run",
      "drill-never-run",
      "offsite-never-run",
    ]);
    expect(r.alertId).toBe(999_001);
    expect(calls).toHaveLength(1);
  });

  it("pages a SINGLE alert with all stale reasons rolled in (not one per stale axis)", async () => {
    await insertBackup(new Date(FAR_FUTURE.getTime() - 5 * DAY_MS));
    await insertDrill(new Date(FAR_FUTURE.getTime() - 30 * DAY_MS));
    const { calls, notify } = makeNotifySpy();

    const r = await checkBackupFreshness({ now: FAR_FUTURE, notify });

    expect(r.fired).toBe(true);
    expect(r.reasons.sort()).toEqual(["backup-stale", "drill-stale"]);
    expect(r.alertId).toBe(999_001);
    expect(calls).toHaveLength(1);

    const alert = calls[0];
    expect(alert.source).toBe("database-backup-watchdog");
    expect(alert.severity).toBe("alert");
    const details = alert.details as { reasons: string[] } | undefined;
    expect(details).toBeDefined();
    expect([...(details?.reasons ?? [])].sort()).toEqual([
      "backup-stale",
      "drill-stale",
    ]);
  });

  it("pages when the backup is stale but the drill is still fresh", async () => {
    await insertBackup(new Date(FAR_FUTURE.getTime() - 5 * DAY_MS));
    await insertDrill(new Date(FAR_FUTURE.getTime() - 60 * 60 * 1000));
    const { calls, notify } = makeNotifySpy();

    const r = await checkBackupFreshness({ now: FAR_FUTURE, notify });

    expect(r.fired).toBe(true);
    expect(r.reasons).toEqual(["backup-stale"]);
    expect(calls).toHaveLength(1);
  });

  it("pages when the drill is stale but the backup is still fresh", async () => {
    await insertBackup(new Date(FAR_FUTURE.getTime() - 60 * 60 * 1000));
    await insertDrill(new Date(FAR_FUTURE.getTime() - 30 * DAY_MS));
    const { calls, notify } = makeNotifySpy();

    const r = await checkBackupFreshness({ now: FAR_FUTURE, notify });

    expect(r.fired).toBe(true);
    expect(r.reasons).toEqual(["drill-stale"]);
    expect(calls).toHaveLength(1);
  });

  it("ignores rows whose status is 'error' when computing freshness", async () => {
    // A recent failed backup must NOT silence the watchdog — the most recent
    // SUCCESSFUL row is what counts.
    await insertBackup(
      new Date(FAR_FUTURE.getTime() - 60 * 60 * 1000),
      "error",
    );
    await insertBackup(new Date(FAR_FUTURE.getTime() - 5 * DAY_MS), "success");
    await insertDrill(new Date(FAR_FUTURE.getTime() - 60 * 60 * 1000));
    const { calls, notify } = makeNotifySpy();

    const r = await checkBackupFreshness({ now: FAR_FUTURE, notify });

    expect(r.fired).toBe(true);
    expect(r.reasons).toEqual(["backup-stale"]);
    expect(calls).toHaveLength(1);
  });

  it("respects custom thresholds when the caller overrides them", async () => {
    // Backup is 25h old. Default threshold (48h) → fresh; tightened
    // threshold (12h) → stale.
    await insertBackup(new Date(FAR_FUTURE.getTime() - 25 * 60 * 60 * 1000));
    await insertDrill(new Date(FAR_FUTURE.getTime() - 60 * 60 * 1000));

    const lax = makeNotifySpy();
    const laxResult = await checkBackupFreshness({
      now: FAR_FUTURE,
      notify: lax.notify,
    });
    expect(laxResult.fired).toBe(false);
    expect(lax.calls).toHaveLength(0);

    const strict = makeNotifySpy();
    const strictResult = await checkBackupFreshness({
      now: FAR_FUTURE,
      backupStaleThresholdMs: 12 * 60 * 60 * 1000,
      notify: strict.notify,
    });
    expect(strictResult.fired).toBe(true);
    expect(strictResult.reasons).toEqual(["backup-stale"]);
    expect(strict.calls).toHaveLength(1);
  });

  it("pages when the offsite sync is stale but backup + drill are fresh", async () => {
    // The motivating scenario for Task #260: local backup tile stays green
    // (recent backup + drill) but the offsite cron silently broke and the
    // last successful S3 sync was days ago. Until this watchdog landed, the
    // operator only found out during a real incident.
    await insertBackup(new Date(FAR_FUTURE.getTime() - 60 * 60 * 1000));
    await insertDrill(new Date(FAR_FUTURE.getTime() - 1 * DAY_MS));
    await insertOffsite(new Date(FAR_FUTURE.getTime() - 5 * DAY_MS));
    const { calls, notify } = makeNotifySpy();

    const r = await checkBackupFreshness({ now: FAR_FUTURE, notify });

    expect(r.fired).toBe(true);
    expect(r.reasons).toEqual(["offsite-stale"]);
    expect(r.alertId).toBe(999_001);
    expect(calls).toHaveLength(1);

    const alert = calls[0];
    expect(alert.source).toBe("database-backup-watchdog");
    expect(alert.severity).toBe("alert");
    expect(alert.title).toMatch(/offsite sync/i);
    const details = alert.details as
      | {
          reasons: string[];
          offsiteAgeHours: number | null;
          offsiteThresholdHours: number;
          offsiteMostRecentSuccessAt: string | null;
          hint: string;
        }
      | undefined;
    expect(details).toBeDefined();
    expect(details?.reasons).toEqual(["offsite-stale"]);
    expect(details?.offsiteAgeHours).toBe(5 * 24);
    expect(details?.offsiteThresholdHours).toBe(48);
    expect(details?.offsiteMostRecentSuccessAt).toBe(
      new Date(FAR_FUTURE.getTime() - 5 * DAY_MS).toISOString(),
    );
    // The hint must point operators at the runbook the task spec calls out.
    expect(details?.hint).toMatch(/docs\/runbooks\/rollback\.md/);
  });

  it("ignores offsite rows whose status is 'error' when computing freshness", async () => {
    // A recent failed offsite-sync row must NOT silence the watchdog —
    // mirrors the same rule for backup / drill rows.
    await insertBackup(new Date(FAR_FUTURE.getTime() - 60 * 60 * 1000));
    await insertDrill(new Date(FAR_FUTURE.getTime() - 1 * DAY_MS));
    await insertOffsite(
      new Date(FAR_FUTURE.getTime() - 60 * 60 * 1000),
      "error",
    );
    await insertOffsite(new Date(FAR_FUTURE.getTime() - 5 * DAY_MS), "success");
    const { calls, notify } = makeNotifySpy();

    const r = await checkBackupFreshness({ now: FAR_FUTURE, notify });

    expect(r.fired).toBe(true);
    expect(r.reasons).toEqual(["offsite-stale"]);
    expect(calls).toHaveLength(1);
  });

  it("rolls a stale offsite reason into a single alert with stale backup/drill", async () => {
    // Three failing axes still produce ONE page, not three.
    await insertBackup(new Date(FAR_FUTURE.getTime() - 5 * DAY_MS));
    await insertDrill(new Date(FAR_FUTURE.getTime() - 30 * DAY_MS));
    await insertOffsite(new Date(FAR_FUTURE.getTime() - 5 * DAY_MS));
    const { calls, notify } = makeNotifySpy();

    const r = await checkBackupFreshness({ now: FAR_FUTURE, notify });

    expect(r.fired).toBe(true);
    expect(r.reasons.slice().sort()).toEqual([
      "backup-stale",
      "drill-stale",
      "offsite-stale",
    ]);
    expect(calls).toHaveLength(1);
    const details = calls[0].details as { reasons: string[] };
    expect(details.reasons.slice().sort()).toEqual([
      "backup-stale",
      "drill-stale",
      "offsite-stale",
    ]);
  });

  it("pages offsite-never-run once warming-up has elapsed", async () => {
    // Offsite cron has NEVER recorded a success but local backup + drill
    // have. Once we're past the offsite threshold, that absence pages on
    // its own — the most-likely failure mode for a new bucket / IAM role.
    await insertBackup(new Date(FAR_FUTURE.getTime() - 60 * 60 * 1000));
    await insertDrill(new Date(FAR_FUTURE.getTime() - 1 * DAY_MS));
    const { calls, notify } = makeNotifySpy();

    const r = await checkBackupFreshness({
      now: FAR_FUTURE,
      serverUptimeMs: 30 * DAY_MS,
      notify,
    });

    expect(r.fired).toBe(true);
    expect(r.reasons).toEqual(["offsite-never-run"]);
    expect(calls).toHaveLength(1);
    expect(r.offsite.mostRecentSuccessAt).toBeNull();
  });

  it("respects a custom offsiteStaleThresholdMs override", async () => {
    // Offsite is 36h old. Default threshold (48h) → fresh; tightened
    // threshold (24h) → stale. Mirrors the `respects custom thresholds`
    // test for the backup axis.
    await insertBackup(new Date(FAR_FUTURE.getTime() - 60 * 60 * 1000));
    await insertDrill(new Date(FAR_FUTURE.getTime() - 1 * DAY_MS));
    await insertOffsite(new Date(FAR_FUTURE.getTime() - 36 * 60 * 60 * 1000));

    const lax = makeNotifySpy();
    const laxResult = await checkBackupFreshness({
      now: FAR_FUTURE,
      notify: lax.notify,
    });
    expect(laxResult.fired).toBe(false);
    expect(lax.calls).toHaveLength(0);

    const strict = makeNotifySpy();
    const strictResult = await checkBackupFreshness({
      now: FAR_FUTURE,
      offsiteStaleThresholdMs: 24 * 60 * 60 * 1000,
      notify: strict.notify,
    });
    expect(strictResult.fired).toBe(true);
    expect(strictResult.reasons).toEqual(["offsite-stale"]);
    expect(strict.calls).toHaveLength(1);
  });

  it("honours the DB_BACKUP_OFFSITE_STALE_HOURS env var as the default", async () => {
    // The env var is the documented operator knob — confirm a value of 24
    // tightens the default and a value of 168 (1 week) loosens it. Mirrors
    // the env-var assertions for `getRetentionCount`.
    const original = process.env.DB_BACKUP_OFFSITE_STALE_HOURS;
    try {
      // Backup + drill must be present so the only axis under test is the
      // offsite-stale one (otherwise the warming-up branch could intervene).
      await insertBackup(new Date(FAR_FUTURE.getTime() - 60 * 60 * 1000));
      await insertDrill(new Date(FAR_FUTURE.getTime() - 1 * DAY_MS));
      await insertOffsite(new Date(FAR_FUTURE.getTime() - 36 * 60 * 60 * 1000));

      process.env.DB_BACKUP_OFFSITE_STALE_HOURS = "24";
      expect(getOffsiteStaleThresholdMs()).toBe(24 * 60 * 60 * 1000);
      const tight = makeNotifySpy();
      const tightResult = await checkBackupFreshness({
        now: FAR_FUTURE,
        notify: tight.notify,
      });
      expect(tightResult.fired).toBe(true);
      expect(tightResult.reasons).toEqual(["offsite-stale"]);
      expect(tight.calls).toHaveLength(1);

      process.env.DB_BACKUP_OFFSITE_STALE_HOURS = "168"; // 7 days
      expect(getOffsiteStaleThresholdMs()).toBe(168 * 60 * 60 * 1000);
      const loose = makeNotifySpy();
      const looseResult = await checkBackupFreshness({
        now: FAR_FUTURE,
        notify: loose.notify,
      });
      expect(looseResult.fired).toBe(false);
      expect(loose.calls).toHaveLength(0);
    } finally {
      if (original === undefined) {
        delete process.env.DB_BACKUP_OFFSITE_STALE_HOURS;
      } else {
        process.env.DB_BACKUP_OFFSITE_STALE_HOURS = original;
      }
    }
  });

  it("falls back to the default when DB_BACKUP_OFFSITE_STALE_HOURS is non-numeric, zero, whitespace, or has trailing junk", () => {
    const original = process.env.DB_BACKUP_OFFSITE_STALE_HOURS;
    try {
      process.env.DB_BACKUP_OFFSITE_STALE_HOURS = "many";
      expect(getOffsiteStaleThresholdMs()).toBe(
        DEFAULT_OFFSITE_STALE_THRESHOLD_MS,
      );
      process.env.DB_BACKUP_OFFSITE_STALE_HOURS = "0";
      expect(getOffsiteStaleThresholdMs()).toBe(
        DEFAULT_OFFSITE_STALE_THRESHOLD_MS,
      );
      process.env.DB_BACKUP_OFFSITE_STALE_HOURS = "-12";
      expect(getOffsiteStaleThresholdMs()).toBe(
        DEFAULT_OFFSITE_STALE_THRESHOLD_MS,
      );
      process.env.DB_BACKUP_OFFSITE_STALE_HOURS = "   ";
      expect(getOffsiteStaleThresholdMs()).toBe(
        DEFAULT_OFFSITE_STALE_THRESHOLD_MS,
      );
      // Trailing junk — `parseInt("24h", 10)` would return 24 and silently
      // accept the misconfiguration. Strict-parser must reject it so the
      // fail-closed contract advertised in docs/runbooks/rollback.md holds.
      process.env.DB_BACKUP_OFFSITE_STALE_HOURS = "24h";
      expect(getOffsiteStaleThresholdMs()).toBe(
        DEFAULT_OFFSITE_STALE_THRESHOLD_MS,
      );
      process.env.DB_BACKUP_OFFSITE_STALE_HOURS = "24abc";
      expect(getOffsiteStaleThresholdMs()).toBe(
        DEFAULT_OFFSITE_STALE_THRESHOLD_MS,
      );
      // Decimals and exponent forms should also be rejected — the
      // threshold is documented as "positive integer hours".
      process.env.DB_BACKUP_OFFSITE_STALE_HOURS = "24.5";
      expect(getOffsiteStaleThresholdMs()).toBe(
        DEFAULT_OFFSITE_STALE_THRESHOLD_MS,
      );
      process.env.DB_BACKUP_OFFSITE_STALE_HOURS = "1e3";
      expect(getOffsiteStaleThresholdMs()).toBe(
        DEFAULT_OFFSITE_STALE_THRESHOLD_MS,
      );
      delete process.env.DB_BACKUP_OFFSITE_STALE_HOURS;
      expect(getOffsiteStaleThresholdMs()).toBe(
        DEFAULT_OFFSITE_STALE_THRESHOLD_MS,
      );
    } finally {
      if (original === undefined) {
        delete process.env.DB_BACKUP_OFFSITE_STALE_HOURS;
      } else {
        process.env.DB_BACKUP_OFFSITE_STALE_HOURS = original;
      }
    }
  });

  it("rejects a non-positive offsiteStaleThresholdMs", async () => {
    const { notify } = makeNotifySpy();
    await expect(
      checkBackupFreshness({
        offsiteStaleThresholdMs: 0,
        now: FAR_FUTURE,
        notify,
      }),
    ).rejects.toThrow(/offsiteStaleThresholdMs must be positive/);
    await expect(
      checkBackupFreshness({
        offsiteStaleThresholdMs: -5,
        now: FAR_FUTURE,
        notify,
      }),
    ).rejects.toThrow(/offsiteStaleThresholdMs must be positive/);
    await expect(
      checkBackupFreshness({
        offsiteStaleThresholdMs: Number.NaN,
        now: FAR_FUTURE,
        notify,
      }),
    ).rejects.toThrow(/offsiteStaleThresholdMs must be positive/);
  });

  it("rejects a non-positive backupStaleThresholdMs", async () => {
    const { notify } = makeNotifySpy();
    await expect(
      checkBackupFreshness({
        backupStaleThresholdMs: 0,
        now: FAR_FUTURE,
        notify,
      }),
    ).rejects.toThrow(/backupStaleThresholdMs must be positive/);
    await expect(
      checkBackupFreshness({
        backupStaleThresholdMs: -5,
        now: FAR_FUTURE,
        notify,
      }),
    ).rejects.toThrow(/backupStaleThresholdMs must be positive/);
    await expect(
      checkBackupFreshness({
        backupStaleThresholdMs: Number.POSITIVE_INFINITY,
        now: FAR_FUTURE,
        notify,
      }),
    ).rejects.toThrow(/backupStaleThresholdMs must be positive/);
  });

  it("rejects a non-positive drillStaleThresholdMs", async () => {
    const { notify } = makeNotifySpy();
    await expect(
      checkBackupFreshness({
        drillStaleThresholdMs: 0,
        now: FAR_FUTURE,
        notify,
      }),
    ).rejects.toThrow(/drillStaleThresholdMs must be positive/);
    await expect(
      checkBackupFreshness({
        drillStaleThresholdMs: Number.NaN,
        now: FAR_FUTURE,
        notify,
      }),
    ).rejects.toThrow(/drillStaleThresholdMs must be positive/);
  });
});

describe("integrity-result JSONB shape", () => {
  // The DatabaseRestoreDrillRun row carries the integrity-check breakdown in
  // a jsonb column with a $type<{ok, checks[]}>() generic. Verify the round
  // trip preserves every field — including optional `detail` strings — so a
  // future migration to a different storage shape is a flagged behaviour
  // change. The watchdog details payload reads from this same row.
  const insertedDrillIds: number[] = [];

  afterEach(async () => {
    if (insertedDrillIds.length > 0) {
      await db
        .delete(databaseRestoreDrillRuns)
        .where(
          inArray(databaseRestoreDrillRuns.id, insertedDrillIds.splice(0)),
        );
    }
  });

  it("round-trips an integrity payload with both ok and failed checks", async () => {
    const payload = {
      ok: false,
      checks: [
        { name: "users_table_present", ok: true, detail: "users.count=7" },
        {
          name: "ledger_journals_balanced",
          ok: false,
          detail: "3 torn journal(s) detected on restored copy",
        },
        { name: "schema_check_with_no_detail", ok: true },
      ],
    };

    const [inserted] = await db
      .insert(databaseRestoreDrillRuns)
      .values({
        startedAt: new Date("3000-07-01T00:00:00Z"),
        finishedAt: new Date("3000-07-01T00:01:00Z"),
        status: "error",
        dumpPath: "/tmp/test.dump",
        scratchDbName: "scratch_jsonb_roundtrip",
        integrity: payload,
        durationMs: 12345,
        errorMessage: "Integrity check FAILED",
      })
      .returning({ id: databaseRestoreDrillRuns.id });
    insertedDrillIds.push(inserted.id);

    const [readBack] = await db
      .select()
      .from(databaseRestoreDrillRuns)
      .where(inArray(databaseRestoreDrillRuns.id, [inserted.id]));

    expect(readBack.integrity).toEqual(payload);
    // Specifically assert the optional detail field is preserved as
    // "absent" rather than coerced to null on the no-detail entry.
    const noDetailCheck = readBack.integrity!.checks.find(
      (c) => c.name === "schema_check_with_no_detail",
    );
    expect(noDetailCheck).toBeDefined();
    expect(noDetailCheck!.detail).toBeUndefined();
  });
});
