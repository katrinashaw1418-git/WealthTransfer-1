// =============================================================================
// TASK #204 — CENTRALISED "SHOW AS INSUFFICIENT FUNDS?" PREDICATE
// -----------------------------------------------------------------------------
// One source of truth for whether a fee-deduction row should render any
// insufficient-funds-specific affordance (badge, recheck text, notification
// metadata, banner inclusion). Every UI consumer — client banner, admin
// deductions table, adviser fees view — calls isInsufficientFundsStatus().
// Whenever a row leaves the `insufficient_funds` state (settled, reversed,
// rejected, ...), the centralised check returns false everywhere at once,
// so the lingering `clientNotifiedAt`, `clientNotificationCount`, and
// `lastRecheckedAt` columns can never leak as stale "still held" UI.
//
// The complementary `projectDeductionForApiContract` strips those bookkeeping
// columns server-side for non-IF rows BEFORE they ship over the wire, so even
// a future consumer that forgets to call the predicate cannot accidentally
// render notification metadata for a settled-formerly-IF row.
// =============================================================================

export const FEE_DEDUCTION_STATUS_INSUFFICIENT_FUNDS = "insufficient_funds";

/**
 * Returns true iff the row is currently in the insufficient_funds state.
 * Use this every time UI code conditionally renders an IF-specific affordance.
 */
export function isInsufficientFundsStatus(
  row: { status: string } | null | undefined,
): boolean {
  return !!row && row.status === FEE_DEDUCTION_STATUS_INSUFFICIENT_FUNDS;
}

/**
 * Server-side projection: clears the IF-only bookkeeping columns
 * (`lastRecheckedAt`, `clientNotifiedAt`, `clientNotificationCount`) on any
 * row whose status is NOT `insufficient_funds`. The row is returned as-is
 * when it IS insufficient_funds, so the admin UI's recheck/notification
 * panel keeps working.
 *
 * The column values still linger in the DB (the sweep needs the debounce
 * history to avoid renotifying within the renotify interval), but no API
 * response surfaces them once the row has moved to settled / reversed / etc.
 */
export function projectDeductionForApiContract<
  T extends {
    status: string;
    lastRecheckedAt?: Date | string | null;
    clientNotifiedAt?: Date | string | null;
    clientNotificationCount?: number | null;
  },
>(row: T): T {
  if (isInsufficientFundsStatus(row)) return row;
  return {
    ...row,
    lastRecheckedAt: null,
    clientNotifiedAt: null,
    clientNotificationCount: 0,
  };
}

// =============================================================================
// TASK #208 — /api/admin/fee-exceptions ROW PROJECTION
// -----------------------------------------------------------------------------
// The admin "Held / Stuck / Failed" exceptions report classifies each row
// into one of four kinds (`held` / `stuck` / `failed` / `role_corruption`).
// Only `held` rows are still in the insufficient_funds state, so only `held`
// rows have meaningful values in the four IF-only bookkeeping columns:
//   - failureReason
//   - lastRecheckedAt
//   - clientNotifiedAt
//   - clientNotificationCount
// The first three of those linger on the row by design (the cron uses the
// debounce history), but they MUST NOT leak onto a non-held exception row —
// e.g. a stuck `pending_approval` row that previously cycled through the IF
// state should not surface "client pinged 3 times" text. This helper enforces
// the contract server-side so any future admin surface that consumes the
// endpoint can render the row without re-implementing the kind-based gate.
// =============================================================================

export type FeeExceptionKind =
  | "held"
  | "stuck"
  | "failed"
  | "role_corruption";

export function projectFeeExceptionRow<
  T extends {
    status: string;
    failureReason?: string | null;
    lastRecheckedAt?: Date | string | null;
    clientNotifiedAt?: Date | string | null;
    clientNotificationCount?: number | null;
  },
>(row: T, kind: FeeExceptionKind): T {
  const base = projectDeductionForApiContract(row);
  if (kind === "held") return base;
  return {
    ...base,
    failureReason: null,
    lastRecheckedAt: null,
    clientNotifiedAt: null,
    clientNotificationCount: 0,
  };
}
