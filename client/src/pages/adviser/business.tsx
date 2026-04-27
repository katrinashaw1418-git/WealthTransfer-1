import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { clientDisplayName } from "@shared/display-name";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  TrendingUp,
  Users,
  Wallet,
  ShieldCheck,
  Building2,
  AlertCircle,
  Info,
} from "lucide-react";

interface AdviserClientRow {
  userId: number;
  email: string;
  firstName: string;
  lastName: string;
  kycStatus: string;
  userTier: string;
  linkedAt: string | null;
  relationshipType: string;
  activeFeeConsents: number;
  portfolioValueAud: string;
  feeConsentExpiringAt: string | null;
  mostRecentExpiredConsentDate: string | null;
}

// /api/adviser/clients wrapper response — `asOfDate` is the server-derived
// timestamp the live AUM totals were computed at. Surfacing it as a sibling
// field (rather than per-row) means the snapshot timestamp keeps rendering
// even for empty books, and never falls back to the client's own clock.
interface AdviserClientsResponse {
  asOfDate: string;
  clients: AdviserClientRow[];
}

interface DashboardSummary {
  linkedClients: number;
  openTasks: number;
  feeConsentsExpiringSoon: number;
  pendingReports: number;
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

function tierLabel(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

// "Apr 2026" — short month + year, used in fee-consent expiry chips.
function formatExpiryShort(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-AU", {
    month: "short",
    year: "numeric",
    timeZone: "Australia/Sydney",
  }).format(d);
}

// "Snapshot as at 27 Apr 2026 · 14:32 AEST" — anchors the page to the same
// moment the AUM totals were computed, so the figures and the timestamp
// can't drift.
function formatSnapshot(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const datePart = new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Australia/Sydney",
  }).format(d);
  const timePart = new Intl.DateTimeFormat("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Australia/Sydney",
  }).format(d);
  return `Snapshot as at ${datePart} · ${timePart} AEST`;
}

function kycBadge(status: string) {
  const variant: "default" | "secondary" | "destructive" | "outline" =
    status === "verified"
      ? "default"
      : status === "rejected"
        ? "destructive"
        : "secondary";
  return (
    <Badge
      variant={variant}
      className="capitalize"
      data-testid={`badge-kyc-${status}`}
    >
      {status}
    </Badge>
  );
}

// Returns { label, kind, sortKey } for the Top Clients fee-consent column.
//   kind=active   → green   "Active · exp <Mon YYYY>"
//   kind=expired  → amber   "Expired <Mon YYYY>"
//   kind=none     → muted   "None"
// sortKey is used for ascending soonest-expiry order across active consents
// (Number.POSITIVE_INFINITY pushes None / Expired rows to the bottom).
function feeConsentCell(row: AdviserClientRow): {
  kind: "active" | "expired" | "none";
  label: string;
  sortKey: number;
} {
  if (row.activeFeeConsents > 0 && row.feeConsentExpiringAt) {
    const short = formatExpiryShort(row.feeConsentExpiringAt);
    return {
      kind: "active",
      label: short ? `Active · exp ${short}` : "Active",
      sortKey: new Date(row.feeConsentExpiringAt).getTime(),
    };
  }
  if (row.activeFeeConsents > 0) {
    // Active but no expiry came back from the server — shouldn't happen,
    // but render defensively rather than crashing.
    return { kind: "active", label: "Active", sortKey: Number.POSITIVE_INFINITY };
  }
  if (row.mostRecentExpiredConsentDate) {
    const short = formatExpiryShort(row.mostRecentExpiredConsentDate);
    return {
      kind: "expired",
      label: short ? `Expired ${short}` : "Expired",
      sortKey: Number.POSITIVE_INFINITY,
    };
  }
  return { kind: "none", label: "None", sortKey: Number.POSITIVE_INFINITY };
}

