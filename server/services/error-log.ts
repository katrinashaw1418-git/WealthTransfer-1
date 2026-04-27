// =============================================================================
// TASK #144 — Persistent error log + lightweight metrics counters
// =============================================================================
// Two related responsibilities live in this file:
//
//   1. A rotating file sink for 5xx error responses (and any explicit
//      `recordServerError` call). Every entry is also written to stdout via
//      the existing `log()` so the in-memory dev console stays useful — the
//      file just guarantees the record survives a redeploy.
//
//   2. Tiny rolling-window counters for the "key business failures" the admin
//      metrics tile exposes (failed transactions, audit-log write failures,
//      fee-deduction failures). Most of those numbers come from real DB
//      tables, but audit-log write failures have no such table — by the time
//      we know the audit insert failed, writing to the DB to record THAT is
//      the worst possible move. So we keep an in-process sliding counter
//      reset on restart.
//
// Design rules:
//   - Fail-closed never. The whole point of this file is observability; if
//     the log file rotation, fs write, or counter increment ever throws, we
//     swallow and console.error so the surrounding request handler is not
//     affected.
//   - No external deps. Plain `fs` + a small size-based rotation keep this
//     self-contained — the task spec deliberately rules out third-party
//     loggers like Sentry / Datadog.
// =============================================================================

import { existsSync, mkdirSync, renameSync, statSync } from "fs";
import { appendFile } from "fs/promises";
import path from "path";

// ---------------------------------------------------------------------------
// File sink config
// ---------------------------------------------------------------------------
// Where the rotating error log file lives. Resolved lazily so tests can
// override LOG_DIR before the first write without monkey-patching this file.
function getLogDir(): string {
  return process.env.LOG_DIR ?? path.resolve(process.cwd(), "logs");
}

function getErrorLogPath(): string {
  return path.join(getLogDir(), "errors.log");
}

// 5 MB per file is plenty for 5xx-only volume on a small wealth platform —
// at ~500 bytes/line that's ~10k entries before rotation. Keep three rotated
// copies (errors.log.1 … errors.log.3) before the oldest is dropped.
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROTATIONS = 3;

let writeChain: Promise<void> = Promise.resolve();

function ensureLogDir(): void {
  const dir = getLogDir();
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } catch (err) {
    console.error("[error-log] failed to create log dir", err);
  }
}

function rotateIfNeeded(): void {
  const file = getErrorLogPath();
  try {
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    if (size < MAX_FILE_BYTES) return;
    // errors.log.2 → errors.log.3, errors.log.1 → errors.log.2, errors.log → errors.log.1
    for (let i = MAX_ROTATIONS; i >= 1; i--) {
      const src = i === 1 ? file : `${file}.${i - 1}`;
      const dst = `${file}.${i}`;
      if (existsSync(src)) {
        try {
          renameSync(src, dst);
        } catch (err) {
          console.error(`[error-log] rotation rename ${src} → ${dst} failed`, err);
        }
      }
    }
  } catch (err) {
    console.error("[error-log] rotation check failed", err);
  }
}

export interface ServerErrorRecord {
  /** Stable per-request id, derived from the Express middleware below. */
  requestId?: string | null;
  /** HTTP method, e.g. "POST". */
  method?: string | null;
  /** Route path (req.originalUrl is fine). */
  path?: string | null;
  /** Final status code returned to the client. */
  status?: number | null;
  /** Authenticated user id, if any. */
  userId?: number | null;
  /** Error object (preferred) or a thrown string / unknown value. */
  error?: unknown;
  /**
   * Free-form tag identifying the source. Used by metrics counters and to
   * filter the file for human review. Examples:
   *   "http_5xx", "audit_log_write_failure".
   */
  tag?: string;
}

function serializeError(err: unknown): { message: string; stack: string | null } {
  if (err instanceof Error) {
    return {
      message: err.message || err.name || "Error",
      stack: err.stack ?? null,
    };
  }
  if (typeof err === "string") return { message: err, stack: null };
  try {
    return { message: JSON.stringify(err), stack: null };
  } catch {
    return { message: String(err), stack: null };
  }
}

function appendLine(line: string): void {
  // Serialise writes through a single chain so a slow disk can't reorder
  // entries under bursty load. Each link swallows its own errors so a single
  // failed write doesn't poison the chain.
  writeChain = writeChain.then(async () => {
    try {
      ensureLogDir();
      rotateIfNeeded();
      await appendFile(getErrorLogPath(), line, "utf8");
    } catch (err) {
      console.error("[error-log] failed to append to error log file", err);
    }
  });
}

/**
 * Append one structured JSON entry to the persistent error log AND write a
 * short summary line to stdout so dev consoles still see the failure.
 *
 * Safe to call from any code path — never throws, never blocks the caller
 * on the file write.
 */
