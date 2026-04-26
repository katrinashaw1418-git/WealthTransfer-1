import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, ClipboardList, AlertTriangle, FileText } from "lucide-react";
import { Link } from "wouter";

interface DashboardSummary {
  linkedClients: number;
  openTasks: number;
  feeConsentsExpiringSoon: number;
  pendingReports: number;
}

interface MetricCardProps {
  label: string;
  value: number | undefined;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  accent: string; // tailwind text color class
  isLoading: boolean;
  testId: string;
}

function MetricCard({ label, value, icon: Icon, href, accent, isLoading, testId }: MetricCardProps) {
  return (
    <Link href={href}>
      <Card className="cursor-pointer hover:shadow-md transition-shadow" data-testid={testId}>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-gray-600">{label}</CardTitle>
          <Icon className={`h-5 w-5 ${accent}`} />
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-8 w-12" />
          ) : (
            <div className="text-3xl font-bold text-gray-900">{value ?? 0}</div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

export default function AdviserDashboard() {
  const { data, isLoading } = useQuery<DashboardSummary>({
    queryKey: ["/api/adviser/dashboard"],
  });

  return (
    <div className="p-6 space-y-6" data-testid="page-adviser-dashboard">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Adviser Dashboard</h1>
        <p className="text-sm text-gray-500 mt-1">
          Read-only access to your linked AMAX Wealth clients. All execution and money movement
          remains with the client and the platform.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Linked clients"
          value={data?.linkedClients}
          icon={Users}
          href="/adviser/clients"
          accent="text-sky-500"
          isLoading={isLoading}
          testId="card-linked-clients"
        />
        <MetricCard
          label="Open tasks"
          value={data?.openTasks}
          icon={ClipboardList}
          href="/adviser/tasks"
          accent="text-emerald-500"
          isLoading={isLoading}
          testId="card-open-tasks"
        />
        <MetricCard
          label="Fee consents expiring ≤30d"
          value={data?.feeConsentsExpiringSoon}
          icon={AlertTriangle}
          href="/adviser/clients"
          accent="text-amber-500"
          isLoading={isLoading}
          testId="card-fee-expiring"
        />
        <MetricCard
          label="Pending report requests"
          value={data?.pendingReports}
          icon={FileText}
          href="/adviser/reports"
          accent="text-violet-500"
          isLoading={isLoading}
          testId="card-pending-reports"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scope of adviser access</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-gray-600 space-y-2">
          <p>
            <strong>You can:</strong> view linked client KYC status, portfolio totals, fee consents,
            and recent advice records; create internal tasks and request statement reports.
          </p>
          <p>
            <strong>You cannot:</strong> move money, edit balances, change KYC, or execute advice
            actions on a client's behalf. Those operations remain with the client and the AMAX
            Wealth platform.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
