// =============================================================================
// TASK #307 — Shell-level Deduction Execution Banner
// =============================================================================
// A non-dismissable strip rendered ONCE in the adviser layout (above the page
// header, below the AMAX nav) that surfaces the Gate-A "deductions are
// accounting-only" signal on EVERY adviser page. Replaces the page-local
// banner that previously lived inside /adviser/fees.tsx — moving it shell-
// level means a future page can never forget to render it, and the copy
// only lives in one place.
//
// Reads /api/system/deduction-execution-state, which the server computes
// from the existing fee_deductions kill switch and any future Gate-B flag.
// Polls every 30s with refetchOnWindowFocus so an admin flipping the switch
// is reflected within ~30s on every open adviser session.
//
// Non-dismissable by design — there is intentionally no close button. The
// signal exists because real money movement could otherwise mislead an
// adviser; letting them dismiss it would defeat the compliance purpose.
//
// Copy: matches Task #294's standardised Gate-A string. If that copy ever
// changes, only this file changes.
// =============================================================================

import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";

interface DeductionExecutionStateResponse {
  enabled: boolean;
}

export default function DeductionExecutionBanner() {
  const { data } = useQuery<DeductionExecutionStateResponse>({
    queryKey: ["/api/system/deduction-execution-state"],
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });

  // Default-show when the state is undefined OR explicitly disabled — until
  // we have a positive answer from the server, assume execution is OFF.
  // This is the safer default because the banner exists to WARN. The
  // /api/system/deduction-execution-state endpoint itself returns
  // enabled:false on read failure for the same reason.
  const enabled = data?.enabled === true;
  if (enabled) return null;

  return (
    <div
      className="bg-amber-50 border-b border-amber-300 text-amber-900 px-4 py-2 flex items-start gap-2 text-sm"
      data-testid="banner-deduction-execution"
      role="status"
    >
      <ShieldAlert className="h-4 w-4 flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        <span className="font-medium">
          Deduction execution is currently disabled
        </span>
        <span className="hidden sm:inline text-amber-800"> — </span>
        <span className="block sm:inline text-amber-800">
          Fee rules are created and managed by the licensee. When deduction
          execution is enabled, deductions in <strong>Settled</strong> status
          will represent completed fund movements. Until then, all deductions
          shown here are accounting-only — no money has moved to your wallet.
        </span>
      </div>
    </div>
  );
}
