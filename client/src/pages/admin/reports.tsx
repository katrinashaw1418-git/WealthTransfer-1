import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileText } from "lucide-react";

interface AdminReport {
  id: number;
  adviserUserId: number;
  clientUserId: number;
  reportType: string;
  format: string;
  status: string;
  notes: string | null;
  downloadUrl: string | null;
  failureReason: string | null;
  requestedAt: string | null;
  generatedAt: string | null;
  expiresAt: string | null;
  adviserUsername: string;
  clientUsername: string;
  clientEmail: string;
}

interface ReportListResp {
  items: AdminReport[];
  page: number;
  limit: number;
  total: number;
}

const STATUSES = ["requested", "generating", "ready", "failed", "expired"] as const;
const TYPES = [
  "portfolio_summary",
  "fee_summary",
  "transaction_history",
  "full_statement",
] as const;

function fmt(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return "—";
  }
}

function statusVariant(s: string): "default" | "secondary" | "outline" | "destructive" {
  if (s === "ready") return "default";
  if (s === "failed" || s === "expired") return "destructive";
  if (s === "generating") return "secondary";
  return "outline";
}

const PAGE_SIZE = 50;

export default function AdminReports() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [page, setPage] = useState(1);

  // Reset to page 1 when either filter changes so pagination stays consistent.
  function changeStatus(s: string) {
    setStatusFilter(s);
    setPage(1);
  }
  function changeType(t: string) {
    setTypeFilter(t);
    setPage(1);
  }

  const queryKey = ["/api/admin/reports", statusFilter, typeFilter, page];
  const { data, isLoading } = useQuery<ReportListResp>({
    queryKey,
    queryFn: async () => {
      const qs: string[] = [`page=${page}`, `limit=${PAGE_SIZE}`];
      if (statusFilter && statusFilter !== "all")
        qs.push(`status=${encodeURIComponent(statusFilter)}`);
      if (typeFilter && typeFilter !== "all")
        qs.push(`reportType=${encodeURIComponent(typeFilter)}`);
      const res = await apiRequest("GET", `/api/admin/reports?${qs.join("&")}`);
      return res.json();
    },
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4 max-w-7xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Report Requests</h1>
          <p className="text-sm text-slate-500 mt-1">
            Adviser- and client-initiated report requests across the platform. Generation itself is
            handled by the report worker (separate phase).
          </p>
        </div>
        <div className="flex gap-2">
          <Select value={statusFilter} onValueChange={changeStatus}>
            <SelectTrigger className="w-44" data-testid="select-report-status-filter">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={changeType}>
            <SelectTrigger className="w-52" data-testid="select-report-type-filter">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4 text-violet-600" />
            {isLoading
              ? "Loading…"
              : `${data?.total ?? 0} report request${data?.total === 1 ? "" : "s"}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !data || data.items.length === 0 ? (
            <p className="text-sm text-slate-500">No report requests match these filters.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Requested</TableHead>
                  <TableHead>Adviser</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Format</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Generated</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((r) => (
                  <TableRow key={r.id} data-testid={`row-report-${r.id}`}>
                    <TableCell className="text-sm">{fmt(r.requestedAt)}</TableCell>
                    <TableCell className="text-sm">{r.adviserUsername}</TableCell>
                    <TableCell className="text-sm">
                      <div>{r.clientUsername}</div>
                      <div className="text-xs text-slate-500">{r.clientEmail}</div>
                    </TableCell>
                    <TableCell className="text-sm capitalize">
                      {r.reportType.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell className="text-xs uppercase text-slate-500">{r.format}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(r.status)} className="capitalize">
                        {r.status}
                      </Badge>
                      {r.failureReason && (
                        <div className="text-[11px] text-rose-700 mt-1">{r.failureReason}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{fmt(r.generatedAt)}</TableCell>
                    <TableCell className="text-xs text-slate-600 max-w-[280px] truncate">
                      {r.notes ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {data && data.total > PAGE_SIZE && (
            <div className="flex items-center justify-between mt-3 text-sm">
              <div className="text-slate-500">
                Page {page} of {totalPages} · {data.total} total
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  data-testid="button-reports-prev"
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  data-testid="button-reports-next"
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
