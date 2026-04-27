// =============================================================================
// TASK #145 — Stuck-pending-transactions cron
// =============================================================================
// A transaction that sits in `pending` or `processing` for longer than its
// expected settlement window is one of three things, all of which need
// operator attention:
//
//   1. The downstream rail returned a non-final status (or none at all) and
//      our state machine never advanced it.
//   2. A bug in the state-machine wrapper (e.g. dropped settle attempt,
//      thrown error in a non-tx path) left the row stuck.
//   3. A backfill / reconciliation race re-created a row in pending but the
//      original settlement already happened — i.e. a duplicate that needs
//      to be cancelled, not progressed.
//
// In all three cases the operator wants exactly one alert per "same set of
// stuck rows", not one alert per cron tick. We achieve that with a stable
// suppression key derived from the sorted ids of the stuck rows: while the
// set is unchanged, an active acknowledgement keeps re-pages off; the moment
// a new row joins or one resolves, the key changes and the alert re-fires.
//
// Threshold is configurable via STUCK_PENDING_THRESHOLD_MINUTES (default 60).
// =============================================================================

import { and, desc, inArray, lt, sql } from "drizzle-orm";
import * as crypto from "crypto";

import { db } from "../db";
import { transactions } from "@shared/schema";
import { notifyOperatorWithSuppression } from "./operator-alerts";

// Cap how many ids we list in the alert payload. Beyond this we still alert,
// but the payload only carries a count + the suppression-key fingerprint so
// a stuck-batch incident doesn't produce a 10MB JSON blob.
const MAX_LISTED_IDS = 50;

// Statuses that are "in flight". `pending` is the legacy/Track-A label;
// `processing` is the Track-B intermediate state. Both are valid for an
// in-progress transaction; both become abnormal after the threshold.
const STUCK_STATUSES = ["pending", "processing"] as const;

export interface StuckPendingTransactionsResult {
  /** How many rows currently exceed the threshold. */
  stuckCount: number;
  /** The threshold that was applied (minutes), exactly as resolved. */
  thresholdMinutes: number;
  /** The cutoff timestamp computed as `now - threshold`. */
  cutoff: Date;
  /** Whether an alert was dispatched (false when no rows were stuck). */
  alerted: boolean;
  /** Whether dispatch was suppressed by an active acknowledgement. */
  suppressed: boolean;
  /** Suppression key sent to the dispatcher (null when no rows were stuck). */
  suppressionKey: string | null;
  /** Up to MAX_LISTED_IDS ids actually listed in the alert payload. */
  listedIds: number[];
}

function resolveThresholdMinutes(): number {
  const raw = process.env.STUCK_PENDING_THRESHOLD_MINUTES;
  if (!raw) return 60;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    // A misconfigured env var should not silently disable the watchdog.
    // We log loudly and fall back to the default rather than throwing —
    // this cron MUST keep running even if a deploy mis-types the value.
    console.warn(
      `[stuck-pending-transactions] invalid STUCK_PENDING_THRESHOLD_MINUTES=${raw}, ` +
        `falling back to default 60`,
    );
    return 60;
  }
  return Math.floor(n);
}

/**
 * Build a stable suppression key from the sorted ids of currently-stuck
 * rows. Identical sets ⇒ identical key ⇒ ack suppresses re-pages. The
 * SHA-256 hex digest keeps the key short enough for the
 * `operator_alert_acknowledgements.suppression_key` text column even when
 * thousands of ids are stuck.
 */
function suppressionKeyFor(ids: number[]): string {
  const sorted = [...ids].sort((a, b) => a - b);
  const joined = sorted.join(",");
  const hash = crypto.createHash("sha256").update(joined).digest("hex");
  return `count=${ids.length}|sha256=${hash}`;
}

/**
 * Run one tick of the stuck-pending-transactions check.
 * Safe to call repeatedly (idempotent: read-only against transactions; one
 * ack-suppressible alert dispatch when rows are stuck).
 */
export async function runStuckPendingTransactionsCheck(): Promise<StuckPendingTransactionsResult> {
  const thresholdMinutes = resolveThresholdMinutes();
  const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);

  // Read just the columns we need for the alert payload — no joins, no
  // free-form metadata pulls. The `transactions_status_idx` (and any
  // composite (status, created_at) index, if present) makes this cheap
  // even on a large table.
  const stuckRows = await db
    .select({
      id: transactions.id,
      userId: transactions.userId,
      type: transactions.type,
      status: transactions.status,
      createdAt: transactions.createdAt,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.status, STUCK_STATUSES as unknown as string[]),
        lt(transactions.createdAt, cutoff),
      ),
    )
    .orderBy(desc(transactions.createdAt));

  if (stuckRows.length === 0) {
    return {
      stuckCount: 0,
      thresholdMinutes,
      cutoff,
      alerted: false,
      suppressed: false,
      suppressionKey: null,
      listedIds: [],
    };
  }

  const allIds = stuckRows.map((r) => r.id);
  const suppressionKey = suppressionKeyFor(allIds);
  const listed = stuckRows.slice(0, MAX_LISTED_IDS);

  // Compact, regulator-friendly payload: counts + sample list. We deliberately
  // do NOT include `description` or any user-facing money detail (those live
  // in the linked transaction rows) so the alert log itself stays PII-light.
  const dispatch = await notifyOperatorWithSuppression(
    {
      source: "stuck-pending-transactions",
      severity: "critical",
      title: `${stuckRows.length} transaction(s) stuck in pending/processing`,
      details: {
        stuckCount: stuckRows.length,
        thresholdMinutes,
        cutoff: cutoff.toISOString(),
        sampleSize: listed.length,
        sample: listed.map((r) => ({
          id: r.id,
          userId: r.userId,
          type: r.type,
          status: r.status,
          createdAt: r.createdAt
            ? new Date(r.createdAt).toISOString()
            : null,
        })),
        suppressionKey,
        message:
          `${stuckRows.length} transaction(s) have been in 'pending' or 'processing' ` +
          `for more than ${thresholdMinutes} minute(s). Cutoff: ${cutoff.toISOString()}. ` +
          `Investigate the in-flight rail or state-machine path that owns each row.`,
      },
    },
    suppressionKey,
  );

  return {
    stuckCount: stuckRows.length,
    thresholdMinutes,
    cutoff,
    alerted: !dispatch.suppressed,
    suppressed: dispatch.suppressed,
    suppressionKey,
    listedIds: listed.map((r) => r.id),
  };
}

// Re-export the underlying schema reference name so a future migration that
// renames/refactors this file is easy to grep for.
export const STUCK_PENDING_TRANSACTIONS_SOURCE = "stuck-pending-transactions";

// Suppress an unused-warning if `sql` is removed by a future cleanup.
void sql;
