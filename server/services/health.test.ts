// =============================================================================
// Task #166 — buildHealthReport regression coverage
// =============================================================================
// Locks in the four-permutation contract that drives the /health surface and
// the admin "lastSuccessfulHealthProbeAt" signal:
//
//   1. ok            — DB ping succeeds AND every cron job has a recent
//                      success. status='ok', every check is 'ok',
//                      recordSuccessfulHealthProbe() IS called.
//   2. db-down       — DB ping rejects/times out. status='degraded',
//                      database_connectivity='fail', the probe signal is
//                      NOT refreshed (so monitors don't see a stale "ok").
//   3. stale-cron    — DB ping ok, but one cron's most-recent success is
//                      OLDER than DAILY_JOB_FRESHNESS_MS. status='degraded',
//                      that single check is 'fail' with ageMs > thresholdMs,
//                      every other check is still 'ok'.
//   4. never-ran     — DB ping ok, but a cron has zero success rows on file.
//                      status='degraded', that check is 'fail' with
//                      ageMs=null and lastSuccessAt=null. (Spec note in
//                      services/health.ts: "we do NOT distinguish 'never ran'
//                      from 'stale' in /health" — both are failures, but the
//                      payload SHAPE differs and we lock both shapes here.)
//
// The DB module is mocked so the test never touches Postgres — exactly the
// "freshness threshold flips silently" scenario the task brief calls out
// runs in milliseconds and is fully deterministic.
//
// Call-order contract (the mock relies on it):
//   buildHealthReport runs Promise.all([
//     checkDatabase,                        // db.execute #1 — SELECT 1
//     checkJobFreshness("fee-accruals"),    // db.execute #2 — SELECT started_at
//     checkJobFreshness("wallet-…"),        // db.execute #3 — SELECT started_at
//     checkJobFreshness("operator-…"),      // db.execute #4 — SELECT started_at
//   ])
// Promise.all kicks the four off synchronously in array order before any of
// them awaits, so mockImplementationOnce queued in that order is the call
// each one receives. If a future refactor reorders the checks, this comment
// is the breadcrumb that explains why the test goes red.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the DB module BEFORE importing services/health so the mocked db.execute
// is what the production code captures at module-evaluation time. Drizzle's
// `sql` template tag is not exercised — we only assert on the response shape
// the production code derives from the rows array.
vi.mock("../db", () => ({
  db: { execute: vi.fn() },
  pool: {},
}));

import { db } from "../db";
import {
  buildHealthReport,
  DAILY_JOB_FRESHNESS_MS,
} from "./health";
import {
  getLastSuccessfulHealthProbeAt,
  recordSuccessfulHealthProbe,
} from "./error-log";

const mockedExecute = db.execute as unknown as ReturnType<typeof vi.fn>;

// Helper — Drizzle's neon driver returns an object with a `rows` array, so
// our mock returns the same shape the production code's defensive accessor
// already handles (see getMostRecentSuccessAt in services/health.ts).
function rows<T>(values: T[]): { rows: T[] } {
  return { rows: values };
}

function freshSuccessRow(now: Date, ageMs: number): { startedAt: Date } {
  return { startedAt: new Date(now.getTime() - ageMs) };
}

beforeEach(() => {
  mockedExecute.mockReset();
});

afterEach(() => {
  mockedExecute.mockReset();
});

