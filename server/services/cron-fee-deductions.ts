// =============================================================================
// Task #168 — testable cron wrappers for fee-deduction money movement
// =============================================================================
// The kill-switch skip behaviour for the two daily fee-deduction crons
// (fee accruals + insufficient-funds sweep) was previously inlined as
// closures inside `setupCrons` in server/index.ts. That made the
// "skipped: kill switch fee_deductions is engaged ..." summary line
// untestable in isolation — Task #168 needs CI assertions that prove a
// future refactor of either cron cannot silently drop the skip.
//
// Extracting them here gives us:
//
//   * One named, exported function per cron that returns the same
//     summary string the cron previously logged.
//   * A single source of truth for the exact "skipped: ..." wording so
//     the tests in `kill-switch.test.ts` can assert against a constant
//     (no copy-paste drift between test and runtime).
//   * Optional injection points (`now` for fee accruals, `runSweep` for
//     the sweep) that keep the production behaviour intact while
//     letting tests force deterministic dates / replace the inner sweep
//     with a probe spy.
//
// Server boot still wraps the call in `withBackgroundJobRunRecord` so
// the dashboard's per-job row is unchanged.
// =============================================================================

import {
  getLatestAccrualDate,
  runDailyAccrualsAndRecord,
  type DroppedFromBackfill,
} from "./fee-engine";
import { isKillSwitchActive } from "./kill-switch";
import {
  runInsufficientFundsSweep,
  type InsufficientFundsSweepSummary,
  type RunInsufficientFundsSweepOpts,
} from "./insufficient-funds-sweep";
import { notifyOperator } from "./operator-alerts";

// Stable strings — both are referenced by the kill-switch test suite to
// assert that the cron actually emitted the skip line (and not, say, a
// silent zero-row "completed" pass). Changing either will fail those
// tests, which is the desired guardrail.
export const FEE_ACCRUALS_KILL_SWITCH_SKIP_NOTE =
  "skipped: kill switch fee_deductions is engaged — no accruals run";
export const SWEEP_KILL_SWITCH_SKIP_NOTE =
  "skipped: kill switch fee_deductions is engaged — no settlements attempted";

// Task #252 — operator alert source string for the "auto-backfill clipped
// the oldest dates" page. Kept as an exported constant so the test suite
// (and any future log-routing rule) can reference the same name without
// risk of copy-paste drift.
export const FEE_ACCRUAL_BACKFILL_CLIP_ALERT_SOURCE =
  "fee-accrual-backfill-clip";

const FEE_ACCRUAL_BACKFILL_MAX_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

function logLine(prefix: string, message: string): void {
  // Mirrors server/vite.ts `log()` formatting closely enough that the
  // dashboard log scrape still groups these lines under the same source.
  console.log(`[${prefix}] ${message}`);
}

export interface RunFeeAccrualsCronOnceOpts {
  // Override the wall clock — used by tests to make the planned date
  // deterministic. Defaults to "now".
  now?: Date;
}

/**
 * Single tick of the fee-accruals cron. Honours the `fee_deductions`
 * kill switch (returns the canonical skip note immediately when it is
 * engaged) and otherwise plans + runs the same backfill window the
 * previous inline implementation did. The return value is the summary
 * string `withBackgroundJobRunRecord` records on the job row.
 */
