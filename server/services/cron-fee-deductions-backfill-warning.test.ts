// =============================================================================
// Task #29 — Warn admins when a long outage drops days from auto-backfill
// =============================================================================
// runFeeAccrualsCronOnce computes the per-tick backfill window from the
// latest accrual_date and the current UTC clock, capped at
// FEE_ACCRUAL_BACKFILL_MAX_DAYS (14). Before Task #29, when the gap
// exceeded the cap the oldest dates were silently dropped — the run row
// in `fee_accrual_runs` looked identical to a "we caught up cleanly"
// pass and admins had to scrape server logs to find the gap.
//
// Task #29 attaches a structured `droppedFromBackfill` annotation to
// every per-date `fee_accrual_runs` row produced by a clipped tick (and
// also adds a suffix to the cron's summary string) so the admin Fees
// page can render an "X days were skipped — replay manually" warning
// without a log scrape. This suite locks the contract:
//
//   1. When the gap fits inside the cap, NO `droppedFromBackfill`
//      annotation is set on any per-date call (and the summary string
//      contains no "dropped" suffix).
//
//   2. When the gap exceeds the cap, every per-date call to
//      `runDailyAccrualsAndRecord` receives the SAME annotation, with
//      `start` = the oldest dropped UTC date, `end` = the newest
//      dropped UTC date, `count` = number of dropped dates, and the
//      summary string carries a matching "dropped … older than cap"
//      suffix mentioning that range.
//
//   3. The cap itself stays in place — the planned date count stays at
//      14 (FEE_ACCRUAL_BACKFILL_MAX_DAYS) regardless of how big the
//      gap is. (This guards against a future regression that "fixes"
//      the warning by removing the cap entirely, which would re-open
//      the runaway-sweep risk Task #24 closed.)
//
// We mock both `getLatestAccrualDate` and `runDailyAccrualsAndRecord`
// so the test runs without DB setup — the cron's planning logic is
// pure given those two seams, which is exactly the surface the warning
// depends on.
// =============================================================================

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./fee-engine", () => ({
  getLatestAccrualDate: vi.fn(),
  runDailyAccrualsAndRecord: vi.fn(),
}));

vi.mock("./kill-switch", () => ({
  isKillSwitchActive: vi.fn(async () => false),
}));

import { runFeeAccrualsCronOnce } from "./cron-fee-deductions";
import {
  getLatestAccrualDate,
  runDailyAccrualsAndRecord,
} from "./fee-engine";

const getLatestAccrualDateMock = vi.mocked(getLatestAccrualDate);
const runDailyAccrualsAndRecordMock = vi.mocked(runDailyAccrualsAndRecord);

const NOW = new Date("2026-04-27T12:00:00Z");

function emptySummaryRun() {
  // The shape `runDailyAccrualsAndRecord` returns — only the count
  // fields and `byGateReason` are read by the cron; `run` is opaque.
  return {
    run: {
      id: 1,
      accrualDate: new Date(),
      trigger: "cron" as const,
      triggeredByUserId: null,
      inserted: 0,
      skipped: 0,
      duplicates: 0,
      byGateReason: {},
      errorMessage: null,
      droppedFromBackfill: null,
      startedAt: new Date(),
      finishedAt: new Date(),
    },
    inserted: 0,
    skipped: 0,
    duplicates: 0,
    byGateReason: {} as Record<string, number>,
  };
}

describe("runFeeAccrualsCronOnce — Task #29 backfill drop warning", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT annotate runs when the gap fits inside the 14-day cap", async () => {
    // 5-day gap: latest = 2026-04-22, today = 2026-04-27 → 5 dates planned,
    // none dropped.
    getLatestAccrualDateMock.mockResolvedValue(new Date("2026-04-22T00:00:00Z"));
    runDailyAccrualsAndRecordMock.mockResolvedValue(emptySummaryRun());

    const summary = await runFeeAccrualsCronOnce({ now: NOW });

    expect(runDailyAccrualsAndRecordMock).toHaveBeenCalledTimes(5);
    for (const call of runDailyAccrualsAndRecordMock.mock.calls) {
      expect(call[0].droppedFromBackfill).toBeNull();
    }
    expect(summary).not.toContain("dropped");
    expect(summary).not.toContain("older than cap");
  });

  it("annotates EVERY run with the dropped range when the gap exceeds the cap", async () => {
    // 30-day gap: latest = 2026-03-28, today = 2026-04-27 → 30 dates
    // computed, oldest 16 dropped, newest 14 planned. Dropped range is
    // 2026-03-29..2026-04-13 (the 16 oldest of the computed window).
    getLatestAccrualDateMock.mockResolvedValue(new Date("2026-03-28T00:00:00Z"));
    runDailyAccrualsAndRecordMock.mockResolvedValue(emptySummaryRun());

    const summary = await runFeeAccrualsCronOnce({ now: NOW });

    // The cap stays at 14 — this is the regression guard against
    // "fixing" the warning by removing the cap.
    expect(runDailyAccrualsAndRecordMock).toHaveBeenCalledTimes(14);

    const expectedDropped = {
      start: "2026-03-29",
      end: "2026-04-13",
      count: 16,
    };
    for (const call of runDailyAccrualsAndRecordMock.mock.calls) {
      expect(call[0].droppedFromBackfill).toEqual(expectedDropped);
    }

    // The summary string the dashboard records on `background_job_runs`
    // must also surface the drop so a log-only consumer (e.g. an alert
    // pipeline) sees it without joining `fee_accrual_runs`.
    expect(summary).toContain("dropped 16 day(s) older than cap");
    expect(summary).toContain("2026-03-29..2026-04-13");
    expect(summary).toContain("replay manually");
  });

  it("does not annotate when the gap is exactly the cap (boundary case)", async () => {
    // 14-day gap: latest = 2026-04-13, today = 2026-04-27 → 14 dates
    // planned, NONE dropped (cap is inclusive of 14).
    getLatestAccrualDateMock.mockResolvedValue(new Date("2026-04-13T00:00:00Z"));
    runDailyAccrualsAndRecordMock.mockResolvedValue(emptySummaryRun());

    const summary = await runFeeAccrualsCronOnce({ now: NOW });

    expect(runDailyAccrualsAndRecordMock).toHaveBeenCalledTimes(14);
    for (const call of runDailyAccrualsAndRecordMock.mock.calls) {
      expect(call[0].droppedFromBackfill).toBeNull();
    }
    expect(summary).not.toContain("dropped");
  });
});
