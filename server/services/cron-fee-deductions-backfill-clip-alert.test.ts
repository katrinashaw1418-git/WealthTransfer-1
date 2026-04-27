// =============================================================================
// Task #252 — Page on-call when daily fee accrual silently drops dates
// =============================================================================
// Task #29 added the in-product banner on the admin Fees page when the
// daily fee-accrual cron's auto-backfill window exceeds the 14-day cap
// and the oldest UTC dates are dropped. Task #252 layers a push channel
// on top: when `runFeeAccrualsCronOnce` clips its planned window, it
// dispatches one operator alert (source = `fee-accrual-backfill-clip`)
// via the same `notifyOperator` dispatcher the wallet-↔-ledger
// reconciliation cron uses — so a clip event during a long weekend does
// not sit on a dashboard nobody is reading.
//
// This suite locks the contract:
//
//   1. NO alert is dispatched on a tick that did NOT clip (the gap fits
//      inside the 14-day cap, OR no previous accrual existed).
//
//   2. Exactly ONE alert IS dispatched on a tick that DID clip, with:
//        - source = 'fee-accrual-backfill-clip'
//        - severity = 'alert'
//        - details containing the dropped UTC range + count + cap
//        - explicit dedupe identity (subjectType=utc-date-range,
//          subjectId='${start}..${end}') so a re-run of the same tick
//          collapses onto one row inside the dispatcher's dedupe window.
//
//   3. The alert dispatch happens BEFORE the per-date accrual loop runs
//      (a single-date accrual failure must not gate the page going out).
//
//   4. A throw from the dispatcher does NOT abort the cron — the
//      per-date accrual loop still runs to completion. The page channel
//      is best-effort by design; the dropped-range banner on the admin
//      Fees page is the durable signal in that case.
// =============================================================================

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./fee-engine", () => ({
  getLatestAccrualDate: vi.fn(),
  runDailyAccrualsAndRecord: vi.fn(),
}));

vi.mock("./kill-switch", () => ({
  isKillSwitchActive: vi.fn(async () => false),
}));

vi.mock("./operator-alerts", () => ({
  notifyOperator: vi.fn(async () => ({
    channelsAttempted: ["log"],
    outcomes: [],
    channels: ["log"],
    alertId: 42,
    deliveryStatus: "delivered",
    occurrences: 1,
    dedupeKey: "test-key",
  })),
}));

import {
  FEE_ACCRUAL_BACKFILL_CLIP_ALERT_SOURCE,
  runFeeAccrualsCronOnce,
} from "./cron-fee-deductions";
import {
  getLatestAccrualDate,
  runDailyAccrualsAndRecord,
} from "./fee-engine";
import { notifyOperator } from "./operator-alerts";

const getLatestAccrualDateMock = vi.mocked(getLatestAccrualDate);
const runDailyAccrualsAndRecordMock = vi.mocked(runDailyAccrualsAndRecord);
const notifyOperatorMock = vi.mocked(notifyOperator);

const NOW = new Date("2026-04-27T12:00:00Z");

