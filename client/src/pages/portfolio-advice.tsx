import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PortalPageHeader } from "@/components/layout/PortalPageHeader";
import { StatusChip } from "@/components/ui/status-chip";
import { apiFetch } from "@/lib/queryClient";
import { normalizeHoldingCategory } from "@/utils/holdingCategory";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

function hubButtonClass(path: string, location: string): string {
  const current = location === path;
  return cn(
    "border-slate-200",
    current && "border-sky-400 bg-sky-50 font-medium text-sky-950 shadow-sm hover:bg-sky-50",
  );
}

interface Holding {
  id: number;
  name: string;
  category?: string | null;
  targetNetIrr?: string | null;
  minimumInvestment?: string | null;
  updatedAt?: string | null;
}

export default function PortfolioAdvicePage() {
  const [location] = useLocation();
  const holdings = useQuery<Holding[]>({
    queryKey: ["/api/investment-products"],
    queryFn: async () => (await apiFetch("/api/investment-products")).json(),
  });

  const isError = holdings.isError;

  const rows = holdings.data ?? [];
  const showEmptyHoldings = !holdings.isLoading && !isError && rows.length === 0;

  return (
    <div className="space-y-8 p-6" data-testid="page-portfolio-advice">
      <PortalPageHeader
        eyebrow="Investor portal"
        title="Portfolio"
        description="Holdings and sleeves reported to your adviser. This view supports advice and reporting only."
      />

      <nav className="flex flex-wrap gap-2" aria-label="Investor portal sections">
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/dashboard", location)}>
          <Link href="/dashboard">
            Dashboard <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/portfolio", location)}>
          <Link href="/portfolio" aria-current={location === "/portfolio" ? "page" : undefined}>
            Portfolio
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/ai-insights", location)}>
          <Link href="/ai-insights">AI insights</Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/goals", location)}>
          <Link href="/goals">Goals</Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/reports", location)}>
          <Link href="/reports">Reports</Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/account", location)}>
          <Link href="/account">Account</Link>
        </Button>
      </nav>

      <div
        className="flex flex-wrap items-start gap-3 rounded-lg border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-950"
        role="region"
        aria-label="Advice-only scope"
      >
        <StatusChip domain="advice">Reporting view</StatusChip>
        <p className="min-w-0 flex-1 leading-relaxed">
          Figures here are drawn from external records and adviser-reviewed menus (managed investments,
          securities, superannuation, life insurance). AMAX Wealth does not hold client assets and does
          not place orders or move funds on your behalf.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {[
          "Managed investments",
          "Securities",
          "Superannuation",
          "Life insurance",
          "Other assets (client-provided)",
        ].map((section) => (
          <Card key={section} className="border-slate-200 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base text-slate-900">{section}</CardTitle>
                <StatusChip domain="advice">Advice sleeve</StatusChip>
              </div>
            </CardHeader>
            <CardContent className="text-sm leading-relaxed text-slate-600">
              Adviser-reviewed positions and valuation notes appear in this sleeve when data is available.
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-slate-200 shadow-sm">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base text-slate-900">Holdings under advice</CardTitle>
          <StatusChip domain="report">Source: adviser-reviewed</StatusChip>
        </CardHeader>
        <CardContent>
          {holdings.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : isError ? (
            <div className="rounded-lg border border-red-200 bg-red-50/80 px-4 py-6 text-center text-sm text-red-900">
              We couldn&apos;t load the product menu. Refresh the page or try again shortly.
            </div>
          ) : showEmptyHoldings ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-4 py-8 text-center text-sm text-slate-600">
              <p className="font-medium text-slate-800">No menu items to display yet</p>
              <p className="mt-2 max-w-md mx-auto leading-relaxed">
                When your adviser links an approved product menu, positions will appear here for reporting
                and review. This portal remains advice and disclosure only.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {rows.slice(0, 8).map((h) => (
                <div key={h.id} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">{h.name}</p>
                    <p className="text-xs text-slate-500">
                      Last updated:{" "}
                      {h.updatedAt ? new Date(h.updatedAt).toLocaleDateString("en-AU") : "—"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusChip domain="clientFactFind" className="capitalize">
                      {normalizeHoldingCategory(h.category)}
                    </StatusChip>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs leading-relaxed text-slate-500">
        Values are indicative only and may not reflect same-day market movements. Speak with your adviser
        before relying on any figure for decisions.
      </p>
    </div>
  );
}
