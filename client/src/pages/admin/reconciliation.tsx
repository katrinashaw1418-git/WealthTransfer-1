// =============================================================================
// SESSION 25 (Task #17) — ADMIN WALLET ↔ LEDGER RECONCILIATION VIEWER
// -----------------------------------------------------------------------------
// LEDGER IS THE SOURCE OF TRUTH — wallet cache is derived only.
//
// This page surfaces the latest wallet-vs-ledger drift check per
// (user, currency). It is read-only with respect to the ledger; the only
// admin write actions are recording an Acknowledge / Resolve note against a
// drifted pair (which suppresses operator pages while the case is being
// investigated) or clearing an existing acknowledgement (which re-enables
// paging on the next reconciliation pass).
//
// Task #203 — consolidates Drafts #18 / #19 / #47 / #48: per-row
// Acknowledge / Resolve buttons (note required on Resolve), inline render
// of the active acknowledgement, per-row ack-history collapsible, and
// "ack expired — re-investigate" labelling once the configured TTL window
// has lapsed.
// =============================================================================

import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
  Scale,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  X,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  ShieldCheck,
  Clock,
  History,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type ReconStatus = "match" | "mismatch";
type ReconSeverity = "none" | "info" | "warning" | "alert" | "critical";
type AckKind = "acknowledge" | "resolve";

interface ActiveAck {
  id: number;
  userId: number;
  currency: string;
  acknowledgedDriftAmount: string;
  note: string | null;
  kind: AckKind;
  acknowledgedByUserId: number;
  acknowledgedAt: string;
  acknowledgedByUsername: string | null;
  expiresAt: string;
  isExpired: boolean;
}

interface AckHistoryItem extends ActiveAck {
  clearedAt: string | null;
  clearedByUserId: number | null;
  clearedByUsername: string | null;
  clearReason: string | null;
}

interface ReconRow {
  id: number;
  userId: number;
  username: string | null;
  currency: string;
  walletCachedBalance: string;
  ledgerSumBalance: string;
  driftAmount: string;
  status: ReconStatus;
  severity: ReconSeverity;
  notes: string | null;
  createdAt: string | null;
  activeAcknowledgement: ActiveAck | null;
}

interface ReconPage {
  items: ReconRow[];
  page: number;
  limit: number;
  total: number;
  ttlDays: number;
}

interface AckHistoryPage {
  items: AckHistoryItem[];
  page: number;
  limit: number;
  total: number;
  ttlDays: number;
}

const TOKEN_KEY = "amax_jwt";

function fmtTimestamp(d: string | null | undefined): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return "—";
  }
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return "—";
  }
}

function fmtAmount(v: string | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  });
}

function severityBadge(sev: ReconSeverity, status: ReconStatus) {
  if (status === "match") {
    return (
      <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
        <CheckCircle2 className="h-3 w-3 mr-1" />
        match
      </Badge>
    );
  }
  const map: Record<Exclude<ReconSeverity, "none">, string> = {
    info: "bg-slate-100 text-slate-700",
    warning: "bg-amber-100 text-amber-800",
    alert: "bg-orange-100 text-orange-800",
    critical: "bg-red-100 text-red-800",
  };
  const cls = map[sev as Exclude<ReconSeverity, "none">] ?? "bg-amber-100 text-amber-800";
  return (
    <Badge className={`${cls} hover:${cls}`}>
      <AlertTriangle className="h-3 w-3 mr-1" />
      {sev === "none" ? "mismatch" : sev}
    </Badge>
  );
}

