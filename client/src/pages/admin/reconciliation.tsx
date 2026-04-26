// =============================================================================
// SESSION 25 (Task #17) — ADMIN WALLET ↔ LEDGER RECONCILIATION VIEWER
// -----------------------------------------------------------------------------
// LEDGER IS THE SOURCE OF TRUTH — wallet cache is derived only.
//
// This page surfaces the latest wallet-vs-ledger drift check per
// (user, currency). It is read-only — it cannot heal drift, only report it.
// =============================================================================

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
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
  Scale,
  ChevronLeft,
  ChevronRight,
  X,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
} from "lucide-react";

type ReconStatus = "match" | "mismatch";
type ReconSeverity = "none" | "info" | "warning" | "alert" | "critical";

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
}

interface ReconPage {
  items: ReconRow[];
  page: number;
  limit: number;
  total: number;
}

const TOKEN_KEY = "amax_jwt";

function fmtTimestamp(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
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

export default function AdminReconciliation() {
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
                  <TableHead className="text-right">Audit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((row) => {
                  const isDrift = row.status === "mismatch";
                  const drift = Number(row.driftAmount);
                  return (
                    <TableRow
                      key={row.id}
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
                      <TableCell>{severityBadge(row.severity, row.status)}</TableCell>
                      <TableCell className="text-xs text-slate-600 whitespace-nowrap">
                        {fmtTimestamp(row.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Link href={`/admin/audit-logs?userId=${row.userId}`}>
                          <a
                            className="inline-flex items-center gap-1 text-xs text-violet-600 hover:text-violet-800"
                            data-testid={`link-audit-${row.userId}`}
                          >
                            View
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </Link>
                      </TableCell>
                    </TableRow>
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
      </p>
    </div>
  );
}