describe("buildHealthReport — ok permutation", () => {
  it("returns status='ok' and refreshes the probe signal when DB + all crons are healthy", async () => {
    // Arrange — DB ping resolves, then three cron freshness queries each
    // return a success row well inside the freshness window.
    const probeBefore = getLastSuccessfulHealthProbeAt();
    mockedExecute
      .mockResolvedValueOnce(rows([{ ok: 1 }])) // SELECT 1
      .mockResolvedValueOnce(rows([freshSuccessRow(new Date(), 60_000)])) // fee-accruals
      .mockResolvedValueOnce(rows([freshSuccessRow(new Date(), 120_000)])) // wallet-…
      .mockResolvedValueOnce(rows([freshSuccessRow(new Date(), 30_000)])); // operator-…

    const report = await buildHealthReport();

    expect(report.status).toBe("ok");
    expect(report.checks).toHaveLength(4);
    expect(report.checks.every((c) => c.status === "ok")).toBe(true);

    const dbCheck = report.checks.find((c) => c.name === "database_connectivity");
    expect(dbCheck?.status).toBe("ok");
    expect(dbCheck?.detail).toMatch(/SELECT 1/);

    const feeCheck = report.checks.find((c) => c.name === "fee_accruals");
    expect(feeCheck?.thresholdMs).toBe(DAILY_JOB_FRESHNESS_MS);
    expect(feeCheck?.ageMs).toBeGreaterThan(0);
    expect(feeCheck?.lastSuccessAt).toMatch(/T/);

    // The probe signal is the contract that drives the admin metrics tile
    // — it MUST be refreshed by every successful build.
    const probeAfter = getLastSuccessfulHealthProbeAt();
    expect(probeAfter).not.toBeNull();
    expect(probeAfter!).toBeGreaterThanOrEqual(probeBefore ?? 0);

    expect(report.lastSuccessfulProbeAt).not.toBeNull();
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("buildHealthReport — db-down permutation", () => {
  it("returns status='degraded' with a failed DB check and does NOT refresh the probe signal", async () => {
    // Seed the probe signal with a known timestamp so we can prove the
    // failed run did not push it forward.
    recordSuccessfulHealthProbe();
    const seededProbe = getLastSuccessfulHealthProbeAt();
    expect(seededProbe).not.toBeNull();

    // Arrange — DB ping rejects (the production code's Promise.race wraps
    // this into a 'fail' check). The three cron queries still resolve so
    // the test proves the DB check alone tips the overall status.
    mockedExecute
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(rows([freshSuccessRow(new Date(), 60_000)]))
      .mockResolvedValueOnce(rows([freshSuccessRow(new Date(), 60_000)]))
      .mockResolvedValueOnce(rows([freshSuccessRow(new Date(), 60_000)]));

    // Wait one tick so the seeded timestamp would be visibly older if the
    // production code (mistakenly) bumped it on a degraded build.
    await new Promise((r) => setTimeout(r, 5));

    const report = await buildHealthReport();

    expect(report.status).toBe("degraded");
    const dbCheck = report.checks.find((c) => c.name === "database_connectivity");
    expect(dbCheck?.status).toBe("fail");
    expect(dbCheck?.detail).toMatch(/connection refused/);

    // The cron checks must still be evaluated and reported even when the
    // DB ping fails — the operator wants the full picture, not a short-
    // circuited payload.
    expect(report.checks.filter((c) => c.status === "ok")).toHaveLength(3);

    // Crucial invariant: a degraded build NEVER bumps the "last successful
    // health probe" timestamp. If it did, an outage would be invisible to
    // the admin metrics tile.
    expect(getLastSuccessfulHealthProbeAt()).toBe(seededProbe);
  });
});

describe("buildHealthReport — stale-cron permutation", () => {
  it("flags the single stale cron 'fail' with ageMs > thresholdMs and leaves the others 'ok'", async () => {
    // Arrange — DB ping resolves; two crons are fresh, one is stale by
    // 2h beyond the threshold. The exact margin is asserted so a future
    // change to DAILY_JOB_FRESHNESS_MS that silently flips the verdict
    // (the very regression the task brief mentions) trips this test.
    const stalenessMs = DAILY_JOB_FRESHNESS_MS + 2 * 60 * 60 * 1000; // +2h
    mockedExecute
      .mockResolvedValueOnce(rows([{ ok: 1 }]))
      .mockResolvedValueOnce(rows([freshSuccessRow(new Date(), 60_000)])) // fee-accruals: fresh
      .mockResolvedValueOnce(rows([freshSuccessRow(new Date(), stalenessMs)])) // wallet-…: STALE
      .mockResolvedValueOnce(rows([freshSuccessRow(new Date(), 60_000)])); // operator-…: fresh

    const report = await buildHealthReport();

    expect(report.status).toBe("degraded");

    const stale = report.checks.find(
      (c) => c.name === "wallet_ledger_reconciliation",
    );
    expect(stale?.status).toBe("fail");
    expect(stale?.ageMs).toBeGreaterThan(DAILY_JOB_FRESHNESS_MS);
    expect(stale?.thresholdMs).toBe(DAILY_JOB_FRESHNESS_MS);
    expect(stale?.lastSuccessAt).toMatch(/T/);
    expect(stale?.detail).toMatch(/over .*h threshold/);

    // The other three checks stay 'ok' — this is the "one bad cron does not
    // poison the rest of the payload" invariant.
    const okChecks = report.checks.filter((c) => c.status === "ok");
    expect(okChecks.map((c) => c.name).sort()).toEqual([
      "database_connectivity",
      "fee_accruals",
      "operator_alerts_prune",
    ]);
  });

  it("treats a freshness exactly at the threshold as still 'ok' (boundary)", async () => {
    // The production check is `ageMs <= thresholdMs ? 'ok' : 'fail'`. We
    // pin the boundary so a future refactor to `<` would be caught here
    // rather than in the next on-call rotation.
    //
    // Freeze the clock for this test only — the assertion is millisecond-
    // exact (ageMs == thresholdMs), and without a frozen clock the few ms
    // between building the mock rows and buildHealthReport's own `new Date()`
    // would push ageMs over the threshold and silently flip the verdict to
    // 'fail'. afterEach restores real timers for the next test.
    vi.useFakeTimers();
    const frozenNow = new Date("2026-06-01T12:00:00Z");
    vi.setSystemTime(frozenNow);

    try {
      const exactlyAtThreshold = DAILY_JOB_FRESHNESS_MS;
      mockedExecute
        .mockResolvedValueOnce(rows([{ ok: 1 }]))
        .mockResolvedValueOnce(
          rows([freshSuccessRow(frozenNow, exactlyAtThreshold)]),
        )
        .mockResolvedValueOnce(rows([freshSuccessRow(frozenNow, 60_000)]))
        .mockResolvedValueOnce(rows([freshSuccessRow(frozenNow, 60_000)]));

      const report = await buildHealthReport();
      const fee = report.checks.find((c) => c.name === "fee_accruals");
      expect(fee?.ageMs).toBe(DAILY_JOB_FRESHNESS_MS);
      expect(fee?.status).toBe("ok");
      expect(report.status).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("buildHealthReport — never-ran-cron permutation", () => {
  it("flags a cron with zero success rows as 'fail' with ageMs=null and lastSuccessAt=null", async () => {
    // Arrange — DB ping ok, fee-accruals has no rows yet, the other two
    // crons are fresh. The zero-rows shape is what a fresh DB plus a cron
    // that has never completed a successful run looks like.
    mockedExecute
      .mockResolvedValueOnce(rows([{ ok: 1 }]))
      .mockResolvedValueOnce(rows([])) // fee-accruals: NEVER RAN
      .mockResolvedValueOnce(rows([freshSuccessRow(new Date(), 60_000)]))
      .mockResolvedValueOnce(rows([freshSuccessRow(new Date(), 60_000)]));

    const report = await buildHealthReport();

    expect(report.status).toBe("degraded");
    const neverRan = report.checks.find((c) => c.name === "fee_accruals");
    expect(neverRan?.status).toBe("fail");
    // Distinct payload shape vs. the stale-cron case — null vs. a number.
    expect(neverRan?.ageMs).toBeNull();
    expect(neverRan?.lastSuccessAt).toBeNull();
    expect(neverRan?.detail).toMatch(/no successful run recorded/);
    expect(neverRan?.thresholdMs).toBe(DAILY_JOB_FRESHNESS_MS);
  });

  it("also handles the row-with-null-startedAt edge as 'never ran'", async () => {
    // Defensive shape — the COALESCE in production treats a null startedAt
    // value the same as zero rows. Lock that in so a future schema change
    // (e.g. column nullability flip) does not silently degrade the signal.
    mockedExecute
      .mockResolvedValueOnce(rows([{ ok: 1 }]))
      .mockResolvedValueOnce(rows([{ startedAt: null }]))
      .mockResolvedValueOnce(rows([freshSuccessRow(new Date(), 60_000)]))
      .mockResolvedValueOnce(rows([freshSuccessRow(new Date(), 60_000)]));

    const report = await buildHealthReport();
    const fee = report.checks.find((c) => c.name === "fee_accruals");
    expect(fee?.status).toBe("fail");
    expect(fee?.ageMs).toBeNull();
    expect(fee?.lastSuccessAt).toBeNull();
  });
});
