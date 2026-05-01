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
  Database,
  AlertTriangle,
  CheckCircle2,
  Layers,
} from "lucide-react";
import { Link } from "wouter";
import WriteKillSwitchPanel from "@/components/admin/write-kill-switch-panel";

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
  backups: BackupHealthPayload | null;
}

// Task #147 — payload from /api/admin/backups/status, mirrored as the
// `backups` field on /api/admin/dashboard. Kept inline rather than imported
// from @shared so the dashboard query type stays self-describing.
interface BackupHealthPayload {
  enabled: boolean;
  backupDir: string | null;
  retentionCount: number;
  latestBackup: {
    startedAt: string;
    finishedAt: string | null;
    dumpPath: string | null;
    dumpSizeBytes: number | null;
    durationMs: number | null;
    ageMs: number;
  } | null;
  latestDrill: {
    startedAt: string;
    finishedAt: string | null;
    dumpPath: string | null;
    integrity: {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; detail?: string }>;
    } | null;
    durationMs: number | null;
    ageMs: number;
  } | null;
}

// Same defaults as DEFAULT_BACKUP_STALE_THRESHOLD_MS / DRILL_STALE_THRESHOLD_MS
// in server/services/database-backups.ts. Duplicated here so the UI can
// colour the tile without an extra round-trip; if those server defaults
// change, update this constant too.
const BACKUP_STALE_HOURS = 48;
const DRILL_STALE_HOURS = 14 * 24;

type Severity = "info" | "warning" | "alert" | "critical";

// Task #175 — delivery rollup recorded by `notifyOperator`. Mirrors the
// allow-list on the server. Kept inline so the dashboard query stays
// self-describing.
type DeliveryStatus = "delivered" | "failed" | "suppressed_duplicate";

interface OperatorAlertsSummary {
  last24h: Record<Severity, number>;
  last7d: Record<Severity, number>;
  // Optional so the dashboard still renders against an older server build
  // that hasn't shipped the delivery rollup yet — the health card simply
  // skips itself in that case.
  deliveryHealth?: {
    lastHour: Record<DeliveryStatus, number>;
    last24h: Record<DeliveryStatus, number>;
  };
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
    <div className="max-w-7xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900">Admin overview</h1>
        <p className="text-sm text-slate-500">
          AFSL operations dashboard. Every state change you trigger here is recorded in the audit log.
        </p>
      </div>

      {/* Task #155 — Global write kill switch panel. Sits at the top so an
          admin landing on the dashboard during an incident sees it first. */}
      <WriteKillSwitchPanel />

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

