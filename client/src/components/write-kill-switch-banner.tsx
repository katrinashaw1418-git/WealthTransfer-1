// =============================================================================
// TASK #155 — Write kill switch banner (read-only, all layouts)
// =============================================================================
// A thin sticky banner that polls /api/system/write-state every 30s. When the
// global write kill switch is ON, every authenticated layout (client, adviser,
// admin) shows the same orange "temporarily read-only" message so a user
// who hits a 503 has the explanation right above the page they were on.
//
// Mounted inside Layout / AdviserLayout / AdminLayout so it cannot be missed
// by a user staring at any single screen. The admin layout *also* renders
// the toggle UI on the dashboard — the banner here is the always-on signal.
// =============================================================================

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";

interface WriteStateResponse {
  writeKillSwitchEnabled: boolean;
  reason: string | null;
}

export default function WriteKillSwitchBanner() {
  const { data } = useQuery<WriteStateResponse>({
    queryKey: ["/api/system/write-state"],
    refetchInterval: 30_000,
    // Kept aggressive enough that the banner appears within ~30s of the
    // toggle being flipped, but not so aggressive that it pings the server
    // every few seconds.
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });

  if (!data?.writeKillSwitchEnabled) return null;

  return (
    <div
      className="bg-amber-50 border-b border-amber-300 text-amber-900 px-4 py-2 flex items-center gap-2 text-sm sticky top-0 z-30"
      data-testid="banner-write-kill-switch"
      role="status"
    >
      <AlertTriangle className="h-4 w-4 flex-shrink-0" />
      <span className="font-medium">Temporarily read-only</span>
      <span className="hidden sm:inline text-amber-800">—</span>
      <span className="text-amber-800 truncate">
        Writes are paused by an administrator
        {data.reason ? `: ${data.reason}` : "."}
      </span>
    </div>
  );
}
