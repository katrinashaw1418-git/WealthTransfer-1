import { useQuery } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { apiFetch } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowLeft, Briefcase, AlertCircle } from "lucide-react";

interface HoldingRow {
  id: number;
  productId: number;
  productName: string;
  productCategory: string;
  productSubCategory: string | null;
  investedAmount: string;
  currentValue: string;
  totalReturn: string;
  returnPercent: string;
  status: string;
  investmentDate: string | null;
  maturityDate: string | null;
}

function formatAud(value: string | null | undefined): string {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
  }).format(n);
}

function formatPercent(value: string | null | undefined): string {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
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

function statusVariant(status: string): "default" | "secondary" | "outline" {
  if (status === "active") return "default";
  if (status === "matured" || status === "exited") return "secondary";
  return "outline";
}

export default function AdviserClientHoldings() {
  const [, params] = useRoute<{ id: string }>("/adviser/clients/:id/holdings");
  const clientId = params?.id;

  // Note: the global queryFn only uses queryKey[0] as the URL, so segmented
  // keys need an explicit queryFn that composes the full path. The segmented
  // key is still useful for cache invalidation.
  const holdings = useQuery<HoldingRow[]>({
    queryKey: ["/api/adviser/clients", clientId, "holdings"],
    enabled: !!clientId,
    queryFn: async () => {
      const res = await apiFetch(`/api/adviser/clients/${clientId}/holdings`);
      return res.json();
    },
  });

  if (holdings.isLoading) {
    return (
      <div className="p-6 space-y-4" data-testid="page-adviser-client-holdings-loading">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (holdings.isError) {
    return (
      <div className="p-6" data-testid="page-adviser-client-holdings-error">
        <Link href={`/adviser/clients/${clientId}`}>
          <Button variant="ghost" size="sm" className="mb-4" data-testid="button-back">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to client
          </Button>
        </Link>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertCircle className="h-4 w-4" />
              Unable to load holdings. The client may not be linked to your adviser
              account.
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const rows = holdings.data ?? [];
  const totalInvested = rows.reduce((acc, r) => acc + Number(r.investedAmount || 0), 0);
  const totalCurrent = rows.reduce((acc, r) => acc + Number(r.currentValue || 0), 0);

  return (
    <div className="p-6 space-y-6" data-testid="page-adviser-client-holdings">
      <div>
        <Link href={`/adviser/clients/${clientId}`}>
          <Button variant="ghost" size="sm" className="mb-2" data-testid="button-back">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to client
          </Button>
        </Link>
        <h1 className="text-2xl font-bold text-gray-900">Client Holdings</h1>
        <p className="text-sm text-gray-500 mt-1">
          Read-only view of this client's allocations across the AMAX product shelf.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card data-testid="card-summary-positions">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase text-gray-500 font-medium">
              Positions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums" data-testid="text-summary-count">
              {rows.length}
            </div>
          </CardContent>
        </Card>
        <Card data-testid="card-summary-invested">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase text-gray-500 font-medium">
              Total Invested
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums" data-testid="text-summary-invested">
              {formatAud(String(totalInvested))}
            </div>
          </CardContent>
        </Card>
        <Card data-testid="card-summary-current">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase text-gray-500 font-medium">
              Current Value
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums" data-testid="text-summary-current">
              {formatAud(String(totalCurrent))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Briefcase className="h-4 w-4 text-sky-500" />
            Holdings
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="text-empty">
              This client has no investment holdings.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Invested</TableHead>
                  <TableHead className="text-right">Current</TableHead>
                  <TableHead className="text-right">Return</TableHead>
                  <TableHead>Invested On</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} data-testid={`row-holding-${r.id}`}>
                    <TableCell className="font-medium text-sm">{r.productName}</TableCell>
                    <TableCell className="text-sm capitalize">
                      {r.productCategory.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {formatAud(r.investedAmount)}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {formatAud(r.currentValue)}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {formatPercent(r.returnPercent)}
                    </TableCell>
                    <TableCell className="text-sm">{formatDate(r.investmentDate)}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(r.status)} className="capitalize">
                        {r.status}
                      </Badge>
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
