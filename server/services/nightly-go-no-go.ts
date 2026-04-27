// =============================================================================
// TASK #217 — Nightly launch readiness gate runner
// -----------------------------------------------------------------------------
// Wraps `scripts/go-no-go.ts` so it can be run unattended once per day from
// the running server, instead of only at deploy time. Several of the gate's
// checks (latest backup freshness, restore-drill freshness, audit-log
// triggers) decay quietly between deploys; if a week passes with no
// `Publish`, the first time we'd notice the backup cron has been broken for
// days is in the deploy log — exactly when we don't want to be debugging it.
//
// What this module does, in order, every nightly tick:
//
//   1. Spawns `npx tsx scripts/go-no-go.ts` as a child process. The script
//      is documented as idempotent and safe to re-run (kill switches are
//      restored to their starting state, drill alerts are tagged
//      `drill: true`, audit-log probe rows are tagged with the runId).
//
//   2. Snapshots `docs/golive/` before and after the run so we can isolate
//      the report file produced by THIS invocation. (Same pattern as
//      `scripts/predeploy-build.sh` so a crashed orchestrator never causes
//      us to surface a stale report from a previous run.)
//
//   3. Reads the report markdown into memory.
//
//   4. Persists the verdict + full report into the operator alerts dashboard
//      so the latest report is durable in Postgres (NOT just on the
//      ephemeral runner filesystem):
//        * On NO-GO  — calls `notifyOperator(severity="alert")` so the
//          on-call channel is paged via OPERATOR_ALERT_WEBHOOK_URL.
//        * On GO     — inserts an info-level row directly into
//          `operator_alerts` via `recordGoNoGoReportRow` so the dashboard
//          carries today's report WITHOUT firing the webhook (a daily
//          "all good" page would be noise the receiver would learn to
//          ignore — and that defeats the point of the alert).
//
// Public API:
//   * `runNightlyGoNoGo(opts?)` — single tick. Returns a `NightlyGoNoGoResult`
//     summary the `withBackgroundJobRunRecord` wrapper renders as the
//     one-line dashboard summary. **Does not throw on spawn or report-read
//     failures** — those are folded into a NO-GO result that pages on-call
//     via the same path as a real NO-GO verdict, so the failure mode is
//     visible to the on-call channel rather than silently buried in the
//     `background_job_runs` row's stack trace. Genuinely unexpected
//     exceptions (e.g. Postgres unreachable when persisting the row) are
//     allowed to bubble so the wrapper records status="error".
//   * `recordGoNoGoReportRow(...)` — exported lower-level primitive used
//     for the GO path; visible to tests.
// =============================================================================

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { db } from "../db";
import {
  operatorAlerts,
  type InsertOperatorAlertRecord,
} from "@shared/schema";
import {
  notifyOperator,
  type OperatorAlertResult,
} from "./operator-alerts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stable source string surfaced in the operator alerts dashboard. */
export const NIGHTLY_GO_NO_GO_SOURCE = "nightly-go-no-go";

/**
 * The exact argv we hand to the gate. Exported so tests can lock in the
 * `--deploy-gate` flag (without it the gate fires per-source webhook
 * drills on every nightly run, which would page on-call even on GO).
 */
export const NIGHTLY_GO_NO_GO_SPAWN_COMMAND = "npx" as const;
export const NIGHTLY_GO_NO_GO_SPAWN_ARGS: readonly string[] = [
  "tsx",
  "scripts/go-no-go.ts",
  "--deploy-gate",
];

/** Where `scripts/go-no-go.ts` writes its markdown report. */
const REPORT_DIR = path.resolve(process.cwd(), "docs", "golive");

