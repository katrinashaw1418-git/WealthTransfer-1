// =============================================================================
// TRANSACTION STATE MACHINE — Track B (Session 7)
// =============================================================================
// Defines the legal lifecycle for ledger-aware transactions:
//
//   pending  →  processing  →  settled
//      │            │
//      └────────────┴──────→  failed
//
//   settled  →  reversed  (via a new opposing journal — never an in-place edit)
//
// `failed` and `reversed` are TERMINAL states. They cannot be resurrected; if
// you need to retry a failed transaction, create a new one with a fresh
// idempotency key.
//
// IMPORTANT: This vocabulary applies ONLY to new ledger-aware money-movement
// code paths (Track B and beyond). The existing transactions table also stores
// rows from legacy wallet routes which use the older vocabulary
// (pending|completed|failed|cancelled). Do not run those rows through this
// state machine — they are out of scope.
// =============================================================================

export type TransactionStatus =
  | "pending"
  | "processing"
  | "settled"
  | "failed"
  | "reversed";

const allowedTransitions: Record<TransactionStatus, readonly TransactionStatus[]> = {
  pending: ["processing", "failed"],
  processing: ["settled", "failed"],
  settled: ["reversed"],
  failed: [],
  reversed: [],
};

/**
 * Throw if `next` is not a legal successor of `current`. Use this in any code
 * that updates a Track B transaction's status to prevent invalid transitions
 * such as `failed → settled` or `settled → pending`.
 */
export function assertValidTransition(
  current: TransactionStatus,
  next: TransactionStatus
): void {
  if (!allowedTransitions[current]?.includes(next)) {
    throw new Error(`Invalid transaction transition: ${current} → ${next}`);
  }
}

/**
 * Non-throwing predicate variant — useful in UI/optimistic checks where you
 * want a boolean rather than an exception.
 */
export function isValidTransition(
  current: TransactionStatus,
  next: TransactionStatus
): boolean {
  return allowedTransitions[current]?.includes(next) ?? false;
}

/**
 * True when the status is terminal (failed or reversed). Use this to short-
 * circuit any retry/refresh logic that might otherwise try to re-process a
 * dead transaction.
 */
export function isTerminal(status: TransactionStatus): boolean {
  return status === "failed" || status === "reversed";
}
