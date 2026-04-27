import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ClipboardList,
  Users,
  Link2,
  ScrollText,
  Siren,
  Activity,
  Info,
} from "lucide-react";
import { Link } from "wouter";

interface DashboardData {
  applications: {
    email_unverified: number;
    submitted: number;
    under_review: number;
    approved: number;
    rejected: number;
    pending: number;
    total: number;
  };
  advisers: { total: number };
  clients: { total: number };
  adviserClients: { total: number; active: number };
  recentAudit: Array<{
    id: number;
    userId: number | null;
    action: string;
    entityType: string | null;
    entityId: string | null;
    createdAt: string | null;
  }>;
}

type Severity = "info" | "warning" | "alert" | "critical";

interface OperatorAlertsSummary {
  last24h: Record<Severity, number>;
  last7d: Record<Severity, number>;
  generatedAt: string;
}

interface AdminMetrics {
  windowMs: number;
  generatedAt: string;
  failedTransactions: {
    last24h: number;
    mostRecentId: number | null;
    mostRecentAt: string | null;
  };
  feeDeductionFailures: {
    last24h: number;
    inProcessLast24h: number;
  };
  auditWriteFailures: {
    last24hInProcess: number;
  };
  http5xx: {
    last24hInProcess: number;
  };
  lastSuccessfulHealthProbe: {
    at: string | null;
    ageMs: number | null;
  };
}

const SEVERITIES: Severity[] = ["critical", "alert", "warning", "info"];

const SEVERITY_TILE: Record<Severity, string> = {
  info: "bg-slate-50 text-slate-700 border-slate-200 hover:border-slate-400",
  warning: "bg-amber-50 text-amber-800 border-amber-200 hover:border-amber-400",
  alert: "bg-orange-50 text-orange-800 border-orange-200 hover:border-orange-400",
  critical: "bg-red-50 text-red-800 border-red-200 hover:border-red-400",
};

function fmt(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return "—";
  }
}

