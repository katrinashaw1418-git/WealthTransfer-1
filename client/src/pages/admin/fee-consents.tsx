import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { HandCoins, ShieldAlert } from "lucide-react";

interface AdminRequestRow {
  id: number;
  adviserUserId: number;
  clientUserId: number;
  adviceRecordId: number | null;
  feeType: string;
  amountType: string;
  amount: string | null;
  deductionFrequency: string;
  proposedConsentExpiryDate: string;
  status: string;
  declineReason: string | null;
  signedFeeConsentId: number | null;
  respondedAt: string | null;
  createdAt: string;
  adviserUsername: string | null;
  clientUsername: string | null;
}

interface AdminLiveRow {
  id: number;
  adviceRecordId: number;
  clientId: number;
  adviserId: number;
  feeType: string;
  amountType: string;
  amount: string | null;
  accountNumber: string;
  deductionFrequency: string;
  referenceDay: string;
  consentExpiryDate: string;
  renewalStatus: string;
  consentedAt: string;
  withdrawnAt: string | null;
  adviserUsername: string | null;
  clientUsername: string | null;
}

interface PaginatedResponse<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

const REQUEST_STATUSES = [
  { value: "all", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "consented", label: "Consented" },
  { value: "declined", label: "Declined" },
  { value: "withdrawn_by_adviser", label: "Withdrawn" },
];

const RENEWAL_STATUSES = [
  { value: "all", label: "All renewal statuses" },
  { value: "active", label: "Active" },
  { value: "renewal_due", label: "Renewal due" },
  { value: "expired", label: "Expired" },
  { value: "withdrawn", label: "Withdrawn" },
];

function statusBadge(status: string) {
  const map: Record<string, { variant: "default" | "secondary" | "outline" | "destructive"; label: string }> = {
    pending: { variant: "secondary", label: "Pending" },
    consented: { variant: "default", label: "Consented" },
    declined: { variant: "destructive", label: "Declined" },
    withdrawn_by_adviser: { variant: "outline", label: "Withdrawn" },
    superseded: { variant: "outline", label: "Superseded" },
    active: { variant: "default", label: "Active" },
    renewal_due: { variant: "secondary", label: "Renewal due" },
    expired: { variant: "destructive", label: "Expired" },
    withdrawn: { variant: "outline", label: "Withdrawn" },
  };
  const e = map[status] ?? { variant: "outline" as const, label: status };
  return <Badge variant={e.variant}>{e.label}</Badge>;
}

function formatAud(value: string | null): string {
  if (value === null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return value as string;
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
  }).format(n);
}

