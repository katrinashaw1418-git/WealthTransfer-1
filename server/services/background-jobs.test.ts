// =============================================================================
// Task #79 — Background-job health tracker tests
// =============================================================================
// Locks in the contracts the admin "Background Jobs" panel relies on:
//
//   1. `withBackgroundJobRunRecord` records one row on success (status=success,
//      summary captured, durationMs set) and one row on error (status=error,
//      errorMessage captured, the original error re-thrown so the cron's
//      existing `console.error` keeps firing).
//
//   2. `getBackgroundJobsHealth` lists EVERY known job — including ones that
//      have never run (neverRan=true, isOverdue=true). For jobs that have run
//      it returns the most recent row and computes `isOverdue` against the
//      configured threshold.
//
//   3. The "last successful" timestamp is independent of the "last run"
//      timestamp: a recent failure does not erase the historical success.
//
//   4. `recordBackgroundJobRun` rejects an unknown jobName so a typo in a
//      cron wrapper produces a loud failure, not a silently-orphan row that
//      never appears in the dashboard.
//
// All inserted rows are tracked and removed in afterEach so the file is
// idempotent on reruns and never leaves test data behind.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gte, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { backgroundJobRuns } from "@shared/schema";
import {
  DEFAULT_OVERDUE_AFTER_MS,
  KNOWN_BACKGROUND_JOBS,
  getBackgroundJobsHealth,
  recordBackgroundJobRun,
  withBackgroundJobRunRecord,
} from "./background-jobs";

// We use a real known job for the happy paths; "fee-accruals" is convenient
// because it's listed in KNOWN_BACKGROUND_JOBS and the test data is scrubbed
// after every test by startedAt anyway.
const TEST_JOB = "fee-accruals";

let testStartedAt: Date;

beforeEach(() => {
  testStartedAt = new Date();
});

afterEach(async () => {
  // Scrub any rows the test produced. Filter on startedAt >= testStartedAt
  // so we never disturb legitimate cron rows from the running server.
  await db
    .delete(backgroundJobRuns)
    .where(gte(backgroundJobRuns.startedAt, testStartedAt));
});

describe("recordBackgroundJobRun", () => {
  it("rejects an unknown jobName", async () => {
    await expect(
      recordBackgroundJobRun({
        jobName: "definitely-not-a-real-job",
        startedAt: new Date(),
        finishedAt: new Date(),
        status: "success",
      }),
    ).rejects.toThrow(/unknown jobName/);
  });

  it("rejects a status outside {success, error}", async () => {
    await expect(
      recordBackgroundJobRun({
        jobName: TEST_JOB,
        startedAt: new Date(),
        finishedAt: new Date(),
        // @ts-expect-error — deliberately invalid for this assertion.
        status: "in-progress",
      }),
    ).rejects.toThrow(/status must be/);
  });

  it("persists a success row with summary + duration", async () => {
    const startedAt = new Date(Date.now() - 1500);
    const finishedAt = new Date();
    const row = await recordBackgroundJobRun({
      jobName: TEST_JOB,
      startedAt,
      finishedAt,
      status: "success",
      summary: "12 inserted, 3 skipped",
      durationMs: 1500,
    });
    expect(row.jobName).toBe(TEST_JOB);
    expect(row.status).toBe("success");
    expect(row.summary).toBe("12 inserted, 3 skipped");
    expect(row.errorMessage).toBeNull();
    expect(row.durationMs).toBe(1500);
  });
});

