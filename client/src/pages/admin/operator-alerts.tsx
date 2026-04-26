import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Siren, ChevronLeft, ChevronRight, X } from "lucide-react";

type Severity = "info" | "warning" | "alert" | "critical";

interface ChannelOutcome {
  channel: string;
  status: string;
  httpStatus?: number;
  error?: string;
  durationMs?: number;
}

interface OperatorAlertRow {
  id: number;
  source: string;
  severity: string;
  title: string;
  details: any;
  channelsAttempted: string[] | null;
  channelOutcomes: ChannelOutcome[] | null;
  createdAt: string | null;
}

interface OperatorAlertsPage {
  items: OperatorAlertRow[];
  page: number;
  limit: number;
  total: number;
}

const TOKEN_KEY = "amax_jwt";
const SEVERITY_ANY = "__any__";

const SEVERITY_BADGE: Record<string, string> = {
  info: "bg-slate-100 text-slate-700 border-slate-300",
  warning: "bg-amber-100 text-amber-800 border-amber-300",
  alert: "bg-orange-100 text-orange-800 border-orange-300",
  critical: "bg-red-100 text-red-800 border-red-300",
};

const OUTCOME_BADGE: Record<string, string> = {
  success: "bg-emerald-100 text-emerald-800 border-emerald-300",
  http_error: "bg-red-100 text-red-800 border-red-300",
  timeout: "bg-amber-100 text-amber-800 border-amber-300",
  error: "bg-red-100 text-red-800 border-red-300",
};

function fmt(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return "—";
  }
}

export default function AdminOperatorAlerts() {
  const [sourceInput, setSourceInput] = useState("");
  const [severityInput, setSeverityInput] = useState<string>(SEVERITY_ANY);
  const [appliedSource, setAppliedSource] = useState("");
  const [appliedSeverity, setAppliedSeverity] = useState<string>(SEVERITY_ANY);
  const [page, setPage] = useState(1);
  const limit = 50;

  const queryKey = [
    "/api/admin/operator-alerts",
    { source: appliedSource, severity: appliedSeverity, page },
  ];

  const { data, isLoading } = useQuery<OperatorAlertsPage>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (appliedSource.trim()) params.set("source", appliedSource.trim());
      if (appliedSeverity !== SEVERITY_ANY) params.set("severity", appliedSeverity);
      params.set("page", String(page));
      params.set("limit", String(limit));
      const token = (() => {
        try {
          return localStorage.getItem(TOKEN_KEY);
        } catch {
          return null;
        }
      })();
      const res = await fetch(`/api/admin/operator-alerts?${params.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / limit)) : 1;

  function clearFilters() {
    setSourceInput("");
    setSeverityInput(SEVERITY_ANY);
    setAppliedSource("");
    setAppliedSeverity(SEVERITY_ANY);
    setPage(1);
  }

  function applyFilters() {
    setAppliedSource(sourceInput);
    setAppliedSeverity(severityInput);
    setPage(1);
  }

  return (
    <div className="space-y-4 max-w-7xl">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Operator alerts</h1>
        <p className="text-sm text-slate-500 mt-1">
          History of alerts dispatched by background jobs and reconciliation tasks. Read-only.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Siren className="h-4 w-4 text-violet-600" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <Input
              placeholder="Source (exact, e.g. wallet-ledger-reconciliation)"
              value={sourceInput}
              onChange={(e) => setSourceInput(e.target.value)}
              data-testid="input-filter-source"
            />
            <Select value={severityInput} onValueChange={setSeverityInput}>
              <SelectTrigger data-testid="select-filter-severity">
                <SelectValue placeholder="Severity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SEVERITY_ANY}>Any severity</SelectItem>
                <SelectItem value="info">info</SelectItem>
                <SelectItem value="warning">warning</SelectItem>
                <SelectItem value="alert">alert</SelectItem>
                <SelectItem value="critical">critical</SelectItem>
              </SelectContent>
            </Select>
            <div />
            <div className="flex gap-2">
              <Button onClick={applyFilters} className="flex-1" data-testid="button-apply-filters">
                Apply
              </Button>
              <Button variant="outline" onClick={clearFilters} data-testid="button-clear-filters">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">
            {isLoading ? "Loading…" : `${data?.total ?? 0} alerts`}
          </CardTitle>
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || isLoading}
              data-testid="button-prev-page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span data-testid="text-pagination">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || isLoading}
              data-testid="button-next-page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : !data || data.items.length === 0 ? (
            <p className="text-sm text-slate-500">No operator alerts match these filters.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Channels</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((row) => {
                  const sevClass =
                    SEVERITY_BADGE[row.severity] ??
                    "bg-slate-100 text-slate-700 border-slate-300";
                  const attempted = row.channelsAttempted ?? [];
                  const outcomes = row.channelOutcomes ?? [];
                  const outcomeByChannel = new Map<string, ChannelOutcome>();
                  for (const o of outcomes) {
                    if (o && typeof o.channel === "string") {
                      outcomeByChannel.set(o.channel, o);
                    }
                  }
                  return (
                    <TableRow key={row.id} data-testid={`row-operator-alert-${row.id}`}>
                      <TableCell className="text-xs text-slate-600 whitespace-nowrap align-top">
                        {fmt(row.createdAt)}
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge
                          variant="outline"
                          className={`font-mono text-xs ${sevClass}`}
                          data-testid={`badge-severity-${row.id}`}
                        >
                          {row.severity}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs font-mono text-slate-700 align-top">
                        {row.source}
                      </TableCell>
                      <TableCell className="text-sm text-slate-900 align-top max-w-md">
                        {row.title}
                      </TableCell>
                      <TableCell className="align-top">
                        {attempted.length === 0 ? (
                          <span className="text-xs text-slate-500">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {attempted.map((channel) => {
                              const outcome = outcomeByChannel.get(channel);
                              const status = outcome?.status ?? "unknown";
                              const cls =
                                OUTCOME_BADGE[status] ??
                                "bg-slate-100 text-slate-700 border-slate-300";
                              const tooltipParts: string[] = [];
                              if (outcome?.httpStatus !== undefined) {
                                tooltipParts.push(`HTTP ${outcome.httpStatus}`);
                              }
                              if (outcome?.durationMs !== undefined) {
                                tooltipParts.push(`${outcome.durationMs}ms`);
                              }
                              if (outcome?.error) {
                                tooltipParts.push(outcome.error);
                              }
                              return (
                                <Badge
                                  key={channel}
                                  variant="outline"
                                  className={`text-[11px] ${cls}`}
                                  title={tooltipParts.join(" · ") || undefined}
                                  data-testid={`badge-channel-${row.id}-${channel}`}
                                >
                                  <span className="font-mono">{channel}</span>
                                  <span className="mx-1 text-slate-400">·</span>
                                  <span>{status}</span>
                                </Badge>
                              );
                            })}
                          </div>
                        )}
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
