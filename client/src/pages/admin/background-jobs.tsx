import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Activity,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  RefreshCw,
} from "lucide-react";

const TOKEN_KEY = "amax_jwt";

interface JobRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: "success" | "error";
  summary: string | null;
  errorMessage: string | null;
  durationMs: number | null;
}

interface JobHealth {
  name: string;
  label: string;
  description: string;
  lastRun:
    | (JobRun & { startedAt: string; status: "success" | "error" })
    | null;
  lastSuccessAt: string | null;
  ageMs: number | null;
  neverRan: boolean;
  isOverdue: boolean;
}

interface BackgroundJobsHealthResponse {
  generatedAt: string;
  overdueAfterMs: number;
  jobs: JobHealth[];
}

interface JobRunsResponse {
  items: Array<JobRun & { jobName: string }>;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "—";
  }
}

function formatRelative(ageMs: number | null): string {
  if (ageMs === null) return "never";
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 48) return `${hrs}h ${min % 60}m ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h ago`;
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function StatusBadge({ job }: { job: JobHealth }) {
  if (job.neverRan) {
    return (
      <Badge
        variant="outline"
        className="bg-slate-100 text-slate-700 border-slate-300"
        data-testid={`badge-status-${job.name}`}
      >
        <Clock className="h-3 w-3 mr-1" />
        Never ran
      </Badge>
    );
  }
  if (job.isOverdue) {
    return (
      <Badge
        variant="outline"
        className="bg-red-100 text-red-800 border-red-300"
        data-testid={`badge-status-${job.name}`}
      >
        <AlertTriangle className="h-3 w-3 mr-1" />
        Overdue
      </Badge>
    );
  }
  if (job.lastRun?.status === "error") {
    return (
      <Badge
        variant="outline"
        className="bg-amber-100 text-amber-800 border-amber-300"
        data-testid={`badge-status-${job.name}`}
      >
        <XCircle className="h-3 w-3 mr-1" />
        Last run failed
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="bg-emerald-100 text-emerald-800 border-emerald-300"
      data-testid={`badge-status-${job.name}`}
    >
      <CheckCircle2 className="h-3 w-3 mr-1" />
      Healthy
    </Badge>
  );
}

export default function AdminBackgroundJobs() {
  const [openJob, setOpenJob] = useState<JobHealth | null>(null);

  const { data, isLoading, refetch, isFetching } =
    useQuery<BackgroundJobsHealthResponse>({
      queryKey: ["/api/admin/background-jobs"],
      queryFn: async () => {
        const token = localStorage.getItem(TOKEN_KEY);
        const res = await fetch("/api/admin/background-jobs", {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error("Failed to load background jobs");
        return res.json();
      },
      // Refresh every 60s so an operator parked on the page sees fresh data
      // without having to manually click. Server-side query is one DISTINCT ON
      // — cheap to repeat.
      refetchInterval: 60_000,
    });

  const { data: runsData, isLoading: runsLoading } = useQuery<JobRunsResponse>({
    queryKey: ["/api/admin/background-jobs", openJob?.name, "runs"],
    enabled: openJob !== null,
    queryFn: async () => {
      const token = localStorage.getItem(TOKEN_KEY);
      const res = await fetch(
        `/api/admin/background-jobs/${encodeURIComponent(openJob!.name)}/runs`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) throw new Error("Failed to load run history");
      return res.json();
    },
  });

  const overdueCount = (data?.jobs ?? []).filter((j) => j.isOverdue).length;
  const errorCount = (data?.jobs ?? []).filter(
    (j) => j.lastRun?.status === "error" && !j.isOverdue,
  ).length;
  const overdueHours = data
    ? Math.round(data.overdueAfterMs / (60 * 60 * 1000))
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1
            className="text-2xl font-semibold text-slate-900 flex items-center gap-2"
            data-testid="heading-background-jobs"
          >
            <Activity className="h-6 w-6 text-violet-600" />
            Background jobs
          </h1>
          <p className="text-sm text-slate-600 mt-1 max-w-2xl">
            Health view of every scheduled server job. A job is{" "}
            <span className="font-medium text-red-700">overdue</span> when it
            hasn't started in the last{" "}
            {overdueHours !== null ? `${overdueHours} hours` : "expected window"}{" "}
            (or has never run). Refreshes automatically every minute.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh-jobs"
        >
          <RefreshCw
            className={`h-4 w-4 mr-1 ${isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card data-testid="card-summary-total">
          <CardContent className="pt-6">
            <div className="text-xs uppercase text-slate-500 tracking-wide">
              Tracked jobs
            </div>
            <div className="text-2xl font-semibold text-slate-900 mt-1">
              {data?.jobs.length ?? "—"}
            </div>
          </CardContent>
        </Card>
        <Card
          data-testid="card-summary-overdue"
          className={overdueCount > 0 ? "border-red-300" : ""}
        >
          <CardContent className="pt-6">
            <div className="text-xs uppercase text-slate-500 tracking-wide">
              Overdue
            </div>
            <div
              className={`text-2xl font-semibold mt-1 ${overdueCount > 0 ? "text-red-700" : "text-slate-900"}`}
              data-testid="text-overdue-count"
            >
              {overdueCount}
            </div>
          </CardContent>
        </Card>
        <Card
          data-testid="card-summary-errors"
          className={errorCount > 0 ? "border-amber-300" : ""}
        >
          <CardContent className="pt-6">
            <div className="text-xs uppercase text-slate-500 tracking-wide">
              Last run failed
            </div>
            <div
              className={`text-2xl font-semibold mt-1 ${errorCount > 0 ? "text-amber-700" : "text-slate-900"}`}
              data-testid="text-error-count"
            >
              {errorCount}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Job status</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : !data || data.jobs.length === 0 ? (
            <p className="text-sm text-slate-500" data-testid="text-no-jobs">
              No jobs registered.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead>Last success</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.jobs.map((job) => (
                  <TableRow
                    key={job.name}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => setOpenJob(job)}
                    data-testid={`row-job-${job.name}`}
                  >
                    <TableCell className="align-top">
                      <div
                        className="font-medium text-slate-900"
                        data-testid={`text-job-label-${job.name}`}
                      >
                        {job.label}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {job.description}
                      </div>
                    </TableCell>
                    <TableCell className="align-top whitespace-nowrap">
                      <StatusBadge job={job} />
                    </TableCell>
                    <TableCell
                      className="align-top text-xs text-slate-700 whitespace-nowrap"
                      data-testid={`text-last-run-${job.name}`}
                    >
                      {job.lastRun ? (
                        <div>
                          <div>{formatDateTime(job.lastRun.startedAt)}</div>
                          <div className="text-slate-500">
                            {formatRelative(job.ageMs)}
                          </div>
                        </div>
                      ) : (
                        <span className="text-slate-400">never</span>
                      )}
                    </TableCell>
                    <TableCell
                      className="align-top text-xs text-slate-700 whitespace-nowrap"
                      data-testid={`text-last-success-${job.name}`}
                    >
                      {job.lastSuccessAt ? (
                        formatDateTime(job.lastSuccessAt)
                      ) : (
                        <span className="text-slate-400">never</span>
                      )}
                    </TableCell>
                    <TableCell className="align-top text-xs text-slate-700">
                      {job.lastRun?.errorMessage ? (
                        <span
                          className="text-red-700"
                          data-testid={`text-error-${job.name}`}
                        >
                          {job.lastRun.errorMessage}
                        </span>
                      ) : (
                        <span className="text-slate-700">
                          {job.lastRun?.summary ?? "—"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="align-top text-xs font-mono text-slate-700 text-right whitespace-nowrap">
                      {formatDuration(job.lastRun?.durationMs ?? null)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Sheet
        open={openJob !== null}
        onOpenChange={(open) => {
          if (!open) setOpenJob(null);
        }}
      >
        <SheetContent className="sm:max-w-2xl w-full">
          {openJob && (
            <>
              <SheetHeader>
                <SheetTitle data-testid="text-detail-title">
                  {openJob.label}
                </SheetTitle>
                <SheetDescription>{openJob.description}</SheetDescription>
              </SheetHeader>
              <div className="mt-4">
                <h3 className="text-sm font-medium text-slate-900 mb-2">
                  Recent runs (most recent first)
                </h3>
                <ScrollArea className="h-[70vh] pr-2">
                  {runsLoading ? (
                    <Skeleton className="h-32 w-full" />
                  ) : !runsData || runsData.items.length === 0 ? (
                    <p
                      className="text-sm text-slate-500"
                      data-testid="text-no-runs"
                    >
                      No runs recorded yet.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {runsData.items.map((run) => (
                        <div
                          key={run.id}
                          className="border border-slate-200 rounded-md p-3"
                          data-testid={`row-run-${run.id}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <Badge
                              variant="outline"
                              className={
                                run.status === "success"
                                  ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                                  : "bg-red-100 text-red-800 border-red-300"
                              }
                            >
                              {run.status}
                            </Badge>
                            <span className="text-xs text-slate-500 font-mono">
                              {formatDuration(run.durationMs)}
                            </span>
                          </div>
                          <div className="text-xs text-slate-700 mt-2">
                            <div>
                              <span className="text-slate-500">Started:</span>{" "}
                              {formatDateTime(run.startedAt)}
                            </div>
                            <div>
                              <span className="text-slate-500">Finished:</span>{" "}
                              {formatDateTime(run.finishedAt)}
                            </div>
                          </div>
                          {run.summary && (
                            <div className="text-sm text-slate-700 mt-2 whitespace-pre-wrap break-words">
                              {run.summary}
                            </div>
                          )}
                          {run.errorMessage && (
                            <div className="text-sm text-red-700 mt-2 whitespace-pre-wrap break-words font-mono">
                              {run.errorMessage}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