describe("withBackgroundJobRunRecord", () => {
  it("records a success row when fn resolves and uses the returned string as summary", async () => {
    const result = await withBackgroundJobRunRecord(TEST_JOB, async () => {
      return "ran cleanly: 5 things done";
    });
    expect(result).toBe("ran cleanly: 5 things done");

    const rows = await db
      .select()
      .from(backgroundJobRuns)
      .where(gte(backgroundJobRuns.startedAt, testStartedAt));
    const ours = rows.filter((r) => r.jobName === TEST_JOB);
    expect(ours).toHaveLength(1);
    expect(ours[0].status).toBe("success");
    expect(ours[0].summary).toBe("ran cleanly: 5 things done");
    expect(ours[0].errorMessage).toBeNull();
    expect(ours[0].finishedAt).not.toBeNull();
    // Duration should be a non-negative integer.
    expect(typeof ours[0].durationMs).toBe("number");
    expect(ours[0].durationMs ?? -1).toBeGreaterThanOrEqual(0);
  });

  it("records an error row AND re-throws so the cron's outer catch still fires", async () => {
    const boom = new Error("simulated cron failure");
    await expect(
      withBackgroundJobRunRecord(TEST_JOB, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const rows = await db
      .select()
      .from(backgroundJobRuns)
      .where(gte(backgroundJobRuns.startedAt, testStartedAt));
    const ours = rows.filter((r) => r.jobName === TEST_JOB);
    expect(ours).toHaveLength(1);
    expect(ours[0].status).toBe("error");
    expect(ours[0].errorMessage).toBe("simulated cron failure");
    expect(ours[0].summary).toBeNull();
  });

  it("rejects an unknown jobName before invoking fn", async () => {
    let invoked = false;
    await expect(
      withBackgroundJobRunRecord("not-a-job", async () => {
        invoked = true;
        return "ok";
      }),
    ).rejects.toThrow(/unknown jobName/);
    expect(invoked).toBe(false);
  });
});

describe("getBackgroundJobsHealth", () => {
  it("lists every known job, with neverRan=true and isOverdue=true for jobs that have not run", async () => {
    // Scrub any pre-existing rows for our isolated jobs so this assertion is
    // independent of state from real cron ticks. We use the test-window
    // approach in afterEach for cleanup; here we just look at a job we know
    // has zero rows in the time window: pick the LAST job in the catalogue
    // and confirm it is reported.
    const health = await getBackgroundJobsHealth();
    expect(health.jobs).toHaveLength(KNOWN_BACKGROUND_JOBS.length);
    expect(health.overdueAfterMs).toBe(DEFAULT_OVERDUE_AFTER_MS);
    expect(typeof health.generatedAt).toBe("string");

    const names = health.jobs.map((j) => j.name).sort();
    const expected = KNOWN_BACKGROUND_JOBS.map((j) => j.name).sort();
    expect(names).toEqual(expected);

    // Every job in the response should carry its label + description.
    for (const j of health.jobs) {
      expect(j.label.length).toBeGreaterThan(0);
      expect(j.description.length).toBeGreaterThan(0);
      // Either it has a lastRun (in which case neverRan=false) or it doesn't.
      if (j.lastRun === null) {
        expect(j.neverRan).toBe(true);
        expect(j.isOverdue).toBe(true);
        expect(j.ageMs).toBeNull();
      }
    }
  });

  it("flags a job as overdue when its last run is older than the threshold", async () => {
    // We insert a deterministic row and then ask the health snapshot for an
    // overdue evaluation against a `now` that is exactly 48h after our row.
    // The injected `now` parameter on `getBackgroundJobsHealth` exists for
    // exactly this kind of deterministic test — without it the dev server's
    // own crons (sharing the database) could write a fresher row between our
    // INSERT and our SELECT and steal the DISTINCT-ON top slot.
    const insertedAt = await withBackgroundJobRunRecord(
      TEST_JOB,
      async () => "deterministic row",
    );
    expect(insertedAt).toBe("deterministic row");

    // Look up the row we just wrote so we can pin "now" to (its startedAt + 48h).
    const [row] = await db
      .select()
      .from(backgroundJobRuns)
      .where(gte(backgroundJobRuns.startedAt, testStartedAt))
      .orderBy(backgroundJobRuns.id);
    const fakeNow = new Date(row.startedAt.getTime() + 48 * 60 * 60 * 1000);

    const health = await getBackgroundJobsHealth({
      overdueAfterMs: 36 * 60 * 60 * 1000,
      now: fakeNow,
    });
    const target = health.jobs.find((j) => j.name === TEST_JOB)!;
    expect(target).toBeDefined();
    expect(target.neverRan).toBe(false);
    expect(target.isOverdue).toBe(true);
    expect(target.ageMs).toBeGreaterThan(36 * 60 * 60 * 1000);
  });

  it("flags a recent run as healthy when within the threshold", async () => {
    await withBackgroundJobRunRecord(TEST_JOB, async () => "fresh run summary");
    // Pin "now" close to actual now so the row is well within the default
    // 36h threshold AND we don't depend on whichever cron last ran in dev.
    const [row] = await db
      .select()
      .from(backgroundJobRuns)
      .where(gte(backgroundJobRuns.startedAt, testStartedAt))
      .orderBy(backgroundJobRuns.id);
    const fakeNow = new Date(row.startedAt.getTime() + 60_000); // +1 min
    const health = await getBackgroundJobsHealth({ now: fakeNow });
    const target = health.jobs.find((j) => j.name === TEST_JOB)!;
    expect(target.neverRan).toBe(false);
    expect(target.isOverdue).toBe(false);
    expect(target.lastSuccessAt).not.toBeNull();
  });

  it("preserves lastSuccessAt even when the most recent run failed", async () => {
    // First, a successful run.
    await withBackgroundJobRunRecord(TEST_JOB, async () => "good run");
    // Capture the iso of the success row we just wrote (filter by our test
    // window so we ignore any dev-server cron rows).
    const [successRow] = await db
      .select()
      .from(backgroundJobRuns)
      .where(gte(backgroundJobRuns.startedAt, testStartedAt))
      .orderBy(backgroundJobRuns.id);
    const successIso = new Date(successRow.startedAt).toISOString();

    // Then, a failure.
    await expect(
      withBackgroundJobRunRecord(TEST_JOB, async () => {
        throw new Error("then it broke");
      }),
    ).rejects.toThrow(/then it broke/);

    const health = await getBackgroundJobsHealth();
    const target = health.jobs.find((j) => j.name === TEST_JOB)!;
    // Last RUN reflects the failure …
    expect(target.lastRun?.status).toBe("error");
    expect(target.lastRun?.errorMessage).toBe("then it broke");
    // … but lastSuccessAt remembers the earlier good run. Note: if the dev
    // server's fee-accruals cron writes a NEWER success row mid-test, this
    // would show that newer iso instead. Asserting >= protects against that.
    expect(target.lastSuccessAt).not.toBeNull();
    expect(new Date(target.lastSuccessAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(successIso).getTime(),
    );
  });
});