function formatDate(value: string | null): string {
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

function formatFeeType(t: string): string {
  return t.replace(/_/g, " ");
}

function RequestsTab() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const limit = 50;
  const q = useQuery<PaginatedResponse<AdminRequestRow>>({
    queryKey: ["/api/admin/fee-consent-requests", { status: statusFilter, page, limit }],
  });
  const totalPages = q.data ? Math.max(1, Math.ceil(q.data.total / limit)) : 1;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Fee consent requests</CardTitle>
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-48" data-testid="select-admin-request-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REQUEST_STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : q.isError ? (
          <p className="text-sm text-red-600">Unable to load requests.</p>
        ) : !q.data || q.data.items.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="text-no-admin-requests">
            No fee consent requests.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Created</TableHead>
                  <TableHead>Adviser</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Fee type</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Frequency</TableHead>
                  <TableHead>Expiry</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data.items.map((r) => (
                  <TableRow key={r.id} data-testid={`row-admin-request-${r.id}`}>
                    <TableCell className="text-sm">{formatDate(r.createdAt)}</TableCell>
                    <TableCell className="text-sm">
                      {r.adviserUsername ?? `#${r.adviserUserId}`}
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.clientUsername ?? `#${r.clientUserId}`}
                    </TableCell>
                    <TableCell className="text-sm capitalize">
                      {formatFeeType(r.feeType)}
                      <div className="text-xs text-gray-500 capitalize">
                        {formatFeeType(r.amountType)}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm tabular-nums text-right">
                      {r.amountType === "calculation_method"
                        ? "Calc method"
                        : r.amountType === "percentage"
                          ? `${(Number(r.amount ?? 0) * 100).toFixed(4)}%`
                          : formatAud(r.amount)}
                    </TableCell>
                    <TableCell className="text-sm capitalize">{r.deductionFrequency}</TableCell>
                    <TableCell className="text-sm">
                      {formatDate(r.proposedConsentExpiryDate)}
                    </TableCell>
                    <TableCell>{statusBadge(r.status)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 text-sm">
                <span className="text-gray-500">
                  Page {q.data.page} of {totalPages} ({q.data.total} total)
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    data-testid="button-admin-req-prev"
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => p + 1)}
                    data-testid="button-admin-req-next"
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function LiveTab() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const limit = 50;
  const q = useQuery<PaginatedResponse<AdminLiveRow>>({
    queryKey: ["/api/admin/fee-consents", { status: statusFilter, page, limit }],
  });
  const totalPages = q.data ? Math.max(1, Math.ceil(q.data.total / limit)) : 1;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Live fee consents</CardTitle>
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-48" data-testid="select-admin-renewal-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RENEWAL_STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : q.isError ? (
          <p className="text-sm text-red-600">Unable to load consents.</p>
        ) : !q.data || q.data.items.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="text-no-admin-fee-consents">
            No live fee consents.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Signed</TableHead>
                  <TableHead>Adviser</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Fee type</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Frequency</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data.items.map((c) => (
                  <TableRow key={c.id} data-testid={`row-admin-live-${c.id}`}>
                    <TableCell className="text-sm">{formatDate(c.consentedAt)}</TableCell>
                    <TableCell className="text-sm">
                      {c.adviserUsername ?? `#${c.adviserId}`}
                    </TableCell>
                    <TableCell className="text-sm">
                      {c.clientUsername ?? `#${c.clientId}`}
                    </TableCell>
                    <TableCell className="text-sm capitalize">{formatFeeType(c.feeType)}</TableCell>
                    <TableCell className="text-sm tabular-nums text-right">
                      {c.amountType === "percentage"
                        ? `${(Number(c.amount ?? 0) * 100).toFixed(4)}%`
                        : formatAud(c.amount)}
                    </TableCell>
                    <TableCell className="text-sm capitalize">{c.deductionFrequency}</TableCell>
                    <TableCell className="text-sm">{formatDate(c.consentExpiryDate)}</TableCell>
                    <TableCell>{statusBadge(c.renewalStatus)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 text-sm">
                <span className="text-gray-500">
                  Page {q.data.page} of {totalPages} ({q.data.total} total)
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    data-testid="button-admin-live-prev"
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => p + 1)}
                    data-testid="button-admin-live-next"
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminFeeConsents() {
  return (
    <div className="p-6 space-y-6" data-testid="page-admin-fee-consents">
      <div
        className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700"
        data-testid="fee-consent-hardening-notice"
      >
        <ShieldAlert className="h-4 w-4 text-slate-600 flex-shrink-0 mt-0.5" />
        <p>
          <span className="font-medium">No money will be moved by these consents.</span> AMAX
          requires separate admin-approved deduction controls (currently disabled). This page is
          read-only oversight of DBFO requests and signed consents.
        </p>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <HandCoins className="h-6 w-6 text-emerald-600" />
          Fee consents
        </h1>
        <p className="text-sm text-gray-500 mt-1 max-w-2xl">
          Oversee adviser-issued fee consent requests and the executed consents that result.
        </p>
      </div>

      <Tabs defaultValue="requests" className="space-y-4">
        <TabsList>
          <TabsTrigger value="requests" data-testid="tab-admin-fee-consent-requests">
            Requests
          </TabsTrigger>
          <TabsTrigger value="live" data-testid="tab-admin-fee-consents-live">
            Live consents
          </TabsTrigger>
        </TabsList>
        <TabsContent value="requests">
          <RequestsTab />
        </TabsContent>
        <TabsContent value="live">
          <LiveTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