/**
 * Hard cap on how long the gate may run. The script itself takes ~30-60s
 * in practice (it spawns `pre-launch-safety.ts` and a few sub-scripts);
 * a 10-minute deadline is generous enough that real load on the CI runner
 * doesn't trip us, but tight enough that a runaway child cannot wedge the
 * cron loop forever. Override via `NIGHTLY_GO_NO_GO_TIMEOUT_MS` if needed.
 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Cap on how much of the report we surface in the operator alert details
 * payload. Reports today are ~10-30 KB of markdown; capping at 200 KB
 * leaves headroom for future sections without risking a JSONB row that's
 * absurdly large for the admin UI to render. The full report is also
 * written to the runner filesystem under `docs/golive/`, so even a
 * truncated copy in the alert never loses information for an operator
 * who can SSH into the box.
 */
const MAX_REPORT_BYTES_IN_DETAILS = 200_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type NightlyGoNoGoVerdict = "GO" | "NO-GO";

export interface NightlyGoNoGoResult {
  verdict: NightlyGoNoGoVerdict;
  /** Exit code of `scripts/go-no-go.ts`. 0 on GO; non-zero on NO-GO. */
  exitCode: number;
  /** Filesystem path of the report this run produced, or null if none. */
  reportPath: string | null;
  /** Wall-clock duration in ms (script spawn → finish). */
  durationMs: number;
  /** Operator alert row id we persisted the report into, or null on failure. */
  alertId: number | null;
  /** True iff `notifyOperator` was used (i.e. NO-GO path with full webhook). */
  paged: boolean;
  /** Short human-readable summary suitable for the background-jobs dashboard. */
  summary: string;
}

export interface RunNightlyGoNoGoOptions {
  /**
   * Override the spawn entrypoint. Tests pass a stub that simulates the
   * script (writes a fake report into REPORT_DIR and returns an exit code)
   * so we don't actually toggle kill switches inside the test process.
   */
  spawner?: NightlyGoNoGoSpawner;
  /** Override the timeout, in ms. Defaults to env or 10 minutes. */
  timeoutMs?: number;
  /**
   * Inject a notifyOperator stub for the NO-GO path. Tests use this to
   * assert the alert dispatch happened with the right shape WITHOUT hitting
   * the real webhook.
   */
  notifyOperator?: typeof notifyOperator;
  /**
   * Inject the GO-path persistence stub for tests. Mirrors `notifyOperator`
   * but runs the direct-insert codepath used when we deliberately do NOT
   * want to page the on-call channel.
   */
  recordGoReportRow?: typeof recordGoNoGoReportRow;
}

export interface NightlyGoNoGoSpawnResult {
  exitCode: number;
  /** Combined stdout + stderr tail (capped) for the dashboard summary. */
  outputTail: string;
}

export type NightlyGoNoGoSpawner = (
  timeoutMs: number,
) => Promise<NightlyGoNoGoSpawnResult>;

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

const MAX_OUTPUT_BUFFER_BYTES = 256 * 1024;

/**
 * Default spawner — runs `npx tsx scripts/go-no-go.ts` and returns the
 * exit code + a tail of combined stdout/stderr. We DON'T inherit stdio
 * because the cron's parent process is the long-running server; piping
 * lets us tail the output into the dashboard summary on failure without
 * polluting the server's own stdout with the gate's noisy per-section log
 * lines (those are already in the persisted report).
 */
