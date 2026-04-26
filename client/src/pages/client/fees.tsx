// Session 23A Gate A — view/audit only; no money movement; no automatic processing
import { useMemo, useState } from "react";
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
import { Coins, ShieldAlert } from "lucide-react";

interface FeeRule {
  id: number;
  feeConsentId: number;
  clientUserId: number;
  adviserUserId: number;
  feeType: string;
  amountType: string;
  rateBps: number | null;
  fixedAmount: string | null;
  adviserSplitBps: number;
  platformSplitBps: number;
  status: string;
  pausedAt: string | null;
  pausedReason: string | null;
}

interface FeeAccrual {
  id: number;
  feeRuleId: number;
  adviserUserId: number;
  accrualDate: string;
  accrualAmount: string;
  currency: string;
  gateReason: string | null;
}

interface FeeDeduction {
  id: number;
  adviserUserId: number;
  periodStart: string;
  periodEnd: string;
  totalAccrued: string;
  status: string;
  approvedAt: string | null;
  rejectedReason: string | null;
  createdAt: string | null;
}

interface UserRef {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
}
type UsersMap = Record<number, UserRef>;

interface PaginatedResponse<T> {
  items: T[];
  page: number;
  limit: number;
  users?: UsersMap;
}

interface ListResponse<T> {
  items?: T[];
  users?: UsersMap;
}

function adviserName(users: UsersMap | undefined, userId: number): string {
  const u = users?.[userId];
  if (!u) return `Adviser #${userId}`;
  return `${u.firstName} ${u.lastName}`.trim() || u.email;
}

