import { useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ListChecks,
  ClipboardCheck,
  AlertTriangle,
  Check,
  Clock,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface AdviserTask {
  id: number;
  clientUserId: number;
  taskType: string;
  title: string;
  notes: string | null;
  status: string;
  priority: string;
  dueAt: string | null;
  createdAt: string | null;
}

interface InstructionRow {
  id: number;
  clientUserId: number;
  productId: number;
  action: string;
  amount: string;
  status: string;
  createdAt: string | null;
  clientFirstName: string;
  clientLastName: string;
  productName: string;
}

interface DashboardSummary {
  linkedClients: number;
  openTasks: number;
  feeConsentsExpiringSoon: number;
  pendingReports: number;
}

function priorityScore(priority: string): number {
  switch (priority) {
    case "urgent":
      return 3;
    case "high":
      return 2;
    case "low":
      return 0;
    default:
      return 1;
  }
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString("en-AU", { month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

function formatAud(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 0,
  }).format(n);
}

export default function AdviserWorkflow() {
  const { toast } = useToast();

  const tasks = useQuery<AdviserTask[]>({ queryKey: ["/api/adviser/tasks"] });
  const instructions = useQuery<InstructionRow[]>({ queryKey: ["/api/adviser/instructions"] });
  const summary = useQuery<DashboardSummary>({ queryKey: ["/api/adviser/dashboard"] });

  const completeTask = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("PATCH", `/api/adviser/tasks/${id}`, { status: "done" });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/adviser/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/adviser/dashboard"] });
      toast({ title: "Task marked done" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    },
  });

  const openTasks = useMemo(
    () =>
      (tasks.data ?? [])
        .filter((t) => t.status === "open" || t.status === "in_progress")
        .sort((a, b) => {
          const p = priorityScore(b.priority) - priorityScore(a.priority);
          if (p !== 0) return p;
          // Older tasks first if same priority
          const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return at - bt;
        }),
    [tasks.data],
  );

  const pendingInstructions = useMemo(
    () => (instructions.data ?? []).filter((i) => i.status === "pending_consent"),
    [instructions.data],
  );

  const urgentCount = openTasks.filter((t) => t.priority === "urgent" || t.priority === "high").length;

  return (
    <div className="p-6 space-y-6" data-testid="page-adviser-workflow">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <ListChecks className="h-6 w-6 text-slate-500" />
          Workflow
        </h1>
        <p className="text-sm text-slate-500 mt-1 max-w-2xl">
          Your live priority queue. Open tasks, instructions awaiting client consent, and the items
          that need attention this week — in one place.
        </p>
      </div>

      {/* Priority strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-slate-200 bg-white">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium text-slate-600">Open tasks</CardTitle>
            <ListChecks className="h-4 w-4 text-slate-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900" data-testid="metric-open-tasks">
              {tasks.isLoading ? <Skeleton className="h-7 w-10" /> : openTasks.length}
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              {urgentCount} urgent / high
            </p>
          </CardContent>
        </Card>
        <Card className="border-sky-200 bg-sky-50/40">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium text-slate-600">Awaiting client consent</CardTitle>
            <ClipboardCheck className="h-4 w-4 text-sky-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900" data-testid="metric-pending-consent">
              {instructions.isLoading ? <Skeleton className="h-7 w-10" /> : pendingInstructions.length}
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              No funds move until the client approves
            </p>
          </CardContent>
        </Card>
        <Card className="border-rose-200 bg-rose-50/40">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium text-slate-600">Fee consents expiring ≤30d</CardTitle>
            <AlertTriangle className="h-4 w-4 text-rose-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900" data-testid="metric-fee-expiring">
              {summary.isLoading ? <Skeleton className="h-7 w-10" /> : summary.data?.feeConsentsExpiringSoon ?? 0}
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              Renew before lapse to keep deductions valid
            </p>
          </CardContent>
        </Card>
        <Card className="border-violet-200 bg-violet-50/40">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium text-slate-600">Pending reports</CardTitle>
            <Clock className="h-4 w-4 text-violet-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900" data-testid="metric-pending-reports">
              {summary.isLoading ? <Skeleton className="h-7 w-10" /> : summary.data?.pendingReports ?? 0}
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              <Link href="/adviser/reports">
                <a className="text-violet-600 hover:underline">Open reports</a>
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Pending instructions */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-sky-500" />
            Instructions awaiting client consent
          </CardTitle>
          <Link href="/adviser/instructions">
            <Button variant="outline" size="sm" data-testid="button-view-all-instructions">
              View all
            </Button>
          </Link>
        </CardHeader>
        <CardContent>
          {instructions.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : pendingInstructions.length === 0 ? (
            <p className="text-sm text-slate-500" data-testid="text-no-pending-consent">
              No instructions are currently waiting for client consent.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sent</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingInstructions.slice(0, 8).map((i) => (
                  <TableRow key={i.id} data-testid={`row-pending-instruction-${i.id}`}>
                    <TableCell className="text-sm">{formatDate(i.createdAt)}</TableCell>
                    <TableCell className="text-sm font-medium">
                      {i.clientFirstName} {i.clientLastName}
                    </TableCell>
                    <TableCell className="text-sm capitalize">{i.action}</TableCell>
                    <TableCell className="text-sm">{i.productName}</TableCell>
                    <TableCell className="text-sm tabular-nums text-right">
                      {formatAud(i.amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Open tasks */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-slate-500" />
            Open tasks (priority order)
          </CardTitle>
          <Link href="/adviser/tasks">
            <Button variant="outline" size="sm" data-testid="button-view-all-tasks">
              View all
            </Button>
          </Link>
        </CardHeader>
        <CardContent>
          {tasks.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : openTasks.length === 0 ? (
            <p className="text-sm text-slate-500" data-testid="text-no-open-tasks">
              No open tasks. You're clear.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Priority</TableHead>
                  <TableHead>Task</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {openTasks.slice(0, 10).map((t) => {
                  const colour =
                    t.priority === "urgent"
                      ? "bg-rose-100 text-rose-800"
                      : t.priority === "high"
                        ? "bg-slate-200 text-slate-800"
                        : t.priority === "low"
                          ? "bg-slate-100 text-slate-700"
                          : "bg-sky-100 text-sky-800";
                  return (
                    <TableRow key={t.id} data-testid={`row-task-${t.id}`}>
                      <TableCell>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colour}`}>
                          {t.priority}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm">
                        <div className="font-medium text-slate-900">{t.title}</div>
                        {t.notes && (
                          <div className="text-xs text-slate-500 truncate max-w-md">{t.notes}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm capitalize text-slate-600">
                        {t.taskType.replace(/_/g, " ")}
                      </TableCell>
                      <TableCell className="text-sm text-slate-600">{formatDate(t.dueAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => completeTask.mutate(t.id)}
                          disabled={completeTask.isPending && completeTask.variables === t.id}
                          data-testid={`button-complete-task-${t.id}`}
                        >
                          <Check className="h-4 w-4 mr-1" />
                          Done
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