const defaultSpawner: NightlyGoNoGoSpawner = (timeoutMs) =>
  new Promise<NightlyGoNoGoSpawnResult>((resolve, reject) => {
    // We pass `--deploy-gate` for the same reason `scripts/predeploy-build.sh`
    // does: in default mode the gate fires nine per-source drill alerts
    // through the webhook on every run, which would page on-call nightly
    // even on GO. `--deploy-gate` keeps per-source drills log+DB only and
    // collapses them into a single info-severity rollup. Combined with our
    // own NO-GO `notifyOperator(severity="alert")` dispatch below, the net
    // effect is: one quiet "drill complete" rollup per night, plus a real
    // page only when the verdict is NO-GO.
    const child = spawn(
      NIGHTLY_GO_NO_GO_SPAWN_COMMAND,
      [...NIGHTLY_GO_NO_GO_SPAWN_ARGS],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );

    let buf = Buffer.alloc(0);
    let truncated = false;
    let exited = false;

    const append = (chunk: Buffer) => {
      if (truncated) return;
      const next = Buffer.concat([buf, chunk]);
      if (next.length > MAX_OUTPUT_BUFFER_BYTES) {
        buf = next.subarray(next.length - MAX_OUTPUT_BUFFER_BYTES);
        truncated = true;
      } else {
        buf = next;
      }
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      // Send SIGTERM, then SIGKILL after a short grace period. We track an
      // `exited` flag (set on the close handler) rather than `child.killed`
      // because Node flips `child.killed` as soon as SIGTERM is *sent*, not
      // when the process actually exits — so checking it here would skip
      // SIGKILL escalation on children that ignore SIGTERM.
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 2_000);
    }, timeoutMs);

    child.once("error", (err) => {
      exited = true;
      clearTimeout(timer);
      reject(err);
    });

    child.once("close", (code, signal) => {
      exited = true;
      clearTimeout(timer);
      const tail = buf.toString("utf8");
      if (signal && code === null) {
        // Killed by our timeout (or external SIGKILL). Treat as a failure
        // exit code so the rest of the pipeline reports NO-GO + summary.
        resolve({
          exitCode: 124,
          outputTail:
            `[nightly-go-no-go] killed by signal ${signal} after ${timeoutMs}ms\n` +
            tail,
        });
        return;
      }
      resolve({
        exitCode: code ?? 1,
        outputTail: tail,
      });
    });
  });

function getConfiguredTimeoutMs(): number {
  const raw = process.env.NIGHTLY_GO_NO_GO_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.floor(n);
}

// ---------------------------------------------------------------------------
// Report-file resolution
// ---------------------------------------------------------------------------

/**
 * List the report directory, returning a Set of basenames matching the
 * gate's `go-no-go-<timestamp>.md` naming. Missing directory is normalised
 * to an empty Set (the gate creates the directory itself before writing).
 */
async function listReports(): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(REPORT_DIR);
    return new Set(entries.filter((e) => /^go-no-go-.*\.md$/.test(e)));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return new Set();
    throw err;
  }
}

/**
 * Compute the report basename produced by the most recent gate run by
 * diffing the report-directory listing taken before vs after. Returns the
 * lexicographically-last newly-appearing file, since the gate uses an ISO
 * timestamp as the filename (sort order = chronological order).
 */
function pickNewReport(before: Set<string>, after: Set<string>): string | null {
  const fresh: string[] = [];
  after.forEach((name) => {
    if (!before.has(name)) fresh.push(name);
  });
  if (fresh.length === 0) return null;
  fresh.sort();
  return fresh[fresh.length - 1];
}

// ---------------------------------------------------------------------------
// Persistence — GO path (durable record without paging)
// ---------------------------------------------------------------------------

export interface RecordGoNoGoReportRowArgs {
  verdict: NightlyGoNoGoVerdict;
  /** Full markdown report. May be the empty string if the file was missing. */
  report: string;
  /** Filesystem path the gate wrote the report to (informational). */
  reportPath: string | null;
  /** Exit code of the gate. */
  exitCode: number;
  /** Wall-clock duration of the run in ms. */
  durationMs: number;
}

/**
 * Insert one `operator_alerts` row directly, WITHOUT going through
 * `notifyOperator` and therefore WITHOUT firing the configured webhook.
 *
 * Used on the GO path so the latest report still lands on the operator
 * alerts dashboard (durable in Postgres) but the on-call channel doesn't
 * get paged with a "GO" notification every single night — recurring
 * "all good" pages would train operators to ignore the channel and that
 * defeats the whole point of paging on real NO-GO.
 *
 * The log channel is still hit (a stdout line so you can grep history).
 */
