import { useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch, useLocation } from "wouter";
import { clientDisplayName } from "@shared/display-name";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
import { ArrowRight, Search, Users, AlertTriangle } from "lucide-react";

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
  feeConsentExpiringAt: string | null;
  portfolioValueAud: string;
  lastActivityAt: string | null;
}

// ---- Filter state types ----------------------------------------------------
type KycFilter = "all" | "verified" | "pending" | "rejected" | "failed";
type FeeFilter = "all" | "active" | "expiring" | "none";

const KYC_OPTIONS: Array<{ value: KycFilter; label: string }> = [
  { value: "all", label: "All KYC" },
  { value: "verified", label: "Verified" },
  { value: "pending", label: "Pending" },
  { value: "rejected", label: "Rejected" },
  { value: "failed", label: "Failed" },
];
const FEE_OPTIONS: Array<{ value: FeeFilter; label: string }> = [
  { value: "all", label: "All fee consents" },
  { value: "active", label: "Active" },
  { value: "expiring", label: "Expiring (≤30d)" },
  { value: "none", label: "None" },
];

// ---- Formatters ------------------------------------------------------------
// Whole-AUD with thousands separators and an em-dash for "no value". Drops
// the misleading $0.00 / $0.000 cells the unit-precision formatter used to
// render for clients whose live valuation came back as zero or unavailable.
function formatPortfolioAud(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  }).format(n);
}