export function recordServerError(record: ServerErrorRecord): void {
  const tag = record.tag ?? "http_5xx";
  if (tag === "http_5xx") {
    bump5xxErrors();
  } else if (tag === "audit_log_write_failure") {
    bumpAuditWriteFailures();
  }

  const ser = serializeError(record.error);
  const entry = {
    ts: new Date().toISOString(),
    tag,
    requestId: record.requestId ?? null,
    method: record.method ?? null,
    path: record.path ?? null,
    status: record.status ?? null,
    userId: record.userId ?? null,
    message: ser.message,
    stack: ser.stack,
  };
  appendLine(JSON.stringify(entry) + "\n");

  // Mirror to stdout in a fixed shape so existing log-aggregation greps still
  // work. We deliberately do NOT include the stack here — the file already
  // has it, and stdout dumps of long stacks make the dev terminal noisy.
  console.error(
    `[server-error] tag=${tag} status=${entry.status ?? "-"} ${entry.method ?? ""} ${entry.path ?? ""}` +
      `${entry.userId ? ` user=${entry.userId}` : ""}${entry.requestId ? ` rid=${entry.requestId}` : ""} — ${entry.message}`,
  );
}

/**
 * Convenience used by `writeAuditLog` failure paths — see `services/audit.ts`
 * and the inline writer in `routes.ts`. Signals "the audit insert itself
 * threw", which the admin metrics tile surfaces as its own counter.
 */
export function recordAuditWriteFailure(err: unknown, context?: { userId?: number | null; action?: string }): void {
  recordServerError({
    tag: "audit_log_write_failure",
    error: err,
    userId: context?.userId ?? null,
    path: context?.action ? `audit:${context.action}` : null,
  });
}

// ---------------------------------------------------------------------------
// Sliding-window counters
// ---------------------------------------------------------------------------
// We keep one timestamp array per counter rather than a fancy ring so the
// implementation is obviously correct: every read filters out entries older
// than the window. At a few hundred events per day per counter this is
// trivially cheap. Old entries are pruned lazily on each read AND on each
// write so an idle counter cannot leak unbounded memory either.

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES_PER_COUNTER = 5000;

const failedTransactionTimes: number[] = [];
const auditWriteFailureTimes: number[] = [];
const feeDeductionFailureTimes: number[] = [];
const http5xxTimes: number[] = [];

function pruneOlderThan(arr: number[], cutoff: number): void {
  // Arrays are append-only and time-ordered, so a single splice covers it.
  let drop = 0;
  while (drop < arr.length && arr[drop] < cutoff) drop++;
  if (drop > 0) arr.splice(0, drop);
  // Hard ceiling against runaway growth (e.g. test harness firing millions).
  if (arr.length > MAX_ENTRIES_PER_COUNTER) {
    arr.splice(0, arr.length - MAX_ENTRIES_PER_COUNTER);
  }
}

function bump(arr: number[]): void {
  const now = Date.now();
  arr.push(now);
  pruneOlderThan(arr, now - WINDOW_MS);
}

export function bumpFailedTransactions(): void {
  bump(failedTransactionTimes);
}

export function bumpAuditWriteFailures(): void {
  bump(auditWriteFailureTimes);
}

export function bumpFeeDeductionFailures(): void {
  bump(feeDeductionFailureTimes);
}

function bump5xxErrors(): void {
  bump(http5xxTimes);
}

export interface InProcessMetricsCounters {
  /** 5xx responses recorded via the error middleware in this process. */
  http5xxLast24h: number;
  /** Audit-log write failures observed in this process. */
  auditWriteFailuresLast24h: number;
  /** In-process counter for fee-deduction failures (DB query is preferred). */
  feeDeductionFailuresLast24h: number;
  /** In-process counter for failed transactions (DB query is preferred). */
  failedTransactionsLast24h: number;
}

export function getInProcessCounters(): InProcessMetricsCounters {
  const cutoff = Date.now() - WINDOW_MS;
  pruneOlderThan(http5xxTimes, cutoff);
  pruneOlderThan(auditWriteFailureTimes, cutoff);
  pruneOlderThan(feeDeductionFailureTimes, cutoff);
  pruneOlderThan(failedTransactionTimes, cutoff);
  return {
    http5xxLast24h: http5xxTimes.length,
    auditWriteFailuresLast24h: auditWriteFailureTimes.length,
    feeDeductionFailuresLast24h: feeDeductionFailureTimes.length,
    failedTransactionsLast24h: failedTransactionTimes.length,
  };
}

// ---------------------------------------------------------------------------
// Last-successful-health-probe tracking
// ---------------------------------------------------------------------------
// Set every time the /health endpoint resolves with overall status 'ok'. The
// admin metrics tile shows "time since last successful probe" so operators
// can see at a glance whether their external uptime monitor is wired up
// (a never-probed endpoint is an empty signal, not a successful one).
let lastSuccessfulHealthProbeAt: number | null = null;

export function recordSuccessfulHealthProbe(): void {
  lastSuccessfulHealthProbeAt = Date.now();
}

export function getLastSuccessfulHealthProbeAt(): number | null {
  return lastSuccessfulHealthProbeAt;
}