      {/* Task #175 — Alert delivery health */}
      <AlertDeliveryHealthCard
        isLoading={alertsLoading}
        deliveryHealth={alertsSummary?.deliveryHealth ?? null}
      />

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
                    via the external-holdings activity / ledger pages.
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
                  the daily background jobs (fee accruals, external-holdings/ledger
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
      {/* Backup health (Task #147) */}
      <BackupHealthCard isLoading={isLoading} backups={data?.backups ?? null} />

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

// ---------------------------------------------------------------------------
// Backup health card (Task #147)
// ---------------------------------------------------------------------------
// Surfaces the most recent successful pg_dump and the most recent successful
// restore drill so the operator can see — without leaving the landing page
// — whether the rollback safety net is healthy. The colour banding mirrors
// the watchdog thresholds in server/services/database-backups.ts:
//   * green   — within freshness window
//   * amber   — known but >50% of the way to staleness
//   * red     — past the staleness window or never run
// When backups are not enabled (DB_BACKUP_DIR unset), we render a
// neutral "Not configured" tile so the absence is visible rather than
// silently hidden.
// ---------------------------------------------------------------------------
function BackupHealthCard({
  isLoading,
  backups,
}: {
  isLoading: boolean;
  backups: BackupHealthPayload | null;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <Database className="h-4 w-4 text-violet-600" />
          Backup health
        </CardTitle>
        <div className="flex items-center gap-3 text-xs">
          <a
            href="/api/admin/runbooks/rollback"
            target="_blank"
            rel="noopener noreferrer"
            className="text-violet-700 hover:underline"
            data-testid="link-rollback-runbook"
          >
            Rollback runbook ↗
          </a>
          <Link href="/admin/background-jobs">
            <a className="text-violet-700 hover:underline">
              View background jobs →
            </a>
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !backups ? (
          <p className="text-sm text-slate-500" data-testid="text-backup-status-error">
            Backup status unavailable.
          </p>
        ) : !backups.enabled ? (
          <div
            className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600"
            data-testid="banner-backups-disabled"
          >
            Backups are not configured (DB_BACKUP_DIR unset). See the{" "}
            <a
              href="/api/admin/runbooks/rollback"
              target="_blank"
              rel="noopener noreferrer"
              className="text-violet-700 underline"
            >
              rollback runbook
            </a>
            .
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <BackupHealthTile
              label="Last successful backup"
              entry={backups.latestBackup}
              staleAfterMs={BACKUP_STALE_HOURS * 60 * 60 * 1000}
              testId="tile-last-backup"
              extraDetail={
                backups.latestBackup
                  ? `${formatBytes(backups.latestBackup.dumpSizeBytes)} · retention=${backups.retentionCount}`
                  : `retention=${backups.retentionCount}`
              }
            />
            <BackupHealthTile
              label="Last successful restore drill"
              entry={
                backups.latestDrill
                  ? {
                      startedAt: backups.latestDrill.startedAt,
                      ageMs: backups.latestDrill.ageMs,
                    }
                  : null
              }
              staleAfterMs={DRILL_STALE_HOURS * 60 * 60 * 1000}
              testId="tile-last-drill"
              extraDetail={
                backups.latestDrill?.integrity
                  ? `${backups.latestDrill.integrity.checks.length} integrity check(s) — ${backups.latestDrill.integrity.ok ? "all passed" : "FAILED"}`
                  : undefined
              }
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BackupHealthTile({
  label,
  entry,
  staleAfterMs,
  testId,
  extraDetail,
}: {
  label: string;
  entry: { startedAt: string; ageMs: number } | null;
  staleAfterMs: number;
  testId: string;
  extraDetail?: string;
}) {
  let toneClass = "border-slate-200 bg-slate-50";
  let badgeText = "Never run";
  let badgeClass = "bg-red-100 text-red-700 border-red-200";

  if (entry) {
    const ratio = entry.ageMs / staleAfterMs;
    if (ratio > 1) {
      toneClass = "border-red-200 bg-red-50";
      badgeText = "Stale";
      badgeClass = "bg-red-100 text-red-700 border-red-200";
    } else if (ratio > 0.5) {
      toneClass = "border-amber-200 bg-amber-50";
      badgeText = "Aging";
      badgeClass = "bg-amber-100 text-amber-800 border-amber-200";
    } else {
      toneClass = "border-emerald-200 bg-emerald-50";
      badgeText = "Fresh";
      badgeClass = "bg-emerald-100 text-emerald-700 border-emerald-200";
    }
  } else {
    toneClass = "border-red-200 bg-red-50";
  }

  return (
    <div
      className={`border rounded-md p-3 ${toneClass}`}
      data-testid={testId}
    >
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500 uppercase tracking-wide">
          {label}
        </div>
        <Badge variant="outline" className={`text-xs ${badgeClass}`}>
          {badgeText}
        </Badge>
      </div>
      <div className="mt-1 text-sm font-medium text-slate-900">
        {entry ? fmt(entry.startedAt) : "—"}
      </div>
      <div className="text-xs text-slate-500 mt-0.5">
        {entry ? `${formatAge(entry.ageMs)} ago` : "no successful run on record"}
      </div>
      {extraDetail && (
        <div className="text-xs text-slate-400 mt-1">{extraDetail}</div>
      )}
    </div>
  );
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "size n/a";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

// ---------------------------------------------------------------------------
// Alert delivery health card (Task #175)
// ---------------------------------------------------------------------------
// The operator-alerts dispatcher tags every row with a delivery rollup
// (delivered / failed / suppressed_duplicate). This card surfaces those
// counts for the last hour and the last 24h so an operator landing on the
// dashboard can spot a webhook outage at a glance — without having to open
// the full alerts page and skim per-row outcomes.
//
// Layout:
//   * Top: a red "delivery failures in the last hour" banner whenever
//     `failed > 0` in the most recent hour. The banner deep-links into
//     `/admin/operator-alerts?deliveryStatus=failed&window=1h` so a click
//     lands the operator on exactly the failing rows.
//   * Body: a 3-column grid (delivered / failed / coalesced) showing the
//     last-hour count prominently, with the last-24h count below as
//     context. Each tile deep-links to the same filtered alerts view with
//     `window=24h` for the 24h click target.
//
// The whole card is intentionally optional — when the server hasn't
// shipped the deliveryHealth payload yet, we simply don't render it
// rather than show a half-broken UI.
// ---------------------------------------------------------------------------
const DELIVERY_TILES: Array<{
  status: DeliveryStatus;
  label: string;
  description: string;
  toneOk: string;
  icon: React.ReactNode;
}> = [
  {
    status: "delivered",
    label: "Delivered",
    description: "alerts that reached at least one channel",
    toneOk: "bg-emerald-50 text-emerald-900 border-emerald-200 hover:border-emerald-400",
    icon: <CheckCircle2 className="h-4 w-4 text-emerald-700" />,
  },
  {
    status: "failed",
    label: "Failed delivery",
    description: "every channel attempt failed",
    toneOk: "bg-slate-50 text-slate-700 border-slate-200 hover:border-slate-400",
    icon: <AlertTriangle className="h-4 w-4 text-red-700" />,
  },
  {
    status: "suppressed_duplicate",
    label: "Coalesced",
    description: "absorbed by an in-window dedupe key",
    toneOk: "bg-slate-50 text-slate-700 border-slate-200 hover:border-slate-400",
    icon: <Layers className="h-4 w-4 text-slate-600" />,
  },
];

function AlertDeliveryHealthCard({
  isLoading,
  deliveryHealth,
}: {
  isLoading: boolean;
  deliveryHealth: {
    lastHour: Record<DeliveryStatus, number>;
    last24h: Record<DeliveryStatus, number>;
  } | null;
}) {
  // Backward-compat: an older server build that hasn't shipped the
  // deliveryHealth payload returns no `deliveryHealth` field. In that
  // case we hide the card entirely (rather than showing a permanent
  // skeleton) so the dashboard doesn't carry a half-broken tile.
  if (!isLoading && deliveryHealth === null) {
    return null;
  }
  const failedLastHour = deliveryHealth?.lastHour.failed ?? 0;
  const totalLastHour =
    (deliveryHealth?.lastHour.delivered ?? 0) +
    (deliveryHealth?.lastHour.failed ?? 0) +
    (deliveryHealth?.lastHour.suppressed_duplicate ?? 0);
  const totalLast24h =
    (deliveryHealth?.last24h.delivered ?? 0) +
    (deliveryHealth?.last24h.failed ?? 0) +
    (deliveryHealth?.last24h.suppressed_duplicate ?? 0);

  return (
    <Card data-testid="card-alert-delivery-health">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4 text-violet-600" />
          Alert delivery health
        </CardTitle>
        <Link href="/admin/operator-alerts?window=1h">
          <a
            className="text-xs text-violet-700 hover:underline"
            data-testid="link-delivery-health-last-hour"
          >
            Open last hour →
          </a>
        </Link>
      </CardHeader>
      <CardContent>
        {isLoading || deliveryHealth === null ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="space-y-3">
            {failedLastHour > 0 && (
              <Link href="/admin/operator-alerts?deliveryStatus=failed&window=1h">
                <a
                  className="block rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 hover:bg-red-100"
                  data-testid="banner-delivery-failures"
                >
                  <div className="flex items-center gap-2 font-medium">
                    <AlertTriangle className="h-4 w-4" />
                    {failedLastHour === 1
                      ? "1 alert failed delivery in the last hour"
                      : `${failedLastHour} alerts failed delivery in the last hour`}
                  </div>
                  <div className="text-xs mt-0.5 opacity-80">
                    Click to open the failed rows — likely a webhook or
                    transport issue.
                  </div>
                </a>
              </Link>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {DELIVERY_TILES.map(({ status, label, description, toneOk, icon }) => {
                const lastHour = deliveryHealth.lastHour[status] ?? 0;
                const last24h = deliveryHealth.last24h[status] ?? 0;
                // Only the "failed" tile escalates to red, and only when
                // its last-hour count is non-zero. Everything else stays
                // neutral — a high "delivered" count is good news, not a
                // warning.
                const tone =
                  status === "failed" && lastHour > 0
                    ? "bg-red-50 text-red-900 border-red-300 hover:border-red-500"
                    : toneOk;
                return (
                  <Link
                    key={status}
                    href={`/admin/operator-alerts?deliveryStatus=${status}&window=24h`}
                  >
                    <a
                      className={`block border rounded-md p-3 transition-colors cursor-pointer ${tone}`}
                      data-testid={`tile-delivery-${status}`}
                    >
                      <div className="flex items-center gap-2 text-xs uppercase tracking-wide font-medium">
                        {icon}
                        {label}
                      </div>
                      <div className="mt-1 flex items-baseline gap-2">
                        <span
                          className="text-2xl font-semibold"
                          data-testid={`text-delivery-${status}-1h`}
                        >
                          {lastHour}
                        </span>
                        <span className="text-xs opacity-70">last hour</span>
                      </div>
                      <div
                        className="text-xs mt-1 opacity-80"
                        data-testid={`text-delivery-${status}-24h`}
                      >
                        {last24h} in last 24h
                      </div>
                      <div className="text-xs mt-1 opacity-60">{description}</div>
                    </a>
                  </Link>
                );
              })}
            </div>

            <p className="text-xs text-slate-400" data-testid="text-delivery-health-totals">
              {totalLastHour} alert{totalLastHour === 1 ? "" : "s"} dispatched
              in the last hour · {totalLast24h} in the last 24h. Click any
              tile to open the alerts page filtered to that delivery status.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