function tierLabel(t: string): string {
  if (!t) return "—";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ---- Date helpers ----------------------------------------------------------
function diffDays(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function formatRelative(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

function formatExpiryShort(date: Date): string {
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}
function formatExpiryMonth(date: Date): string {
  return date.toLocaleDateString("en-AU", { month: "short", year: "numeric" });
}

// ---- KYC badge -------------------------------------------------------------
// Coloured-dot badge so an adviser can scan the column and spot the rows that
// need attention without reading the label. Failed and rejected map to the
// same red treatment because the adviser action is the same in both cases.
function KycDotBadge({ status }: { status: string }) {
  const normalised = (status || "").toLowerCase();
  let dot = "bg-amber-500";
  let text = "text-amber-800";
  let bg = "bg-amber-50";
  let border = "border-amber-200";
  let label = status || "—";
  if (normalised === "verified") {
    dot = "bg-emerald-500";
    text = "text-emerald-800";
    bg = "bg-emerald-50";
    border = "border-emerald-200";
    label = "Verified";
  } else if (normalised === "rejected" || normalised === "failed") {
    dot = "bg-rose-500";
    text = "text-rose-800";
    bg = "bg-rose-50";
    border = "border-rose-200";
    label = normalised === "failed" ? "Failed" : "Rejected";
  } else if (normalised === "pending") {
    label = "Pending";
  } else {
    label = label.charAt(0).toUpperCase() + label.slice(1);
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${bg} ${border} ${text}`}
      data-testid={`badge-kyc-${normalised || "unknown"}`}
    >
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}

// ---- Fee consent cell ------------------------------------------------------
function FeeConsentCell({
  count,
  expiringAt,
  testId,
}: {
  count: number;
  expiringAt: string | null;
  testId: string;
}) {
  if (!expiringAt || count <= 0) {
    return (
      <span className="text-xs text-slate-400" data-testid={testId}>
        None
      </span>
    );
  }
  const date = new Date(expiringAt);
  if (Number.isNaN(date.getTime())) {
    return (
      <span className="text-xs text-slate-400" data-testid={testId}>
        None
      </span>
    );
  }
  const now = new Date();
  const days = diffDays(now, date);
  if (days <= 30) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs font-medium text-amber-700"
        data-testid={testId}
      >
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        Expiring {formatExpiryShort(date)}
      </span>
    );
  }
  return (
    <span className="text-xs text-slate-700" data-testid={testId}>
      <span className="font-medium text-emerald-700">Active</span>
      <span className="text-slate-400"> · exp </span>
      {formatExpiryMonth(date)}
    </span>
  );
}

// ---- Filter helpers --------------------------------------------------------
function feeStateFor(row: AdviserClientRow, now: Date): FeeFilter {
  if (!row.feeConsentExpiringAt || row.activeFeeConsents <= 0) return "none";
  const date = new Date(row.feeConsentExpiringAt);
  if (Number.isNaN(date.getTime())) return "none";
  return diffDays(now, date) <= 30 ? "expiring" : "active";
}

function kycStateFor(row: AdviserClientRow): KycFilter {
  const s = (row.kycStatus || "").toLowerCase();
  if (s === "verified" || s === "pending" || s === "rejected" || s === "failed") {
    return s;
  }
  return "all"; // unknown → won't match any specific filter
}

// ---- Page ------------------------------------------------------------------
export default function AdviserClients() {
  const { data, isLoading } = useQuery<AdviserClientRow[]>({
    queryKey: ["/api/adviser/clients"],
  });
  // useSearch subscribes to the live querystring; useLocation only tracks
  // pathname, which would miss ?q= updates when only the query changes.
  const searchString = useSearch();
  const [, setLocation] = useLocation();

  const { query, kycFilter, feeFilter } = useMemo(() => {
    const params = new URLSearchParams(searchString);
    const q = (params.get("q") ?? "").toLowerCase().trim();
    const rawKyc = (params.get("kyc") ?? "all").toLowerCase();
    const rawFee = (params.get("fee") ?? "all").toLowerCase();
    const kyc: KycFilter =
      rawKyc === "verified" ||
      rawKyc === "pending" ||
      rawKyc === "rejected" ||
      rawKyc === "failed"
        ? rawKyc
        : "all";
    const fee: FeeFilter =
      rawFee === "active" || rawFee === "expiring" || rawFee === "none"
        ? rawFee
        : "all";
    return { query: q, kycFilter: kyc, feeFilter: fee };
  }, [searchString]);

  // Push a new querystring without changing the path. `replace: true` keeps
  // typing in the search box from spamming the browser history stack.
  const updateUrl = useCallback(
    (next: { q?: string; kyc?: KycFilter; fee?: FeeFilter }) => {
      const params = new URLSearchParams(searchString);
      const setOrDelete = (key: string, value: string | undefined) => {
        if (!value || value === "" || value === "all") params.delete(key);
        else params.set(key, value);
      };
      if (next.q !== undefined) setOrDelete("q", next.q);
      if (next.kyc !== undefined) setOrDelete("kyc", next.kyc);
      if (next.fee !== undefined) setOrDelete("fee", next.fee);
      const qs = params.toString();
      setLocation(qs ? `/adviser/clients?${qs}` : "/adviser/clients", {
        replace: true,
      });
    },
    [searchString, setLocation],
  );

  const filtered = useMemo(() => {
    const rows = data ?? [];
    if (rows.length === 0) return rows;
    const now = new Date();
    return rows.filter((r) => {
      if (query) {
        const hay = `${r.firstName} ${r.lastName} ${r.email}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      if (kycFilter !== "all") {
        if (kycStateFor(r) !== kycFilter) return false;
      }
      if (feeFilter !== "all") {
        if (feeStateFor(r, now) !== feeFilter) return false;
      }
      return true;
    });
  }, [data, query, kycFilter, feeFilter]);

  const filtersActive =
    query !== "" || kycFilter !== "all" || feeFilter !== "all";

  return (
    <div className="p-6 space-y-6" data-testid="page-adviser-clients">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Linked Clients</h1>
        <p className="text-sm text-gray-500 mt-1">
          Read-only view. Click a row to see KYC, fee consents and recent advice records.
        </p>
      </div>

      {/* Filter bar — search + KYC + fee consent. URL-synced so the view is
          shareable and the back button restores the same filter state. */}
      <Card data-testid="card-clients-filters">
        <CardContent className="p-4">
          <div className="flex flex-col md:flex-row md:items-center md:gap-3 gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <Input
                value={query}
                onChange={(e) =>
                  updateUrl({ q: e.target.value.toLowerCase().trim() })
                }
                placeholder="Search by name or email"
                className="pl-8"
                data-testid="input-clients-search"
              />
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={kycFilter}
                onValueChange={(v) => updateUrl({ kyc: v as KycFilter })}
              >
                <SelectTrigger
                  className="w-[160px]"
                  data-testid="select-kyc-filter"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KYC_OPTIONS.map((o) => (
                    <SelectItem
                      key={o.value}
                      value={o.value}
                      data-testid={`option-kyc-${o.value}`}
                    >
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={feeFilter}
                onValueChange={(v) => updateUrl({ fee: v as FeeFilter })}
              >
                <SelectTrigger
                  className="w-[180px]"
                  data-testid="select-fee-filter"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FEE_OPTIONS.map((o) => (
                    <SelectItem
                      key={o.value}
                      value={o.value}
                      data-testid={`option-fee-${o.value}`}
                    >
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle
            className="text-base flex items-center gap-2"
            data-testid="text-clients-count"
          >
            <Users className="h-4 w-4 text-sky-500" />
            {isLoading
              ? "Loading…"
              : `${filtered.length} of ${data?.length ?? 0} linked client${data?.length === 1 ? "" : "s"}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !data || data.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="text-no-clients">
              No clients are linked to your adviser account yet. The platform team links clients
              via the partner-AFSL onboarding flow.
            </p>
          ) : filtered.length === 0 ? (
            <p
              className="text-sm text-gray-500"
              data-testid="text-no-search-results"
            >
              No clients match{filtersActive ? " the current filters." : "."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>KYC</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Portfolio (AUD)</TableHead>
                  <TableHead>Fee consent</TableHead>
                  <TableHead>Last activity</TableHead>
                  <TableHead className="text-right">Open client</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((row) => (
                  <TableRow key={row.userId} data-testid={`row-client-${row.userId}`}>
                    <TableCell>
                      <div className="font-medium text-gray-900">
                        {clientDisplayName(row, row.userId)}
                      </div>
                      <div className="text-xs text-gray-500">{row.email}</div>
                    </TableCell>
                    <TableCell>
                      <KycDotBadge status={row.kycStatus} />
                    </TableCell>
                    <TableCell className="text-sm text-slate-700">
                      {tierLabel(row.userTier)}
                    </TableCell>
                    <TableCell
                      className="text-right tabular-nums"
                      data-testid={`cell-portfolio-${row.userId}`}
                    >
                      {formatPortfolioAud(row.portfolioValueAud)}
                    </TableCell>
                    <TableCell>
                      <FeeConsentCell
                        count={row.activeFeeConsents}
                        expiringAt={row.feeConsentExpiringAt}
                        testId={`cell-fee-consent-${row.userId}`}
                      />
                    </TableCell>
                    <TableCell
                      className="text-xs text-slate-600"
                      data-testid={`cell-last-activity-${row.userId}`}
                    >
                      {formatRelative(row.lastActivityAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link href={`/adviser/clients/${row.userId}`}>
                        <a
                          className="inline-flex items-center gap-1 rounded-md border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-sky-100"
                          data-testid={`link-open-client-${row.userId}`}
                        >
                          Open client
                          <ArrowRight className="h-3.5 w-3.5" />
                        </a>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
