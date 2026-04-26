import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "wouter";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Siren, ChevronLeft, ChevronRight, X, Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

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

function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Allow-list mirrored from the server endpoint so a malformed querystring
// can never push an arbitrary severity value into the filter UI.
function normalizeSeverity(raw: string | null): string {
  if (raw === "info" || raw === "warning" || raw === "alert" || raw === "critical") {
    return raw;
  }
  return SEVERITY_ANY;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea fallback
  }
  if (typeof document === "undefined") return false;
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.left = "-1000px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export default function AdminOperatorAlerts() {
  const { toast } = useToast();
  // Read filters from the querystring once, on first render — the dashboard
  // tile links here with `?severity=critical` (etc.) so admins land on a
  // pre-filtered view. We deliberately don't subscribe to live querystring
  // changes here because the user can also edit filters from the page UI;
  // re-syncing on every URL change would clobber their in-progress edits.
  const initialSearch = useSearch();
  const initialParams = new URLSearchParams(initialSearch);
  const initialSeverity = normalizeSeverity(initialParams.get("severity"));
  const initialSource = (initialParams.get("source") ?? "").slice(0, 128);
  const initialQ = (initialParams.get("q") ?? "").slice(0, 200);

  const [sourceInput, setSourceInput] = useState(initialSource);
  const [severityInput, setSeverityInput] = useState<string>(initialSeverity);
  const [searchInput, setSearchInput] = useState(initialQ);
  const [appliedSource, setAppliedSource] = useState(initialSource);
  const [appliedSeverity, setAppliedSeverity] = useState<string>(initialSeverity);
  const [appliedSearch, setAppliedSearch] = useState(initialQ);
  const [page, setPage] = useState(1);
  const [selectedAlert, setSelectedAlert] = useState<OperatorAlertRow | null>(null);
  const limit = 50;

  const queryKey = [
    "/api/admin/operator-alerts",
    { source: appliedSource, severity: appliedSeverity, q: appliedSearch, page },
  ];

  const { data, isLoading } = useQuery<OperatorAlertsPage>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (appliedSource.trim()) params.set("source", appliedSource.trim());
      if (appliedSeverity !== SEVERITY_ANY) params.set("severity", appliedSeverity);
      if (appliedSearch.trim()) params.set("q", appliedSearch.trim());
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
    setSearchInput("");
    setAppliedSource("");
    setAppliedSeverity(SEVERITY_ANY);
    setAppliedSearch("");
    setPage(1);
  }

  function applyFilters() {
    setAppliedSource(sourceInput);
    setAppliedSeverity(severityInput);
    setAppliedSearch(searchInput);
    setPage(1);
  }

  const selectedSevClass = selectedAlert
    ? SEVERITY_BADGE[selectedAlert.severity] ??
      "bg-slate-100 text-slate-700 border-slate-300"
    : "";
  const selectedOutcomes = selectedAlert?.channelOutcomes ?? [];
  const selectedAttempted = selectedAlert?.channelsAttempted ?? [];

  async function handleCopy(text: string, label: string) {
    const ok = await copyToClipboard(text);
    if (ok) {
      toast({
        title: `${label} copied`,
        description: "The text is now on your clipboard.",
        duration: 2500,
      });
    } else {
      toast({
        title: `Couldn't copy ${label.toLowerCase()}`,
        description: "Your browser blocked clipboard access. Try selecting and copying manually.",
        variant: "destructive",
        duration: 4000,
      });
    }
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
            <Input
              placeholder="Search title or payload (e.g. user id, job name)"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyFilters();
              }}
              maxLength={200}
              data-testid="input-filter-search"
            />
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
                    <TableRow
                      key={row.id}
                      data-testid={`row-operator-alert-${row.id}`}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => setSelectedAlert(row)}
                    >
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

      <Sheet
        open={selectedAlert !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedAlert(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-full sm:max-w-2xl sm:w-[36rem] flex flex-col p-0"
          data-testid="sheet-alert-detail"
        >
          {selectedAlert && (
            <>
              <SheetHeader className="px-6 pt-6 pb-4 border-b">
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className={`font-mono text-xs ${selectedSevClass}`}
                    data-testid="badge-detail-severity"
                  >
                    {selectedAlert.severity}
                  </Badge>
                  <span
                    className="text-xs font-mono text-slate-600"
                    data-testid="text-detail-source"
                  >
                    {selectedAlert.source}
                  </span>
                </div>
                <SheetTitle
                  className="text-left text-base"
                  data-testid="text-detail-title"
                >
                  {selectedAlert.title}
                </SheetTitle>
                <SheetDescription
                  className="text-left text-xs"
                  data-testid="text-detail-when"
                >
                  Alert #{selectedAlert.id} · {fmt(selectedAlert.createdAt)}
                </SheetDescription>
              </SheetHeader>

              <ScrollArea className="flex-1">
                <div className="px-6 py-4 space-y-6">
                  <section>
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-semibold text-slate-900">
                        Details
                      </h3>
                      {selectedAlert.details !== null &&
                        selectedAlert.details !== undefined && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs gap-1"
                            onClick={() =>
                              handleCopy(
                                prettyJson(selectedAlert.details),
                                "JSON",
                              )
                            }
                            data-testid="button-copy-detail-payload"
                          >
                            <Copy className="h-3 w-3" />
                            Copy JSON
                          </Button>
                        )}
                    </div>
                    {selectedAlert.details === null ||
                    selectedAlert.details === undefined ? (
                      <p
                        className="text-xs text-slate-500"
                        data-testid="text-detail-empty"
                      >
                        No details payload was recorded for this alert.
                      </p>
                    ) : (
                      <pre
                        className="text-xs font-mono bg-slate-50 border border-slate-200 rounded-md p-3 whitespace-pre-wrap break-words text-slate-800 overflow-x-auto"
                        data-testid="text-detail-payload"
                      >
                        {prettyJson(selectedAlert.details)}
                      </pre>
                    )}
                  </section>

                  <section>
                    <h3 className="text-sm font-semibold text-slate-900 mb-2">
                      Channel outcomes
                    </h3>
                    {selectedOutcomes.length === 0 ? (
                      <p
                        className="text-xs text-slate-500"
                        data-testid="text-detail-no-outcomes"
                      >
                        {selectedAttempted.length === 0
                          ? "No channels were attempted for this alert."
                          : "No outcomes were recorded for the attempted channels."}
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {selectedOutcomes.map((outcome, idx) => {
                          const status = outcome.status ?? "unknown";
                          const cls =
                            OUTCOME_BADGE[status] ??
                            "bg-slate-100 text-slate-700 border-slate-300";
                          const channelLabel = outcome.channel || `channel-${idx}`;
                          return (
                            <div
                              key={`${channelLabel}-${idx}`}
                              className="border border-slate-200 rounded-md p-3 bg-white"
                              data-testid={`outcome-detail-${channelLabel}`}
                            >
                              <div className="flex items-center justify-between gap-2 mb-2">
                                <span className="text-xs font-mono font-semibold text-slate-800">
                                  {channelLabel}
                                </span>
                                <Badge
                                  variant="outline"
                                  className={`text-[11px] ${cls}`}
                                >
                                  {status}
                                </Badge>
                              </div>
                              <dl className="grid grid-cols-[6.5rem_1fr] gap-y-1 text-xs">
                                <dt className="text-slate-500">HTTP status</dt>
                                <dd
                                  className="font-mono text-slate-800"
                                  data-testid={`outcome-http-${channelLabel}`}
                                >
                                  {outcome.httpStatus !== undefined
                                    ? outcome.httpStatus
                                    : "—"}
                                </dd>
                                <dt className="text-slate-500">Duration</dt>
                                <dd
                                  className="font-mono text-slate-800"
                                  data-testid={`outcome-duration-${channelLabel}`}
                                >
                                  {outcome.durationMs !== undefined
                                    ? `${outcome.durationMs} ms`
                                    : "—"}
                                </dd>
                                <dt className="text-slate-500">Error</dt>
                                <dd
                                  className="font-mono text-slate-800 break-words whitespace-pre-wrap"
                                  data-testid={`outcome-error-${channelLabel}`}
                                >
                                  {outcome.error ? (
                                    <div className="flex items-start justify-between gap-2">
                                      <span className="min-w-0 flex-1">
                                        {outcome.error}
                                      </span>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-6 w-6 p-0 shrink-0"
                                        onClick={() =>
                                          handleCopy(
                                            outcome.error ?? "",
                                            "Error",
                                          )
                                        }
                                        title="Copy error"
                                        data-testid={`button-copy-error-${channelLabel}`}
                                      >
                                        <Copy className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  ) : (
                                    "—"
                                  )}
                                </dd>
                              </dl>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  {selectedAttempted.length > 0 && (
                    <section>
                      <h3 className="text-sm font-semibold text-slate-900 mb-2">
                        Channels attempted
                      </h3>
                      <div className="flex flex-wrap gap-1.5">
                        {selectedAttempted.map((channel) => (
                          <Badge
                            key={channel}
                            variant="outline"
                            className="text-[11px] font-mono bg-slate-100 text-slate-700 border-slate-300"
                          >
                            {channel}
                          </Badge>
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              </ScrollArea>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
