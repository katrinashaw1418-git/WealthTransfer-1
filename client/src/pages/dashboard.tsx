import { useEffect, useState } from "react";
import { Clock, X, Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import WealthOverview from "@/components/dashboard/wealth-overview";
import PortfolioChart from "@/components/dashboard/portfolio-chart";
import FxExchangeTool from "@/components/dashboard/fx-exchange-tool";
import AiAdvisoryPanel from "@/components/dashboard/ai-advisory-panel";
import CurrencyBalances from "@/components/dashboard/currency-balances";
import TransactionHistory from "@/components/dashboard/transaction-history";
import { InsufficientFundsBanner } from "@/components/insufficient-funds-banner";
import { usePortfolio } from "@/hooks/use-portfolio";
import { Skeleton } from "@/components/ui/skeleton";

interface ApplicationRecord {
  referenceId: string;
  submittedAt: string;
  bannerDismissed: boolean;
}

// Task #337 — the dashboard footer total used to render "$0.00M" because
// it wasn't bound to the same source as the WealthOverview "Total
// Portfolio Value" card. We now reuse the shared `usePortfolio()` hook
// so the footer shows the same fiat + crypto + stablecoin + investment
// aggregation, formatted consistently. The hook's loading and error
// states are surfaced rather than masked, so the footer can never silently
// fall back to the old $0.00M placeholder.
function DashboardWealthFooter() {
  const { data: portfolio, isLoading, error } = usePortfolio();

  const formatTotal = (raw: string | undefined): string => {
    const v = parseFloat(raw ?? "");
    if (!Number.isFinite(v)) return "—";
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
    return `$${v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };

  return (
    <footer
      className="rounded-lg border border-gray-200 bg-gray-50 px-5 py-4 flex flex-wrap items-center justify-between gap-3"
      data-testid="dashboard-footer-total"
    >
      <div className="space-y-0.5">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Total wealth on platform</p>
        <p className="text-[11px] text-gray-500">
          Aggregated across cash, digital assets and structured investments — same source as the portfolio overview card above.
        </p>
      </div>
      <div className="text-right">
        {isLoading ? (
          <Skeleton className="h-7 w-32" />
        ) : error || !portfolio ? (
          <span className="text-sm text-destructive" data-testid="dashboard-footer-total-error">
            Unable to load total
          </span>
        ) : (
          <p className="text-2xl font-bold text-gray-900" data-testid="dashboard-footer-total-value">
            {formatTotal(portfolio.totalValue)}
          </p>
        )}
      </div>
    </footer>
  );
}

export default function Dashboard() {
  const { toast } = useToast();
  const [application, setApplication] = useState<ApplicationRecord | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("amax_application");
      if (!raw) return;
      const parsed = JSON.parse(raw) as ApplicationRecord;
      if (parsed.referenceId && !parsed.bannerDismissed) setApplication(parsed);
    } catch {}
  }, []);

  const dismissBanner = () => {
    if (!application) return;
    const updated = { ...application, bannerDismissed: true };
    try {
      localStorage.setItem("amax_application", JSON.stringify(updated));
    } catch {}
    setApplication(null);
  };

  const copyReference = () => {
    if (!application) return;
    navigator.clipboard.writeText(application.referenceId).then(() => {
      toast({ title: "Reference copied", description: application.referenceId });
    });
  };

  return (
    <div className="p-6 space-y-6">
      {/* Task #204 — surface held adviser-fee deductions across the app.
          Renders nothing when no IF rows exist; harmless on dashboards
          for non-clients (the query 401s and stays silent). The banner
          uses its compact one-liner variant on the dashboard so the page
          chrome stays focused. */}
      <InsufficientFundsBanner compact />

      {application && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start gap-4" data-testid="banner-application-pending">
          <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
            <Clock className="w-5 h-5 text-blue-700" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <p className="font-semibold text-blue-900">Application under review</p>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-white border border-blue-200 text-sm font-mono text-blue-900">
                {application.referenceId}
                <button onClick={copyReference} className="text-blue-700 hover:text-blue-900" data-testid="button-copy-reference-banner" aria-label="Copy reference">
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </span>
            </div>
            <p className="text-sm text-blue-800 mt-1">
              Your adviser is preparing your Statement of Advice. Expected within 3–5 business days. Quote your reference in any correspondence.
            </p>
            <p className="text-xs text-blue-700/80 mt-2">
              AMAX Wealth provides general advice and acts under AFSL obligations. Personal advice is provided only via your Statement of Advice.
            </p>
          </div>
          <button onClick={dismissBanner} className="text-blue-700 hover:text-blue-900 flex-shrink-0" data-testid="button-dismiss-banner" aria-label="Dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Wealth Overview Cards */}
      <WealthOverview />

      {/* Main Dashboard Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Portfolio Chart and FX Tool */}
        <div className="lg:col-span-2 space-y-6">
          <PortfolioChart />
          <FxExchangeTool />
        </div>

        {/* Right Column - Market Insights and Balances */}
        <div className="space-y-6">
          <AiAdvisoryPanel />
          <CurrencyBalances />
        </div>
      </div>

      {/* Transaction History */}
      <TransactionHistory />

      {/* Dashboard footer total — bound to the same aggregation as the
          WealthOverview "Total Portfolio Value" card. */}
      <DashboardWealthFooter />
    </div>
  );
}
