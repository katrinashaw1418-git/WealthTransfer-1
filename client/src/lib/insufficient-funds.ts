// =============================================================================
// INSUFFICIENT-FUNDS UI CONTRACT (Task #204)
// -----------------------------------------------------------------------------
// Single source of truth for "is this fee deduction row currently held due to
// insufficient client funds?" used across:
//
//   - client/src/pages/fees.tsx           (client-facing banner + table)
//   - client/src/pages/dashboard.tsx      (cross-page banner)
//   - client/src/pages/adviser/fees.tsx   (held-state badge)
//   - client/src/pages/admin/fees.tsx     (existing IF rendering)
//   - client/src/components/insufficient-funds-banner.tsx
//
// Why centralise:
//   The schema retains `clientNotifiedAt` / `clientNotificationCount` /
//   `lastRecheckedAt` on the row even AFTER it transitions out of
//   `insufficient_funds` to `settled` (the daily cron reads them for email
//   throttling — they intentionally linger). Without one shared predicate,
//   it is easy for a new consumer to render "client has been pinged N
//   times" or a "Re-check now" affordance against a row that is already
//   settled, leaking stale IF semantics into UI surfaces that were never
//   supposed to show them.
//
//   `isInsufficientFundsRow` is the ONLY check any consumer should use to
//   decide whether to render IF-specific UI. The status flip is the single
//   contract; the bookkeeping fields are implementation detail of the cron
//   and must not gate UI visibility.
// =============================================================================

export const INSUFFICIENT_FUNDS_STATUS = "insufficient_funds" as const;

export type InsufficientFundsStatus = typeof INSUFFICIENT_FUNDS_STATUS;

export interface FeeDeductionStatusBearer {
  status: string;
}

export function isInsufficientFundsRow<T extends FeeDeductionStatusBearer>(
  row: T,
): boolean {
  return row.status === INSUFFICIENT_FUNDS_STATUS;
}

// ---------------------------------------------------------------------------
// Shortfall parsing.
//
// `failureReason` for an IF row is written by InsufficientFundsError (see
// server/services/fee-engine.ts) with the canonical shape:
//
//   "[<iso-timestamp>] Insufficient <CCY> balance for client #<id>: " +
//     "required <required>, available <available>"
//
// We parse defensively because the column may also hold legacy text from
// pre-Task #34 deductions or a non-IF failure that briefly used the same
// column. If the regex doesn't match, return null and the caller should
// fall back to showing `totalAccrued` as the amount the client must cover.
// ---------------------------------------------------------------------------
export interface ParsedShortfall {
  currency: string;
  required: string;
  available: string;
  shortfall: string;
}

const SHORTFALL_RE =
  /Insufficient\s+([A-Z]{3})\s+balance\s+for\s+client\s+#\d+:\s*required\s+([\d.]+),\s*available\s+([\d.]+)/i;

export function parseShortfallFromFailureReason(
  reason: string | null | undefined,
): ParsedShortfall | null {
  if (!reason) return null;
  const m = reason.match(SHORTFALL_RE);
  if (!m) return null;
  const [, currency, required, available] = m;
  const shortfall = Math.max(0, Number(required) - Number(available));
  return {
    currency: currency.toUpperCase(),
    required,
    available,
    // Keep the same precision the source used; `toFixed(2)` is the display
    // contract for the banner and admin summary.
    shortfall: shortfall.toFixed(2),
  };
}
