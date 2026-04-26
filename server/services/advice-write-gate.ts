// =============================================================================
// ADVICE-WRITE GATE — Task #96
// -----------------------------------------------------------------------------
// While an advice record sits in status='review_pending' a compliance reviewer
// is reading the plan as it stood when it was submitted. If the adviser is
// still able to append recommendations, objectives, scope changes, fact-find
// updates or document attachments to that record, the reviewer is no longer
// looking at a stable artefact and the review itself becomes a regulatory
// finding risk.
//
// This guard is the single chokepoint that rejects such writes. Every service
// function that mutates an advice-record CHILD must call
// requireAdviceRecordWritable(adviceRecordId) before any DB write.
//
// EXEMPT (must remain writeable while review_pending):
//   - adviser_notes (the reviewer needs to leave notes)
//   - the compliance state-machine itself — i.e. the route that flips
//     adviceRecords.status from 'review_pending' back to 'draft' / 'issued'.
//     Those callers MUST NOT call this guard or the review can never be
//     resolved.
//
// On rejection the guard throws an Error shaped so the route layer's
// handleError converts it to:
//   HTTP 423 Locked
//   { error: "...", reason: "record_locked_under_review" }
//
// The reason code matches REVIEW_LOCK_REASON exported from wealth-planner.ts
// and the inline check in adviser-routes.ts so the client UI can key a
// single lock-banner code regardless of which layer surfaced the lock.
// =============================================================================

import { eq } from "drizzle-orm";
import { db } from "../db";
import { adviceRecords } from "@shared/schema";

export type AdviceWriteBlockedReason =
  | "advice_record_not_found"
  | "record_locked_under_review";

export type AdviceWritabilityResult =
  | { writable: true; adviceRecordId: number; status: string }
  | {
      writable: false;
      adviceRecordId: number;
      reason: AdviceWriteBlockedReason;
      detail: string;
      status: string | null;
    };

/**
 * Read the live status of the advice record and decide whether children of
 * that record may be written right now.
 *
 * Pure read; safe to call from inside an outer transaction (pass executor).
 */
export async function getAdviceRecordWritability(
  adviceRecordId: number,
  executor: typeof db = db,
): Promise<AdviceWritabilityResult> {
  const [advice] = await executor
    .select({ id: adviceRecords.id, status: adviceRecords.status })
    .from(adviceRecords)
    .where(eq(adviceRecords.id, adviceRecordId))
    .limit(1);

  if (!advice) {
    return {
      writable: false,
      adviceRecordId,
      reason: "advice_record_not_found",
      detail: `No advice record exists for id=${adviceRecordId}`,
      status: null,
    };
  }

  if (advice.status === "review_pending") {
    return {
      writable: false,
      adviceRecordId,
      reason: "record_locked_under_review",
      detail:
        "Advice record is currently under compliance review. Child records cannot be appended until the review is resolved.",
      status: advice.status,
    };
  }

  return { writable: true, adviceRecordId, status: advice.status };
}

/**
 * Throwing wrapper for the common case. Throws an Error decorated with:
 *   - status:  HTTP status (404 if record missing, 423 if locked)
 *   - reason:  machine-readable reason code, copied verbatim into the
 *              JSON response body by handleError in adviser-routes.ts
 *
 * Routes do not need to catch this directly — the adviserRoute() wrapper
 * already routes thrown errors through handleError.
 */
export async function requireAdviceRecordWritable(
  adviceRecordId: number,
  executor: typeof db = db,
): Promise<void> {
  const result = await getAdviceRecordWritability(adviceRecordId, executor);
  if (result.writable) return;

  const status = result.reason === "advice_record_not_found" ? 404 : 423;
  throw Object.assign(new Error(result.detail), {
    status,
    reason: result.reason,
  });
}
