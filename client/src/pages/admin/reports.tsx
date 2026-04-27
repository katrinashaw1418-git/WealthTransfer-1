import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileText, RotateCcw, AlertCircle, Layers, PlayCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface AdminReport {
  id: number;
  adviserUserId: number;
  clientUserId: number;
  reportType: string;
  format: string;
  status: string;
  notes: string | null;
  downloadUrl: string | null;
  failureReason: string | null;
  requestedAt: string | null;
  generatedAt: string | null;
  expiresAt: string | null;
  versionNumber: number | null;
  supersedesReportId: number | null;
  downloadLinkExpiresAt: string | null;
  adviserUsername: string;
  clientUsername: string;
  clientEmail: string;
}

interface ReportListResp {
  items: AdminReport[];
  page: number;
  limit: number;
  total: number;
  counts: Record<string, number>;
}

const STATUSES = ["requested", "generating", "ready", "failed", "expired_link", "expired"] as const;
const TYPES = [
  "portfolio_summary",
  "fee_summary",
  "transaction_history",
  "full_statement",
] as const;

function fmt(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return "—";
  }
}

function statusVariant(s: string): "default" | "secondary" | "outline" | "destructive" {
  if (s === "ready") return "default";
  if (s === "failed" || s === "expired" || s === "expired_link") return "destructive";
  if (s === "generating") return "secondary";
  return "outline";
}

const COUNT_BUCKETS: Array<{ key: string; label: string; chipClass: string }> = [
  { key: "requested", label: "Pending", chipClass: "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100" },
  { key: "generating", label: "Generating", chipClass: "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100" },
  { key: "ready", label: "Ready", chipClass: "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100" },
  { key: "failed", label: "Failed", chipClass: "bg-red-50 text-red-700 border-red-200 hover:bg-red-100" },
  { key: "expired_link", label: "Link expired", chipClass: "bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200" },
  { key: "expired", label: "Expired", chipClass: "bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200" },
];

const PAGE_SIZE = 50;