export async function runFeeAccrualsCronOnce(
  opts: RunFeeAccrualsCronOnceOpts = {},
): Promise<string> {
  // Task #146 — kill switch. When fee_deductions is disabled, scheduled
  // accrual still represents fee work that operators have asked us to
  // stop. Bail with a single info-level summary line so the cron leaves
  // a clean trace in `background_job_runs` (instead of a blank pass that
  // looks identical to "no rules to accrue").
  if (await isKillSwitchActive("fee_deductions")) {
    logLine("fee-accruals", FEE_ACCRUALS_KILL_SWITCH_SKIP_NOTE);
    return FEE_ACCRUALS_KILL_SWITCH_SKIP_NOTE;
  }

  const today = startOfUtcDay(opts.now ?? new Date());

  // Decide which UTC dates to run. Default: today only. If a previous
  // accrual exists and there's a gap, fill in every missed UTC date up to
  // today (capped). If the table is empty (first ever run) we don't try
  // to invent history — we just do today.
  let plannedDates: Date[] = [today];
  // Task #29 — when the gap exceeds FEE_ACCRUAL_BACKFILL_MAX_DAYS we drop the
  // oldest computed dates and remember which ones were dropped so the admin
  // Fees page can warn that those dates need a manual replay. NULL on a
  // tick where the gap fits inside the cap.
  let droppedFromBackfill: DroppedFromBackfill | null = null;
  try {
    const latest = await getLatestAccrualDate();
    if (latest) {
      const latestDay = startOfUtcDay(latest);
      const gapDays = Math.floor(
        (today.getTime() - latestDay.getTime()) / DAY_MS,
      );
      if (gapDays > 0) {
        const computed: Date[] = [];
        for (let i = 1; i <= gapDays; i++) {
          computed.push(new Date(latestDay.getTime() + i * DAY_MS));
        }
        if (computed.length > FEE_ACCRUAL_BACKFILL_MAX_DAYS) {
          const dropped = computed.slice(
            0,
            computed.length - FEE_ACCRUAL_BACKFILL_MAX_DAYS,
          );
          droppedFromBackfill = {
            start: dropped[0].toISOString().slice(0, 10),
            end: dropped[dropped.length - 1].toISOString().slice(0, 10),
            count: dropped.length,
          };
          plannedDates = computed.slice(
            computed.length - FEE_ACCRUAL_BACKFILL_MAX_DAYS,
          );
        } else {
          plannedDates = computed;
        }
      }
    }
  } catch (e) {
    console.error(
      "[fee-accruals] failed to determine backfill range; running today only",
      e,
    );
    plannedDates = [today];
    droppedFromBackfill = null;
  }

  // Task #252 — page on-call when the auto-backfill window was clipped.
  // The dropped-range banner on the admin Fees page (Task #29) is still in
  // place; this just adds a push channel so a multi-day outage does not
  // sit unnoticed over a long weekend. Wrapped in try/catch so a failing
  // dispatcher (DB outage, webhook misconfig) cannot abort the actual
  // accrual loop below — the per-date work matters more than the page.
  //
  // Dedupe identity: the dropped range itself. `subjectType=utc-date-range`
  // and `subjectId=${start}..${end}` keep two ticks that produce the SAME
  // dropped range collapsed onto a single operator_alerts row inside the
  // configured dedupe window (default 15 minutes), so a manual replay of
  // the same tick — or a boot-time tick that lands on top of the scheduled
  // tick — does not double-page.
  if (droppedFromBackfill) {
    const plannedFirst = plannedDates[0].toISOString().slice(0, 10);
    const plannedLast = plannedDates[plannedDates.length - 1]
      .toISOString()
      .slice(0, 10);
    try {
      await notifyOperator({
        source: FEE_ACCRUAL_BACKFILL_CLIP_ALERT_SOURCE,
        severity: "alert",
        title:
          `Daily fee accrual dropped ${droppedFromBackfill.count} day(s) ` +
          `older than ${FEE_ACCRUAL_BACKFILL_MAX_DAYS}-day cap ` +
          `(${droppedFromBackfill.start}..${droppedFromBackfill.end}) — ` +
          `replay manually`,
        details: {
          droppedRangeStart: droppedFromBackfill.start,
          droppedRangeEnd: droppedFromBackfill.end,
          droppedCount: droppedFromBackfill.count,
          backfillCapDays: FEE_ACCRUAL_BACKFILL_MAX_DAYS,
          plannedRangeStart: plannedFirst,
          plannedRangeEnd: plannedLast,
          tickUtcDate: today.toISOString().slice(0, 10),
          remediation:
            "Run `POST /api/admin/fee-accruals/run` for each dropped UTC " +
            "date (or batch via the admin Fees page) to fill the gap.",
        },
        // Explicit dedupe identity so two ticks producing the same dropped
        // range collapse onto a single row inside the dedupe window — even
        // if some other detail in the payload happened to drift.
        kind: FEE_ACCRUAL_BACKFILL_CLIP_ALERT_SOURCE,
        subjectType: "utc-date-range",
        subjectId: `${droppedFromBackfill.start}..${droppedFromBackfill.end}`,
      });
    } catch (err) {
      // notifyOperator already swallows its own channel failures; this
      // catch is belt-and-braces so a hypothetical synchronous throw can
      // never abort the accrual loop below. The dropped-range banner on
      // the admin Fees page remains the durable signal in that case.
      console.error(
        "[fee-accruals] notifyOperator threw unexpectedly for backfill clip",
        (err as Error)?.message ?? err,
      );
    }
  }

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalDuplicates = 0;
  const totalsByGate: Record<string, number> = {};
  const datesRun: string[] = [];
  const datesFailed: string[] = [];

  for (const accrualDate of plannedDates) {
    const iso = accrualDate.toISOString().slice(0, 10);
    try {
      const s = await runDailyAccrualsAndRecord({
        accrualDate,
        trigger: "cron",
        triggeredByUserId: null,
        // Task #29 — annotate every per-date row from this clipped tick so
        // the latest-row admin UI surface still sees the warning regardless
        // of which date in the window happened to land last.
        droppedFromBackfill,
      });
      totalInserted += s.inserted;
      totalSkipped += s.skipped;
      totalDuplicates += s.duplicates;
      for (const [k, v] of Object.entries(s.byGateReason)) {
        totalsByGate[k] = (totalsByGate[k] ?? 0) + v;
      }
      datesRun.push(iso);
    } catch (e) {
      // One failed date doesn't block the rest — the next scheduled tick
      // will retry it (idempotency + per-date transaction make that safe).
      console.error(`[fee-accruals] cron error for ${iso}`, e);
      datesFailed.push(iso);
    }
  }

  const gateBreakdown =
    Object.entries(totalsByGate)
      .map(([k, v]) => `${k}=${v}`)
      .join(",") || "none";
  const todayIso = today.toISOString().slice(0, 10);
  const failedSuffix =
    datesFailed.length > 0
      ? `, ${datesFailed.length} failed (${datesFailed.join(",")})`
      : "";
  // Task #29 — surface the dropped-older-than-cap range in the cron's log
  // line too. The persistent admin UI signal lives on the run row's
  // `droppedFromBackfill` field; this just keeps the log story consistent.
  const droppedSuffix = droppedFromBackfill
    ? `, dropped ${droppedFromBackfill.count} day(s) older than cap (${droppedFromBackfill.start}..${droppedFromBackfill.end} — replay manually)`
    : "";

  // "today only" is reserved for the case where the cron PLANNED a single
  // tick (no backfill needed). If we planned multiple dates and only some
  // succeeded, we still report it as a backfill run so operators can see
  // the failed dates in the log line above.
  const plannedTodayOnly =
    plannedDates.length === 1 &&
    plannedDates[0].toISOString().slice(0, 10) === todayIso;

  let summaryLine: string;
  if (plannedTodayOnly) {
    summaryLine =
      `for ${todayIso} (today only): ` +
      `${totalInserted} inserted, ${totalSkipped} gated (${gateBreakdown}), ` +
      `${totalDuplicates} duplicate(s)${failedSuffix}${droppedSuffix}`;
    logLine("fee-accruals", `completed ${summaryLine}`);
  } else {
    const firstPlanned = plannedDates[0].toISOString().slice(0, 10);
    const lastPlanned = plannedDates[plannedDates.length - 1]
      .toISOString()
      .slice(0, 10);
    const backfilled = plannedDates.filter(
      (d) => d.toISOString().slice(0, 10) !== todayIso,
    ).length;
    summaryLine =
      `for ${firstPlanned}..${lastPlanned} (backfilled ${backfilled} day(s)): ` +
      `${totalInserted} inserted, ${totalSkipped} gated (${gateBreakdown}), ` +
      `${totalDuplicates} duplicate(s)${failedSuffix}${droppedSuffix}`;
    if (datesRun.length > 0 || datesFailed.length > 0) {
      logLine("fee-accruals", `completed ${summaryLine}`);
    }
  }
  return summaryLine;
}