function emptySummaryRun() {
  // Same shape used by the Task #29 sibling suite — only the count
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

describe("runFeeAccrualsCronOnce — Task #252 backfill clip operator alert", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT dispatch an alert when the gap fits inside the cap", async () => {
    // 5-day gap → 5 dates planned, 0 dropped. No clip event, no page.
    getLatestAccrualDateMock.mockResolvedValue(new Date("2026-04-22T00:00:00Z"));
    runDailyAccrualsAndRecordMock.mockResolvedValue(emptySummaryRun());

    await runFeeAccrualsCronOnce({ now: NOW });

    expect(notifyOperatorMock).not.toHaveBeenCalled();
  });

  it("does NOT dispatch an alert on the first-ever run (no prior accrual)", async () => {
    // No prior accrual → cron just runs today, droppedFromBackfill stays null.
    getLatestAccrualDateMock.mockResolvedValue(null);
    runDailyAccrualsAndRecordMock.mockResolvedValue(emptySummaryRun());

    await runFeeAccrualsCronOnce({ now: NOW });

    expect(notifyOperatorMock).not.toHaveBeenCalled();
  });

  it("dispatches exactly ONE alert when the gap exceeds the cap, with the dropped range in the payload", async () => {
    // 30-day gap: latest = 2026-03-28, today = 2026-04-27 → 30 dates
    // computed, oldest 16 dropped (2026-03-29..2026-04-13), newest 14
    // planned (2026-04-14..2026-04-27).
    getLatestAccrualDateMock.mockResolvedValue(new Date("2026-03-28T00:00:00Z"));
    runDailyAccrualsAndRecordMock.mockResolvedValue(emptySummaryRun());

    await runFeeAccrualsCronOnce({ now: NOW });

    expect(notifyOperatorMock).toHaveBeenCalledTimes(1);
    const alert = notifyOperatorMock.mock.calls[0][0];

    // Source / severity match the contract documented in the task and
    // pinned by FEE_ACCRUAL_BACKFILL_CLIP_ALERT_SOURCE.
    expect(alert.source).toBe(FEE_ACCRUAL_BACKFILL_CLIP_ALERT_SOURCE);
    expect(alert.source).toBe("fee-accrual-backfill-clip");
    expect(alert.severity).toBe("alert");

    // Payload carries the dropped UTC range + count so a downstream
    // Slack/PagerDuty receiver can render it without joining the DB.
    expect(alert.details).toMatchObject({
      droppedRangeStart: "2026-03-29",
      droppedRangeEnd: "2026-04-13",
      droppedCount: 16,
      backfillCapDays: 14,
      plannedRangeStart: "2026-04-14",
      plannedRangeEnd: "2026-04-27",
      tickUtcDate: "2026-04-27",
    });
    expect(alert.details.remediation).toEqual(
      expect.stringContaining("fee-accruals/run"),
    );

    // Title is human-readable and surfaces the same range/count for the
    // log line and Slack message preview.
    expect(alert.title).toContain("16 day(s)");
    expect(alert.title).toContain("2026-03-29..2026-04-13");
    expect(alert.title).toContain("replay manually");
  });

  it("uses the dropped range as the explicit dedupe identity so same-tick re-runs collapse onto one row", async () => {
    getLatestAccrualDateMock.mockResolvedValue(new Date("2026-03-28T00:00:00Z"));
    runDailyAccrualsAndRecordMock.mockResolvedValue(emptySummaryRun());

    await runFeeAccrualsCronOnce({ now: NOW });

    const alert = notifyOperatorMock.mock.calls[0][0];

    // The kind / subject pair is what the dispatcher feeds into
    // `deriveDedupeKey`. Anchoring it to the dropped range means a
    // manual replay of the same tick (and any other clip event that
    // happens to produce the same range inside the dedupe window)
    // collapses onto the EARLIER operator_alerts row instead of
    // re-paging.
    expect(alert.kind).toBe("fee-accrual-backfill-clip");
    expect(alert.subjectType).toBe("utc-date-range");
    expect(alert.subjectId).toBe("2026-03-29..2026-04-13");
  });

  it("dispatches the alert BEFORE the per-date accrual loop runs (so a per-date failure cannot gate the page)", async () => {
    // 30-day gap, but every per-date call throws. The cron must still
    // page the on-call channel — the clip event is the signal, not the
    // success/failure of the (capped) loop.
    getLatestAccrualDateMock.mockResolvedValue(new Date("2026-03-28T00:00:00Z"));
    runDailyAccrualsAndRecordMock.mockRejectedValue(
      new Error("synthetic per-date failure"),
    );

    await runFeeAccrualsCronOnce({ now: NOW });

    expect(notifyOperatorMock).toHaveBeenCalledTimes(1);
    expect(notifyOperatorMock.mock.calls[0][0].source).toBe(
      FEE_ACCRUAL_BACKFILL_CLIP_ALERT_SOURCE,
    );
    // And the cron still attempted every planned date (the per-date
    // try/catch absorbs the throws so one bad date never blocks the rest).
    expect(runDailyAccrualsAndRecordMock).toHaveBeenCalledTimes(14);
  });

  it("does NOT abort the cron when the dispatcher itself throws (page is best-effort)", async () => {
    // notifyOperator already swallows its own channel failures, but we
    // also defend against a hypothetical synchronous throw — a flaky
    // dispatcher must never break the per-date accrual loop. The
    // dropped-range banner on the admin Fees page is the durable
    // signal in that case.
    getLatestAccrualDateMock.mockResolvedValue(new Date("2026-03-28T00:00:00Z"));
    runDailyAccrualsAndRecordMock.mockResolvedValue(emptySummaryRun());
    notifyOperatorMock.mockRejectedValueOnce(
      new Error("synthetic dispatcher outage"),
    );

    const summary = await runFeeAccrualsCronOnce({ now: NOW });

    // The cron returned a normal summary string and ran the planned
    // 14 dates anyway.
    expect(runDailyAccrualsAndRecordMock).toHaveBeenCalledTimes(14);
    expect(summary).toContain("dropped 16 day(s) older than cap");
  });
});
