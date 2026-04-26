import { eq } from "drizzle-orm";
import { db } from "../db";
import { adviceRecords } from "@shared/schema";
import { writeAuditLog } from "./audit";

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

// =============================================================================
// Task #108 — Audit log on every blocked write
// =============================================================================
// When the gate blocks a write, callers can pass `block` so the gate records
// an audit row BEFORE throwing. The audit row uses the standardised
// `{ before, after, ...extra }` shape from server/services/audit.ts so the
// admin audit-log diff viewer (Task #109) renders it correctly. Both
// before and after are `null` because no state actually changed — the event
// being recorded is the *attempt itself*. Useful operational context lives
// in `extra`: the reason code (record_locked_under_review or
// advice_record_not_found), the attempted action verb, and the live status
// of the advice record at the moment of the block.
//
// The audit row is intentionally written via the un-wrapped top-level `db`
// handle (NOT the caller's executor), because the very next statement is a
// throw that will roll back any surrounding transaction the caller is in.
// Rolling back the audit row alongside the blocked write would defeat the
// whole point of recording it. Audit failures are logged to console.error
// but do NOT mask the original block — the route caller must still see the
// 423 / 404 so the wire response is correct.
// =============================================================================

export interface AdviceWriteBlockContext {
  /** The user whose write was blocked (the adviser making the request). */
  actorUserId: number;
  /**
   * Stable verb identifying what the actor was trying to write — e.g.
   * "client_objective.create", "client_document.upload",
   * "client_document.create". Lands in audit metadata as `attemptedAction`.
   */
  attemptedAction: string;
  /** Originating IP if available. */
  ipAddress?: string | null;
}

async function recordBlockedWrite(
  result: Extract<AdviceWritabilityResult, { writable: false }>,
  block: AdviceWriteBlockContext,
): Promise<void> {
  try {
    await writeAuditLog({
      // Deliberately use the top-level `db` handle, not the caller's
      // executor. See the section header above for why.
      userId: block.actorUserId,
      action: "advice_record.write_blocked",
      entityType: "advice_record",
      entityId: String(result.adviceRecordId),
      before: null,
      after: null,
      extra: {
        reason: result.reason,
        attemptedAction: block.attemptedAction,
        adviceRecordStatus: result.status,
      },
      ipAddress: block.ipAddress ?? null,
    });
  } catch (auditErr) {
    // Audit failures must not mask the original 423/404 — log and move on.
    // Operators get notified via the standard error stream; the block
    // itself is still surfaced to the caller below.
    console.error(
      "[advice-write-gate] failed to record blocked-write audit row",
      auditErr,
    );
  }
}

/**
 * Throwing wrapper for the common case. Throws an Error decorated with:
 *   - status:  HTTP status (404 if record missing, 423 if locked)
 *   - reason:  machine-readable reason code
 *
 * When `block` is provided AND the gate decides to throw, an audit row is
 * recorded first via `recordBlockedWrite` so admins can see the blocked
 * attempt in the audit log even though no state actually changed. Pass
 * `block` from any code path that knows the actor — every adviser-side
 * write into an advice-record child should pass it.
 */
export async function requireAdviceRecordWritable(
  adviceRecordId: number,
  executor: typeof db = db,
  block?: AdviceWriteBlockContext,
): Promise<void> {
  const result = await getAdviceRecordWritability(adviceRecordId, executor);
  if (result.writable) return;

  if (block) {
    await recordBlockedWrite(result, block);
  }

  const status = result.reason === "advice_record_not_found" ? 404 : 423;
  throw Object.assign(new Error(result.detail), {
    status,
    reason: result.reason,
  });
}
