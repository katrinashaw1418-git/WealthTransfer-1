import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Users,
  ClipboardList,
  AlertTriangle,
  FileText,
  ClipboardCheck,
  TrendingUp,
  ArrowRight,
} from "lucide-react";

interface DashboardSummary {
  linkedClients: number;
  openTasks: number;
  feeConsentsExpiringSoon: number;
  pendingReports: number;
}

interface AdviserClientRow {
  userId: number;
  email: string;
  firstName: string;
  lastName: string;
  kycStatus: string;
  userTier: string;
  activeFeeConsents: number;
  portfolioValueAud: string;
}

interface AdviserTask {
  id: number;
  title: string;
  taskType: string;
  status: string;
  priority: string;
  dueAt: string | null;
  createdAt: string | null;
}

interface InstructionRow {
  id: number;
  status: string;
  action: string;
  amount: string;
  productName: string;
  clientFirstName: string;
  clientLastName: string;
  createdAt: string | null;
}

interface MetricCardProps {
  label: string;
  value: number | undefined;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  accent: string;
  isLoading: boolean;
  testId: string;
}

function MetricCard({ label, value, icon: Icon, href, accent, isLoading, testId }: MetricCardProps) {
  return (
    <Link href={href}>
      <Card className="cursor-pointer hover:shadow-md transition-shadow" data-testid={testId}>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-slate-600">{label}</CardTitle>
          <Icon className={`h-5 w-5 ${accent}`} />
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-8 w-12" />
          ) : (
            <div className="text-3xl font-bold text-slate-900">{value ?? 0}</div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

function priorityScore(p: string): number {
  return p === "urgent" ? 3 : p === "high" ? 2 : p === "low" ? 0 : 1;
}

function priorityChip(priority: string) {
  const colour =
    priority === "urgent"
      ? "bg-rose-100 text-rose-800"
      : priority === "high"
        ? "bg-slate-200 text-slate-800"
        : priority === "low"
          ? "bg-slate-100 text-slate-700"
          : "bg-sky-100 text-sky-800";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${colour}`}>
      {priority}
    </span>
  );
}

function safeNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function formatAud(value: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString("en-AU", { month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

export default function AdviserDashboard() {
  const summary = useQuery<DashboardSummary>({ queryKey: ["/api/adviser/dashboard"] });
  const clients = useQuery<AdviserClientRow[]>({ queryKey: ["/api/adviser/clients"] });
  const tasks = useQuery<AdviserTask[]>({ queryKey: ["/api/adviser/tasks"] });
  const instructions = useQuery<InstructionRow[]>({ queryKey: ["/api/adviser/instructions"] });

  const priorityTasks = useMemo(
    () =>
      (tasks.data ?? [])
        .filter((t) => t.status === "open" || t.status === "in_progress")
        .sort((a, b) => priorityScore(b.priority) - priorityScore(a.priority))
        .slice(0, 5),
    [tasks.data],
  );

  const pendingInstructions = useMemo(
    () => (instructions.data ?? []).filter((i) => i.status === "pending_consent").slice(0, 5),
    [instructions.data],
  );

  const topClients = useMemo(
    () =>
      [...(clients.data ?? [])]
        .sort((a, b) => safeNum(b.portfolioValueAud) - safeNum(a.portfolioValueAud))
        .slice(0, 5),
    [clients.data],
  );

  const totalAum = useMemo(
    () => (clients.data ?? []).reduce((sum, r) => sum + safeNum(r.portfolioValueAud), 0),
    [clients.data],
  );

  return (
    <div className="p-6 space-y-6" data-testid="page-adviser-dashboard">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Adviser Dashboard</h1>
        <p className="text-sm text-slate-500 mt-1">
          Read-only access to your linked AMAX Wealth clients. Money movement and execution remain
          with the client and the platform.
        </p>
      </div>

      {/* Headline metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Linked clients"
          value={summary.data?.linkedClients}
          icon={Users}
          href="/adviser/clients"
          accent="text-sky-500"
          isLoading={summary.isLoading}
          testId="card-linked-clients"
        />
        <MetricCard
          label="Open tasks"
          value={summary.data?.openTasks}
          icon={ClipboardList}
          href="/adviser/workflow"
          accent="text-emerald-500"
          isLoading={summary.isLoading}
          testId="card-open-tasks"
        />
        <MetricCard
          label="Fee consents expiring ≤30d"
          value={summary.data?.feeConsentsExpiringSoon}
          icon={AlertTriangle}
          href="/adviser/clients"
          accent="text-slate-500"
          isLoading={summary.isLoading}
          testId="card-fee-expiring"
        />
        <MetricCard
          label="Pending report requests"
          value={summary.data?.pendingReports}
          icon={FileText}
          href="/adviser/reports"
          accent="text-violet-500"
          isLoading={summary.isLoading}
          testId="card-pending-reports"
        />
      </div>

      {/* Workflow priority + Client book snapshot */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Workflow priority */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-slate-500" />
              Workflow priority
            </CardTitle>
            <Link href="/adviser/workflow">
              <Button variant="ghost" size="sm" data-testid="link-workflow">
                Open workflow <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Pending consents */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <ClipboardCheck className="h-3.5 w-3.5 text-sky-500" />
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Client consent required
                </p>
                <Badge variant="secondary" className="ml-auto">
                  {pendingInstructions.length}
                </Badge>
              </div>
              {instructions.isLoading ? (
                <Skeleton className="h-12 w-full" />
              ) : pendingInstructions.length === 0 ? (
                <p className="text-xs text-slate-500 pl-5">No instructions waiting.</p>
              ) : (
                <ul className="space-y-1.5 pl-5">
                  {pendingInstructions.map((i) => (
                    <li
                      key={i.id}
                      className="text-sm text-slate-700 flex items-center justify-between gap-3"
                      data-testid={`dash-pending-${i.id}`}
                    >
                      <span className="truncate">
                        <span className="capitalize font-medium">{i.action}</span>{" "}
                        {formatAud(safeNum(i.amount))}{" "}
                        <span className="text-slate-500">in</span> {i.productName}
                      </span>
                      <span className="text-xs text-slate-400 whitespace-nowrap">
                        {i.clientFirstName} {i.clientLastName}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Priority tasks */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <ClipboardList className="h-3.5 w-3.5 text-slate-500" />
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Top open tasks
                </p>
                <Badge variant="secondary" className="ml-auto">
                  {priorityTasks.length}
                </Badge>
              </div>
              {tasks.isLoading ? (
                <Skeleton className="h-12 w-full" />
              ) : priorityTasks.length === 0 ? (
                <p className="text-xs text-slate-500 pl-5">No open tasks. You're clear.</p>
              ) : (
                <ul className="space-y-1.5 pl-5">
                  {priorityTasks.map((t) => (
                    <li
                      key={t.id}
                      className="text-sm text-slate-700 flex items-center justify-between gap-3"
                      data-testid={`dash-task-${t.id}`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        {priorityChip(t.priority)}
                        <span className="truncate">{t.title}</span>
                      </span>
                      <span className="text-xs text-slate-400 whitespace-nowrap">
                        Due {formatDate(t.dueAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Client book snapshot */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-emerald-500" />
              Client book
            </CardTitle>
            <Link href="/adviser/business">
              <Button variant="ghost" size="sm" data-testid="link-business">
                Snapshot <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Assets under advice</p>
              {clients.isLoading ? (
                <Skeleton className="h-7 w-32 mt-1" />
              ) : (
                <p className="text-2xl font-bold text-slate-900 tabular-nums" data-testid="aum-total">
                  {formatAud(totalAum)}
                </p>
              )}
            </div>
            <div className="border-t border-slate-100 pt-3">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">
                Top portfolios
              </p>
              {clients.isLoading ? (
                <Skeleton className="h-20 w-full" />
              ) : topClients.length === 0 ? (
                <p className="text-xs text-slate-500">No linked clients yet.</p>
              ) : (
                <ul className="space-y-2">
                  {topClients.map((c) => (
                    <li
                      key={c.userId}
                      className="flex items-center justify-between gap-2"
                      data-testid={`dash-top-client-${c.userId}`}
                    >
                      <Link href={`/adviser/clients/${c.userId}`}>
                        <a className="text-sm font-medium text-slate-900 hover:text-sky-600 truncate">
                          {c.firstName} {c.lastName}
                        </a>
                      </Link>
                      <span className="text-sm text-slate-700 tabular-nums">
                        {formatAud(safeNum(c.portfolioValueAud))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Scope reminder */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scope of adviser access</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-slate-600 space-y-2">
          <p>
            <strong>You can:</strong> view linked client KYC status, portfolio totals, fee consents,
            and recent advice records; create internal tasks, request statement reports, and send
            investment instructions for client consent.
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