export default function AdminReports() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [page, setPage] = useState(1);

  function changeStatus(s: string) {
    setStatusFilter(s);
    setPage(1);
  }
  function changeType(t: string) {
    setTypeFilter(t);
    setPage(1);
  }

  const queryKey = ["/api/admin/reports", statusFilter, typeFilter, page];
  const { data, isLoading } = useQuery<ReportListResp>({
    queryKey,
    queryFn: async () => {
      const qs: string[] = [`page=${page}`, `limit=${PAGE_SIZE}`];
      if (statusFilter && statusFilter !== "all")
        qs.push(`status=${encodeURIComponent(statusFilter)}`);
      if (typeFilter && typeFilter !== "all")
        qs.push(`reportType=${encodeURIComponent(typeFilter)}`);
      const res = await apiRequest("GET", `/api/admin/reports?${qs.join("&")}`);
      return res.json();
    },
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const counts = data?.counts ?? {};
  const totalAcrossAll = useMemo(
    () => Object.values(counts).reduce((s, n) => s + (n || 0), 0),
    [counts],
  );

  // Task #315 — Admin retry. Server-side inserts a fresh versioned row
  // (supersedesReportId = original) and runs the PDF generator inline.
  const retry = useMutation({
    mutationFn: async (reportId: number) => {
      const res = await apiRequest("POST", `/api/admin/reports/${reportId}/retry`, {});
      return res.json();
    },
    onSuccess: (data: AdminReport) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/reports"] });
      toast({
        title: data?.status === "ready" ? "Retry completed" : "Retry submitted",
        description:
          data?.status === "ready"
            ? `Version ${data.versionNumber ?? "?"} generated for the original adviser.`
            : data?.failureReason ?? "Submitted; refresh to see status.",
        variant: data?.status === "failed" ? "destructive" : "default",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Retry failed", description: err.message, variant: "destructive" });
    },
  });

  // Task #315 — Manual sweeper trigger. Returns scanned/flipped counts so
  // an operator clearing a backlog gets immediate feedback.
  const runSweeper = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/reports/sweeper/run-once", {});
      return res.json();
    },
    onSuccess: (s: { scanned: number; flipped: number; flippedIds: number[] }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/reports"] });
      toast({
        title: "Sweeper run complete",
        description:
          s.flipped > 0
            ? `Flipped ${s.flipped} stuck row(s) to failed: ${s.flippedIds.join(", ")}`
            : `No stuck rows (scanned ${s.scanned}).`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Sweeper run failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-4 max-w-7xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Report Requests</h1>
          <p className="text-sm text-slate-500 mt-1">
            Adviser-initiated report requests across the platform. The per-minute job sweeper
            flips rows stuck for &gt;10 minutes to <code>failed</code> so they can be retried.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => runSweeper.mutate()}
            disabled={runSweeper.isPending}
            data-testid="button-run-sweeper"
          >
            <PlayCircle className="h-4 w-4 mr-1.5" />
            {runSweeper.isPending ? "Running…" : "Run sweeper now"}
          </Button>
          <Select value={statusFilter} onValueChange={changeStatus}>
            <SelectTrigger className="w-44" data-testid="select-report-status-filter">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={changeType}>
            <SelectTrigger className="w-52" data-testid="select-report-type-filter">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Status counts strip — counts are GLOBAL, click filters the page-scoped list. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="strip-status-counts">
        <button
          type="button"
          onClick={() => changeStatus("all")}
          className={`text-xs font-medium px-3 py-1.5 rounded-full border transition ${
            statusFilter === "all"
              ? "bg-slate-900 text-white border-slate-900"
              : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
          }`}
          data-testid="chip-count-all"
        >
          All ({totalAcrossAll})
        </button>
        {COUNT_BUCKETS.map((b) => {
          const n = counts[b.key] ?? 0;
          const active = statusFilter === b.key;
          return (
            <button
              key={b.key}
              type="button"
              onClick={() => changeStatus(active ? "all" : b.key)}
              className={`text-xs font-medium px-3 py-1.5 rounded-full border transition ${
                active ? "ring-2 ring-offset-1 ring-slate-400 " : ""
              }${b.chipClass}`}
              data-testid={`chip-count-${b.key}`}
            >
              {b.label}: {n}
            </button>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4 text-violet-600" />
            {isLoading
              ? "Loading…"
              : `${data?.total ?? 0} report request${data?.total === 1 ? "" : "s"}`}
            {statusFilter !== "all" && (
              <span className="text-xs font-normal text-slate-500">
                · filtered by <span className="font-mono">{statusFilter}</span>
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !data || data.items.length === 0 ? (
            <p className="text-sm text-slate-500">No report requests match these filters.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Requested</TableHead>
                  <TableHead>Adviser</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Generated</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((r) => {
                  const isFailed = r.status === "failed";
                  const isExpiredLink = r.status === "expired_link";
                  const showRetry = isFailed || isExpiredLink || r.status === "expired";
                  const versionNum = r.versionNumber ?? 1;
                  return (
                    <TableRow
                      key={r.id}
                      data-testid={`row-report-${r.id}`}
                      className={
                        isFailed
                          ? "border-l-4 border-l-red-500 bg-red-50/40"
                          : isExpiredLink
                            ? "border-l-4 border-l-slate-400 bg-slate-50/40"
                            : ""
                      }
                    >
                      <TableCell className="text-sm">{fmt(r.requestedAt)}</TableCell>
                      <TableCell className="text-sm">{r.adviserUsername}</TableCell>
                      <TableCell className="text-sm">
                        <div>{r.clientUsername}</div>
                        <div className="text-xs text-slate-500">{r.clientEmail}</div>
                      </TableCell>
                      <TableCell className="text-sm capitalize">
                        {r.reportType.replace(/_/g, " ")}
                      </TableCell>
                      <TableCell>
                        {r.supersedesReportId ? (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  className="inline-flex items-center text-xs gap-1 text-violet-700 bg-violet-50 border border-violet-200 px-2 py-0.5 rounded cursor-help"
                                  data-testid={`chip-version-${r.id}`}
                                >
                                  <Layers className="h-3 w-3" />v{versionNum}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="text-xs">Supersedes report #{r.supersedesReportId}</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : (
                          <span className="text-xs text-slate-500" data-testid={`chip-version-${r.id}`}>v{versionNum}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Badge variant={statusVariant(r.status)} className="capitalize">
                            {r.status.replace(/_/g, " ")}
                          </Badge>
                          {isFailed && r.failureReason && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span
                                    className="inline-flex items-center text-[10px] uppercase tracking-wide bg-red-100 text-red-700 border border-red-200 px-1.5 py-0.5 rounded cursor-help"
                                    data-testid={`chip-reason-${r.id}`}
                                  >
                                    <AlertCircle className="h-3 w-3 mr-1" />
                                    {r.failureReason === "sweeper_timeout"
                                      ? "timeout"
                                      : r.failureReason.slice(0, 24)}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p className="max-w-xs text-xs">{r.failureReason}</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{fmt(r.generatedAt)}</TableCell>
                      <TableCell>
                        {showRetry ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => retry.mutate(r.id)}
                            disabled={retry.isPending}
                            data-testid={`button-retry-report-${r.id}`}
                          >
                            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                            Retry
                          </Button>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {data && data.total > PAGE_SIZE && (
            <div className="flex items-center justify-between mt-3 text-sm">
              <div className="text-slate-500">
                Page {page} of {totalPages} · {data.total} total
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  data-testid="button-reports-prev"
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  data-testid="button-reports-next"
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
