// =============================================================================
// Task #318 — Document retention lock evaluation
// =============================================================================
// Single source of truth for the "is this document deletable?" question.
// The DELETE /api/adviser/client-documents/:id route calls this helper
// instead of open-coding the boolean tests; the same helper is unit-tested
// here so the contract is locked down independently of HTTP plumbing.
//
// Lock contract (matches the schema defaults installed in shared/schema.ts):
//
//   - deletion_locked = true  →  locked, reason = "deletion_locked"
//   - retention_until > now() →  locked, reason = "retention_window_active"
//   - both null/false/past    →  unlocked, no reason
//
// The route surfaces the reason inside a 423 Locked body so the UI can show
// the right tooltip wording.
// =============================================================================

export type RetentionLockReason =
  | "deletion_locked"
  | "retention_window_active";

export interface RetentionLockEvaluation {
  locked: boolean;
  // Populated only when locked=true. Routes use this to drive the 423
  // response body's `reason` field; the UI uses it to pick the lock
  // chip's tooltip wording.
  reason?: RetentionLockReason;
  // The ISO-8601 retention deadline pulled straight from the row, so the
  // 423 response can include it in `extra.retentionUntil` for the UI.
  retentionUntil: string | null;
  // The boolean lock value pulled straight from the row, again so the 423
  // body's `extra.deletionLocked` can echo it back to the UI.
  deletionLocked: boolean;
}

export interface RetentionLockableRow {
  retentionUntil: Date | null;
  deletionLocked: boolean;
}

// The exact string the UI strip and the 423 body's `extra.policy` field
// share. Keeping a single constant guarantees adviser, client, and the
// regulator-facing 423 body all quote the same wording — a drift would
// be flagged at compliance review.
export const RETENTION_POLICY_TEXT =
  "Documents are retained for 7 years from creation per Corporations Act s912G. Deletion is locked while the retention window is active.";

export function evaluateRetentionLock(
  row: RetentionLockableRow,
  now: Date = new Date(),
): RetentionLockEvaluation {
  const lockedFlag = row.deletionLocked === true;
  const retentionActive =
    row.retentionUntil !== null && row.retentionUntil.getTime() > now.getTime();
  const retentionIso = row.retentionUntil
    ? row.retentionUntil.toISOString()
    : null;

  if (lockedFlag) {
    return {
      locked: true,
      reason: "deletion_locked",
      retentionUntil: retentionIso,
      deletionLocked: true,
    };
  }
  if (retentionActive) {
    return {
      locked: true,
      reason: "retention_window_active",
      retentionUntil: retentionIso,
      deletionLocked: false,
    };
  }
  return {
    locked: false,
    retentionUntil: retentionIso,
    deletionLocked: row.deletionLocked,
  };
}
