import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link, useLocation } from "wouter";
import { PortalPageHeader } from "@/components/layout/PortalPageHeader";
import { StatusChip } from "@/components/ui/status-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowRight } from "lucide-react";
import { useAiRecommendations } from "@/hooks/use-portfolio";
import { cn } from "@/lib/utils";
import type { AiRecommendation } from "@shared/schema";

function InsightCard({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
        <CardTitle className="text-base font-semibold text-slate-900">{title}</CardTitle>
        <StatusChip domain="workflow">Education</StatusChip>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm leading-relaxed text-slate-600">{detail}</p>
        <p className="text-xs font-medium text-amber-800">General information only — not personal advice.</p>
      </CardContent>
    </Card>
  );
}

function hubButtonClass(path: string, location: string): string {
  const current = location === path;
  return cn(
    "border-slate-200",
    current && "border-sky-400 bg-sky-50 font-medium text-sky-950 shadow-sm hover:bg-sky-50",
  );
}

function SeverityChip({ severity }: { severity: string }) {
  const s = severity.toLowerCase();
  if (s === "warning") {
    return <StatusChip domain="workflow">Review suggested</StatusChip>;
  }
  if (s === "alert") {
    return (
      <StatusChip domain="feeConsent" className="border-amber-300 bg-amber-50 text-amber-950">
        Priority context
      </StatusChip>
    );
  }
  return <StatusChip domain="workflow">Context</StatusChip>;
}

export default function AiInsightsPage() {
  const [location] = useLocation();
  const recs = useAiRecommendations();
  const isError = recs.isError;
  const isLoading = recs.isLoading;
  const list: AiRecommendation[] = Array.isArray(recs.data) ? recs.data : [];
  const showEmptyList = !isLoading && !isError && list.length === 0;

  return (
    <div className="space-y-8 p-6" data-testid="page-ai-insights">
      <PortalPageHeader
        eyebrow="Investor portal"
        title="AI insights"
        description="High-level observations to support conversations with your adviser. Nothing here replaces a Statement of Advice or Record of Advice."
      />

      <nav className="flex flex-wrap gap-2" aria-label="Investor portal sections">
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/dashboard", location)}>
          <Link href="/dashboard">
            Dashboard <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/portfolio", location)}>
          <Link href="/portfolio">Portfolio</Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/ai-insights", location)}>
          <Link href="/ai-insights" aria-current={location === "/ai-insights" ? "page" : undefined}>
            AI insights
          </Link>
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
        <StatusChip domain="advice">Insight scope</StatusChip>
        <p className="min-w-0 flex-1 leading-relaxed">
          Content here covers AFSL-scoped product context only (managed investments, securities, superannuation,
          life insurance). AMAX Wealth does not hold client assets, does not place orders, and does not move
          funds on your behalf. Use these notes for education and adviser-supported review — not as standalone
          advice.
        </p>
      </div>

      <section className="space-y-4" aria-labelledby="ai-notes-heading">
        <h2 id="ai-notes-heading" className="text-sm font-semibold text-slate-900">
          Latest model notes
        </h2>
        {isLoading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Skeleton className="h-36 w-full rounded-lg" />
            <Skeleton className="h-36 w-full rounded-lg" />
          </div>
        ) : isError ? (
          <div className="rounded-lg border border-red-200 bg-red-50/80 px-4 py-6 text-center text-sm text-red-900">
            We couldn&apos;t load model notes. Refresh the page or try again shortly.
          </div>
        ) : showEmptyList ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-4 py-8 text-center text-sm text-slate-600">
            <p className="font-medium text-slate-800">No model notes yet</p>
            <p className="mt-2 max-w-md mx-auto leading-relaxed">
              When your adviser generates or attaches notes, they will appear here for context before your
              next SOA or ROA conversation.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {list.map((row) => (
              <Card key={row.id} className="border-slate-200 shadow-sm">
                <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
                  <CardTitle className="text-base font-semibold text-slate-900">{row.title}</CardTitle>
                  <SeverityChip severity={row.severity} />
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-sm leading-relaxed text-slate-600">{row.description}</p>
                  <p className="text-xs font-medium text-amber-800">General information only — not personal advice.</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4" aria-labelledby="education-frames-heading">
        <h2 id="education-frames-heading" className="text-sm font-semibold text-slate-900">
          Illustrative discussion topics
        </h2>
        <p className="text-xs text-slate-500">
          Fixed examples for education only — not generated from your portfolio until your adviser confirms
          data-backed notes above.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <InsightCard
            title="Portfolio observations"
            detail="Diversification and concentration trends are summarised from your adviser-reviewed holdings."
          />
          <InsightCard
            title="Benchmark commentary"
            detail="Relative performance context is shown for education and review discussions with your adviser."
          />
          <InsightCard
            title="Risk commentary"
            detail="Risk posture indicators are provided for context before your next advice review."
          />
          <InsightCard
            title="Goal gap indicators"
            detail="Progress markers highlight which goals may warrant an adviser review in the next cycle."
          />
        </div>
      </section>

      <Card className="border-amber-200 bg-amber-50/80 shadow-sm">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base text-amber-950">Adviser-reviewed advice</CardTitle>
            <StatusChip domain="advice">Advice</StatusChip>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-amber-950">
            Personal financial product advice is given only through your Statement of Advice or Record of
            Advice, after your adviser has assessed your circumstances.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline" className="border-amber-300 bg-white">
              <Link href="/reports">View latest SOA</Link>
            </Button>
            <Button asChild size="sm" variant="outline" className="border-amber-300 bg-white">
              <Link href="/goals">View related goal</Link>
            </Button>
            <Button asChild size="sm" className="bg-amber-800 hover:bg-amber-900">
              <Link href="/account">Request adviser review</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
