import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link, useLocation } from "wouter";
import { PortalPageHeader } from "@/components/layout/PortalPageHeader";
import { StatusChip } from "@/components/ui/status-chip";
import { apiFetch } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { ArrowRight } from "lucide-react";

/** Wire shape for GET /api/client/objectives (see `client/wealth-planner.tsx`). */
interface ClientObjective {
  id: number;
  adviceRecordId: number;
  objectiveType: string;
  label: string;
  targetAmount: string | null;
  targetCurrency: string;
  targetDate: string | null;
  priority: string;
  notes: string | null;
  createdAt: string | null;
}

function hubButtonClass(path: string, location: string): string {
  const current = location === path;
  return cn(
    "border-slate-200",
    current && "border-sky-400 bg-sky-50 font-medium text-sky-950 shadow-sm hover:bg-sky-50",
  );
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString("en-AU", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

function formatTargetAmount(amount: string | null, currency: string): string {
  if (!amount) return "—";
  const n = parseFloat(amount);
  if (!Number.isFinite(n)) return amount;
  try {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: currency || "AUD",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${amount} ${currency}`;
  }
}

export default function GoalsPage() {
  const [location] = useLocation();
  const objectives = useQuery<{ items: ClientObjective[] }>({
    queryKey: ["/api/client/objectives"],
    queryFn: async () => (await apiFetch("/api/client/objectives")).json(),
  });

  const isError = objectives.isError;
  const isLoading = objectives.isLoading;
  const items = objectives.data?.items ?? [];
  const showEmptyList = !isLoading && !isError && items.length === 0;

  return (
    <div className="space-y-8 p-6" data-testid="page-goals">
      <PortalPageHeader
        eyebrow="Investor portal"
        title="Goals"
        description="Financial goals and planning objectives your adviser has recorded or is reviewing. Figures depend on assumptions agreed in advice."
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
          <Link href="/ai-insights">AI insights</Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/goals", location)}>
          <Link href="/goals" aria-current={location === "/goals" ? "page" : undefined}>
            Goals
          </Link>
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
        <StatusChip domain="advice">Planning scope</StatusChip>
        <p className="min-w-0 flex-1 leading-relaxed">
          Goals here sit in AFSL-scoped advice and reporting context (managed investments, securities,
          superannuation, life insurance). AMAX Wealth does not hold client assets, does not place orders,
          and does not move funds on your behalf. Progress and targets are for discussion with your adviser
          and any formal SOA or ROA you receive.
        </p>
      </div>

      <section className="space-y-4" aria-labelledby="goals-record-heading">
        <h2 id="goals-record-heading" className="text-sm font-semibold text-slate-900">
          Recorded objectives
        </h2>
        {isLoading ? (
          <div className="grid grid-cols-1 gap-4">
            <Skeleton className="h-40 w-full rounded-lg" />
            <Skeleton className="h-40 w-full rounded-lg" />
          </div>
        ) : isError ? (
          <div className="rounded-lg border border-red-200 bg-red-50/80 px-4 py-6 text-center text-sm text-red-900">
            We couldn&apos;t load your objectives. Refresh the page or try again shortly.
          </div>
        ) : showEmptyList ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-4 py-8 text-center text-sm text-slate-600">
            <p className="font-medium text-slate-800">No objectives on file yet</p>
            <p className="mt-2 max-w-md mx-auto leading-relaxed">
              When your adviser records structured objectives, they will appear here for review alongside
              your advice documents.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            {items.map((goal) => (
              <Card key={goal.id} className="border-slate-200 shadow-sm">
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base text-slate-900">{goal.label}</CardTitle>
                    <StatusChip domain="goal">Adviser-recorded</StatusChip>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 gap-3 text-sm text-slate-600 md:grid-cols-3">
                    <p>
                      Type:{" "}
                      <span className="font-medium text-slate-800">{goal.objectiveType || "—"}</span>
                    </p>
                    <p>
                      Target:{" "}
                      <span className="font-medium text-slate-800">
                        {formatTargetAmount(goal.targetAmount, goal.targetCurrency)}
                      </span>
                    </p>
                    <p>
                      Horizon:{" "}
                      <span className="font-medium text-slate-800">{formatDate(goal.targetDate)}</span>
                    </p>
                  </div>

                  <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2 text-xs leading-relaxed text-slate-600">
                    <p>
                      Priority: <span className="font-medium text-slate-800">{goal.priority || "—"}</span>
                      {" · "}
                      Linked advice record #{goal.adviceRecordId}
                    </p>
                    <p className="mt-1 text-slate-500">
                      Progress projections appear after your adviser completes a reviewed plan update tied to
                      this objective.
                    </p>
                  </div>

                  {goal.notes ? (
                    <p className="rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-2 text-xs leading-relaxed text-slate-700">
                      {goal.notes}
                    </p>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                    <StatusChip domain="clientFactFind">Client / fact-find</StatusChip>
                    <p className="text-xs text-slate-500">Recorded: {formatDate(goal.createdAt)}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
