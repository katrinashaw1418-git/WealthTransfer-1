// =============================================================================
// INSUFFICIENT-FUNDS BANNER (Task #204)
// -----------------------------------------------------------------------------
// Top-of-page banner shown to a CLIENT whenever any of their adviser fee
// deductions is currently held in `insufficient_funds`. Disappears as soon
// as the row flips to `settled` (the cron daily sweep, or the admin manual
// sweep, or a Stripe top-up that brings the wallet over the required amount).
//
// Mounted from:
//   - client/src/pages/dashboard.tsx (cross-page persistent reminder)
//   - client/src/pages/fees.tsx       (in-context detail with per-row Period
//                                      tags and shortfall figures)
//
// The banner is purely a READ surface — it never mutates state. The CTA links
// to the wallet page so the client can top up; settlement is re-attempted
// automatically by the daily cron + the admin manual sweep.
// =============================================================================

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertTriangle, ArrowRight } from "lucide-react";
import {
  isInsufficientFundsRow,
  parseShortfallFromFailureReason,
} from "@/lib/insufficient-funds";

interface ClientFeeDeductionRow {
  id: number;
  adviserUserId: number;
  periodStart: string;
  periodEnd: string;
  totalAccrued: string;
  currency: string;
  status: string;
  failureReason: string | null;
}

interface ClientFeeDeductionsPayload {
  items: ClientFeeDeductionRow[];
}

interface InsufficientFundsBannerProps {
  // When true, render a compact one-liner suitable for the dashboard.
  // When false (default) render the full multi-row breakdown for the
  // dedicated fees page.
  compact?: boolean;
}

export function InsufficientFundsBanner({
  compact = false,
}: InsufficientFundsBannerProps) {
  // Code-review follow-up — the global queryClient default is staleTime
  // Infinity, which would pin the banner to its first-load value for the
  // life of the session. After a client tops up their wallet on /wallets
  // and the IF cron (or admin manual sweep) settles the held row, the
  // dashboard banner would otherwise keep showing the old shortfall until
  // a hard refresh. We override with a short staleTime + a 60s background
  // refetch so the banner clears (or updates the shortfall amount) within
  // a minute of the underlying state changing, without requiring every
  // top-up flow to remember to invalidate this exact query key.
  const q = useQuery<ClientFeeDeductionsPayload>({
    queryKey: ["/api/client/fee-deductions"],
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  // Loading / errored: render nothing. The banner is opportunistic — it
  // surfaces a problem if we know about one, and stays silent otherwise.
  // It is NEVER the primary signal that the page is loading.
  if (!q.data) return null;

  const ifRows = q.data.items.filter(isInsufficientFundsRow);
  if (ifRows.length === 0) return null;

  if (compact) {
    return (
      <Alert
        variant="destructive"
        className="border-destructive/50"
        data-testid="banner-insufficient-funds-compact"
      >
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>
          {ifRows.length === 1
            ? "An adviser fee couldn't be deducted"
            : `${ifRows.length} adviser fees couldn't be deducted`}
        </AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <span>
            Your wallet didn't have enough funds when the deduction ran. Top up
            and the system will retry automatically.
          </span>
          <div className="flex gap-2">
            <Link href="/wallets">
              <Button
                size="sm"
                variant="default"
                data-testid="button-banner-topup"
              >
                Top up wallet
                <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            </Link>
            <Link href="/fees">
              <Button
                size="sm"
                variant="outline"
                data-testid="button-banner-view-fees"
              >
                View fees
              </Button>
            </Link>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert
      variant="destructive"
      className="border-destructive/50"
      data-testid="banner-insufficient-funds"
    >
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>
        {ifRows.length === 1
          ? "Your adviser fee couldn't be deducted"
          : `${ifRows.length} adviser fees couldn't be deducted`}
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <ul className="list-disc pl-5 space-y-1">
          {ifRows.map((d) => {
            const parsed = parseShortfallFromFailureReason(d.failureReason);
            const period = `${d.periodStart.slice(0, 10)} → ${d.periodEnd.slice(0, 10)}`;
            return (
              <li key={d.id} data-testid={`banner-if-row-${d.id}`}>
                <span className="font-medium">Period {period}</span>
                {": "}
                {parsed ? (
                  <>
                    needs{" "}
                    <span
                      className="font-semibold"
                      data-testid={`banner-if-shortfall-${d.id}`}
                    >
                      {parsed.shortfall} {parsed.currency}
                    </span>{" "}
                    more (required {parsed.required}, available{" "}
                    {parsed.available})
                  </>
                ) : (
                  <>
                    {/* Fallback when the failure-reason text doesn't match the
                        canonical shape (legacy rows / non-IF crash text the
                        gate stripped). Show the total the row needs to clear
                        — topping up at least that much will succeed. */}
                    needs{" "}
                    <span
                      className="font-semibold"
                      data-testid={`banner-if-shortfall-${d.id}`}
                    >
                      {d.totalAccrued} {d.currency}
                    </span>{" "}
                    in your wallet
                  </>
                )}
              </li>
            );
          })}
        </ul>
        <div className="flex gap-2 pt-1">
          <Link href="/wallets">
            <Button
              size="sm"
              variant="default"
              data-testid="button-banner-topup"
            >
              Top up wallet
              <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </Link>
        </div>
        <p className="text-xs opacity-80">
          The system re-checks held deductions automatically once a day. As
          soon as your wallet covers the amount the deduction will settle and
          this banner will disappear.
        </p>
      </AlertDescription>
    </Alert>
  );
}
