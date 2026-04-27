import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import {
  Siren,
  ChevronLeft,
  ChevronRight,
  X,
  Copy,
  Trash2,
  ShieldCheck,
  BookOpen,
  Send,
  Repeat,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";

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
  // Task #156 — top-level rollup + occurrence counter + last-seen timestamp.
  // Older rows that predate Task #156 may not have these fields populated;
  // the renderer treats undefined/null defensively.
  deliveryStatus?: string | null;
  occurrences?: number | null;
  lastSeenAt?: string | null;
}

interface TestAlertResponse {
  alertId: number | null;
  deliveryStatus: string;
  channelsAttempted: string[];
  outcomes: ChannelOutcome[];
  occurrences: number;
  webhookConfigured: boolean;
}

interface OperatorAlertsPage {
  items: OperatorAlertRow[];
  page: number;
  limit: number;
  total: number;
}

interface PruneRunRow {
  id: number;
  startedAt: string | null;
  retentionDays: number;
  cutoff: string | null;
  deleted: number;
  durationMs: number;
}

interface PruneRunsResponse {
  items: PruneRunRow[];
}

interface OperatorAlertAckRow {
  id: number;
  alertSource: string;
  suppressionKey: string;
  note: string | null;
  acknowledgedByUserId: number;
  acknowledgedAt: string | null;
  clearedAt: string | null;
  clearedByUserId: number | null;
  clearReason: string | null;
  acknowledgedByUsername: string | null;
  clearedByUsername: string | null;
}

interface OperatorAlertAcksPage {
  items: OperatorAlertAckRow[];
  page: number;
  limit: number;
  total: number;
}

// TASK #145 — admin-facing legend for every alert source the system can
// dispatch. Kept in this file (rather than fetched from the server) because
// it is documentation about the code, not state — and it stays in lock-step
// with the dispatchers in `server/services/operator-alerts.ts` callers.
//
// Sources flagged `ackable` are wired through the generic acknowledgement
// table added in this task; only those expose an "Acknowledge" button on the
// alert detail sheet.
//
// **Authoritative list** — every concrete `notifyOperator(...) source: "…"`
// literal in `server/` AND the one dynamic-suffix family below
// (`ledger-balance-guard.<callsite>`) appear here. If a new dispatcher is
// added, add a row here AND update `replit.md` § alert types so admin docs
// don't drift.
interface AlertTypeDef {
  source: string;
  /**
   * Optional regex for sources whose name carries a dynamic suffix
   * (currently only `ledger-balance-guard.<callsite>`). When set, this
   * pattern is used to look up the type for an alert whose exact source
   * isn't in `ALERT_TYPE_BY_SOURCE`.
   */
  sourcePattern?: RegExp;
  label: string;
  description: string;
  ackable: boolean;
  /**
   * For ackable sources, how the suppressionKey is derived from the alert
   * details. Shown to the operator so they understand WHAT they are silencing
   * before they confirm. Returns null when no key can be derived from the
   * alert (in which case the Acknowledge button is hidden for that row).
   */
  deriveSuppressionKey?: (details: any, source: string) => string | null;
}

