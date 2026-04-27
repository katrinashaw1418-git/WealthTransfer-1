import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Building2, AlertCircle, FileSignature, Filter as FilterIcon, X } from "lucide-react";

interface AdviserProduct {
  id: number;
  name: string;
  category: string;
  subCategory: string | null;
  investmentStrategy: string | null;
  targetNetIrr: string | null;
  grossIrr: string | null;
  term: string | null;
  structure: string | null;
  distributions: string | null;
  liquidity: string | null;
  minimumInvestment: string | null;
  riskProfile: string | null;
  returnType: string | null;
  isActive: boolean;
  createdAt: string | null;
}

function formatAud(value: string | null | undefined): string {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

function categoryLabel(category: string): string {
  return category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Lower number = shown first. Crypto/digital-asset strategies are a specialist sleeve and
// always render last for credibility on a wealth-platform shelf.
const CATEGORY_PRIORITY: Record<string, number> = {
  corporate_credit: 1,
  real_estate: 2,
  cash_deposit: 3,
  venture_capital: 4,
  digital_assets: 99,
};

function categoryRank(category: string): number {
  return CATEGORY_PRIORITY[category] ?? 50;
}

// Sentence-case the risk profile label for display. Source data is now stored
// already-normalised ("Low" / "Moderate" / "Medium" / "High" / "Very High"),
// but we still defensively re-format any legacy snake_case or lowercase value
// that might leak through, instead of using the previous CSS `capitalize` hack
// which produces "Very_high".
function formatRiskLabel(profile: string | null | undefined): string {
  if (!profile) return "—";
  const trimmed = profile.trim();
  if (!trimmed) return "—";
  return trimmed
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function riskBadgeVariant(profile: string | null): "default" | "secondary" | "outline" | "destructive" {
  if (!profile) return "outline";
  const p = profile.toLowerCase();
  if (p.includes("very high")) return "destructive";
  if (p.includes("low") || p.includes("conservative")) return "secondary";
  if (p.includes("high") || p.includes("aggressive")) return "default";
  return "outline";
}

// Risk levels listed strongest-to-weakest priority for sorting, then sentence
// cased for display.
const RISK_ORDER = ["Low", "Moderate", "Medium", "High", "Very High"];

function riskRank(profile: string | null | undefined): number {
  const label = formatRiskLabel(profile);
  const idx = RISK_ORDER.indexOf(label);
  return idx === -1 ? 99 : idx;
}

// First numeric value in the targetNetIrr label, used for sorting.
// "10–12% p.a." -> 10. "Market-linked — no target return" -> NaN (ranks last).
function parseLeadingNumber(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const m = value.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : Number.NaN;
}

// Approximate a term string as months for sorting. Open-ended sorts last.
function parseTermMonths(value: string | null | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const lower = value.toLowerCase();
  if (lower.includes("open-ended") || lower.includes("illiquid")) {
    return Number.POSITIVE_INFINITY;
  }
  const num = parseLeadingNumber(value);
  if (!Number.isFinite(num)) return Number.POSITIVE_INFINITY;
  if (lower.includes("year")) return num * 12;
  return num;
}

// Minimum-investment band buckets for the filter. The DB stores AUD as a
// decimal string.
type MinBand = "all" | "lt50k" | "50k_100k" | "100k_250k" | "gte250k";

function minBandMatch(min: string | null | undefined, band: MinBand): boolean {
  if (band === "all") return true;
  const n = Number(min ?? "0");
  if (!Number.isFinite(n)) return false;
  if (band === "lt50k") return n < 50_000;
  if (band === "50k_100k") return n >= 50_000 && n < 100_000;
  if (band === "100k_250k") return n >= 100_000 && n < 250_000;
  if (band === "gte250k") return n >= 250_000;
  return true;
}

type LiquidityBand = "all" | "instant_daily" | "monthly_quarterly" | "locked_illiquid";

function liquidityBandMatch(liquidity: string | null | undefined, band: LiquidityBand): boolean {
  if (band === "all") return true;
  const l = (liquidity ?? "").toLowerCase();
  if (band === "instant_daily") {
    return l.includes("instant") || l.includes("t+0") || l.includes("t+1") || l.includes("daily") || l.includes("same-day") || l.includes("next-day");
  }
  if (band === "monthly_quarterly") {
    return l.includes("monthly") || l.includes("quarterly");
  }
  if (band === "locked_illiquid") {
    return l.includes("locked") || l.includes("illiquid") || l.includes("fixed-term") || l.includes("no early");
  }
  return true;
}

type SortBy = "default" | "irr_desc" | "irr_asc" | "min_asc" | "min_desc" | "term_asc" | "term_desc";

const DEFAULT_FILTERS = {
  category: "all" as string,
  risk: "all" as string,
  minBand: "all" as MinBand,
  liquidity: "all" as LiquidityBand,
  sort: "default" as SortBy,
};

export default function AdviserProducts() {
  const [, setLocation] = useLocation();
  const products = useQuery<AdviserProduct[]>({
    queryKey: ["/api/adviser/products"],
    staleTime: 30_000,
    refetchOnMount: "always",
  });

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const filtersChanged =
    filters.category !== "all" ||
    filters.risk !== "all" ||
    filters.minBand !== "all" ||
    filters.liquidity !== "all" ||
    filters.sort !== "default";

  const allProducts = products.data ?? [];

  // The set of categories present in the loaded list — used so the filter
  // dropdown only shows categories that actually exist on the shelf.
  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    for (const p of allProducts) set.add(p.category);
    return Array.from(set).sort((a, b) => categoryRank(a) - categoryRank(b));
  }, [allProducts]);

  const availableRisks = useMemo(() => {
    const set = new Set<string>();
    for (const p of allProducts) set.add(formatRiskLabel(p.riskProfile));
    return RISK_ORDER.filter((r) => set.has(r));
  }, [allProducts]);

  const filtered = useMemo(() => {
    const list = allProducts.filter((p) => {
      if (filters.category !== "all" && p.category !== filters.category) return false;
      if (filters.risk !== "all" && formatRiskLabel(p.riskProfile) !== filters.risk) return false;
      if (!minBandMatch(p.minimumInvestment, filters.minBand)) return false;
      if (!liquidityBandMatch(p.liquidity, filters.liquidity)) return false;
      return true;
    });

    const sorted = [...list];
    switch (filters.sort) {
      case "irr_desc":
        sorted.sort((a, b) => (parseLeadingNumber(b.targetNetIrr) || -Infinity) - (parseLeadingNumber(a.targetNetIrr) || -Infinity));
        break;
      case "irr_asc":
        sorted.sort((a, b) => (parseLeadingNumber(a.targetNetIrr) || Infinity) - (parseLeadingNumber(b.targetNetIrr) || Infinity));
        break;
      case "min_asc":
        sorted.sort((a, b) => Number(a.minimumInvestment ?? 0) - Number(b.minimumInvestment ?? 0));
        break;
      case "min_desc":
        sorted.sort((a, b) => Number(b.minimumInvestment ?? 0) - Number(a.minimumInvestment ?? 0));
        break;
      case "term_asc":
        sorted.sort((a, b) => parseTermMonths(a.term) - parseTermMonths(b.term));
        break;
      case "term_desc":
        sorted.sort((a, b) => parseTermMonths(b.term) - parseTermMonths(a.term));
        break;
      default:
        sorted.sort((a, b) => {
          const rankDiff = categoryRank(a.category) - categoryRank(b.category);
          if (rankDiff !== 0) return rankDiff;
          const riskDiff = riskRank(a.riskProfile) - riskRank(b.riskProfile);
          if (riskDiff !== 0) return riskDiff;
          return a.name.localeCompare(b.name);
        });
    }
    return sorted;
  }, [allProducts, filters]);

  const digital = filtered.filter((p) => p.category === "digital_assets");
  const nonDigital = filtered.filter((p) => p.category !== "digital_assets");

  if (products.isLoading) {
    return (
      <div className="p-6 space-y-4" data-testid="page-adviser-products-loading">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-64 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (products.isError) {
    return (
      <div className="p-6" data-testid="page-adviser-products-error">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertCircle className="h-4 w-4" />
              Unable to load the product shelf. Please try again.
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleRaiseInstruction = (productId: number) => {
    // The instructions workflow requires an adviser-linked client and an
    // amount, so we deep-link to the shared instructions page with the
    // product preselected via query param. The instructions page falls back
    // to its existing form behaviour if the param is missing.
    setLocation(`/adviser/instructions?productId=${productId}`);
  };

  const renderCard = (p: AdviserProduct) => (
    <Card key={p.id} data-testid={`card-product-${p.id}`} className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Building2 className="h-4 w-4 text-sky-500 flex-shrink-0" />
            <CardTitle
              className="text-base truncate"
              data-testid={`text-product-name-${p.id}`}
            >
              {p.name}
            </CardTitle>
          </div>
          {p.riskProfile && (
            <Badge
              variant={riskBadgeVariant(p.riskProfile)}
              className="text-xs whitespace-nowrap"
              data-testid={`badge-risk-${p.id}`}
            >
              {formatRiskLabel(p.riskProfile)}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <Badge variant="outline" className="text-xs">
            {categoryLabel(p.category)}
          </Badge>
          {p.subCategory && (
            <Badge variant="outline" className="text-xs">
              {categoryLabel(p.subCategory)}
            </Badge>
          )}
        </div>
        {p.investmentStrategy && (
          <p
            className="text-xs text-gray-500 mt-2 line-clamp-3"
            data-testid={`text-strategy-${p.id}`}
          >
            {p.investmentStrategy}
          </p>
        )}
      </CardHeader>
      <CardContent className="flex-1 flex flex-col">
        <dl className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-3 text-sm">
          <div>
            <dt className="text-xs uppercase text-gray-500">Target IRR</dt>
            <dd
              className="font-semibold tabular-nums"
              data-testid={`text-irr-${p.id}`}
            >
              {p.targetNetIrr ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-gray-500">Term</dt>
            <dd className="font-semibold" data-testid={`text-term-${p.id}`}>
              {p.term ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-gray-500">Minimum</dt>
            <dd className="font-semibold tabular-nums" data-testid={`text-min-${p.id}`}>
              {formatAud(p.minimumInvestment)}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-gray-500">Liquidity</dt>
            <dd className="font-semibold" data-testid={`text-liquidity-${p.id}`}>
              {p.liquidity ?? "—"}
            </dd>
          </div>
        </dl>
        <dl className="mt-3 space-y-2 text-sm">
          <div>
            <dt className="text-xs uppercase text-gray-500">Distributions</dt>
            <dd
              className="font-medium"
              data-testid={`text-distributions-${p.id}`}
            >
              {p.distributions ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-gray-500">Structure</dt>
            <dd
              className="text-sm text-gray-700"
              data-testid={`text-structure-${p.id}`}
            >
              {p.structure ?? "—"}
            </dd>
          </div>
        </dl>
        <div className="mt-4 pt-3 border-t border-gray-100">
          <Button
            type="button"
            size="sm"
            className="w-full"
            onClick={() => handleRaiseInstruction(p.id)}
            data-testid={`button-raise-instruction-${p.id}`}
          >
            <FileSignature className="h-4 w-4 mr-1" />
            Raise instruction
          </Button>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="p-6 space-y-6" data-testid="page-adviser-products">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Investment Products</h1>
        <p className="text-sm text-gray-500 mt-1">
          AMAX-issued product shelf. Read-only — to allocate, raise an investment
          instruction with the client.
        </p>
      </div>

      <div
        className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700"
        data-testid="products-disclaimer"
      >
        <AlertCircle className="h-4 w-4 text-slate-600 flex-shrink-0 mt-0.5" />
        <p>
          <span className="font-medium">Targets are illustrative, not forecasts.</span> Net IRR and
          return ranges shown are target ranges only and are not guarantees. Actual returns may be
          materially lower and capital loss is possible. See the relevant PDS / IM before
          recommending. Digital-asset strategies are a specialist sleeve and require additional
          suitability assessment.
        </p>
      </div>

      <Card data-testid="products-filter-bar">
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 mb-3 text-xs font-medium text-gray-600">
            <FilterIcon className="h-3.5 w-3.5" />
            Filter and sort
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Asset class</label>
              <Select
                value={filters.category}
                onValueChange={(v) => setFilters((f) => ({ ...f, category: v }))}
              >
                <SelectTrigger data-testid="filter-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All asset classes</SelectItem>
                  {availableCategories.map((c) => (
                    <SelectItem key={c} value={c}>
                      {categoryLabel(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Risk level</label>
              <Select
                value={filters.risk}
                onValueChange={(v) => setFilters((f) => ({ ...f, risk: v }))}
              >
                <SelectTrigger data-testid="filter-risk">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All risk levels</SelectItem>
                  {availableRisks.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Minimum investment</label>
              <Select
                value={filters.minBand}
                onValueChange={(v) => setFilters((f) => ({ ...f, minBand: v as MinBand }))}
              >
                <SelectTrigger data-testid="filter-min">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any minimum</SelectItem>
                  <SelectItem value="lt50k">Under $50k</SelectItem>
                  <SelectItem value="50k_100k">$50k – $100k</SelectItem>
                  <SelectItem value="100k_250k">$100k – $250k</SelectItem>
                  <SelectItem value="gte250k">$250k and above</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Liquidity</label>
              <Select
                value={filters.liquidity}
                onValueChange={(v) =>
                  setFilters((f) => ({ ...f, liquidity: v as LiquidityBand }))
                }
              >
                <SelectTrigger data-testid="filter-liquidity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any liquidity</SelectItem>
                  <SelectItem value="instant_daily">Instant / daily</SelectItem>
                  <SelectItem value="monthly_quarterly">Monthly / quarterly</SelectItem>
                  <SelectItem value="locked_illiquid">Locked / illiquid</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Sort by</label>
              <Select
                value={filters.sort}
                onValueChange={(v) => setFilters((f) => ({ ...f, sort: v as SortBy }))}
              >
                <SelectTrigger data-testid="filter-sort">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default (asset class)</SelectItem>
                  <SelectItem value="irr_desc">Target IRR (high to low)</SelectItem>
                  <SelectItem value="irr_asc">Target IRR (low to high)</SelectItem>
                  <SelectItem value="min_asc">Minimum (low to high)</SelectItem>
                  <SelectItem value="min_desc">Minimum (high to low)</SelectItem>
                  <SelectItem value="term_asc">Term (short to long)</SelectItem>
                  <SelectItem value="term_desc">Term (long to short)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {filtersChanged && (
            <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
              <span data-testid="filter-result-count">
                Showing {filtered.length} of {allProducts.length} products
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFilters(DEFAULT_FILTERS)}
                data-testid="button-clear-filters"
              >
                <X className="h-3.5 w-3.5 mr-1" />
                Clear filters
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-gray-500" data-testid="text-empty">
              {allProducts.length === 0
                ? "No active products on the shelf."
                : "No products match the current filters. Clear filters to see the full shelf."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {nonDigital.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {nonDigital.map(renderCard)}
            </div>
          )}
          {digital.length > 0 && (
            <div data-testid="section-digital-assets">
              <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 mb-4">
                <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-amber-900">
                  <div className="font-semibold uppercase tracking-wide mb-0.5">
                    Digital Assets — Specialist sleeve
                  </div>
                  <div>
                    Additional suitability assessment required. Capital loss is possible and
                    historic returns are highly volatile.
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {digital.map(renderCard)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
