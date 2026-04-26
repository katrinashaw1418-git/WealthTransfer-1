import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollText, ChevronLeft, ChevronRight, X } from "lucide-react";

interface AuditRow {
  id: number;
  userId: number | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: any;
  ipAddress: string | null;
  createdAt: string | null;
}

interface AuditPage {
  items: AuditRow[];
  page: number;
  limit: number;
  total: number;
}

const TOKEN_KEY = "amax_jwt";

function fmt(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return "—";
  }
}

export default function AdminAuditLogs() {
  const [actionFilter, setActionFilter] = useState("");
  const [entityFilter, setEntityFilter] = useState("");
  const [userFilter, setUserFilter] = useState("");
  const [page, setPage] = useState(1);
  const limit = 50;

  const queryKey = ["/api/admin/audit-logs", { actionFilter, entityFilter, userFilter, page }];

  const { data, isLoading } = useQuery<AuditPage>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (actionFilter.trim()) params.set("action", actionFilter.trim());
      if (entityFilter.trim()) params.set("entityType", entityFilter.trim());
      if (userFilter.trim()) params.set("userId", userFilter.trim());
      params.set("page", String(page));
      params.set("limit", String(limit));
      const token = (() => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } })();
      const res = await fetch(`/api/admin/audit-logs?${params.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / limit)) : 1;

  function clearFilters() {
    setActionFilter("");
    setEntityFilter("");
    setUserFilter("");
    setPage(1);
  }

  function applyFilters() {
    setPage(1);
  }

  return (
    <div className="space-y-4 max-w-7xl">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Audit log</h1>
        <p className="text-sm text-slate-500 mt-1">
          Every state-changing action across the platform. Read-only.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-violet-600" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <Input
              placeholder="Action contains…"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              data-testid="input-filter-action"
            />
            <Input
              placeholder="Entity type (exact)"
              value={entityFilter}
              onChange={(e) => setEntityFilter(e.target.value)}
              data-testid="input-filter-entity"
            />
            <Input
              placeholder="User ID"
              type="number"
              value={userFilter}
              onChange={(e) => setUserFilter(e.target.value)}
              data-testid="input-filter-user"
            />
            <div className="flex gap-2">
              <Button onClick={applyFilters} className="flex-1" data-testid="button-apply-filters">
                Apply
              </Button>
              <Button variant="outline" onClick={clearFilters} data-testid="button-clear-filters">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">
            {isLoading ? "Loading…" : `${data?.total ?? 0} entries`}
          </CardTitle>
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || isLoading}
              data-testid="button-prev-page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span data-testid="text-pagination">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || isLoading}
              data-testid="button-next-page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : !data || data.items.length === 0 ? (
            <p className="text-sm text-slate-500">No audit entries match these filters.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>Metadata</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((row) => (
                  <TableRow key={row.id} data-testid={`row-audit-${row.id}`}>
                    <TableCell className="text-xs text-slate-600 whitespace-nowrap">
                      {fmt(row.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-xs">
                        {row.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {row.entityType ?? "—"}
                      {row.entityId ? ` #${row.entityId}` : ""}
                    </TableCell>
                    <TableCell className="text-sm font-mono">{row.userId ?? "—"}</TableCell>
                    <TableCell className="text-xs text-slate-500">{row.ipAddress ?? "—"}</TableCell>
                    <TableCell className="max-w-md">
                      <pre className="text-[11px] text-slate-600 whitespace-pre-wrap break-all bg-slate-50 rounded px-2 py-1">
                        {row.metadata ? JSON.stringify(row.metadata) : "—"}
                      </pre>
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