const DEDUCTION_STATUSES = [
  { value: "all", label: "All statuses" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

function formatAud(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
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

function statusBadge(status: string) {
  const map: Record<string, { variant: "default" | "secondary" | "outline" | "destructive"; label: string }> = {
    active: { variant: "default", label: "Active" },
    paused: { variant: "secondary", label: "Paused" },
    pending_approval: { variant: "secondary", label: "Pending approval" },
    approved: { variant: "default", label: "Approved" },
    rejected: { variant: "destructive", label: "Rejected" },
  };
  const e = map[status] ?? { variant: "outline" as const, label: status };
  return <Badge variant={e.variant}>{e.label}</Badge>;
}

function describeAmount(rule: FeeRule): string {
  if (rule.amountType === "fixed") return formatAud(rule.fixedAmount);
  if (rule.amountType === "percentage")
    return `${((rule.rateBps ?? 0) / 100).toFixed(4)}%`;
  return rule.amountType;
}

function authedFetch<T>(url: string): Promise<T> {
  const token = localStorage.getItem("auth_token");
  return fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).then(async (r) => {
    if (!r.ok) throw new Error(await r.text());
    return r.json() as Promise<T>;
  });
}

function RulesTab() {
  const q = useQuery<ListResponse<FeeRule>>({
    queryKey: ["/api/client/fee-rules"],
    queryFn: () => authedFetch<ListResponse<FeeRule>>("/api/client/fee-rules"),
  });
  const items = Array.isArray(q.data) ? (q.data as unknown as FeeRule[]) : q.data?.items ?? [];
  const users = Array.isArray(q.data) ? undefined : q.data?.users;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Fees your adviser may charge</CardTitle>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : q.isError ? (
          <p className="text-sm text-red-600">Unable to load rules.</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="text-client-no-rules">
            No fee rules are currently set up against your account.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Adviser</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((r) => (
                <TableRow key={r.id} data-testid={`row-client-rule-${r.id}`}>
                  <TableCell className="text-sm">{adviserName(users, r.adviserUserId)}</TableCell>
                  <TableCell className="text-sm capitalize">
                    {r.feeType.replace(/_/g, " ")}
                    <div className="text-xs text-gray-500">{r.amountType}</div>
                  </TableCell>
                  <TableCell className="text-sm tabular-nums text-right">
                    {describeAmount(r)}
                  </TableCell>
                  <TableCell>{statusBadge(r.status)}</TableCell>
                  <TableCell className="text-sm text-gray-500">
                    {r.pausedReason ?? "Backed by a signed fee consent."}
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

function AccrualsTab() {
  const [page, setPage] = useState(1);
  const limit = 50;
  const q = useQuery<PaginatedResponse<FeeAccrual>>({
    queryKey: ["/api/client/fee-accruals", { page, limit }],
    queryFn: () =>
      authedFetch<PaginatedResponse<FeeAccrual>>(
        `/api/client/fee-accruals?page=${page}&limit=${limit}`,
      ),
  });
  const users = q.data?.users;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Daily accrual ledger</CardTitle>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : q.isError ? (
          <p className="text-sm text-red-600">Unable to load accruals.</p>
        ) : !q.data || q.data.items.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="text-client-no-accruals">
            No fee accruals recorded.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Rule</TableHead>
                  <TableHead>Adviser</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data.items.map((a) => (
                  <TableRow key={a.id} data-testid={`row-client-accrual-${a.id}`}>
                    <TableCell className="text-sm">{formatDate(a.accrualDate)}</TableCell>
                    <TableCell className="text-sm">#{a.feeRuleId}</TableCell>
                    <TableCell className="text-sm">{adviserName(users, a.adviserUserId)}</TableCell>
                    <TableCell className="text-sm tabular-nums text-right">
                      {formatAud(a.accrualAmount)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {a.gateReason ? (
                        <Badge variant="outline">{a.gateReason}</Badge>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between mt-4 text-sm">
              <span className="text-gray-500">Page {q.data.page}</span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  data-testid="button-client-accruals-prev"
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={q.data.items.length < limit}
                  onClick={() => setPage((p) => p + 1)}
                  data-testid="button-client-accruals-next"
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DeductionsTab() {
  const [statusFilter, setStatusFilter] = useState("all");
  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (statusFilter !== "all") p.set("status", statusFilter);
    return p.toString();
  }, [statusFilter]);
  const q = useQuery<PaginatedResponse<FeeDeduction>>({
    queryKey: ["/api/client/fee-deductions", { status: statusFilter }],
    queryFn: () =>
      authedFetch<PaginatedResponse<FeeDeduction>>(
        `/api/client/fee-deductions${params ? `?${params}` : ""}`,
      ),
  });
  const users = q.data?.users;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Pending deductions</CardTitle>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44" data-testid="select-client-deduction-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DEDUCTION_STATUSES.map((s) => (
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
          <p className="text-sm text-red-600">Unable to load deductions.</p>
        ) : !q.data || q.data.items.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="text-client-no-deductions">
            No deductions yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Adviser</TableHead>
                <TableHead>Period</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Approved at</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.items.map((d) => (
                <TableRow key={d.id} data-testid={`row-client-deduction-${d.id}`}>
                  <TableCell className="text-sm">{formatDate(d.createdAt)}</TableCell>
                  <TableCell className="text-sm">{adviserName(users, d.adviserUserId)}</TableCell>
                  <TableCell className="text-sm">
                    {formatDate(d.periodStart)} → {formatDate(d.periodEnd)}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums text-right">
                    {formatAud(d.totalAccrued)}
                  </TableCell>
                  <TableCell>{statusBadge(d.status)}</TableCell>
                  <TableCell className="text-sm">{formatDate(d.approvedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export default function ClientFees() {
  return (
    <div className="p-6 space-y-6" data-testid="page-client-fees">
      <div
        className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
        data-testid="fee-engine-gate-a-notice"
      >
        <ShieldAlert className="h-4 w-4 text-amber-700 flex-shrink-0 mt-0.5" />
        <p>
          <span className="font-medium">View only.</span> AMAX has not started deducting fees from
          your wallet. The fee engine is in scaffold mode — what you see here is the audit ledger.
          Nothing is debited from your balance.
        </p>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Coins className="h-6 w-6 text-amber-600" />
          Fees
        </h1>
        <p className="text-sm text-gray-500 mt-1 max-w-2xl">
          Read-only view of the fee rules attached to your account, the daily accrual ledger, and any
          pending deductions awaiting AMAX approval.
        </p>
      </div>

      <Tabs defaultValue="rules" className="space-y-4">
        <TabsList>
          <TabsTrigger value="rules" data-testid="tab-client-fees-rules">
            Rules
          </TabsTrigger>
          <TabsTrigger value="accruals" data-testid="tab-client-fees-accruals">
            Accruals
          </TabsTrigger>
          <TabsTrigger value="deductions" data-testid="tab-client-fees-deductions">
            Deductions
          </TabsTrigger>
        </TabsList>
        <TabsContent value="rules">
          <RulesTab />
        </TabsContent>
        <TabsContent value="accruals">
          <AccrualsTab />
        </TabsContent>
        <TabsContent value="deductions">
          <DeductionsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
