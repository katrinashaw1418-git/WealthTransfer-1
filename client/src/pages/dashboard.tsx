import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link, useLocation } from "wouter";
import { PortalPageHeader } from "@/components/layout/PortalPageHeader";
import { StatusChip } from "@/components/ui/status-chip";
import { usePortfolio } from "@/hooks/use-portfolio";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

function hubButtonClass(path: string, location: string): string {
  const current = location === path;
  return cn(
    "border-slate-200",
    current && "border-sky-400 bg-sky-50 font-medium text-sky-950 shadow-sm hover:bg-sky-50",
  );
}

function fmtAud(value: string | undefined): string {
  const n = parseFloat(value ?? "");
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  }).format(n);
}

const periods = ["1M", "3M", "6M", "1Y", "All"] as const;

export default function Dashboard() {
  const [location] = useLocation();
  const { data: portfolio, isLoading, isError } = usePortfolio();

  const snapshotCards = [
    {
      label: "Reported portfolio value",
      value: isLoading ? null : isError || !portfolio ? "—" : fmtAud(portfolio.totalValue),
      helper: portfolio?.updatedAt
        ? `Last updated ${new Date(portfolio.updatedAt).toLocaleString("en-AU", { dateStyle: "short", timeStyle: "short" })}`
        : "Client and adviser-reviewed aggregate from your linked records",
    },
    {
      label: "Advised & structured sleeve",
      value: isLoading ? null : isError || !portfolio ? "—" : fmtAud(portfolio.investmentValue),
      helper: "Managed investments and similar positions under advice",
    },
    {
      label: "Superannuation (reported)",
      value: "$360,000",
      helper: "External account reporting — sample until linked",
    },
    {
      label: "Other reported assets",
      value: isLoading ? null : isError || !portfolio ? "—" : fmtAud(portfolio.fiatValue),
      helper: "Cash and client-reported components (AUD)",
    },
  ];

  return (
    <div className="space-y-8 p-6" data-testid="page-dashboard">
      <PortalPageHeader
        eyebrow="Investor portal"
        title="Dashboard"
        description="Summary of reported holdings, goal progress, and adviser-reviewed documents. Key figures sync from your portfolio record when available."
      />

      <nav className="flex flex-wrap gap-2" aria-label="Investor portal sections">
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/dashboard", location)}>
          <Link href="/dashboard" aria-current={location === "/dashboard" ? "page" : undefined}>
            Dashboard <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/portfolio", location)}>
          <Link href="/portfolio">Portfolio</Link>
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
        <StatusChip domain="advice">Hub scope</StatusChip>
        <p className="min-w-0 flex-1 leading-relaxed">
          This portal summarises adviser-reviewed reporting across managed investments, securities, superannuation,
          and life insurance. AMAX Wealth does not hold client assets, does not place orders, and does not move
          funds on your behalf. Figures support advice conversations only.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {snapshotCards.map((card) => (
          <Card key={card.label} className="border-slate-200 shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium uppercase tracking-wide text-slate-500">
                {card.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {card.value === null ? (
                <Skeleton className="h-9 w-32" />
              ) : (
                <p className="text-2xl font-bold tabular-nums text-slate-900">{card.value}</p>
              )}
              <p className="mt-1 text-xs text-slate-500">{card.helper}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-slate-200 shadow-sm">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-base text-slate-900">Portfolio performance</CardTitle>
            <p className="mt-1 text-xs text-slate-500">Adviser-reviewed reporting window</p>
          </div>
          <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1">
            {periods.map((p) => (
              <Button
                key={p}
                type="button"
                size="sm"
                variant={p === "1Y" ? "secondary" : "ghost"}
                className="h-8 px-3 text-xs"
              >
                {p}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex h-44 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50/80 text-sm text-slate-500">
            Chart placeholder — performance series loads here
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            Portfolio information is based on data provided by the client and reviewed by your adviser
            based on information available at the time.
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-base text-slate-900">Asset allocation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-600">
            <p>Managed investments, superannuation, securities, and other client-reported assets.</p>
            <StatusChip domain="report">Under advice</StatusChip>
          </CardContent>
        </Card>
        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-base text-slate-900">Insurance cover snapshot</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-600">
            <p>Life and related cover indicators from adviser-reviewed records.</p>
            <StatusChip domain="advice">Review current</StatusChip>
          </CardContent>
        </Card>
        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-base text-slate-900">Upcoming adviser fee</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-600">
            <p>Reference day: 14 May 2026</p>
            <p>Amount: $150.00 AUD / month</p>
            <StatusChip domain="feeConsent" emphasis="solid">
              Fee consent — active
            </StatusChip>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base text-slate-900">AI insights</CardTitle>
            <StatusChip domain="workflow">General information</StatusChip>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-600">
            <p>Portfolio drift and goal-gap indicators are available for discussion with your adviser.</p>
            <p className="text-xs text-amber-800">Not personal financial advice.</p>
          </CardContent>
        </Card>
        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base text-slate-900">Retirement goal progress</CardTitle>
            <StatusChip domain="goal">Goal — on track</StatusChip>
          </CardHeader>
          <CardContent className="space-y-2">
            <Progress value={34} className="h-2" />
            <p className="text-sm text-slate-600">34% towards the target milestone in your agreed plan.</p>
          </CardContent>
        </Card>
      </div>

      <Card className="border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-base text-slate-900">Alerts and next steps</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-slate-700">
          <div className="flex flex-wrap items-start gap-2">
            <StatusChip domain="report">Report / document</StatusChip>
            <span>Annual review pack is ready in Reports.</span>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            <StatusChip domain="goal">Goal</StatusChip>
            <span>Passive income goal is awaiting adviser review.</span>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            <StatusChip domain="feeConsent">Fee consent</StatusChip>
            <span>Consent renewal window opens in 13 days.</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
