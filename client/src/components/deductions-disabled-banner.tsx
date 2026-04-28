// =============================================================================
// Task #471 — Deductions Disabled Banner (renamed from DeductionExecutionBanner)
// -----------------------------------------------------------------------------
// A persistent, non-dismissable strip rendered at the top of every adviser
// page (mounted in `adviser-layout.tsx`) that surfaces the `fee_deductions`
// kill switch state. The component is exported as `DeductionsDisabledBanner`
// so a future Compliance tab (Task #473) can drop it inline into a tab body
// without re-implementing the polling, default-show, or copy.
//
// Reads `/api/system/deduction-execution-state`, which the server computes
// from the `fee_deductions` kill switch (env var: DISABLE_FEE_DEDUCTIONS).
// Polls every 30s with refetchOnWindowFocus so an admin flipping the switch
// is reflected within ~30s on every open adviser session — and clears the
// banner within the same window without a hard reload.
//
// Non-dismissable by design — there is intentionally no close button. The
// signal exists because real money movement could otherwise mislead an
// adviser; letting them dismiss it would defeat the compliance purpose.
//
// Default-show on undefined response (network error / first paint) — the
// `/api/system/deduction-execution-state` endpoint also returns
// `enabled:false` on read failure, for the same compliance-first reason.
//
// Accessibility:
//   - role="status" gives an implicit aria-live="polite" without nagging
//     screen readers when the banner first mounts.
//   - The banner is part of normal page flow — keyboard tab order is
//     unaffected (no focus traps).
//
// Backwards-compat: a thin re-export lives at
// `client/src/components/deduction-execution-banner.tsx` so older imports
// don't break.
// =============================================================================

import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";

interface DeductionExecutionStateResponse {
  enabled: boolean;
}

export default function DeductionsDisabledBanner() {
  const { data } = useQuery<DeductionExecutionStateResponse>({
    queryKey: ["/api/system/deduction-execution-state"],
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });

  // Default-show until we have a positive answer from the server. This is the
  // safer default for a compliance signal — see header comment.
  const enabled = data?.enabled === true;
  if (enabled) return null;

  return (
    <div
      className="bg-amber-50 border-b border-amber-300 text-amber-900 px-4 py-2 flex items-start gap-2 text-sm"
      data-testid="banner-deductions-disabled"
      role="status"
      aria-live="polite"
    >
      <ShieldAlert className="h-4 w-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
      <div className="flex-1">
        <span className="font-medium">
          Deduction execution is currently disabled
        </span>
        <span className="hidden sm:inline text-amber-800"> — </span>
        <span className="block sm:inline text-amber-800">
          No new fee deductions will settle while this signal is active. Fee
          rules and accruals continue to be recorded for audit, but no money
          will move to your wallet until the licensee re-enables execution.
        </span>
      </div>
    </div>
  );
}