// -----------------------------------------------------------------------------
// Per-row "active acknowledgement" card. Renders inline beneath the row's
// data cells (via a colSpanned <tr>) so a glance at the page tells admins
// which drift cases are already being investigated.
// -----------------------------------------------------------------------------
function ActiveAckPanel({
  ack,
  onClear,
  isClearing,
}: {
  ack: ActiveAck;
  onClear: () => void;
  isClearing: boolean;
}) {
  const expired = ack.isExpired;
  const tone = expired
    ? "border-amber-300 bg-amber-50 text-amber-900"
    : ack.kind === "resolve"
      ? "border-emerald-300 bg-emerald-50 text-emerald-900"
      : "border-violet-300 bg-violet-50 text-violet-900";
  const Icon = expired ? Clock : ack.kind === "resolve" ? ShieldCheck : CheckCircle2;
  const label = expired
    ? "Acknowledgement expired — re-investigate"
    : ack.kind === "resolve"
      ? "Resolved"
      : "Acknowledged";
  return (
    <div
      className={`rounded-md border ${tone} px-3 py-2 text-xs`}
      data-testid={`panel-ack-${ack.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-medium">
            <Icon className="h-3.5 w-3.5" />
            {label}
            <span className="font-normal opacity-80">
              by {ack.acknowledgedByUsername ?? `user#${ack.acknowledgedByUserId}`}
              {" · "}
              {fmtDate(ack.acknowledgedAt)}
            </span>
          </div>
          {ack.note ? (
            <div className="opacity-90 whitespace-pre-wrap">{ack.note}</div>
          ) : (
            <div className="italic opacity-60">No note recorded</div>
          )}
          <div className="opacity-70">
            Snapshot drift: {fmtAmount(ack.acknowledgedDriftAmount)} {ack.currency}
            {" · "}
            Expires {fmtDate(ack.expiresAt)}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={onClear}
          disabled={isClearing}
          data-testid={`button-clear-ack-${ack.id}`}
        >
          {isClearing ? "Clearing…" : "Clear"}
        </Button>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Per-row "ack history" collapsible. Lazy-loads the full ack history for
// the (user, currency) pair the first time the chevron is expanded so the
// initial page render isn't slowed down by N extra requests.
// -----------------------------------------------------------------------------
function AckHistoryCollapsible({
  userId,
  currency,
}: {
  userId: number;
  currency: string;
}) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery<AckHistoryPage>({
    queryKey: [
      "/api/admin/wallet-ledger-drift-acknowledgements",
      { userId, currency, scope: "history" },
    ],
    enabled: open,
    queryFn: async () => {
      const params = new URLSearchParams({
        userId: String(userId),
        currency,
        limit: "50",
      });
      const token = (() => {
        try {
          return localStorage.getItem(TOKEN_KEY);
        } catch {
          return null;
        }
      })();
      const res = await fetch(
        `/api/admin/wallet-ledger-drift-acknowledgements?${params.toString()}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-slate-600 hover:text-slate-900"
          data-testid={`button-toggle-history-${userId}-${currency}`}
        >
          <History className="h-3 w-3 mr-1" />
          Ack history
          <ChevronDown
            className={`h-3 w-3 ml-1 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : !data || data.items.length === 0 ? (
          <p className="text-xs text-slate-500 italic">
            No acknowledgement history for this drift case.
          </p>
        ) : (
          <ol className="space-y-2 border-l-2 border-slate-200 pl-3 ml-1">
            {data.items.map((h) => {
              const isActive = h.clearedAt === null;
              const expired = isActive && h.isExpired;
              const verb = h.kind === "resolve" ? "Resolved" : "Acknowledged";
              return (
                <li
                  key={h.id}
                  className="text-xs space-y-0.5"
                  data-testid={`history-item-${h.id}`}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${
                        expired
                          ? "bg-amber-400"
                          : isActive
                            ? "bg-violet-500"
                            : "bg-slate-300"
                      }`}
                    />
                    <span className="font-medium text-slate-800">
                      {verb}
                    </span>
                    <span className="text-slate-500">
                      by {h.acknowledgedByUsername ?? `user#${h.acknowledgedByUserId}`}
                      {" · "}
                      {fmtTimestamp(h.acknowledgedAt)}
                    </span>
                    {expired ? (
                      <Badge variant="outline" className="h-4 text-[10px] border-amber-400 text-amber-700">
                        expired
                      </Badge>
                    ) : null}
                  </div>
                  {h.note ? (
                    <div className="text-slate-700 whitespace-pre-wrap pl-3.5">
                      {h.note}
                    </div>
                  ) : null}
                  {h.clearedAt ? (
                    <div className="text-slate-500 pl-3.5">
                      Cleared by {h.clearedByUsername ?? `user#${h.clearedByUserId ?? "?"}`}
                      {" · "}
                      {fmtTimestamp(h.clearedAt)}
                      {h.clearReason ? ` — ${h.clearReason}` : ""}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

// -----------------------------------------------------------------------------
// Acknowledge / Resolve dialog — single component covers both flows; the
// `kind` prop drives the title, the note-required validation, and the
// submit button label.
// -----------------------------------------------------------------------------
function AckDialog({
  open,
  onOpenChange,
  row,
  kind,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  row: ReconRow | null;
  kind: AckKind;
  onSubmit: (note: string) => void;
  isPending: boolean;
}) {
  const [note, setNote] = useState("");
  const isResolve = kind === "resolve";

  // Reset on open so a previous note doesn't bleed across dialogs.
  function handleOpenChange(next: boolean) {
    if (!next) setNote("");
    onOpenChange(next);
  }

  function handleSubmit() {
    onSubmit(note.trim());
  }

  const noteRequired = isResolve;
  const submitDisabled =
    isPending || (noteRequired && note.trim().length === 0);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid={`dialog-${kind}`}>
        <DialogHeader>
          <DialogTitle>
            {isResolve ? "Resolve drift case" : "Acknowledge drift case"}
          </DialogTitle>
          <DialogDescription>
            {row
              ? `${row.username ?? `user#${row.userId}`} — ${row.currency} (drift ${fmtAmount(row.driftAmount)})`
              : null}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="text-xs text-slate-600 space-y-1">
            <p>
              {isResolve
                ? "Use Resolve when the drift has been corrected (e.g. you posted a balancing ledger entry). Operator pages stay suppressed until the drift moves materially or this acknowledgement is cleared / expires."
                : "Use Acknowledge when you are aware of the drift and are investigating. Operator pages stay suppressed for the configured TTL window or until the drift moves materially."}
            </p>
            <p className="italic">
              The ledger and wallet cache are not modified by this action.
            </p>
          </div>
          <div>
            <label
              htmlFor="ack-note"
              className="text-xs font-medium text-slate-700"
            >
              Note {noteRequired ? <span className="text-red-600">*</span> : <span className="text-slate-400">(optional)</span>}
            </label>
            <Textarea
              id="ack-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                isResolve
                  ? "What corrective entry was posted? Ticket id?"
                  : "Ticket id, hypothesis, owner…"
              }
              maxLength={2000}
              className="mt-1"
              data-testid={`textarea-${kind}-note`}
            />
            <div className="text-[11px] text-slate-400 mt-0.5">
              {note.length} / 2000
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isPending}
            data-testid={`button-${kind}-cancel`}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitDisabled}
            data-testid={`button-${kind}-submit`}
          >
            {isPending
              ? isResolve
                ? "Resolving…"
                : "Acknowledging…"
              : isResolve
                ? "Resolve"
                : "Acknowledge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminReconciliation() {
  const { toast } = useToast();

  // Drill-down from the fees-tab drift card: `?pairs=userId:CCY,...`
  // pins the table to exactly the (user, currency) pairs that produced
  // the card's count, so the row count here always matches the card.
  const searchString = useSearch();
  const pairsParam = useMemo(() => {
    const raw = new URLSearchParams(searchString).get("pairs") ?? "";
    return raw.trim();
  }, [searchString]);
  const pairsCount = useMemo(() => {
    if (!pairsParam) return 0;
    return pairsParam.split(",").filter((p) => /^\d+:[A-Za-z]{3,10}$/.test(p.trim())).length;
  }, [pairsParam]);

  // Hydrate filter state from the URL on first render so deep-links from
  // the fees drift card (or any bookmark) land with the same view they
  // would after manually choosing the filters. Default to "mismatch" —
  // the whole point of this page is to surface drift, not show admins a
  // wall of green.
  const initialStatus = (() => {
    const v = new URLSearchParams(searchString).get("status");
    return v === "match" || v === "mismatch" || v === "all" ? v : "mismatch";
  })();
  const initialCurrency = (() => {
    const v = new URLSearchParams(searchString).get("currency") ?? "";
    return /^[A-Za-z]{3,10}$/.test(v.trim()) ? v.trim().toUpperCase() : "";
  })();
  const [status, setStatus] = useState<"all" | ReconStatus>(initialStatus);
  const [currency, setCurrency] = useState(initialCurrency);
  const [page, setPage] = useState(1);
  const limit = 50;

  // Dialog wiring — a single dialog instance reused for both Acknowledge
  // and Resolve so we don't render N dialog DOM nodes per row.
  const [dialogState, setDialogState] = useState<{
    open: boolean;
    row: ReconRow | null;
    kind: AckKind;
  }>({ open: false, row: null, kind: "acknowledge" });

  const queryKey = [
    "/api/admin/wallet-ledger-reconciliations",
    { status, currency, page, pairs: pairsParam },
  ];

  const { data, isLoading, isFetching } = useQuery<ReconPage>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (status !== "all") params.set("status", status);
      if (currency.trim()) params.set("currency", currency.trim().toUpperCase());
      if (pairsParam) params.set("pairs", pairsParam);
      params.set("page", String(page));
      params.set("limit", String(limit));
      const token = (() => {
        try {
          return localStorage.getItem(TOKEN_KEY);
        } catch {
          return null;
        }
      })();
      const res = await fetch(
        `/api/admin/wallet-ledger-reconciliations?${params.toString()}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  // ---- mutations ----------------------------------------------------------
  const ackMutation = useMutation({
    mutationFn: async (vars: {
      userId: number;
      currency: string;
      note: string;
      kind: AckKind;
    }) => {
      const res = await apiRequest(
        "POST",
        "/api/admin/wallet-ledger-reconciliations/acknowledge",
        {
          userId: vars.userId,
          currency: vars.currency,
          note: vars.note.length === 0 ? null : vars.note,
          kind: vars.kind,
        },
      );
      return res.json();
    },
    onSuccess: (_data, vars) => {
      toast({
        title: vars.kind === "resolve" ? "Drift resolved" : "Drift acknowledged",
        description: `Operator pages suppressed for ${vars.currency}.`,
      });
      setDialogState({ open: false, row: null, kind: "acknowledge" });
      queryClient.invalidateQueries({
        queryKey: ["/api/admin/wallet-ledger-reconciliations"],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/admin/wallet-ledger-drift-acknowledgements"],
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Could not acknowledge",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const clearMutation = useMutation({
    mutationFn: async (vars: { userId: number; currency: string }) => {
      const res = await apiRequest(
        "POST",
        "/api/admin/wallet-ledger-reconciliations/clear-acknowledgement",
        {
          userId: vars.userId,
          currency: vars.currency,
          reason: "Cleared from reconciliation page",
        },
      );
      return res.json();
    },
    onSuccess: (_data, vars) => {
      toast({
        title: "Acknowledgement cleared",
        description: `Operator pages will resume for ${vars.currency} on the next mismatch.`,
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/admin/wallet-ledger-reconciliations"],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/admin/wallet-ledger-drift-acknowledgements"],
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Could not clear",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / limit)) : 1;

  function clearFilters() {
    setStatus("mismatch");
    setCurrency("");
    setPage(1);
  }

  // Strips ?pairs=... from the URL so the admin can return to the full
  // table after using the drill-down. We rebuild the search string
  // explicitly rather than mutating it in place so wouter's useSearch
  // re-subscribes cleanly.
  function clearPairsFilter() {
    const sp = new URLSearchParams(searchString);
    sp.delete("pairs");
    const next = sp.toString();
    const url = `${window.location.pathname}${next ? `?${next}` : ""}`;
    window.history.replaceState(null, "", url);
    // useSearch tracks the live query string via popstate; nudge it.
    window.dispatchEvent(new PopStateEvent("popstate"));
    setPage(1);
  }

  return (
    <div className="space-y-4 max-w-7xl">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Reconciliation</h1>
        <p className="text-sm text-slate-500 mt-1">
          Wallet display cache vs. ledger sum, per (user, currency). The ledger
          is the source of truth — any drift here is either a bug or a
          historical transaction that pre-dates ledger enforcement.
          {data?.ttlDays
            ? ` Acknowledgements expire automatically after ${data.ttlDays} days.`
            : ""}
        </p>
      </div>

      {pairsParam && (
        <div
          className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          data-testid="banner-pairs-filter"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <span>
              Filtered to {pairsCount} drifted (user, currency) pair
              {pairsCount === 1 ? "" : "s"} from the fees reconciliation card.
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={clearPairsFilter}
            data-testid="button-clear-pairs-filter"
          >
            <X className="h-4 w-4 mr-1" />
            Clear drill-down
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Scale className="h-4 w-4 text-violet-600" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v as "all" | ReconStatus);
                setPage(1);
              }}
            >
              <SelectTrigger data-testid="select-filter-status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mismatch">Mismatch only</SelectItem>
                <SelectItem value="match">Match only</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Currency (e.g. USD)"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setPage(1);
              }}
              data-testid="input-filter-currency"
            />
            <div className="flex gap-2 sm:col-span-2">
              <Button
                onClick={() => setPage(1)}
                className="flex-1"
                data-testid="button-apply-filters"
              >
                Apply
              </Button>
              <Button
                variant="outline"
                onClick={clearFilters}
                data-testid="button-clear-filters"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">
            {isLoading ? "Loading…" : `${data?.total ?? 0} (user, currency) pair(s)`}
            {isFetching && !isLoading ? " · refreshing…" : ""}
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
            <p className="text-sm text-slate-500">
              No reconciliation rows match these filters.
              {status === "mismatch"
                ? " That's the desired state — no drift detected."
                : ""}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead className="text-right">Ledger balance</TableHead>
                  <TableHead className="text-right">Wallet cache</TableHead>
                  <TableHead className="text-right">Drift</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last checked</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((row) => {
                  const isDrift = row.status === "mismatch";
                  const drift = Number(row.driftAmount);
                  const ack = row.activeAcknowledgement;
                  const isClearingThisRow =
                    clearMutation.isPending &&
                    clearMutation.variables?.userId === row.userId &&
                    clearMutation.variables?.currency === row.currency;
                  return (
                    <Fragment key={`row-${row.id}`}>
                      <TableRow
                        data-testid={`row-recon-${row.id}`}
                        className={isDrift ? "bg-red-50/50" : ""}
                      >
                        <TableCell className="text-sm">
                          <div className="font-medium">
                            {row.username ?? `user#${row.userId}`}
                          </div>
                          <div className="text-xs text-slate-500 font-mono">
                            id {row.userId}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm font-mono">
                          {row.currency}
                        </TableCell>
                        <TableCell className="text-sm font-mono text-right">
                          {fmtAmount(row.ledgerSumBalance)}
                        </TableCell>
                        <TableCell className="text-sm font-mono text-right">
                          {fmtAmount(row.walletCachedBalance)}
                        </TableCell>
                        <TableCell
                          className={`text-sm font-mono text-right ${
                            isDrift
                              ? Math.abs(drift) > 0.0000001
                                ? "text-red-700 font-semibold"
                                : "text-slate-700"
                              : "text-slate-500"
                          }`}
                        >
                          {fmtAmount(row.driftAmount)}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            {severityBadge(row.severity, row.status)}
                            {ack && !ack.isExpired ? (
                              <Badge
                                variant="outline"
                                className={`h-5 text-[10px] ${
                                  ack.kind === "resolve"
                                    ? "border-emerald-400 text-emerald-700"
                                    : "border-violet-400 text-violet-700"
                                }`}
                                data-testid={`badge-ack-${row.id}`}
                              >
                                {ack.kind === "resolve" ? "resolved" : "acknowledged"}
                              </Badge>
                            ) : null}
                            {ack && ack.isExpired ? (
                              <Badge
                                variant="outline"
                                className="h-5 text-[10px] border-amber-400 text-amber-700"
                                data-testid={`badge-ack-expired-${row.id}`}
                              >
                                ack expired
                              </Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-slate-600 whitespace-nowrap">
                          {fmtTimestamp(row.createdAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center gap-1 justify-end">
                            {isDrift && (!ack || ack.isExpired) ? (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    setDialogState({
                                      open: true,
                                      row,
                                      kind: "acknowledge",
                                    })
                                  }
                                  data-testid={`button-ack-${row.id}`}
                                >
                                  Ack
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() =>
                                    setDialogState({
                                      open: true,
                                      row,
                                      kind: "resolve",
                                    })
                                  }
                                  data-testid={`button-resolve-${row.id}`}
                                >
                                  Resolve
                                </Button>
                              </>
                            ) : null}
                            <Link href={`/admin/audit-logs?userId=${row.userId}`}>
                              <a
                                className="inline-flex items-center gap-1 text-xs text-violet-600 hover:text-violet-800 ml-1"
                                data-testid={`link-audit-${row.userId}`}
                              >
                                Audit
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            </Link>
                          </div>
                        </TableCell>
                      </TableRow>
                      {isDrift ? (
                        <TableRow
                          key={`row-${row.id}-detail`}
                          className={isDrift ? "bg-red-50/30" : ""}
                          data-testid={`row-recon-detail-${row.id}`}
                        >
                          <TableCell colSpan={8} className="py-2">
                            <div className="space-y-2">
                              {ack ? (
                                <ActiveAckPanel
                                  ack={ack}
                                  isClearing={isClearingThisRow}
                                  onClear={() =>
                                    clearMutation.mutate({
                                      userId: row.userId,
                                      currency: row.currency,
                                    })
                                  }
                                />
                              ) : null}
                              {row.notes ? (
                                <p className="text-xs text-slate-600 italic">
                                  {row.notes}
                                </p>
                              ) : null}
                              <AckHistoryCollapsible
                                userId={row.userId}
                                currency={row.currency}
                              />
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-slate-500">
        Reconciliation runs daily. The check is observation-only — it never
        mutates the ledger or the wallet cache. To resolve a mismatch, post a
        ledger correction; the next reconciliation pass will clear the row.
        Acknowledging or resolving a drift case suppresses operator pages
        without touching balances.
      </p>

      <AckDialog
        open={dialogState.open}
        onOpenChange={(v) =>
          setDialogState((s) => ({ ...s, open: v }))
        }
        row={dialogState.row}
        kind={dialogState.kind}
        isPending={ackMutation.isPending}
        onSubmit={(note) => {
          if (!dialogState.row) return;
          ackMutation.mutate({
            userId: dialogState.row.userId,
            currency: dialogState.row.currency,
            note,
            kind: dialogState.kind,
          });
        }}
      />
    </div>
  );
}