const ALERT_TYPES: AlertTypeDef[] = [
  {
    source: "wallet-ledger-reconciliation",
    label: "Wallet ↔ ledger drift",
    description:
      "Daily reconciliation found a wallet cache balance that disagrees with SUM(ledger_entries) for the same (user, currency). Acknowledged on the dedicated Reconciliation page.",
    ackable: false,
  },
  {
    source: "operator-alerts-prune-watchdog",
    label: "Prune watchdog",
    description:
      "The operator-alerts retention prune job has not run successfully in more than 48 hours, OR a single prune run failed mid-flight.",
    ackable: false,
  },
  {
    source: "posting-receipt-invariant",
    label: "Posting-receipt invariant",
    description:
      "A transaction with ledger entries is missing its posting receipt row (or vice versa). Run scripts/backfill-ledger-postings.ts to repair.",
    ackable: false,
  },
  {
    source: "ledger-balance-guard",
    sourcePattern: /^ledger-balance-guard\./,
    label: "Unbalanced ledger journal (family)",
    description:
      "Posting-time guard rejected a journal whose debits ≠ credits. The full source string is `ledger-balance-guard.<callsite>` so different write paths can be filtered independently. Not ack-able — every occurrence is a hard correctness bug worth investigating individually.",
    ackable: false,
  },
  {
    source: "audit-log-write-failure",
    label: "Audit log write failure",
    description:
      "An attempt to insert an audit_logs row failed. Suppression key is action|entityType|entityId so the same failing row collapses to one ack-able signature.",
    ackable: true,
    deriveSuppressionKey: (details) => {
      if (!details || typeof details !== "object") return null;
      const action = details.action ?? "null";
      const entityType = details.entityType ?? "null";
      const entityId = details.entityId ?? "null";
      return `${action}|${entityType}|${entityId}`;
    },
  },
  {
    source: "stuck-pending-transactions",
    label: "Stuck pending transactions",
    description:
      "One or more transactions have been in pending/processing for longer than the configured threshold. Suppression key is a hash of the stuck-id set so a new stuck row re-fires the alert.",
    ackable: true,
    deriveSuppressionKey: (details) => {
      if (!details || typeof details !== "object") return null;
      const k = details.suppressionKey;
      return typeof k === "string" && k.length > 0 ? k : null;
    },
  },
  {
    source: "db-connection-failure",
    label: "Database connection drops",
    description:
      "The DB health watcher has seen N consecutive ping failures within the configured window. Suppression key is fixed: there is only one DB to be down at a time.",
    ackable: true,
    deriveSuppressionKey: () => "db-connection-failure",
  },
];

const ALERT_TYPE_BY_SOURCE = new Map<string, AlertTypeDef>(
  ALERT_TYPES.map((t) => [t.source, t]),
);

/**
 * Look up the AlertTypeDef for a concrete alert source string. Falls back
 * to a regex match against `sourcePattern` for the `ledger-balance-guard.*`
 * dynamic family (and any future dynamic-suffix families).
 */
