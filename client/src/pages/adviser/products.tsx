import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, AlertCircle } from "lucide-react";

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

function riskBadgeVariant(profile: string | null): "default" | "secondary" | "outline" {
  if (!profile) return "outline";
  const p = profile.toLowerCase();
  if (p.includes("low") || p.includes("conservative")) return "secondary";
  if (p.includes("high") || p.includes("aggressive")) return "default";
  return "outline";
}

export default function AdviserProducts() {
  const products = useQuery<AdviserProduct[]>({
    queryKey: ["/api/adviser/products"],
  });

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

  const list = products.data ?? [];

  return (
    <div className="p-6 space-y-6" data-testid="page-adviser-products">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Investment Products</h1>
        <p className="text-sm text-gray-500 mt-1">
          AMAX-issued product shelf. Read-only — to allocate, raise an investment
          instruction with the client (coming soon).
        </p>
      </div>

      {list.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-gray-500" data-testid="text-empty">
              No active products on the shelf.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {list.map((p) => (
            <Card key={p.id} data-testid={`card-product-${p.id}`} className="flex flex-col">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Building2 className="h-4 w-4 text-sky-500 flex-shrink-0" />
                    <CardTitle className="text-base truncate" data-testid={`text-product-name-${p.id}`}>
                      {p.name}
                    </CardTitle>
                  </div>
                  {p.riskProfile && (
                    <Badge variant={riskBadgeVariant(p.riskProfile)} className="capitalize text-xs">
                      {p.riskProfile}
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
              </CardHeader>
              <CardContent className="flex-1">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div>
                    <dt className="text-xs uppercase text-gray-500">Target Net IRR</dt>
                    <dd className="font-semibold tabular-nums" data-testid={`text-irr-${p.id}`}>
                      {p.targetNetIrr ? `${p.targetNetIrr}%` : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase text-gray-500">Term</dt>
                    <dd className="font-semibold">{p.term ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase text-gray-500">Minimum</dt>
                    <dd className="font-semibold tabular-nums">{formatAud(p.minimumInvestment)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase text-gray-500">Distributions</dt>
                    <dd className="font-semibold capitalize">{p.distributions ?? "—"}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-xs uppercase text-gray-500">Structure</dt>
                    <dd className="text-sm">{p.structure ?? "—"}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-xs uppercase text-gray-500">Liquidity</dt>
                    <dd className="text-sm">{p.liquidity ?? "—"}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
