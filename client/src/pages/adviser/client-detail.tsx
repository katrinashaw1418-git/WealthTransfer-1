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
import { ArrowLeft, FileText, ClipboardList, Briefcase } from "lucide-react";

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
  }>;
}

interface PortfolioPayload {
  portfolio: {
    totalValue: string;
    cashBalance: string | null;
  } | null;
  wallets: Array<{
    id: number;
    currency: string;
    balance: string;
  }>;
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

  return (
    <div className="p-6 space-y-6" data-testid="page-adviser-client-detail">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/adviser/clients">
            <Button variant="ghost" size="sm" className="mb-2" data-testid="button-back">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
          </Link>
          <h1 className="text-2xl font-bold text-gray-900">
            {client.firstName} {client.lastName}
          </h1>
          <p className="text-sm text-gray-500">{client.email}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/adviser/clients/${client.id}/holdings`}>
            <Button variant="outline" size="sm" data-testid="button-view-holdings">
              <Briefcase className="h-4 w-4 mr-2" />
              View Holdings
            </Button>
          </Link>
          <Badge variant={client.kycStatus === "verified" ? "default" : "secondary"}>
            KYC: {client.kycStatus}
          </Badge>
          <Badge variant="outline" className="capitalize">
            {client.userTier}
          </Badge>
        </div>
      </div>

      {/* Portfolio summary (read-only) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Portfolio (read-only)</CardTitle>
        </CardHeader>
        <CardContent>
          {portfolio.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <div className="space-y-3">
              <div>
                <div className="text-xs uppercase text-gray-500">Total value</div>
                <div className="text-2xl font-bold tabular-nums" data-testid="text-portfolio-total">
                  {formatAud(portfolio.data?.portfolio?.totalValue)}
                </div>
              </div>
              {portfolio.data?.wallets && portfolio.data.wallets.length > 0 && (
                <div>
                  <div className="text-xs uppercase text-gray-500 mb-1">Wallets</div>
                  <div className="flex flex-wrap gap-2">
                    {portfolio.data.wallets.map((w) => (
                      <Badge key={w.id} variant="outline" className="tabular-nums">
                        {w.currency}: {Number(w.balance).toLocaleString("en-AU")}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Fee consents */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4 text-violet-500" />
            Fee consents
          </CardTitle>
        </CardHeader>
        <CardContent>
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

      {/* Recent advice */}
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
                      <Badge variant="outline" className="capitalize">
                        {ar.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{formatDate(ar.createdAt)}</TableCell>
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