function lookupAlertType(source: string): AlertTypeDef | undefined {
  const exact = ALERT_TYPE_BY_SOURCE.get(source);
  if (exact) return exact;
  for (const t of ALERT_TYPES) {
    if (t.sourcePattern && t.sourcePattern.test(source)) return t;
  }
  return undefined;
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

// Task #156 — top-level dispatch rollup. Distinct palette from per-channel
// outcomes so the two columns don't visually merge.
const DELIVERY_BADGE: Record<string, string> = {
  delivered: "bg-emerald-50 text-emerald-800 border-emerald-300",
  failed: "bg-red-50 text-red-800 border-red-300",
  suppressed_duplicate: "bg-violet-50 text-violet-800 border-violet-300",
};

const DELIVERY_LABEL: Record<string, string> = {
  delivered: "delivered",
  failed: "failed",
  suppressed_duplicate: "duplicate",
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

// Task #69 — datetime-local inputs need `YYYY-MM-DDTHH:mm` in *local* time.
// Convert the server-side ISO/UTC value back to the user's local clock so
// the picker shows what they typed; convert local input back to ISO when
// sending to the server.
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function fromLocalInput(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

// Resolve the dashboard tile's `?window=24h|7d` shortcut to a `from`
// datetime-local string. The dashboard tile shows two windowed counts and
// links here with the window the admin clicked, so they land on a view
// already scoped to the same period.
function windowToFrom(raw: string | null): string {
  if (raw === "24h") return toLocalInput(new Date(Date.now() - 24 * 60 * 60 * 1000));
  if (raw === "7d") return toLocalInput(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
  return "";
}

function rawToInput(raw: string | null): string {
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  return toLocalInput(d);
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
  const queryClient = useQueryClient();
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
  // `from`/`to` win over the `window` shortcut so a deep link with explicit
  // bounds is never silently overridden by a stale shortcut.
  const initialFrom =
    rawToInput(initialParams.get("from")) || windowToFrom(initialParams.get("window"));
  const initialTo = rawToInput(initialParams.get("to"));

  const [sourceInput, setSourceInput] = useState(initialSource);
  const [severityInput, setSeverityInput] = useState<string>(initialSeverity);
  const [searchInput, setSearchInput] = useState(initialQ);
  const [fromInput, setFromInput] = useState(initialFrom);
  const [toInput, setToInput] = useState(initialTo);
  const [appliedSource, setAppliedSource] = useState(initialSource);
  const [appliedSeverity, setAppliedSeverity] = useState<string>(initialSeverity);
  const [appliedSearch, setAppliedSearch] = useState(initialQ);
  const [appliedFrom, setAppliedFrom] = useState(initialFrom);
  const [appliedTo, setAppliedTo] = useState(initialTo);
  const [page, setPage] = useState(1);
  const [selectedAlert, setSelectedAlert] = useState<OperatorAlertRow | null>(null);
  const [ackNote, setAckNote] = useState("");
  const limit = 50;

  const queryKey = [
    "/api/admin/operator-alerts",
    {
      source: appliedSource,
      severity: appliedSeverity,
      q: appliedSearch,
      from: appliedFrom,
      to: appliedTo,
      page,
    },
  ];

  function getAuthHeaders(): Record<string, string> {
    const token = (() => {
      try {
        return localStorage.getItem(TOKEN_KEY);
      } catch {
        return null;
      }
    })();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  const { data, isLoading } = useQuery<OperatorAlertsPage>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (appliedSource.trim()) params.set("source", appliedSource.trim());
      if (appliedSeverity !== SEVERITY_ANY) params.set("severity", appliedSeverity);
      if (appliedSearch.trim()) params.set("q", appliedSearch.trim());
      const fromIso = fromLocalInput(appliedFrom);
      const toIso = fromLocalInput(appliedTo);
      if (fromIso) params.set("from", fromIso);
      if (toIso) params.set("to", toIso);
      params.set("page", String(page));
      params.set("limit", String(limit));
      const res = await fetch(`/api/admin/operator-alerts?${params.toString()}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  // Task #59 — recent retention prune runs. Surfaced here so operators can
  // confirm at a glance that the daily prune job is running without having to
  // grep server logs.
  const { data: pruneRunsData, isLoading: pruneRunsLoading } = useQuery<PruneRunsResponse>({
    queryKey: ["/api/admin/operator-alerts/prune-runs"],
    queryFn: async () => {
      const res = await fetch("/api/admin/operator-alerts/prune-runs", {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  // TASK #145 — active acknowledgements list. Refetched after every
  // create/clear so the UI never lies about which alerts are silenced.
  const { data: acksData, isLoading: acksLoading } =
    useQuery<OperatorAlertAcksPage>({
      queryKey: ["/api/admin/operator-alert-acknowledgements", { activeOnly: true }],
      queryFn: async () => {
        const res = await fetch(
          "/api/admin/operator-alert-acknowledgements?activeOnly=true&limit=200",
          { headers: getAuthHeaders() },
        );
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      },
    });

  const ackCreateMutation = useMutation({
    mutationFn: async (vars: {
      alertSource: string;
      suppressionKey: string;
      note: string | null;
    }) => {
      return apiRequest(
        "POST",
        "/api/admin/operator-alert-acknowledgements",
        vars,
      ).then((r) => r.json());
    },
    onSuccess: () => {
      toast({
        title: "Alert acknowledged",
        description:
          "Future alerts with this signature will be suppressed until you clear the ack.",
      });
      setAckNote("");
      setSelectedAlert(null);
      queryClient.invalidateQueries({
        queryKey: ["/api/admin/operator-alert-acknowledgements"],
      });
    },
    onError: (err: any) => {
      toast({
        title: "Failed to acknowledge",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  const ackClearMutation = useMutation({
    mutationFn: async (vars: { id: number; reason: string | null }) => {
      return apiRequest(
        "POST",
        "/api/admin/operator-alert-acknowledgements/clear",
        vars,
      ).then((r) => r.json());
    },
    onSuccess: () => {
      toast({
        title: "Acknowledgement cleared",
        description: "Future matching alerts will be dispatched again.",
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/admin/operator-alert-acknowledgements"],
      });
    },
    onError: (err: any) => {
      toast({
        title: "Failed to clear acknowledgement",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  // Compute the suppression key for the currently-selected alert (if any),
  // so the Acknowledge button can show the operator exactly what will be
  // silenced before they confirm.
  const selectedAlertType = selectedAlert
    ? lookupAlertType(selectedAlert.source) ?? null
    : null;
  const selectedSuppressionKey = useMemo(() => {
    if (!selectedAlert || !selectedAlertType?.ackable) return null;
    if (!selectedAlertType.deriveSuppressionKey) return null;
    return selectedAlertType.deriveSuppressionKey(
      selectedAlert.details,
      selectedAlert.source,
    );
  }, [selectedAlert, selectedAlertType]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / limit)) : 1;

  function clearFilters() {
    setSourceInput("");
    setSeverityInput(SEVERITY_ANY);
    setSearchInput("");
    setFromInput("");
    setToInput("");
    setAppliedSource("");
    setAppliedSeverity(SEVERITY_ANY);
    setAppliedSearch("");
    setAppliedFrom("");
    setAppliedTo("");
    setPage(1);
  }

  function applyFilters() {
    setAppliedSource(sourceInput);
    setAppliedSeverity(severityInput);
    setAppliedSearch(searchInput);
    setAppliedFrom(fromInput);
    setAppliedTo(toInput);
    setPage(1);
  }

  const selectedSevClass = selectedAlert
    ? SEVERITY_BADGE[selectedAlert.severity] ??
      "bg-slate-100 text-slate-700 border-slate-300"
    : "";
  const selectedOutcomes = selectedAlert?.channelOutcomes ?? [];
  const selectedAttempted = selectedAlert?.channelsAttempted ?? [];

  // Task #156 — "Send test alert" mutation. Fires a synthetic alert through
  // the dispatcher so the operator can confirm the webhook pipe is reachable
  // without manufacturing a real failure. The toast reports the rollup
  // status (delivered / failed / suppressed-as-duplicate) so the operator
  // gets immediate feedback even before the table refreshes.
  const testAlertMutation = useMutation<TestAlertResponse, Error, void>({
    mutationFn: async () => {
      const res = await fetch("/api/admin/operator-alerts/test", {
        method: "POST",
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (result) => {
      const status = result.deliveryStatus;
      const channelList = result.channelsAttempted.join(", ") || "none";
      if (status === "delivered") {
        toast({
          title: "Test alert delivered",
          description:
            `Reached channels: ${channelList}.` +
            (result.webhookConfigured
              ? ""
              : " (Webhook not configured — alert was logged only.)"),
          duration: 4000,
        });
      } else if (status === "suppressed_duplicate") {
        toast({
          title: "Test alert coalesced",
          description: `An identical test alert is already inside the dedupe window. Counter incremented (occurrences=${result.occurrences}).`,
          duration: 4000,
        });
      } else {
        const errSummary =
          result.outcomes
            .filter((o) => o.status !== "success")
            .map(
              (o) =>
                `${o.channel}=${o.status}${o.httpStatus ? ` (HTTP ${o.httpStatus})` : ""}`,
            )
            .join("; ") || "see audit row";
        toast({
          title: "Test alert delivery failed",
          description: `Outcome: ${errSummary}. Check OPERATOR_ALERT_WEBHOOK_URL.`,
          variant: "destructive",
          duration: 6000,
        });
      }
      // Surface the freshly-inserted row in the table without forcing a
      // hard reload.
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/operator-alerts"] });
    },
    onError: (err) => {
      toast({
        title: "Test alert request failed",
        description: err.message,
        variant: "destructive",
        duration: 6000,
      });
    },
  });

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
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mt-3">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="filter-from"
                className="text-xs font-medium text-slate-600"
              >
                From
              </label>
              <Input
                id="filter-from"
                type="datetime-local"
                value={fromInput}
                onChange={(e) => setFromInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyFilters();
                }}
                data-testid="input-filter-from"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label
                htmlFor="filter-to"
                className="text-xs font-medium text-slate-600"
              >
                To
              </label>
              <Input
                id="filter-to"
                type="datetime-local"
                value={toInput}
                onChange={(e) => setToInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyFilters();
                }}
                data-testid="input-filter-to"
              />
            </div>
            <div className="sm:col-span-2 flex items-end gap-2 flex-wrap">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const from = toLocalInput(new Date(Date.now() - 24 * 60 * 60 * 1000));
                  setFromInput(from);
                  setToInput("");
                  setAppliedFrom(from);
                  setAppliedTo("");
                  setPage(1);
                }}
                data-testid="button-range-24h"
              >
                Last 24h
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const from = toLocalInput(
                    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
                  );
                  setFromInput(from);
                  setToInput("");
                  setAppliedFrom(from);
                  setAppliedTo("");
                  setPage(1);
                }}
                data-testid="button-range-7d"
              >
                Last 7d
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const from = toLocalInput(
                    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
                  );
                  setFromInput(from);
                  setToInput("");
                  setAppliedFrom(from);
                  setAppliedTo("");
                  setPage(1);
                }}
                data-testid="button-range-30d"
              >
                Last 30d
              </Button>
              {(appliedFrom || appliedTo) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFromInput("");
                    setToInput("");
                    setAppliedFrom("");
                    setAppliedTo("");
                    setPage(1);
                  }}
                  data-testid="button-clear-range"
                >
                  Clear range
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-alert-types-legend">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-violet-600" />
            Alert types
          </CardTitle>
          <p className="text-xs text-slate-500 mt-1">
            Every alert source dispatched by the system. Sources marked
            <span className="mx-1">
              <Badge variant="outline" className="text-[10px] bg-emerald-100 text-emerald-800 border-emerald-300">ackable</Badge>
            </span>
            can be acknowledged from the alert detail panel to suppress repeat pages
            until cleared.
          </p>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-24">Ackable</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ALERT_TYPES.map((t) => (
                <TableRow key={t.source} data-testid={`row-alert-type-${t.source}`}>
                  <TableCell className="text-xs font-mono text-slate-700 align-top whitespace-nowrap">
                    <div className="font-semibold text-slate-900">{t.label}</div>
                    <div className="text-slate-500">{t.source}</div>
                  </TableCell>
                  <TableCell className="text-xs text-slate-700 align-top">
                    {t.description}
                  </TableCell>
                  <TableCell className="align-top">
                    {t.ackable ? (
                      <Badge variant="outline" className="text-[10px] bg-emerald-100 text-emerald-800 border-emerald-300">
                        ackable
                      </Badge>
                    ) : (
                      <span className="text-[10px] text-slate-400">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card data-testid="card-active-acks">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-violet-600" />
            Active acknowledgements
          </CardTitle>
          <p className="text-xs text-slate-500 mt-1">
            Alert dispatches currently suppressed by an operator acknowledgement.
            Clear an entry to resume notifications for that signature.
          </p>
        </CardHeader>
        <CardContent>
          {acksLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !acksData || acksData.items.length === 0 ? (
            <p className="text-sm text-slate-500" data-testid="text-no-active-acks">
              No active acknowledgements. All ackable alert sources are
              currently dispatching as normal.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Suppression key</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead className="w-20"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {acksData.items.map((a) => (
                  <TableRow key={a.id} data-testid={`row-active-ack-${a.id}`}>
                    <TableCell className="text-xs text-slate-600 whitespace-nowrap align-top">
                      {fmt(a.acknowledgedAt)}
                    </TableCell>
                    <TableCell className="text-xs font-mono text-slate-700 align-top">
                      {a.alertSource}
                    </TableCell>
                    <TableCell className="text-xs font-mono text-slate-700 align-top break-all max-w-xs">
                      {a.suppressionKey}
                    </TableCell>
                    <TableCell className="text-xs text-slate-600 align-top">
                      {a.acknowledgedByUsername ?? `#${a.acknowledgedByUserId}`}
                    </TableCell>
                    <TableCell className="text-xs text-slate-600 align-top break-words max-w-md">
                      {a.note ?? <span className="text-slate-400">—</span>}
                    </TableCell>
                    <TableCell className="align-top text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={ackClearMutation.isPending}
                        onClick={() => {
                          const reason = window.prompt(
                            "Reason for clearing this acknowledgement (optional):",
                            "",
                          );
                          if (reason === null) return;
                          ackClearMutation.mutate({
                            id: a.id,
                            reason: reason.trim() === "" ? null : reason.trim(),
                          });
                        }}
                        data-testid={`button-clear-ack-${a.id}`}
                      >
                        Clear
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-prune-runs">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-violet-600" />
            Recent retention prune runs
          </CardTitle>
          <p className="text-xs text-slate-500 mt-1">
            Daily background job that deletes operator alerts older than the retention window.
            Most recent runs first.
          </p>
        </CardHeader>
        <CardContent>
          {pruneRunsLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !pruneRunsData || pruneRunsData.items.length === 0 ? (
            <p className="text-sm text-slate-500" data-testid="text-no-prune-runs">
              No prune runs recorded yet. The job runs once per day; the first record
              will appear within 24 hours of server start.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead className="text-right">Deleted</TableHead>
                  <TableHead>Cutoff</TableHead>
                  <TableHead className="text-right">Retention</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pruneRunsData.items.map((run) => (
                  <TableRow key={run.id} data-testid={`row-prune-run-${run.id}`}>
                    <TableCell className="text-xs text-slate-600 whitespace-nowrap">
                      {fmt(run.startedAt)}
                    </TableCell>
                    <TableCell
                      className="text-sm font-mono text-right"
                      data-testid={`text-prune-deleted-${run.id}`}
                    >
                      {run.deleted.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-xs text-slate-600 whitespace-nowrap">
                      {fmt(run.cutoff)}
                    </TableCell>
                    <TableCell className="text-xs font-mono text-slate-700 text-right">
                      {run.retentionDays}d
                    </TableCell>
                    <TableCell className="text-xs font-mono text-slate-700 text-right">
                      {run.durationMs}ms
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">
            {isLoading ? "Loading…" : `${data?.total ?? 0} alerts`}
          </CardTitle>
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Button
              variant="default"
              size="sm"
              onClick={() => testAlertMutation.mutate()}
              disabled={testAlertMutation.isPending}
              data-testid="button-send-test-alert"
              className="gap-1"
            >
              <Send className="h-4 w-4" />
              {testAlertMutation.isPending ? "Sending…" : "Send test alert"}
            </Button>
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
                  <TableHead>Delivery</TableHead>
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
                  // Task #156 — derive a delivery rollup even for legacy rows
                  // that predate the new column, by inspecting the persisted
                  // per-channel outcomes. This way the "Delivery" column is
                  // never blank.
                  const derivedDelivery = (() => {
                    if (row.deliveryStatus) return row.deliveryStatus;
                    if (outcomes.length === 0) return "delivered";
                    const allOk = outcomes.every((o) => o.status === "success");
                    return allOk ? "delivered" : "failed";
                  })();
                  const deliveryClass =
                    DELIVERY_BADGE[derivedDelivery] ??
                    "bg-slate-50 text-slate-700 border-slate-300";
                  const deliveryLabel =
                    DELIVERY_LABEL[derivedDelivery] ?? derivedDelivery;
                  const occurrences = Math.max(1, row.occurrences ?? 1);
                  const lastSeen = row.lastSeenAt ?? row.createdAt;
                  return (
                    <TableRow
                      key={row.id}
                      data-testid={`row-operator-alert-${row.id}`}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => setSelectedAlert(row)}
                    >
                      <TableCell className="text-xs text-slate-600 whitespace-nowrap align-top">
                        <div data-testid={`text-when-${row.id}`}>{fmt(lastSeen)}</div>
                        {occurrences > 1 && lastSeen !== row.createdAt && (
                          <div
                            className="text-[11px] text-slate-400 mt-0.5"
                            title={`First seen ${fmt(row.createdAt)}`}
                          >
                            first {fmt(row.createdAt)}
                          </div>
                        )}
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
                        <div className="flex flex-col gap-1">
                          <Badge
                            variant="outline"
                            className={`text-[11px] font-mono ${deliveryClass}`}
                            data-testid={`badge-delivery-${row.id}`}
                          >
                            {deliveryLabel}
                          </Badge>
                          {occurrences > 1 && (
                            <Badge
                              variant="outline"
                              className="text-[11px] font-mono bg-slate-100 text-slate-700 border-slate-300 gap-1"
                              data-testid={`badge-occurrences-${row.id}`}
                              title="Number of times this alert has fired (coalesced inside the dedupe window)"
                            >
                              <Repeat className="h-3 w-3" />×{occurrences}
                            </Badge>
                          )}
                        </div>
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
                  Alert #{selectedAlert.id} · first {fmt(selectedAlert.createdAt)}
                  {selectedAlert.lastSeenAt &&
                    selectedAlert.lastSeenAt !== selectedAlert.createdAt && (
                      <> · last {fmt(selectedAlert.lastSeenAt)}</>
                    )}
                </SheetDescription>
                <div className="flex items-center gap-2 pt-1">
                  {(() => {
                    const ds =
                      selectedAlert.deliveryStatus ??
                      ((selectedAlert.channelOutcomes ?? []).every(
                        (o) => o.status === "success",
                      )
                        ? "delivered"
                        : "failed");
                    const cls =
                      DELIVERY_BADGE[ds] ??
                      "bg-slate-50 text-slate-700 border-slate-300";
                    return (
                      <Badge
                        variant="outline"
                        className={`text-[11px] font-mono ${cls}`}
                        data-testid="badge-detail-delivery"
                      >
                        {DELIVERY_LABEL[ds] ?? ds}
                      </Badge>
                    );
                  })()}
                  {(selectedAlert.occurrences ?? 1) > 1 && (
                    <Badge
                      variant="outline"
                      className="text-[11px] font-mono bg-slate-100 text-slate-700 border-slate-300 gap-1"
                      data-testid="badge-detail-occurrences"
                    >
                      <Repeat className="h-3 w-3" />×{selectedAlert.occurrences}
                    </Badge>
                  )}
                </div>
              </SheetHeader>

              <ScrollArea className="flex-1">
                <div className="px-6 py-4 space-y-6">
                  {selectedAlertType?.ackable && (
                    <section
                      className="border border-emerald-200 bg-emerald-50 rounded-md p-3 space-y-2"
                      data-testid="section-acknowledge"
                    >
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-emerald-700" />
                        <h3 className="text-sm font-semibold text-emerald-900">
                          Acknowledge this alert
                        </h3>
                      </div>
                      <p className="text-xs text-emerald-900/80">
                        Suppresses future alerts whose suppression key matches the
                        one below. Clear the ack from the "Active acknowledgements"
                        list above to resume notifications.
                      </p>
                      <div className="text-xs">
                        <span className="text-emerald-900/70">Suppression key: </span>
                        <code
                          className="font-mono text-emerald-900 break-all"
                          data-testid="text-derived-suppression-key"
                        >
                          {selectedSuppressionKey ?? "(unable to derive — alert payload missing required fields)"}
                        </code>
                      </div>
                      <Textarea
                        value={ackNote}
                        onChange={(e) => setAckNote(e.target.value.slice(0, 2000))}
                        placeholder="Optional note: ticket id, root-cause hypothesis, etc."
                        rows={2}
                        className="text-xs bg-white"
                        data-testid="textarea-ack-note"
                      />
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          disabled={
                            !selectedSuppressionKey || ackCreateMutation.isPending
                          }
                          onClick={() => {
                            if (!selectedAlert || !selectedSuppressionKey) return;
                            ackCreateMutation.mutate({
                              alertSource: selectedAlert.source,
                              suppressionKey: selectedSuppressionKey,
                              note: ackNote.trim() === "" ? null : ackNote.trim(),
                            });
                          }}
                          data-testid="button-acknowledge"
                        >
                          {ackCreateMutation.isPending
                            ? "Acknowledging…"
                            : "Acknowledge & suppress"}
                        </Button>
                      </div>
                    </section>
                  )}

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
