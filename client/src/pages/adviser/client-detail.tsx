import { useQuery } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { clientDisplayName } from "@shared/display-name";
import { apiFetch } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ArrowLeft,
  FileText,
  ClipboardList,
  Briefcase,
  ArrowLeftRight,
  Target,
  AlertTriangle,
  ShieldAlert,
  ListChecks,
} from "lucide-react";
import {
  WealthPlannerPanel,
  AdviceStatusBadge,
  isAdviceRecordLocked,
} from "@/components/adviser/wealth-planner-panel";

// =============================================================================
// Task #279 — adviser client detail page redesign
// -----------------------------------------------------------------------------
// The page is structured into three clear zones:
//   1. Identity      — name, email, KYC + tier badges (no action buttons)
//   2. Compliance banner (optional) — shown above the tabs when the client is
//      a wholesale/professional investor so the adviser can't miss it
//   3. Tabs          — Overview / Transactions / Advice & Fees / Wealth planner
//
// The Overview tab holds the auditable portfolio summary: live total with the
// "as at" + FX-source subtitle, a per-bucket asset-class breakdown, and a
// wallet table that shows balance + AUD equivalent + % of portfolio. The
// "View Holdings" button lives next to the portfolio total here, not in the
// page header — advisers rarely need it before they've looked at the totals.
//
// Tab labels carry status indicators:
//   * "Advice & Fees" shows a red dot with the count of fee consents that are
//     expiring (≤30d) or expired/cancelled, plus advice records under
//     compliance review (`review_pending`). Hidden when the count is zero.
//   * "Wealth planner" shows a "disclaimer required" pill when at least one
//     advice record has not been acknowledged by the client (using the new
//     `clientAcknowledged` flag from the detail endpoint — derived from the
//     same gate as `requireAcknowledgedAdvice`).
//
// The Wealth planner tab gates the planner content behind an amber banner
// when the most-recent advice record has no acknowledgement, but still
// renders the planner so the adviser can keep working while the client
// completes the disclaimer.
// =============================================================================

interface ClientDetail {
  client: {
    id: number;
    email: string;
    firstName: string;
    lastName: string;
    kycStatus: string;
    userTier: string;
    emailVerified: boolean;
  };
  feeConsents: Array<{
    id: number;
    feeType: string;
    amountType: string;
    amount: string;
    consentExpiryDate: string | null;
    renewalStatus: string;
  }>;
  adviceRecords: Array<{
    id: number;
    adviceType: string;
    status: string;
    createdAt: string | null;
    clientAcknowledged: boolean;
  }>;
}

interface PortfolioPayload {
  portfolio: {
    totalValue: string;
    fiatValue: string;
    cryptoValue: string;
    stablecoinValue: string;
    investmentValue: string;
    cashBalance: string | null;
    hasUnpricedWallets?: boolean;
    unpricedCurrencies?: string[];
  } | null;
  wallets: Array<{
    id: number;
    currency: string;
    balance: string;
    audValue: string | null;
  }>;
  asOfDate: string;
}

interface TransactionRow {
  id: number;
  type: string;
  fromCurrency: string | null;
  toCurrency: string | null;
  amount: string;
  fee: string;
  status: string;
  description: string;
  createdAt: string | null;
}

const PROFESSIONAL_TIERS = new Set(["professional", "wholesale"]);

function formatAud(value: string | number | null | undefined): string {
  if (value == null) return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
  }).format(n);
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString("en-AU", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

function formatPercentOfTotal(part: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "—";
  const pct = (part / total) * 100;
  if (!Number.isFinite(pct)) return "—";
  return `${pct.toFixed(1)}%`;
}

function statusBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  const s = status.toLowerCase();
  if (s.includes("complet") || s.includes("settled") || s === "active") return "default";
  if (s.includes("pending") || s.includes("processing")) return "secondary";
  if (s.includes("fail") || s.includes("cancel") || s.includes("reject")) return "destructive";
  return "outline";
}

// ----- Fee consent helpers -------------------------------------------------

