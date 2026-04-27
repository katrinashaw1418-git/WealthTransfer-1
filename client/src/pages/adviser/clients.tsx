import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
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
import { ChevronRight, Users } from "lucide-react";

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

function kycBadge(status: string) {
  const variant: "default" | "secondary" | "destructive" | "outline" =
    status === "verified" ? "default" : status === "rejected" ? "destructive" : "secondary";
  return (
    <Badge variant={variant} data-testid={`badge-kyc-${status}`}>
      {status}
    </Badge>
  );
}

function formatAud(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
  }).format(n);
}

export default function AdviserClients() {
  const { data, isLoading } = useQuery<AdviserClientRow[]>({
    queryKey: ["/api/adviser/clients"],
  });
  // useSearch subscribes to the live querystring; useLocation only tracks
  // pathname, which would miss ?q= updates when only the query changes.
  const searchString = useSearch();

  const query = useMemo(() => {
    const params = new URLSearchParams(searchString);
    return (params.get("q") ?? "").toLowerCase().trim();
  }, [searchString]);

  const filtered = useMemo(() => {
    const rows = data ?? [];
    if (!query) return rows;
    return rows.filter((r) => {
      const hay = `${r.firstName} ${r.lastName} ${r.email}`.toLowerCase();
      return hay.includes(query);
    });
  }, [data, query]);

  return (
    <div className="p-6 space-y-6" data-testid="page-adviser-clients">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Linked Clients</h1>
        <p className="text-sm text-gray-500 mt-1">
          Read-only view. Click a row to see KYC, fee consents and recent advice records.
          {query ? (
            <>
              {" "}Filtering by{" "}
              <span className="font-medium text-slate-700">"{query}"</span>.
            </>
          ) : null}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
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
            <p className="text-sm text-gray-500" data-testid="text-no-search-results">
              No clients match "{query}".
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Relationship</TableHead>
                  <TableHead>KYC</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Portfolio (AUD)</TableHead>
                  <TableHead className="text-right">Active fee consents</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((row) => (
                  <TableRow key={row.userId} data-testid={`row-client-${row.userId}`}>
                    <TableCell>
                      <div className="font-medium text-gray-900">
                        {/* Task #283 — name -> email -> Client #<id> */}
                        {clientDisplayName(row, row.userId)}
                      </div>
                      <div className="text-xs text-gray-500">{row.email}</div>
                    </TableCell>
                    <TableCell className="capitalize text-sm">{row.relationshipType}</TableCell>
                    <TableCell>{kycBadge(row.kycStatus)}</TableCell>
                    <TableCell className="capitalize text-sm">{row.userTier}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatAud(row.portfolioValueAud)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.activeFeeConsents}
                    </TableCell>
                    <TableCell>
                      <Link href={`/adviser/clients/${row.userId}`}>
                        <a className="text-sky-600 hover:text-sky-800 inline-flex items-center text-sm">
                          View <ChevronRight className="h-4 w-4" />
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
