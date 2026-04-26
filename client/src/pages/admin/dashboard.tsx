import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ClipboardList, Users, Link2, ScrollText } from "lucide-react";
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

function fmt(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return "—";
  }
}

export default function AdminDashboard() {
  const { data, isLoading } = useQuery<DashboardData>({ queryKey: ["/api/admin/dashboard"] });

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

function PipelineCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-slate-200 rounded-md p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-xl font-semibold text-slate-900">{value}</div>
    </div>
  );
}