const EXPIRING_SOON_DAYS = 30;

function feeConsentExpiringWithin(
  consent: { consentExpiryDate: string | null; renewalStatus: string },
  days: number,
  now: Date = new Date(),
): boolean {
  if (!consent.consentExpiryDate) return false;
  const expiry = new Date(consent.consentExpiryDate);
  if (Number.isNaN(expiry.getTime())) return false;
  const diffMs = expiry.getTime() - now.getTime();
  return diffMs >= 0 && diffMs <= days * 24 * 60 * 60 * 1000;
}

function feeConsentNeedsAttention(consent: {
  consentExpiryDate: string | null;
  renewalStatus: string;
}): boolean {
  const status = (consent.renewalStatus || "").toLowerCase();
  if (status !== "active") return true; // expired / cancelled / withdrawn
  return feeConsentExpiringWithin(consent, EXPIRING_SOON_DAYS);
}

function findActiveFeeConsent(
  consents: ClientDetail["feeConsents"],
): ClientDetail["feeConsents"][number] | null {
  // Prefer the active consent with the latest expiry date.
  const actives = consents.filter(
    (c) => (c.renewalStatus || "").toLowerCase() === "active",
  );
  if (actives.length === 0) return null;
  return actives.reduce((best, c) => {
    if (!best.consentExpiryDate) return c;
    if (!c.consentExpiryDate) return best;
    return new Date(c.consentExpiryDate) > new Date(best.consentExpiryDate)
      ? c
      : best;
  });
}