export default function AdminDashboard() {
  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ["/api/admin/dashboard"],
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  const {
    data: alertsSummary,
    isLoading: alertsLoading,
    isFetching: alertsFetching,
    dataUpdatedAt: alertsUpdatedAt,
  } = useQuery<OperatorAlertsSummary>({
    queryKey: ["/api/admin/operator-alerts/summary"],
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  const {
    data: metrics,
    isLoading: metricsLoading,
  } = useQuery<AdminMetrics>({
    queryKey: ["/api/admin/metrics"],
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Admin overview</h1>
        <p className="text-sm text-slate-500 mt-1">
          AFSL operations dashboard. Every state change you trigger here is recorded in the audit log.
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Pending applications"
          value={isLoading ? null : data?.applications.pending ?? 0}
          subtext={isLoading ? undefined : `${data?.applications.total ?? 0} total`}
          icon={<ClipboardList className="h-5 w-5 text-violet-600" />}
          to="/admin/applications"
        />
        <StatCard
          label="Advisers"
          value={isLoading ? null : data?.advisers.total ?? 0}
          icon={<Users className="h-5 w-5 text-violet-600" />}
          to="/admin/advisers"
        />
        <StatCard
          label="Clients"
          value={isLoading ? null : data?.clients.total ?? 0}
          icon={<Users className="h-5 w-5 text-violet-600" />}
        />
        <StatCard
          label="Active adviser links"
          value={isLoading ? null : data?.adviserClients.active ?? 0}
          subtext={isLoading ? undefined : `${data?.adviserClients.total ?? 0} total`}
          icon={<Link2 className="h-5 w-5 text-violet-600" />}
          to="/admin/adviser-clients"
        />
      </div>

      {/* Application breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Application pipeline</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
              <PipelineCell label="Email unverified" value={data?.applications.email_unverified ?? 0} />
              <PipelineCell label="Submitted" value={data?.applications.submitted ?? 0} />
              <PipelineCell label="Under review" value={data?.applications.under_review ?? 0} />
              <PipelineCell label="Approved" value={data?.applications.approved ?? 0} />
              <PipelineCell label="Rejected" value={data?.applications.rejected ?? 0} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Operator alerts summary */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Siren className="h-4 w-4 text-violet-600" />
            Operator alerts
          </CardTitle>
          <Link href="/admin/operator-alerts">
            <a
              className="text-xs text-violet-700 hover:underline"
              data-testid="link-operator-alerts-all"
            >
              View all alerts →
            </a>
          </Link>
        </CardHeader>
        <CardContent>
          {alertsLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {SEVERITIES.map((sev) => {
                  const count24h = alertsSummary?.last24h[sev] ?? 0;
                  const count7d = alertsSummary?.last7d[sev] ?? 0;
                  const trend = count7d - count24h;
                  return (
                    <Link
                      key={sev}
                      href={`/admin/operator-alerts?severity=${sev}&window=24h`}
                    >
                      <a
                        data-testid={`tile-operator-alert-${sev}`}
                        className={`block border rounded-md p-3 transition-colors cursor-pointer ${SEVERITY_TILE[sev]}`}
                      >
                        <div className="text-xs uppercase tracking-wide font-medium">
                          {sev}
                        </div>
                        <div className="mt-1 flex items-baseline gap-2">
                          <span
                            className="text-2xl font-semibold"
                            data-testid={`text-alert-24h-${sev}`}
                          >
                            {count24h}
                          </span>
                          <span className="text-xs opacity-70">last 24h</span>
                        </div>
                        <div
                          className="text-xs mt-1 opacity-80"
                          data-testid={`text-alert-7d-${sev}`}
                        >
                          {count7d} in last 7d
                          {count7d > 0 ? (
                            <span className="ml-1 opacity-70">
                              ({trend === 0 ? "all in last 24h" : `+${trend} earlier`})
                            </span>
                          ) : null}
                        </div>
                      </a>
                    </Link>
                  );
                })}
              </div>
              <p className="text-xs text-slate-400">
                Counts cover the last 7 days. Click a severity to open the
                alert log filtered to that level.
              </p>
              <AlertsRefreshStatus
                updatedAt={alertsUpdatedAt}
                isFetching={alertsFetching}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Key business metrics — Task #144 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4 text-violet-600" />
            Key business metrics
          </CardTitle>
        </CardHeader>
        <CardContent>
          {metricsLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <MetricTile
                  testId="tile-metric-failed-transactions"
                  label="Failed transactions"
                  value={metrics?.failedTransactions.last24h ?? 0}
                  windowLabel="last 24h"
                  warn={(metrics?.failedTransactions.last24h ?? 0) > 0}
                />
                <MetricTile
                  testId="tile-metric-audit-failures"
                  label="Audit-log write failures"
                  value={metrics?.auditWriteFailures.last24hInProcess ?? 0}
                  windowLabel="last 24h (this process)"
                  warn={(metrics?.auditWriteFailures.last24hInProcess ?? 0) > 0}
                />
                <MetricTile
                  testId="tile-metric-fee-deduction-failures"
                  label="Fee deduction failures"
                  value={metrics?.feeDeductionFailures.last24h ?? 0}
                  windowLabel="last 24h"
                  warn={(metrics?.feeDeductionFailures.last24h ?? 0) > 0}
                />
                <HealthProbeTile
                  ageMs={metrics?.lastSuccessfulHealthProbe.ageMs ?? null}
                  at={metrics?.lastSuccessfulHealthProbe.at ?? null}
                />
              </div>

              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 space-y-2">
                <div className="flex items-center gap-2 font-medium text-slate-700">
                  <Info className="h-3.5 w-3.5 text-slate-500" />
                  What these numbers mean
                </div>
                <ul className="list-disc pl-5 space-y-1">
                  <li>
                    <span className="font-medium">Failed transactions</span> —
                    rows in <code>transactions</code> with status{" "}
                    <code>failed</code> created in the last 24h. Investigate
                    via the wallet activity / ledger pages.
                  </li>
                  <li>
                    <span className="font-medium">Audit-log write failures</span>{" "}
                    — times the persistent audit-log insert itself threw or
                    was swallowed in the last 24h. In-process counter (resets
                    on deploy); a non-zero value here means at least one
                    finance event may not have been recorded — check{" "}
                    <code>logs/errors.log</code>.
                  </li>
                  <li>
                    <span className="font-medium">Fee deduction failures</span>{" "}
                    — fee deductions in the last 24h that landed in{" "}
                    <code>insufficient_funds</code> or recorded a{" "}
                    <code>failureReason</code>. Review under the fee
                    deductions admin page.
                  </li>
                  <li>
                    <span className="font-medium">Last successful /health probe</span>{" "}
                    — the most recent time the <code>/health</code> endpoint
                    returned 200. Monitor it from your uptime tool; if this
                    field stays empty, no monitor is wired up.
                  </li>
                </ul>
                <div className="pt-1">
                  <span className="font-medium text-slate-700">
                    /health returns 503 when:
                  </span>{" "}
                  the database <code>SELECT 1</code> probe fails OR any of
                  the daily background jobs (fee accruals, wallet/ledger
                  reconciliation, operator alert prune) has not recorded a
                  successful run within the last 36 hours. The 503 body
                  always includes the per-check status so the failing signal
                  is identifiable without a separate log dive.
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent audit */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-violet-600" />
            Recent activity
          </CardTitle>
          <Link href="/admin/audit-logs">
            <a className="text-xs text-violet-700 hover:underline">View full audit log →</a>
          </Link>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : data?.recentAudit && data.recentAudit.length > 0 ? (
            <div className="divide-y divide-slate-100">
              {data.recentAudit.map((row) => (
                <div
                  key={row.id}
                  className="py-2 flex items-center justify-between text-sm"
                  data-testid={`row-audit-${row.id}`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Badge variant="outline" className="text-xs font-mono shrink-0">
                      {row.action}
                    </Badge>
                    <span className="text-slate-500 truncate">
                      {row.entityType ?? "—"}
                      {row.entityId ? ` #${row.entityId}` : ""}
                      {row.userId ? ` · by user ${row.userId}` : ""}
                    </span>
                  </div>
                  <span className="text-xs text-slate-400 shrink-0 ml-2">{fmt(row.createdAt)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">No audit entries yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  label,
  value,
  subtext,
  icon,
  to,
}: {
  label: string;
  value: number | null;
  subtext?: string;
  icon: React.ReactNode;
  to?: string;
}) {
  const inner = (
    <Card className={to ? "hover:border-violet-300 transition-colors cursor-pointer" : ""}>
      <CardContent className="pt-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">
              {value === null ? <Skeleton className="h-7 w-12" /> : value}
            </div>
            {subtext && <div className="text-xs text-slate-400 mt-0.5">{subtext}</div>}
          </div>
          {icon}
        </div>
      </CardContent>
    </Card>
  );
  return to ? (
    <Link href={to}>
      <a data-testid={`link-stat-${label.toLowerCase().replace(/\s+/g, "-")}`}>{inner}</a>
    </Link>
  ) : (
    inner
  );
}

function AlertsRefreshStatus({
  updatedAt,
  isFetching,
}: {
  updatedAt: number;
  isFetching: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

  let label: string;
  if (isFetching) {
    label = "updating…";
  } else if (!updatedAt) {
    label = "waiting for first refresh…";
  } else {
    const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
    label =
      seconds < 5
        ? "last refreshed just now"
        : `last refreshed ${seconds}s ago`;
  }

  return (
    <p
      className="text-xs text-slate-400 tabular-nums"
      data-testid="text-alerts-refresh-status"
      aria-live="polite"
    >
      auto-updating · {label}
    </p>
  );
}

function MetricTile({
  label,
  value,
  windowLabel,
  warn,
  testId,
}: {
  label: string;
  value: number;
  windowLabel: string;
  warn?: boolean;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`border rounded-md p-3 ${
        warn
          ? "bg-amber-50 border-amber-200 text-amber-900"
          : "bg-slate-50 border-slate-200 text-slate-700"
      }`}
    >
      <div className="text-xs uppercase tracking-wide font-medium">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      <div className="text-xs opacity-70 mt-0.5">{windowLabel}</div>
    </div>
  );
}

function HealthProbeTile({
  ageMs,
  at,
}: {
  ageMs: number | null;
  at: string | null;
}) {
  // The "no probe yet" state is genuinely informative — it usually means
  // the operator forgot to point their uptime monitor at /health, which is
  // exactly the kind of silent miss this tile exists to surface.
  const neverProbed = at === null;
  const stale = !neverProbed && (ageMs ?? 0) > 5 * 60 * 1000; // > 5 min
  const tone = neverProbed
    ? "bg-slate-50 border-slate-200 text-slate-600"
    : stale
    ? "bg-amber-50 border-amber-200 text-amber-900"
    : "bg-emerald-50 border-emerald-200 text-emerald-900";

  let display: string;
  if (neverProbed) {
    display = "never";
  } else if (ageMs === null) {
    display = "—";
  } else if (ageMs < 60_000) {
    display = `${Math.max(1, Math.round(ageMs / 1000))}s ago`;
  } else if (ageMs < 60 * 60_000) {
    display = `${Math.round(ageMs / 60_000)}m ago`;
  } else {
    display = `${Math.round(ageMs / 3_600_000)}h ago`;
  }

  return (
    <div
      data-testid="tile-metric-health-probe"
      className={`border rounded-md p-3 ${tone}`}
    >
      <div className="text-xs uppercase tracking-wide font-medium">
        Last /health 200
      </div>
      <div className="mt-1 text-2xl font-semibold" data-testid="text-health-probe-age">
        {display}
      </div>
      <div className="text-xs opacity-70 mt-0.5">
        {neverProbed ? "no monitor wired up?" : fmt(at)}
      </div>
    </div>
  );
}

function PipelineCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-slate-200 rounded-md p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-xl font-semibold text-slate-900">{value}</div>
    </div>
  );
}
