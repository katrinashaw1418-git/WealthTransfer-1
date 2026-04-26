// =============================================================================
// SESSION 23A — ADMIN FEE ENGINE PAGE
// -----------------------------------------------------------------------------
// Three sections:
//   1. Rules — paginated list, "create rule" form, "pause" action.
//   2. Accruals — paginated list, "run today's accruals" action.
//   3. Deductions — pending list, "generate" action, per-row "approve" action.
//
// Visible Gate A banner so anyone clicking around the admin shell is reminded
// that NO money moves here yet.
// =============================================================================

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { ShieldAlert, HandCoins, Play, Pause, Plus, CheckCircle2, Clock, AlertCircle, Search, X } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const TOKEN_KEY = "amax_jwt";

async function fetchPaginated<T>(url: string): Promise<T> {
  const token = (() => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  })();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function SearchBox({
  value,
  onChange,
  placeholder,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  testId: string;
}) {
  return (
    <div className="relative max-w-md">
      <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-8 pr-8"
        data-testid={testId}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
          data-testid={`${testId}-clear`}
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

interface FeeRuleRow {
  id: number;
  feeConsentId: number;
  clientUserId: number;
  adviserUserId: number;
  feeType: string;
  amountType: string;
  rateBps: number | null;
  fixedAmount: string | null;
  currency: string;
  adviserSplitBps: number;
  platformSplitBps: number;
  status: string;
  pausedAt: string | null;
  pausedReason: string | null;
  createdAt: string;
}

interface FeeAccrualRow {
  id: number;
  feeRuleId: number;
  clientUserId: number;
  adviserUserId: number;
  accrualDate: string;
  accrualAmount: string;
  adviserShareAmount: string;
  platformShareAmount: string;
  currency: string;
  gateReason: string | null;
  createdAt: string;
}

interface FeeDeductionRow {
  id: number;
  clientUserId: number;
  adviserUserId: number;
  periodStart: string;
  periodEnd: string;
  totalAccrued: string;
  adviserShareAmount: string;
  platformShareAmount: string;
  currency: string;
  accrualIds: number[];
  status: string;
  approvedByUserId: number | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  createdAt: string;
}

interface UserRef {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
}
type UsersMap = Record<number, UserRef>;
interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  users?: UsersMap;
}

// Session 27 (Task #23) — Latest fee accrual run summary surfaced near the
// "Run today's accruals" button so admins don't have to grep server logs to
// confirm the cron actually ran.
interface FeeAccrualRunSummary {
  id: number;
  accrualDate: string;
  trigger: "cron" | "manual";
  triggeredByUserId: number | null;
  triggeredByUsername: string | null;
  inserted: number;
  skipped: number;
  duplicates: number;
  byGateReason: Record<string, number>;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.max(1, Math.floor((now - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function LatestRunSummary({ run }: { run: FeeAccrualRunSummary }) {
  const gateEntries = Object.entries(run.byGateReason ?? {});
  const startedAtLocal = new Date(run.startedAt).toLocaleString();
  return (
    <div className="space-y-2 text-sm" data-testid="latest-run-summary">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={run.trigger === "cron" ? "outline" : "secondary"}
          data-testid="badge-trigger"
        >
          {run.trigger}
        </Badge>
        {run.errorMessage ? (
          <Badge variant="destructive" data-testid="badge-status">
            <AlertCircle className="h-3 w-3 mr-1" /> error
          </Badge>
        ) : (
          <Badge variant="outline" data-testid="badge-status">
            <CheckCircle2 className="h-3 w-3 mr-1" /> ok
          </Badge>
        )}
        <span className="text-muted-foreground">
          covered <strong data-testid="text-accrual-date">{run.accrualDate.slice(0, 10)}</strong>
        </span>
        <span className="text-muted-foreground">
          · ran <span data-testid="text-relative">{formatRelative(run.startedAt)}</span>{" "}
          (<span data-testid="text-started-at">{startedAtLocal}</span>)
        </span>
        {run.trigger === "manual" && run.triggeredByUsername && (
          <span className="text-muted-foreground" data-testid="text-triggered-by">
            · by <strong>{run.triggeredByUsername}</strong>
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-3 text-sm">
        <span data-testid="text-inserted">
          <strong>{run.inserted}</strong> inserted
        </span>
        <span data-testid="text-skipped">
          <strong>{run.skipped}</strong> gated
        </span>
        <span data-testid="text-duplicates">
          <strong>{run.duplicates}</strong> duplicate
        </span>
      </div>
      {gateEntries.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid="gate-reasons">
          {gateEntries.map(([reason, count]) => (
            <Badge key={reason} variant="destructive" className="text-xs">
              {reason}: {count}
            </Badge>
          ))}
        </div>
      )}
      {run.errorMessage && (
        <Alert variant="destructive" data-testid="alert-error">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Run failed</AlertTitle>
          <AlertDescription className="font-mono text-xs">
            {run.errorMessage}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function bpsLabel(bps: number) {
  return `${(bps / 100).toFixed(2)}%`;
}

function userLabel(
  users: UsersMap | undefined,
  userId: number | null | undefined,
): string {
  if (userId == null) return "—";
  const u = users?.[userId];
  if (!u) return `#${userId}`;
  return `${u.firstName} ${u.lastName}`.trim() || u.email || `#${userId}`;
}

function UserCell({
  users,
  userId,
}: {
  users: UsersMap | undefined;
  userId: number | null | undefined;
}) {
  if (userId == null) return <span className="text-muted-foreground">—</span>;
  const u = users?.[userId];
  if (!u) {
    return (
      <span className="text-sm" title={`User #${userId}`}>
        #{userId}
      </span>
    );
  }
  const name = `${u.firstName} ${u.lastName}`.trim() || u.email;
  return (
    <div className="leading-tight">
      <div className="text-sm font-medium">{name}</div>
      <div className="text-xs text-muted-foreground">{u.email}</div>
    </div>
  );
}

export default function AdminFeesPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState("rules");

  // -------- Create rule form --------
  const [form, setForm] = useState({
    feeConsentId: "",
    clientUserId: "",
    adviserUserId: "",
    feeType: "ongoing_service_fee",
    amountType: "fixed" as "fixed" | "percentage",
    fixedAmount: "",
    rateBps: "",
    currency: "AUD",
    adviserSplitBps: "8000",
    platformSplitBps: "2000",
  });

  async function submitCreateRule() {
    try {
      const payload: any = {
        feeConsentId: Number(form.feeConsentId),
        clientUserId: Number(form.clientUserId),
        adviserUserId: Number(form.adviserUserId),
        feeType: form.feeType,
        amountType: form.amountType,
        currency: form.currency,
        adviserSplitBps: Number(form.adviserSplitBps),
        platformSplitBps: Number(form.platformSplitBps),
      };
      if (form.amountType === "fixed") payload.fixedAmount = form.fixedAmount;
      if (form.amountType === "percentage") payload.rateBps = Number(form.rateBps);
      await apiRequest("POST", "/api/admin/fee-rules", payload);
      toast({ title: "Fee rule created" });
      setForm({
        ...form,
        feeConsentId: "",
        clientUserId: "",
        adviserUserId: "",
        fixedAmount: "",
        rateBps: "",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/fee-rules"] });
    } catch (err: any) {
      toast({ title: "Create failed", description: err?.message ?? String(err), variant: "destructive" });
    }
  }

  // -------- Run accruals --------
  const [accrualDate, setAccrualDate] = useState(todayIso());
  async function runAccruals() {
    try {
      const r = await apiRequest("POST", "/api/admin/fee-accruals/run", { accrualDate });
      const j = await r.json();
      toast({
        title: "Accrual run complete",
        description: `Inserted: ${j.inserted}, Skipped: ${j.skipped}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/fee-accruals"] });
      // Refresh the "Last accrual run" card immediately rather than waiting
      // for the 30s poll interval — keeps the UI snappy after a manual run.
      queryClient.invalidateQueries({ queryKey: ["/api/admin/fee-accrual-runs/latest"] });
    } catch (err: any) {
      toast({ title: "Run failed", description: err?.message ?? String(err), variant: "destructive" });
    }
  }

  // -------- Generate deductions --------
  const [period, setPeriod] = useState({ start: todayIso(), end: todayIso() });
  async function generateDeductions() {
    try {
      const r = await apiRequest("POST", "/api/admin/fee-deductions/generate", {
        periodStart: period.start,
        periodEnd: period.end,
      });
      const j = await r.json();
      toast({
        title: "Deductions generated",
        description: `Batches: ${j.batches}, Accruals rolled: ${j.rolledUpAccruals}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/fee-deductions"] });
    } catch (err: any) {
      toast({ title: "Generate failed", description: err?.message ?? String(err), variant: "destructive" });
    }
  }

  // -------- Pause / approve --------
  async function pauseRule(id: number) {
    try {
      await apiRequest("PATCH", `/api/admin/fee-rules/${id}/pause`, { reason: "manual pause from admin UI" });
      toast({ title: "Rule paused" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/fee-rules"] });
    } catch (err: any) {
      toast({ title: "Pause failed", description: err?.message ?? String(err), variant: "destructive" });
    }
  }
  async function approveDeduction(id: number) {
    try {
      await apiRequest("POST", `/api/admin/fee-deductions/${id}/approve`, {});
      toast({ title: "Deduction approved", description: "Status flipped only — no money moved (Gate A)." });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/fee-deductions"] });
    } catch (err: any) {
      toast({ title: "Approve failed", description: err?.message ?? String(err), variant: "destructive" });
    }
  }

  // -------- Search state (one box per tab, debounced server-side filter) --------
  const [rulesSearch, setRulesSearch] = useState("");
  const [accrualsSearch, setAccrualsSearch] = useState("");
  const [deductionsSearch, setDeductionsSearch] = useState("");
  const debouncedRulesSearch = useDebounced(rulesSearch);
  const debouncedAccrualsSearch = useDebounced(accrualsSearch);
  const debouncedDeductionsSearch = useDebounced(deductionsSearch);

  // -------- Queries --------
  const rulesQ = useQuery<Paginated<FeeRuleRow>>({
    queryKey: ["/api/admin/fee-rules", { q: debouncedRulesSearch }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (debouncedRulesSearch.trim()) params.set("q", debouncedRulesSearch.trim());
      const qs = params.toString();
      return fetchPaginated<Paginated<FeeRuleRow>>(
        `/api/admin/fee-rules${qs ? `?${qs}` : ""}`,
      );
    },
  });

  const accrualsQ = useQuery<Paginated<FeeAccrualRow>>({
    queryKey: ["/api/admin/fee-accruals", { q: debouncedAccrualsSearch }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (debouncedAccrualsSearch.trim()) params.set("q", debouncedAccrualsSearch.trim());
      const qs = params.toString();
      return fetchPaginated<Paginated<FeeAccrualRow>>(
        `/api/admin/fee-accruals${qs ? `?${qs}` : ""}`,
      );
    },
  });
  // Session 27 (Task #23): poll the latest run summary every 30s so the
  // displayed timestamp doesn't go stale once the page is open. The query is
  // cheap (LIMIT 1 on an indexed column) so this is fine.
  const latestRunQ = useQuery<{ run: FeeAccrualRunSummary | null }>({
    queryKey: ["/api/admin/fee-accrual-runs/latest"],
    refetchInterval: 30_000,
  });
  const deductionsQ = useQuery<Paginated<FeeDeductionRow>>({
    queryKey: ["/api/admin/fee-deductions", { q: debouncedDeductionsSearch }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (debouncedDeductionsSearch.trim()) params.set("q", debouncedDeductionsSearch.trim());
      const qs = params.toString();
      return fetchPaginated<Paginated<FeeDeductionRow>>(
        `/api/admin/fee-deductions${qs ? `?${qs}` : ""}`,
      );
    },
  });

  return (
    <div className="space-y-6 p-6" data-testid="page-admin-fees">
      <div className="flex items-center gap-2">
        <HandCoins className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-semibold">Adviser fee engine</h1>
      </div>

      <Alert variant="default" data-testid="alert-gate-a">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Gate A — scaffold only</AlertTitle>
        <AlertDescription>
          Rules, accruals and deductions are visible and auditable, but{" "}
          <strong>no money moves</strong>. Approving a deduction in this screen flips its
          status and writes an audit row only.
        </AlertDescription>
      </Alert>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="rules" data-testid="tab-rules">Rules</TabsTrigger>
          <TabsTrigger value="accruals" data-testid="tab-accruals">Accruals</TabsTrigger>
          <TabsTrigger value="deductions" data-testid="tab-deductions">Deductions</TabsTrigger>
        </TabsList>

        {/* ---- RULES TAB ---- */}
        <TabsContent value="rules" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Create a new fee rule</CardTitle>
              <CardDescription>
                The fee consent must already be signed and not withdrawn. Splits must sum to 10000 bps (100%).
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <div>
                <Label>Fee consent ID</Label>
                <Input
                  data-testid="input-consent-id"
                  value={form.feeConsentId}
                  onChange={(e) => setForm({ ...form, feeConsentId: e.target.value })}
                />
              </div>
              <div>
                <Label>Client user ID</Label>
                <Input
                  data-testid="input-client-id"
                  value={form.clientUserId}
                  onChange={(e) => setForm({ ...form, clientUserId: e.target.value })}
                />
              </div>
              <div>
                <Label>Adviser user ID</Label>
                <Input
                  data-testid="input-adviser-id"
                  value={form.adviserUserId}
                  onChange={(e) => setForm({ ...form, adviserUserId: e.target.value })}
                />
              </div>
              <div>
                <Label>Fee type</Label>
                <Select value={form.feeType} onValueChange={(v) => setForm({ ...form, feeType: v })}>
                  <SelectTrigger data-testid="select-fee-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ongoing_service_fee">Ongoing service fee</SelectItem>
                    <SelectItem value="advice_fee">Advice fee</SelectItem>
                    <SelectItem value="platform_fee">Platform fee</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Amount type</Label>
                <Select
                  value={form.amountType}
                  onValueChange={(v) => setForm({ ...form, amountType: v as any })}
                >
                  <SelectTrigger data-testid="select-amount-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed">Fixed (monthly amount)</SelectItem>
                    <SelectItem value="percentage">Percentage (bps)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.amountType === "fixed" ? (
                <div>
                  <Label>Fixed monthly amount</Label>
                  <Input
                    data-testid="input-fixed-amount"
                    value={form.fixedAmount}
                    onChange={(e) => setForm({ ...form, fixedAmount: e.target.value })}
                    placeholder="e.g. 150.0000"
                  />
                </div>
              ) : (
                <div>
                  <Label>Rate (bps, 1bp = 0.01%)</Label>
                  <Input
                    data-testid="input-rate-bps"
                    value={form.rateBps}
                    onChange={(e) => setForm({ ...form, rateBps: e.target.value })}
                    placeholder="e.g. 75 for 0.75%"
                  />
                </div>
              )}
              <div>
                <Label>Adviser split (bps)</Label>
                <Input
                  data-testid="input-adviser-split"
                  value={form.adviserSplitBps}
                  onChange={(e) => setForm({ ...form, adviserSplitBps: e.target.value })}
                />
              </div>
              <div>
                <Label>Platform split (bps)</Label>
                <Input
                  data-testid="input-platform-split"
                  value={form.platformSplitBps}
                  onChange={(e) => setForm({ ...form, platformSplitBps: e.target.value })}
                />
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button
                  onClick={submitCreateRule}
                  data-testid="button-create-rule"
                >
                  <Plus className="h-4 w-4 mr-1" /> Create rule
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">All rules</CardTitle>
              <CardDescription>
                Active rules accrue daily. Paused rules still emit a zero-amount audit row
                with reason <code>rule_paused</code>.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-4">
                <SearchBox
                  value={rulesSearch}
                  onChange={setRulesSearch}
                  placeholder="Search by client or adviser name / email"
                  testId="input-search-rules"
                />
              </div>
              {rulesQ.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : rulesQ.data && rulesQ.data.items.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID</TableHead>
                      <TableHead>Consent</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead>Adviser</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Splits (adv/plat)</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rulesQ.data.items.map((r) => (
                      <TableRow key={r.id} data-testid={`row-rule-${r.id}`}>
                        <TableCell>{r.id}</TableCell>
                        <TableCell>{r.feeConsentId}</TableCell>
                        <TableCell>
                          <UserCell users={rulesQ.data?.users} userId={r.clientUserId} />
                        </TableCell>
                        <TableCell>
                          <UserCell users={rulesQ.data?.users} userId={r.adviserUserId} />
                        </TableCell>
                        <TableCell>{r.feeType}</TableCell>
                        <TableCell>
                          {r.amountType === "fixed"
                            ? `${r.fixedAmount} ${r.currency} / month`
                            : `${(Number(r.rateBps ?? 0) / 100).toFixed(2)}% p.a.`}
                        </TableCell>
                        <TableCell>
                          {bpsLabel(r.adviserSplitBps)} / {bpsLabel(r.platformSplitBps)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={r.status === "active" ? "outline" : "secondary"}>
                            {r.status}
                          </Badge>
                          {r.pausedReason && (
                            <span className="block text-xs text-muted-foreground mt-1">
                              {r.pausedReason}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          {r.status === "active" && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => pauseRule(r.id)}
                              data-testid={`button-pause-${r.id}`}
                            >
                              <Pause className="h-4 w-4 mr-1" /> Pause
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {debouncedRulesSearch.trim()
                    ? "No fee rules match your search."
                    : "No fee rules yet."}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- ACCRUALS TAB ---- */}
        <TabsContent value="accruals" className="space-y-4">
          <Card data-testid="card-latest-run">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4" /> Last accrual run
              </CardTitle>
              <CardDescription>
                Surfaced from <code>fee_accrual_runs</code> — covers both the daily{" "}
                <strong>cron</strong> and admin <strong>manual</strong> runs.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {latestRunQ.isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : latestRunQ.isError ? (
                <Alert variant="destructive" data-testid="alert-latest-run-error">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Couldn't load the last accrual run</AlertTitle>
                  <AlertDescription className="font-mono text-xs">
                    {(latestRunQ.error as Error)?.message ?? "Unknown error"}
                  </AlertDescription>
                </Alert>
              ) : latestRunQ.data?.run ? (
                <LatestRunSummary run={latestRunQ.data.run} />
              ) : (
                <p className="text-sm text-muted-foreground" data-testid="text-no-runs">
                  No accrual run has been recorded yet. The daily cron starts ~3 minutes
                  after the server boots; you can also press <strong>Run</strong> below.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Run daily accruals</CardTitle>
              <CardDescription>
                Idempotent — re-running for the same date is a no-op. Failed gates insert a
                zero-amount row with a gate reason.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex gap-2 items-end">
              <div>
                <Label>Accrual date</Label>
                <Input
                  type="date"
                  value={accrualDate}
                  onChange={(e) => setAccrualDate(e.target.value)}
                  data-testid="input-accrual-date"
                />
              </div>
              <Button onClick={runAccruals} data-testid="button-run-accruals">
                <Play className="h-4 w-4 mr-1" /> Run
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Recent accruals</CardTitle></CardHeader>
            <CardContent>
              <div className="mb-4">
                <SearchBox
                  value={accrualsSearch}
                  onChange={setAccrualsSearch}
                  placeholder="Search by client or adviser name / email"
                  testId="input-search-accruals"
                />
              </div>
              {accrualsQ.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : accrualsQ.data && accrualsQ.data.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {debouncedAccrualsSearch.trim()
                    ? "No accruals match your search."
                    : "No accruals yet."}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID</TableHead>
                      <TableHead>Rule</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead>Adviser</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Adviser share</TableHead>
                      <TableHead>Gate reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accrualsQ.data?.items.map((a) => (
                      <TableRow key={a.id} data-testid={`row-accrual-${a.id}`}>
                        <TableCell>{a.id}</TableCell>
                        <TableCell>{a.feeRuleId}</TableCell>
                        <TableCell>
                          <UserCell users={accrualsQ.data?.users} userId={a.clientUserId} />
                        </TableCell>
                        <TableCell>
                          <UserCell users={accrualsQ.data?.users} userId={a.adviserUserId} />
                        </TableCell>
                        <TableCell>{a.accrualDate.slice(0, 10)}</TableCell>
                        <TableCell>{a.accrualAmount} {a.currency}</TableCell>
                        <TableCell>{a.adviserShareAmount}</TableCell>
                        <TableCell>
                          {a.gateReason ? (
                            <Badge variant="destructive">{a.gateReason}</Badge>
                          ) : (
                            <Badge variant="outline">accrued</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- DEDUCTIONS TAB ---- */}
        <TabsContent value="deductions" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Generate pending deductions</CardTitle>
              <CardDescription>
                Roll up non-skipped accruals in a window into per-(client, adviser) batches.
                Approval is a status flip + audit row only — Gate A.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex gap-2 items-end">
              <div>
                <Label>Period start</Label>
                <Input
                  type="date"
                  value={period.start}
                  onChange={(e) => setPeriod({ ...period, start: e.target.value })}
                  data-testid="input-period-start"
                />
              </div>
              <div>
                <Label>Period end</Label>
                <Input
                  type="date"
                  value={period.end}
                  onChange={(e) => setPeriod({ ...period, end: e.target.value })}
                  data-testid="input-period-end"
                />
              </div>
              <Button onClick={generateDeductions} data-testid="button-generate-deductions">
                <Play className="h-4 w-4 mr-1" /> Generate
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Deductions</CardTitle></CardHeader>
            <CardContent>
              <div className="mb-4">
                <SearchBox
                  value={deductionsSearch}
                  onChange={setDeductionsSearch}
                  placeholder="Search by client or adviser name / email"
                  testId="input-search-deductions"
                />
              </div>
              {deductionsQ.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : deductionsQ.data && deductionsQ.data.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {debouncedDeductionsSearch.trim()
                    ? "No deductions match your search."
                    : "No deductions yet."}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead>Adviser</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead>Total</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deductionsQ.data?.items.map((d) => (
                      <TableRow key={d.id} data-testid={`row-deduction-${d.id}`}>
                        <TableCell>{d.id}</TableCell>
                        <TableCell>
                          <UserCell users={deductionsQ.data?.users} userId={d.clientUserId} />
                        </TableCell>
                        <TableCell>
                          <UserCell users={deductionsQ.data?.users} userId={d.adviserUserId} />
                        </TableCell>
                        <TableCell>{d.periodStart.slice(0, 10)} → {d.periodEnd.slice(0, 10)}</TableCell>
                        <TableCell>{d.totalAccrued} {d.currency}</TableCell>
                        <TableCell>
                          <Badge variant={d.status === "pending_approval" ? "secondary" : "outline"}>
                            {d.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {d.status === "pending_approval" && (
                            <Button
                              size="sm"
                              variant="default"
                              onClick={() => approveDeduction(d.id)}
                              data-testid={`button-approve-${d.id}`}
                            >
                              <CheckCircle2 className="h-4 w-4 mr-1" /> Approve
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