export default function AdviserClientDetail() {
  const [, params] = useRoute<{ id: string }>("/adviser/clients/:id");
  const clientId = params?.id;

  // Note: the global queryFn only uses queryKey[0] as the URL, so segmented
  // keys need an explicit queryFn that composes the full path. The segmented
  // key is still useful for cache invalidation across nested resources.
  const detail = useQuery<ClientDetail>({
    queryKey: ["/api/adviser/clients", clientId],
    enabled: !!clientId,
    queryFn: async () => {
      const res = await apiFetch(`/api/adviser/clients/${clientId}`);
      return res.json();
    },
  });
  const portfolio = useQuery<PortfolioPayload>({
    queryKey: ["/api/adviser/clients", clientId, "portfolio"],
    enabled: !!clientId,
    queryFn: async () => {
      const res = await apiFetch(`/api/adviser/clients/${clientId}/portfolio`);
      return res.json();
    },
  });
  const txs = useQuery<TransactionRow[]>({
    queryKey: ["/api/adviser/clients", clientId, "transactions"],
    enabled: !!clientId,
    queryFn: async () => {
      const res = await apiFetch(`/api/adviser/clients/${clientId}/transactions`);
      return res.json();
    },
  });

  if (detail.isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (detail.isError || !detail.data) {
    return (
      <div className="p-6">
        <Link href="/adviser/clients">
          <Button variant="ghost" size="sm" className="mb-4" data-testid="button-back">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to clients
          </Button>
        </Link>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-red-600" data-testid="text-error">
              Unable to load this client. They may not be linked to your adviser account.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { client, feeConsents, adviceRecords } = detail.data;
  const isProfessional = PROFESSIONAL_TIERS.has((client.userTier || "").toLowerCase());

  // Tab badges
  const adviceFeesAttentionCount =
    feeConsents.filter(feeConsentNeedsAttention).length +
    adviceRecords.filter((r) => isAdviceRecordLocked(r.status)).length;
  const someAdviceUnacknowledged = adviceRecords.some(
    (r) => r.clientAcknowledged === false,
  );

  // Most-recent advice record drives the planner gate. Records are returned
  // in createdAt DESC order from the backend.
  const mostRecentAdvice = adviceRecords[0] ?? null;
  const plannerNeedsAck =
    mostRecentAdvice != null && mostRecentAdvice.clientAcknowledged === false;

  const activeFeeConsent = findActiveFeeConsent(feeConsents);

  return (
    <div className="p-6 space-y-6" data-testid="page-adviser-client-detail">
      {/* ==================================================================
          ZONE 1 — IDENTITY
          ================================================================== */}
      <div data-testid="zone-identity">
        <Link href="/adviser/clients">
          <Button variant="ghost" size="sm" className="mb-2" data-testid="button-back">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1
              className="text-2xl font-bold text-gray-900"
              data-testid="text-client-name"
            >
              {clientDisplayName(client, client.id)}
            </h1>
            <p className="text-sm text-gray-500" data-testid="text-client-email">
              {client.email}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge
              variant={client.kycStatus === "verified" ? "default" : "secondary"}
              data-testid="badge-kyc"
            >
              KYC: {client.kycStatus}
            </Badge>
            <Badge variant="outline" className="capitalize" data-testid="badge-tier">
              {client.userTier}
            </Badge>
          </div>
        </div>
      </div>

      {/* ==================================================================
          ZONE 2 — COMPLIANCE BANNER (professional / wholesale only)
          ================================================================== */}
      {isProfessional && (
        <div
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 flex items-start gap-2"
          role="alert"
          data-testid="banner-professional-investor"
        >
          <ShieldAlert className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div>
            <span className="font-medium">Wholesale / Professional Investor</span>
            {" — standard retail disclosure obligations may not apply. Verify applicable obligations before issuing advice."}
          </div>
        </div>
      )}

      {/* ==================================================================
          ZONE 3 — TABS
          ================================================================== */}
      <Tabs defaultValue="overview" className="space-y-4" data-testid="tabs-client-detail">
        <TabsList>
          <TabsTrigger value="overview" data-testid="tab-overview">Overview</TabsTrigger>
          <TabsTrigger value="transactions" data-testid="tab-transactions">Transactions</TabsTrigger>
          <TabsTrigger value="advice" data-testid="tab-advice">
            Advice &amp; Fees
            {adviceFeesAttentionCount > 0 && (
              <Badge
                variant="destructive"
                className="ml-2 h-4 min-w-4 px-1 text-[10px] leading-none"
                data-testid="badge-advice-attention-count"
              >
                {adviceFeesAttentionCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="tasks" data-testid="tab-tasks">
            <ListChecks className="h-4 w-4 mr-1" />
            Tasks
          </TabsTrigger>
          <TabsTrigger value="planner" data-testid="tab-planner">
            <Target className="h-4 w-4 mr-1" />
            Wealth planner
            {someAdviceUnacknowledged && (
              <Badge
                variant="outline"
                className="ml-2 border-amber-400 bg-amber-50 text-amber-800 text-[10px] py-0 h-4"
                data-testid="badge-planner-disclaimer-required"
                title="At least one advice record has not been acknowledged by the client"
              >
                disclaimer required
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* OVERVIEW TAB */}
        <TabsContent value="overview" className="space-y-6">
          <PortfolioSummaryCard
            portfolioPayload={portfolio.data}
            isLoading={portfolio.isLoading}
            isError={portfolio.isError}
            clientId={client.id}
          />
        </TabsContent>

        {/* TRANSACTIONS TAB */}
        <TabsContent value="transactions" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <ArrowLeftRight className="h-4 w-4 text-sky-500" />
                Cash &amp; transactions (read-only)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {txs.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : txs.isError ? (
                <p className="text-sm text-red-600">Unable to load transactions.</p>
              ) : !txs.data || txs.data.length === 0 ? (
                <p className="text-sm text-gray-500" data-testid="text-no-transactions">
                  No transactions on file for this client.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Fee</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {txs.data.map((t) => (
                      <TableRow key={t.id} data-testid={`row-tx-${t.id}`}>
                        <TableCell className="text-sm">{formatDate(t.createdAt)}</TableCell>
                        <TableCell className="text-sm capitalize">
                          {t.type.replace(/_/g, " ")}
                        </TableCell>
                        <TableCell className="text-sm text-gray-600">{t.description}</TableCell>
                        <TableCell className="text-sm tabular-nums text-right">
                          {Number(t.amount).toLocaleString("en-AU", { maximumFractionDigits: 8 })}
                          {t.toCurrency ? ` ${t.toCurrency}` : t.fromCurrency ? ` ${t.fromCurrency}` : ""}
                        </TableCell>
                        <TableCell className="text-sm tabular-nums text-right text-gray-500">
                          {Number(t.fee) > 0 ? Number(t.fee).toLocaleString("en-AU", { maximumFractionDigits: 8 }) : "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusBadgeVariant(t.status)} className="capitalize">
                            {t.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ADVICE & FEES TAB */}
        <TabsContent value="advice" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4 text-violet-500" />
                Fee consents
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <FeeConsentStatusPill activeConsent={activeFeeConsent} />
              {feeConsents.length === 0 ? (
                <p className="text-sm text-gray-500">No fee consents on file.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {feeConsents.map((fc) => (
                      <TableRow key={fc.id} data-testid={`row-fee-${fc.id}`}>
                        <TableCell className="capitalize text-sm">
                          {fc.feeType.replace(/_/g, " ")}
                        </TableCell>
                        <TableCell className="text-sm tabular-nums">
                          {fc.amountType === "percentage" ? `${fc.amount}%` : formatAud(fc.amount)}
                        </TableCell>
                        <TableCell className="text-sm">{formatDate(fc.consentExpiryDate)}</TableCell>
                        <TableCell>
                          <Badge variant={fc.renewalStatus === "active" ? "default" : "secondary"}>
                            {fc.renewalStatus}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <ClipboardList className="h-4 w-4 text-emerald-500" />
                Recent advice records
              </CardTitle>
            </CardHeader>
            <CardContent>
              {adviceRecords.length === 0 ? (
                <p className="text-sm text-gray-500">No advice records on file.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {adviceRecords.map((ar) => (
                      <TableRow key={ar.id} data-testid={`row-advice-${ar.id}`}>
                        <TableCell className="capitalize text-sm">
                          {ar.adviceType.replace(/_/g, " ")}
                        </TableCell>
                        <TableCell>
                          <AdviceStatusBadge status={ar.status} />
                        </TableCell>
                        <TableCell className="text-sm">{formatDate(ar.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* TASKS TAB — adviser-side task list scoped to this client.
            Pulled in for Task #285 so completion notes and next-review
            dates recorded on the workflow page are visible in the client
            record (which is the audit-of-record location). */}
        <TabsContent value="tasks" className="space-y-4">
          <ClientTasksCard clientUserId={client.id} />
        </TabsContent>

        {/* WEALTH PLANNER TAB */}
        <TabsContent value="planner" className="space-y-4">
          {plannerNeedsAck && mostRecentAdvice && (
            <div
              className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 flex items-start gap-2"
              role="alert"
              data-testid="banner-planner-disclaimer-missing"
            >
              <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <div>
                <div className="font-medium">
                  Client has not yet acknowledged the general advice disclaimer.
                </div>
                <p className="text-xs mt-1">
                  Plan details are not visible to the client until this is
                  completed (advice record #{mostRecentAdvice.id}).
                </p>
              </div>
            </div>
          )}
          <WealthPlannerPanel
            clientId={client.id}
            adviceRecords={adviceRecords}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ===========================================================================
// PORTFOLIO SUMMARY CARD
// ---------------------------------------------------------------------------
// Renders the middle zone described in the task: total value with the as-at
// + FX provenance subtitle, the asset-class breakdown row with progress
// bars, and the wallet table sorted by AUD equivalent descending.
// ===========================================================================

function PortfolioSummaryCard({
  portfolioPayload,
  isLoading,
  isError,
  clientId,
}: {
  portfolioPayload: PortfolioPayload | undefined;
  isLoading: boolean;
  isError: boolean;
  clientId: number;
}) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Portfolio</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (isError || !portfolioPayload) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-red-600">Unable to load portfolio.</p>
        </CardContent>
      </Card>
    );
  }

  const { portfolio, wallets, asOfDate } = portfolioPayload;
  const totalValue = portfolio ? Number(portfolio.totalValue) : 0;
  const fiatValue = portfolio ? Number(portfolio.fiatValue) : 0;
  const cryptoValue = portfolio ? Number(portfolio.cryptoValue) : 0;
  const stablecoinValue = portfolio ? Number(portfolio.stablecoinValue) : 0;
  const investmentValue = portfolio ? Number(portfolio.investmentValue) : 0;
  const hasUnpriced = !!portfolio?.hasUnpricedWallets;
  const unpricedCurrencies = portfolio?.unpricedCurrencies ?? [];

  const buckets: Array<{ key: string; label: string; value: number }> = [
    { key: "fiat", label: "Fiat", value: fiatValue },
    { key: "stablecoins", label: "Stablecoins", value: stablecoinValue },
    { key: "crypto", label: "Crypto", value: cryptoValue },
    { key: "investments", label: "Investments", value: investmentValue },
  ].filter((b) => b.value > 0);

  // Sort wallets by AUD equivalent descending; unpriced wallets fall to
  // the bottom so the table still leads with what the adviser can audit.
  const sortedWallets = [...wallets].sort((a, b) => {
    const aV = a.audValue == null ? -1 : Number(a.audValue);
    const bV = b.audValue == null ? -1 : Number(b.audValue);
    return bV - aV;
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Portfolio</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Total value + as-at + View Holdings link */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase text-gray-500">Total value</div>
            <div
              className="text-2xl font-bold tabular-nums"
              data-testid="text-portfolio-total"
            >
              {formatAud(totalValue)}
            </div>
            <div
              className="text-xs text-gray-500 mt-1"
              data-testid="text-portfolio-asat"
            >
              As at {formatDate(asOfDate)} · FX rates from AMAX consolidated rates
            </div>
          </div>
          <Link href={`/adviser/clients/${clientId}/holdings`}>
            <Button variant="outline" size="sm" data-testid="button-view-holdings">
              <Briefcase className="h-4 w-4 mr-2" />
              View Holdings
            </Button>
          </Link>
        </div>

        <p className="text-xs text-gray-500" data-testid="text-portfolio-source-note">
          Portfolio data is sourced from the custodian and updated daily. To act
          on this data, create an advice record.
        </p>

        {/* Bucket breakdown row */}
        {buckets.length > 0 && (
          <div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3"
            data-testid="grid-asset-buckets"
          >
            {buckets.map((b) => {
              const pct = totalValue > 0 ? (b.value / totalValue) * 100 : 0;
              return (
                <div
                  key={b.key}
                  className="rounded-md border bg-white p-3 space-y-1"
                  data-testid={`bucket-${b.key}`}
                >
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span className="uppercase tracking-wide">{b.label}</span>
                    <span className="tabular-nums">{pct.toFixed(1)}%</span>
                  </div>
                  <div className="text-base font-semibold tabular-nums">
                    {formatAud(b.value)}
                  </div>
                  <Progress value={Math.min(100, pct)} className="h-1.5" />
                </div>
              );
            })}
          </div>
        )}

        {/* Wallet table */}
        <div>
          <div className="text-xs uppercase text-gray-500 mb-2">Wallets</div>
          {sortedWallets.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="text-no-wallets">
              No wallets on file for this client.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Currency</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead className="text-right">AUD Equivalent</TableHead>
                  <TableHead className="text-right">% of Portfolio</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedWallets.map((w) => {
                  const audNum = w.audValue == null ? null : Number(w.audValue);
                  return (
                    <TableRow key={w.id} data-testid={`row-wallet-${w.id}`}>
                      <TableCell className="text-sm font-medium">
                        {w.currency}
                      </TableCell>
                      <TableCell className="text-sm tabular-nums text-right">
                        {Number(w.balance).toLocaleString("en-AU", {
                          maximumFractionDigits: 8,
                        })}
                      </TableCell>
                      <TableCell className="text-sm tabular-nums text-right">
                        {audNum == null ? (
                          <span
                            className="text-amber-700"
                            title="No FX rate available for this currency"
                          >
                            unpriced
                          </span>
                        ) : (
                          formatAud(audNum)
                        )}
                      </TableCell>
                      <TableCell className="text-sm tabular-nums text-right">
                        {audNum == null
                          ? "—"
                          : formatPercentOfTotal(audNum, totalValue)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {hasUnpriced && unpricedCurrencies.length > 0 && (
            <p
              className="text-xs text-amber-700 mt-2 flex items-start gap-1"
              data-testid="text-unpriced-note"
            >
              <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
              <span>
                No FX rate available for: {unpricedCurrencies.join(", ")}.
                Percentages may not sum to 100%.
              </span>
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ===========================================================================
// FEE CONSENT STATUS PILL
// ---------------------------------------------------------------------------
// Single-line pill summarising the client's current fee-consent state. Sits
// above the existing fee consent table on the Advice & Fees tab.
// ===========================================================================

function FeeConsentStatusPill({
  activeConsent,
}: {
  activeConsent: ClientDetail["feeConsents"][number] | null;
}) {
  if (activeConsent) {
    return (
      <div
        className="inline-flex items-center gap-2 rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800"
        data-testid="pill-fee-consent-active"
      >
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        Fee Consent: Active · Expires {formatDate(activeConsent.consentExpiryDate)}
      </div>
    );
  }
  return (
    <div
      className="inline-flex items-center gap-2 rounded-full border border-red-300 bg-red-50 px-3 py-1 text-xs font-medium text-red-800"
      data-testid="pill-fee-consent-expired"
    >
      <span className="h-2 w-2 rounded-full bg-red-500" />
      Fee Consent: Expired
    </div>
  );
}

// ===========================================================================
// CLIENT TASKS CARD (Task #285)
// ---------------------------------------------------------------------------
// Lists adviser-side tasks scoped to a single client. The /api/adviser/tasks
// endpoint accepts a `clientUserId` filter so the same listing query that
// powers the workflow page can be re-used here without a new endpoint.
// Both open and completed tasks are shown so completion notes and the next
// scheduled review remain visible after closure.
// ===========================================================================

interface ClientTaskRow {
  id: number;
  taskType: string;
  title: string;
  notes: string | null;
  status: string;
  priority: string;
  dueAt: string | null;
  completedAt: string | null;
  completionNotes: string | null;
  nextReviewAt: string | null;
  createdAt: string | null;
}

function ClientTasksCard({ clientUserId }: { clientUserId: number }) {
  const tasks = useQuery<ClientTaskRow[]>({
    queryKey: ["/api/adviser/tasks", { clientUserId }],
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-slate-500" />
          Tasks for this client
        </CardTitle>
      </CardHeader>
      <CardContent>
        {tasks.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : tasks.isError ? (
          <p className="text-sm text-red-600">Unable to load tasks.</p>
        ) : !tasks.data || tasks.data.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="text-no-client-tasks">
            No tasks have been raised for this client.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead>Next review</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.data.map((t) => (
                <TableRow key={t.id} data-testid={`row-client-task-${t.id}`}>
                  <TableCell className="text-sm font-medium text-gray-900">
                    {t.title}
                  </TableCell>
                  <TableCell className="text-sm capitalize text-gray-600">
                    {t.taskType.replace(/_/g, " ")}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={t.status === "done" ? "secondary" : "outline"}
                      className="capitalize"
                    >
                      {t.status.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-gray-600">
                    {t.dueAt ? formatDate(t.dueAt) : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-gray-600">
                    {t.completedAt ? formatDate(t.completedAt) : "—"}
                  </TableCell>
                  <TableCell
                    className="text-sm text-gray-600"
                    data-testid={`cell-task-next-review-${t.id}`}
                  >
                    {t.nextReviewAt ? formatDate(t.nextReviewAt) : "—"}
                  </TableCell>
                  <TableCell
                    className="text-xs text-gray-600 max-w-[280px] whitespace-pre-wrap"
                    data-testid={`cell-task-completion-notes-${t.id}`}
                  >
                    {t.completionNotes || (
                      <span className="text-gray-400">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
