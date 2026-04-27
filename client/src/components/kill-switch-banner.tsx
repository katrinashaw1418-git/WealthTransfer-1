// =============================================================================
// TASK #146 — Public kill-switch banner
// -----------------------------------------------------------------------------
// Renders a "Temporarily unavailable" notice at the top of any client/adviser
// page whose money-movement is currently disabled. Pulls /api/kill-switches/status
// (no auth) on a short interval so the banner appears within ~10s of an
// operator engaging the switch.
//
// Pass one or more switch keys; the banner shows if ANY of them are
// engaged. The intentional master semantics live in the route guard, not
// the UI — pages always pass both their specific switch (e.g. "deposits")
// AND "transactions" so the banner mirrors what the API would refuse.
// =============================================================================
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";

type SwitchKey =
  | "transactions"
  | "deposits"
  | "withdrawals"
  | "fee_deductions";

interface KillSwitchStatusResponse {
  switches: Record<SwitchKey, { disabled: boolean }>;
}

interface KillSwitchBannerProps {
  // Switch keys this page cares about. The banner shows when ANY are
  // engaged. Always include "transactions" alongside the specific key.
  switches: SwitchKey[];
  // Optional override for the banner copy (e.g. "Deposits are temporarily
  // unavailable"). Defaults to a generic phrase.
  message?: string;
}

export function KillSwitchBanner({ switches, message }: KillSwitchBannerProps) {
  const { data } = useQuery<KillSwitchStatusResponse>({
    queryKey: ["/api/kill-switches/status"],
    // Poll often enough that an operator engaging the switch is reflected
    // in the UI within ~10s without spamming the server.
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    // Render nothing on first paint while the request is in flight — the
    // server-side guard is still authoritative; the banner is a heads-up.
    staleTime: 5_000,
  });

  const map = data?.switches ?? ({} as Record<string, { disabled: boolean }>);
  const isDisabled = switches.some((k) => map[k]?.disabled === true);
  if (!isDisabled) return null;

  return (
    <Alert
      variant="destructive"
      className="mb-4 border-amber-300 bg-amber-50 text-amber-900"
      data-testid="banner-kill-switch"
    >
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Temporarily unavailable</AlertTitle>
      <AlertDescription>
        {message ??
          "This service is temporarily paused while we resolve an operational issue. Please try again later."}
      </AlertDescription>
    </Alert>
  );
}

export default KillSwitchBanner;