export default function AdviserBusiness() {
  const clientsResponse = useQuery<AdviserClientsResponse>({
    queryKey: ["/api/adviser/clients"],
  });
  const summary = useQuery<DashboardSummary>({ queryKey: ["/api/adviser/dashboard"] });
  // Adapter: most of this file (and a half-dozen other adviser pages) reads
  // the response as a flat row list — keep that shape locally and lift the
  // wrapper's asOfDate into a sibling so the snapshot timestamp can render
  // even when there are zero rows.
  const clients = {
    data: clientsResponse.data?.clients,
    isLoading: clientsResponse.isLoading,
  };

  const stats = useMemo(() => {
    const rows = clients.data ?? [];
    const totalAum = rows.reduce((sum, r) => sum + safeNum(r.portfolioValueAud), 0);
    const totalConsents = rows.reduce((sum, r) => sum + safeNum(r.activeFeeConsents), 0);
    const verifiedKyc = rows.filter((r) => r.kycStatus === "verified").length;
    const kycPending = rows.length - verifiedKyc;

    const tierBuckets = new Map<string, { count: number; aum: number }>();
    for (const r of rows) {
      const key = r.userTier || "standard";
      const cur = tierBuckets.get(key) ?? { count: 0, aum: 0 };
      cur.count += 1;
      cur.aum += safeNum(r.portfolioValueAud);
      tierBuckets.set(key, cur);
    }
    // When the book has zero AUM we sort tiers by client count instead so
    // the bar chart still has a sensible biggest-first ordering.
    const tiers = Array.from(tierBuckets.entries())
      .map(([tier, v]) => ({ tier, count: v.count, aum: v.aum }))
      .sort((a, b) =>
        totalAum > 0 ? b.aum - a.aum : b.count - a.count,
      );

    // Top Clients sort: portfolio desc, then by soonest fee-consent expiry
    // so two zero-portfolio clients land in a deterministic, useful order.
    const topClients = [...rows]
      .map((r) => ({ row: r, fee: feeConsentCell(r) }))
      .sort((a, b) => {
        const portfolioDiff = safeNum(b.row.portfolioValueAud) - safeNum(a.row.portfolioValueAud);
        if (portfolioDiff !== 0) return portfolioDiff;
        return a.fee.sortKey - b.fee.sortKey;
      })
      .slice(0, 5);

    // Avg per client — over clients with non-zero portfolios only. When the
    // whole book is at zero, render "—" so the page stops showing $0 next
    // to a populated client list.
    const fundedClients = rows.filter((r) => safeNum(r.portfolioValueAud) > 0);
    const avgAum =
      fundedClients.length > 0
        ? fundedClients.reduce((s, r) => s + safeNum(r.portfolioValueAud), 0) /
          fundedClients.length
        : null;

    // Active fee-consent client list — clients who actually hold a consent,
    // sorted by soonest upcoming expiry. The card surfaces up to three
    // names + "+N more" so advisers don't have to drill into each client.
    const activeFeeClients = rows
      .filter((r) => r.activeFeeConsents > 0 && r.feeConsentExpiringAt)
      .sort(
        (a, b) =>
          new Date(a.feeConsentExpiringAt as string).getTime() -
          new Date(b.feeConsentExpiringAt as string).getTime(),
      );

    return {
      totalAum,
      totalConsents,
      verifiedKyc,
      kycPending,
      tiers,
      topClients,
      avgAum,
      hasFunded: fundedClients.length > 0,
      activeFeeClients,
      totalClients: rows.length,
    };
  }, [clients.data]);

  const isLoading = clients.isLoading || summary.isLoading;
  // Snapshot timestamp comes from the response itself (server-derived,
  // anchored to the same instant the live AUM figures were computed).
  // It renders for empty books too — the wrapper carries asOfDate even
  // when `clients` is `[]` — and never falls back to the client's clock.
  const snapshotLine = formatSnapshot(clientsResponse.data?.asOfDate);

  return (
    <div className="p-6 space-y-6" data-testid="page-adviser-business">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <TrendingUp className="h-6 w-6 text-emerald-500" />
          Business
        </h1>
        {clients.isLoading ? (
          <Skeleton className="h-4 w-64 mt-1" />
        ) : snapshotLine ? (
          <p
            className="text-xs text-slate-500 mt-1 tabular-nums"
            data-testid="text-snapshot-timestamp"
          >
            {snapshotLine}
          </p>
        ) : null}
        <p className="text-sm text-slate-500 mt-2 max-w-2xl">
          Read-only snapshot of your client book — assets under advice, tier mix, KYC and fee
          consent coverage. No figure shown here represents settled income.
        </p>
      </div>

      {/* Headline metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card data-testid="card-total-aum">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium text-slate-600">Assets under advice</CardTitle>
            <Wallet className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-32" />
            ) : (
              <>
                <div className="text-2xl font-bold text-slate-900 tabular-nums">
                  {formatAud(stats.totalAum)}
                </div>
                <p
                  className="text-[11px] text-slate-500 mt-1"
                  data-testid="text-avg-per-client"
                >
                  Avg per client {stats.avgAum === null ? "—" : formatAud(stats.avgAum)}
                </p>
                <p className="text-[10px] text-slate-400 mt-0.5">
                  Excludes clients with no linked portfolio
                </p>
              </>
            )}
          </CardContent>
        </Card>
        <Card data-testid="card-clients">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium text-slate-600">Linked clients</CardTitle>
            <Users className="h-4 w-4 text-sky-500" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-12" />
            ) : (
              <>
                <div className="text-2xl font-bold text-slate-900">
                  {summary.data?.linkedClients ?? clients.data?.length ?? 0}
                </div>
                <p className="text-[11px] text-slate-500 mt-1">
                  Across {stats.tiers.length} tier{stats.tiers.length === 1 ? "" : "s"}
                </p>
              </>
            )}
          </CardContent>
        </Card>
        <Card data-testid="card-kyc-coverage">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium text-slate-600">KYC coverage</CardTitle>
            <ShieldCheck className="h-4 w-4 text-violet-500" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <>
                <div className="text-2xl font-bold text-slate-900">
                  {stats.verifiedKyc}
                  <span className="text-base text-slate-400 font-medium">
                    {" "}
                    / {clients.data?.length ?? 0}
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 mt-1">
                  {stats.kycPending} pending verification
                </p>
              </>
            )}
          </CardContent>
        </Card>
        <Card data-testid="card-fee-consents">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium text-slate-600">Active fee consents</CardTitle>
            <AlertCircle className="h-4 w-4 text-slate-500" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-12" />
            ) : (
              <>
                <div className="text-2xl font-bold text-slate-900">{stats.totalConsents}</div>
                <p className="text-[11px] text-slate-500 mt-1">
                  {summary.data?.feeConsentsExpiringSoon ?? 0} expiring ≤30d
                </p>
                {stats.activeFeeClients.length > 0 ? (
                  <ul
                    className="mt-2 space-y-0.5 text-[11px] text-slate-600"
                    data-testid="list-active-fee-clients"
                  >
                    {stats.activeFeeClients.slice(0, 3).map((c) => (
                      <li
                        key={c.userId}
                        className="truncate"
                        data-testid={`row-active-fee-client-${c.userId}`}
                      >
                        <Link href={`/adviser/clients/${c.userId}`}>
                          <a className="hover:text-sky-600">
                            {clientDisplayName(c, c.userId)} ·{" "}
                            <span className="text-slate-500">
                              exp {formatExpiryShort(c.feeConsentExpiringAt) ?? "—"}
                            </span>
                          </a>
                        </Link>
                      </li>
                    ))}
                    {stats.activeFeeClients.length > 3 ? (
                      <li>
                        <Link href="/adviser/fee-consents">
                          <a
                            className="inline-block mt-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-600 hover:bg-slate-200"
                            data-testid="link-active-fee-clients-more"
                          >
                            +{stats.activeFeeClients.length - 3} more
                          </a>
                        </Link>
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Disclosures — moved up so the qualifier sits above the working data
          it qualifies, with bumped typography + an info icon + subtle border
          so it reads as a qualifier rather than fine print. */}
      <Card
        className="border-slate-300 bg-slate-50/60"
        data-testid="card-disclosures"
      >
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Info className="h-4 w-4 text-slate-500" />
            Disclosures
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-slate-600 leading-relaxed">
          <p>
            All figures are read-only snapshots. AMAX Wealth operates as a platform and authorised
            representative under the relevant AFSL arrangement. Adviser access, client visibility,
            fee consent and product access are subject to AMAX approval, client permissioning and
            the applicable AFSL holder's authorisation. No revenue or fee deduction shown here
            represents settled income — refer to your firm's reconciliation reports for final
            amounts.
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Tier mix */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="h-4 w-4 text-slate-500" />
              Book composition by tier
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : stats.tiers.length === 0 ? (
              <p className="text-sm text-slate-500">No client data available yet.</p>
            ) : (
              <div className="space-y-3">
                {stats.tiers.map((t) => {
                  // When the whole book is at zero AUM, "0.0% of book" reads
                  // like a math error. Switch to client-count share so the
                  // proportion the adviser sees still maps to something
                  // truthful (how many of their clients sit in this tier).
                  const useClientShare = stats.totalAum <= 0;
                  const pct = useClientShare
                    ? stats.totalClients > 0
                      ? (t.count / stats.totalClients) * 100
                      : 0
                    : (t.aum / stats.totalAum) * 100;
                  const pctLabel = useClientShare
                    ? `${t.count} of ${stats.totalClients} clients · ${pct.toFixed(0)}% of book by client count`
                    : `${pct.toFixed(1)}% of book`;
                  return (
                    <div key={t.tier} data-testid={`tier-${t.tier}`}>
                      <div className="flex items-center justify-between text-sm">
                        <div className="font-medium text-slate-700">{tierLabel(t.tier)}</div>
                        <div className="text-slate-500 tabular-nums">
                          {t.count} client{t.count === 1 ? "" : "s"} · {formatAud(t.aum)}
                        </div>
                      </div>
                      <div className="mt-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-emerald-500 rounded-full"
                          style={{ width: `${Math.max(2, pct)}%` }}
                        />
                      </div>
                      <div
                        className="text-right text-[11px] text-slate-400 mt-0.5 tabular-nums"
                        data-testid={`tier-${t.tier}-pct-label`}
                      >
                        {pctLabel}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top clients */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4 text-slate-500" />
              Top clients by portfolio value
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : stats.topClients.length === 0 ? (
              <p className="text-sm text-slate-500">No clients yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead>Tier</TableHead>
                    <TableHead className="text-right">Portfolio</TableHead>
                    <TableHead>KYC</TableHead>
                    <TableHead>Fee consent</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.topClients.map(({ row: c, fee }) => (
                    <TableRow key={c.userId} data-testid={`row-top-client-${c.userId}`}>
                      <TableCell>
                        <Link href={`/adviser/clients/${c.userId}`}>
                          <a className="font-medium text-slate-900 hover:text-sky-600">
                            {clientDisplayName(c, c.userId)}
                          </a>
                        </Link>
                        <div className="text-[11px] text-slate-500">{c.email}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">
                          {c.userTier}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm tabular-nums text-right font-medium">
                        {formatAud(safeNum(c.portfolioValueAud))}
                      </TableCell>
                      <TableCell data-testid={`cell-top-client-kyc-${c.userId}`}>
                        {kycBadge(c.kycStatus)}
                      </TableCell>
                      <TableCell
                        className={
                          fee.kind === "active"
                            ? "text-xs font-medium text-emerald-700"
                            : fee.kind === "expired"
                              ? "text-xs font-medium text-amber-700"
                              : "text-xs text-slate-400"
                        }
                        data-testid={`cell-top-client-fee-${c.userId}`}
                      >
                        {fee.label}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