export async function recordGoNoGoReportRow(
  args: RecordGoNoGoReportRowArgs,
): Promise<number | null> {
  const truncated = truncateForDetails(args.report);
  const details: Record<string, unknown> = {
    verdict: args.verdict,
    exitCode: args.exitCode,
    reportPath: args.reportPath,
    durationMs: args.durationMs,
    reportLength: Buffer.byteLength(args.report, "utf8"),
    reportTruncated: truncated.truncated,
    report: truncated.body,
    scheduledBy: "server/services/nightly-go-no-go.ts",
  };

  const title = `Nightly launch readiness gate: ${args.verdict}`;
  console.log(
    `[nightly-go-no-go] ${title} (exit=${args.exitCode}, ${args.durationMs}ms)`,
  );

  const row: InsertOperatorAlertRecord = {
    source: NIGHTLY_GO_NO_GO_SOURCE,
    severity: "info",
    title,
    details,
    channelsAttempted: ["log"],
    channelOutcomes: [
      {
        channel: "log",
        status: "success",
        durationMs: 0,
      },
    ] as unknown as Record<string, unknown>,
    deliveryStatus: "delivered",
  };
  try {
    const inserted = await db
      .insert(operatorAlerts)
      .values(row)
      .returning({ id: operatorAlerts.id });
    return inserted[0]?.id ?? null;
  } catch (err) {
    // Same contract as `persistAlert` in operator-alerts.ts: log loudly
    // but do not bubble — the gate already produced its real value (the
    // file on disk + the stdout line above).
    console.error(
      `[nightly-go-no-go] failed to persist GO row to operator_alerts:`,
      (err as Error)?.message ?? err,
    );
    return null;
  }
}

