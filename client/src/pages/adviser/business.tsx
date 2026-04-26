import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
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

export default function AdviserBusiness() {
  const clients = useQuery<AdviserClientRow[]>({ queryKey: ["/api/adviser/clients"] });
  const summary = useQuery<DashboardSummary>({ queryKey: ["/api/adviser/dashboard"] });

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
    const tiers = Array.from(tierBuckets.entries())
      .map(([tier, v]) => ({ tier, count: v.count, aum: v.aum }))
      .sort((a, b) => b.aum - a.aum);

    const topClients = [...rows]
      .sort((a, b) => safeNum(b.portfolioValueAud) - safeNum(a.portfolioValueAud))
      .slice(0, 5);

    return {
      totalAum,
      totalConsents,
      verifiedKyc,
      kycPending,
      tiers,
      topClients,
      avgAum: rows.length > 0 ? totalAum / rows.length : 0,
    };
  }, [clients.data]);

  const isLoading = clients.isLoading || summary.isLoading;

  return (
    <div className="p-6 space-y-6" data-testid="page-adviser-business">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <TrendingUp className="h-6 w-6 text-emerald-500" />
          Business
        </h1>
        <p className="text-sm text-slate-500 mt-1 max-w-2xl">
          Read-only snapshot of your client book — assets under advice, tier mix, KYC and fee
          consent coverage. Fee estimates are indicative only and subject to active client
          consent, AMAX platform approval, deduction processing and reconciliation. They do
          not represent settled income.
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
                <p className="text-[11px] text-slate-500 mt-1">
                  Avg per client {formatAud(stats.avgAum)}
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
              </>
            )}
          </CardContent>
        </Card>
      </div>

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
                  const pct = stats.totalAum > 0 ? (t.aum / stats.totalAum) * 100 : 0;
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
                      <div className="text-right text-[11px] text-slate-400 mt-0.5 tabular-nums">
                        {pct.toFixed(1)}% of book
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.topClients.map((c) => (
                    <TableRow key={c.userId} data-testid={`row-top-client-${c.userId}`}>
                      <TableCell>
                        <Link href={`/adviser/clients/${c.userId}`}>
                          <a className="font-medium text-slate-900 hover:text-sky-600">
                            {c.firstName} {c.lastName}
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
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Disclosures</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-slate-500 space-y-1">
          <p>
            All figures are read-only snapshots. AMAX Wealth holds the AFSL and acts as product
            issuer; you act as the client's Authorised Representative. No revenue or fee deduction
            shown here represents settled income — refer to your firm's reconciliation reports for
            final amounts.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