export interface RunInsufficientFundsSweepCronOnceOpts {
  // Forwarded to runInsufficientFundsSweep() so tests can pin `now` and
  // the renotify debounce window without time travel.
  sweepOpts?: RunInsufficientFundsSweepOpts;
  // Test seam: replace the underlying sweep call entirely. Used by the
  // kill-switch test suite to assert the inner sweep is NEVER invoked
  // when the switch is engaged. Defaults to runInsufficientFundsSweep.
  runSweep?: (
    opts?: RunInsufficientFundsSweepOpts,
  ) => Promise<InsufficientFundsSweepSummary>;
}

/**
 * Single tick of the insufficient-funds sweep cron. Honours the
 * `fee_deductions` kill switch and returns the canonical skip note when
 * engaged; otherwise runs the sweep and returns a `key=count` joined
 * summary identical to the previous inline implementation.
 */
export async function runInsufficientFundsSweepCronOnce(
  opts: RunInsufficientFundsSweepCronOnceOpts = {},
): Promise<string> {
  // Task #146 — kill switch. Mirror the fee-accruals cron skip:
  // emit an explicit, recognisable summary line so operators can
  // tell "we skipped because the switch is engaged" apart from
  // "we ran and there was nothing to do" in background_job_runs.
  if (await isKillSwitchActive("fee_deductions")) {
    logLine("insufficient-funds-sweep", SWEEP_KILL_SWITCH_SKIP_NOTE);
    return SWEEP_KILL_SWITCH_SKIP_NOTE;
  }

  const sweep = opts.runSweep ?? runInsufficientFundsSweep;
  const r = await sweep(opts.sweepOpts);

  const parts: string[] = [];
  if (r && typeof r === "object") {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === "number") parts.push(`${k}=${v}`);
    }
  }
  return parts.length > 0 ? parts.join(", ") : "completed";
}