function truncateForDetails(report: string): {
  body: string;
  truncated: boolean;
} {
  // Measure in *bytes*, not JS chars: the cap is a payload-size guard for
  // operator_alerts.details (JSONB), and one Unicode codepoint can be 1–4
  // UTF-8 bytes. Slicing by char count would let a multibyte report sail
  // past the byte ceiling.
  const byteLen = Buffer.byteLength(report, "utf8");
  if (byteLen <= MAX_REPORT_BYTES_IN_DETAILS) {
    return { body: report, truncated: false };
  }
  // Take the first MAX bytes, then trim any partial trailing UTF-8
  // sequence so we never produce an invalid string.
  const headBuf = Buffer.from(report, "utf8").subarray(
    0,
    MAX_REPORT_BYTES_IN_DETAILS,
  );
  const head = headBuf.toString("utf8");
  return {
    body:
      head +
      `\n\n…[truncated to ${MAX_REPORT_BYTES_IN_DETAILS} bytes; see reportPath on the runner for the full file]`,
    truncated: true,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Execute one nightly tick of the launch readiness gate.
 *
 * Caller is expected to wrap this in `withBackgroundJobRunRecord` so the
 * outcome lands in `background_job_runs` for the admin dashboard.
 */
export async function runNightlyGoNoGo(
  opts: RunNightlyGoNoGoOptions = {},
): Promise<NightlyGoNoGoResult> {
  const spawner = opts.spawner ?? defaultSpawner;
  const timeoutMs = opts.timeoutMs ?? getConfiguredTimeoutMs();
  const notify = opts.notifyOperator ?? notifyOperator;
  const recordGoRow = opts.recordGoReportRow ?? recordGoNoGoReportRow;

  await fs.mkdir(REPORT_DIR, { recursive: true });
  const before = await listReports();
  const startedAt = Date.now();

  let spawnResult: NightlyGoNoGoSpawnResult;
  try {
    spawnResult = await spawner(timeoutMs);
  } catch (err) {
    // Spawn-level failure (npx missing, fork/exec error). Surface it as a
    // NO-GO so the cron's wrapper records status="error" AND we still page
    // the on-call channel — a gate that can't even start is itself an
    // ops-attention problem. We have no report file, so the alert details
    // carry the error message instead.
    const durationMs = Date.now() - startedAt;
    const message = (err as Error)?.message ?? String(err);
    console.error(
      `[nightly-go-no-go] spawn failed after ${durationMs}ms:`,
      message,
    );
    let pageResult: OperatorAlertResult | null = null;
    try {
      pageResult = await notify({
        source: NIGHTLY_GO_NO_GO_SOURCE,
        severity: "alert",
        title: "Nightly launch readiness gate: spawn failed",
        details: {
          verdict: "NO-GO",
          exitCode: -1,
          spawnError: message,
          durationMs,
          scheduledBy: "server/services/nightly-go-no-go.ts",
        },
      });
    } catch (pageErr) {
      console.error(
        `[nightly-go-no-go] notifyOperator threw on spawn-failure path:`,
        (pageErr as Error)?.message ?? pageErr,
      );
    }
    return {
      verdict: "NO-GO",
      exitCode: -1,
      reportPath: null,
      durationMs,
      alertId: pageResult?.alertId ?? null,
      paged: pageResult !== null,
      summary: `verdict=NO-GO spawn-failed: ${message.slice(0, 120)}`,
    };
  }

  const durationMs = Date.now() - startedAt;
  const after = await listReports();
  const newReportName = pickNewReport(before, after);
  const reportPath = newReportName ? path.join(REPORT_DIR, newReportName) : null;
  let report = "";
  if (reportPath) {
    try {
      report = await fs.readFile(reportPath, "utf8");
    } catch (err) {
      console.error(
        `[nightly-go-no-go] failed to read report at ${reportPath}:`,
        (err as Error)?.message ?? err,
      );
    }
  }

  const verdict: NightlyGoNoGoVerdict = spawnResult.exitCode === 0 ? "GO" : "NO-GO";

  if (verdict === "GO") {
    const alertId = await recordGoRow({
      verdict,
      report,
      reportPath,
      exitCode: spawnResult.exitCode,
      durationMs,
    });
    return {
      verdict,
      exitCode: spawnResult.exitCode,
      reportPath,
      durationMs,
      alertId,
      paged: false,
      summary:
        `verdict=GO duration=${durationMs}ms` +
        (reportPath ? ` report=${path.relative(process.cwd(), reportPath)}` : "") +
        (alertId !== null ? ` alertId=${alertId}` : ""),
    };
  }

  // NO-GO path: full notifyOperator dispatch so the on-call channel pages.
  const truncated = truncateForDetails(report);
  const tailOnly = spawnResult.outputTail
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-25)
    .join("\n");

  let alertId: number | null = null;
  let paged = false;
  try {
    const result = await notify({
      source: NIGHTLY_GO_NO_GO_SOURCE,
      severity: "alert",
      title: "Nightly launch readiness gate: NO-GO",
      details: {
        verdict,
        exitCode: spawnResult.exitCode,
        reportPath,
        durationMs,
        reportLength: Buffer.byteLength(report, "utf8"),
        reportTruncated: truncated.truncated,
        report: truncated.body,
        outputTail: tailOnly,
        scheduledBy: "server/services/nightly-go-no-go.ts",
        // A short pointer that operators can render verbatim in the
        // alerts dashboard so they don't need to fish through the JSON
        // for "what do I do now". Mirrors the per-check `hint` in the
        // gate's own report.
        dashboardHint:
          "Find this alert at /admin/operator-alerts (filter by source = nightly-go-no-go).",
        whatToDo:
          "Open the linked report (details.report or details.reportPath) and follow the per-check `What to do:` hints. " +
          "See docs/runbooks/go-no-go.md for verdict interpretation.",
      },
    });
    alertId = result.alertId;
    paged = true;
  } catch (err) {
    console.error(
      `[nightly-go-no-go] notifyOperator threw on NO-GO path:`,
      (err as Error)?.message ?? err,
    );
  }

  return {
    verdict,
    exitCode: spawnResult.exitCode,
    reportPath,
    durationMs,
    alertId,
    paged,
    summary:
      `verdict=NO-GO exit=${spawnResult.exitCode} duration=${durationMs}ms` +
      (reportPath ? ` report=${path.relative(process.cwd(), reportPath)}` : "") +
      (alertId !== null ? ` alertId=${alertId}` : "") +
      (paged ? " paged=true" : " paged=false"),
  };
}
