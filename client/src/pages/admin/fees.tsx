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

import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
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
import {
  ShieldAlert,
  HandCoins,
  Play,
  Pause,
  Plus,
  CheckCircle2,
  Clock,
  AlertCircle,
  Search,
  X,
  Undo2,
  // Task #93 — reporting tab icons
  Scale,
  Wallet,
  TrendingUp,
  Bug,
  ExternalLink,
  AlertTriangle,
  // Task #100 — CSV export buttons on the four reporting tabs
  Download,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
// Task #204 — single canonical source for the IF status string + predicate.
// Using these in admin/fees.tsx keeps the admin surface aligned with the
// client + adviser surfaces; previously the page used raw "insufficient_funds"
// string literals which are easy to drift if the engine ever renames the
// status.
import {
  INSUFFICIENT_FUNDS_STATUS,
  isInsufficientFundsRow,
} from "@/lib/insufficient-funds";

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
  // Gate B settlement fields
  settledAt: string | null;
  settledTransactionId: number | null;
  failureReason: string | null;
  // Task #33 — reversal fields
  reversedAt: string | null;
  reversedByUserId: number | null;
  reversedReason: string | null;
  reversalTransactionId: number | null;
  // Task #64 — sweep + client-notification tracking. Populated by the daily
  // insufficient-funds sweep cron, NULL/0 on rows it has never visited.
  lastRecheckedAt: string | null;
  clientNotifiedAt: string | null;
  clientNotificationCount: number;
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
  // Task #65 — present on the deductions endpoint only. Global count of
  // rows currently held for insufficient funds, regardless of the active
  // filter, so the header counter stays stable as admins toggle filters.
  heldCount?: number;
}

// =============================================================================
// TASK #93 — Reporting types (mirror the four read-only endpoints).
// =============================================================================
interface ReportingPeriod {
  from: string;
  to: string;
}
interface FeeReconciliationResp {
  period: ReportingPeriod;
  settled: {
    count: number;
    totalAccrued: string;
    adviserShare: string;
    platformShare: string;
  };
  reversed: {
    count: number;
    totalAccrued: string;
    adviserShare: string;
    platformShare: string;
  };
  insufficientFunds: { count: number; totalAccrued: string };
  pendingApproval: { count: number; totalAccrued: string };
  walletLedgerDrift: {
    count: number;
    matchEpsilon: number;
    pairs: { userId: number; currency: string }[];
  };
}
interface AdviserPayoutRow {
  adviserUserId: number;
  firstName: string;
  lastName: string;
  email: string;
  settledCount: number;
  settledTotal: string;
  settledTotalAccrued: string;
  reversedCount: number;
  reversedTotal: string;
  reversedTotalAccrued: string;
  netPayable: string;
}
interface AdviserPayoutsResp {
  period: ReportingPeriod;
  items: AdviserPayoutRow[];
}
interface PlatformRevenueBucket {
  bucket: string;
  count: number;
  platformShare: string;
  totalAccrued: string;
}
interface PlatformRevenueResp {
  period: ReportingPeriod;
  bucket: "monthly" | "weekly";
  items: PlatformRevenueBucket[];
  sparkline: { bucket: string; platformShare: string }[];
}
interface FeeExceptionRow {
  kind: "held" | "stuck" | "failed" | "role_corruption";
  deduction: FeeDeductionRow;
  ageDays: number;
}
interface FeeExceptionsResp {
  period: ReportingPeriod;
  stuckCutoff: string;
  items: FeeExceptionRow[];
  users: UsersMap;
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

// =============================================================================
// TASK #100 — CSV export helpers used by the four reporting tabs.
// -----------------------------------------------------------------------------
// We build the CSV client-side from the already-fetched query data so the
// export naturally reflects the visible period (and any active client-side
// sort, e.g. adviser payouts). No new server endpoints — the task is read-only
// and explicitly forbids new money-movement routes.
// =============================================================================
function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function downloadCsv(
  filename: string,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): void {
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
  // Prepend a UTF-8 BOM so Excel opens non-ASCII (e.g. accented adviser names)
  // correctly without manual encoding gymnastics.
  const blob = new Blob(["\uFEFF" + csv], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function periodSlug(from: string, to: string): string {
  return `${from.slice(0, 10)}_to_${to.slice(0, 10)}`;
}

function deductionStatusVariant(status: string): "default" | "secondary" | "outline" | "destructive" {
  if (status === "settled") return "default";
  if (status === "pending_approval") return "secondary";
  if (status === "rejected") return "destructive";
  // Task #34: client couldn't cover the debit. Render as destructive so it
  // pops in the table the same way a rejection does — admins need to see
  // these to top the client up before retrying.
  if (status === INSUFFICIENT_FUNDS_STATUS) return "destructive";
  return "outline";
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

// =============================================================================
// TASK #204 — Manual insufficient-funds sweep card
// -----------------------------------------------------------------------------
// Lives above the deductions table. Posts to the new admin-only endpoint
// that wraps `runInsufficientFundsSweep()` and renders the returned summary
// counts in a compact card. Refreshes the deductions query so freshly-settled
// rows disappear from the IF filter view immediately.
// =============================================================================
interface SweepSummary {
  checked: number;
  settled: number;
  stillInsufficient: number;
  errors: number;
  notificationsSent: number;
  notificationsSkippedDueToDebounce: number;
  notificationsFailed: number;
}
interface SweepRunResponse {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  message?: string;
  summary?: SweepSummary;
}

function InsufficientFundsSweepCard() {
  const { toast } = useToast();
  const [lastResult, setLastResult] = useState<SweepRunResponse | null>(null);

  const runMutation = useMutation({
    mutationFn: async (): Promise<SweepRunResponse> => {
      const res = await apiRequest(
        "POST",
        "/api/admin/insufficient-funds-sweep/run",
        {},
      );
      return (await res.json()) as SweepRunResponse;
    },
    onSuccess: (data) => {
      setLastResult(data);
      // Pull fresh deduction rows so the table reflects any newly-settled
      // entries the sweep moved out of the IF state.
      queryClient.invalidateQueries({ queryKey: ["/api/admin/fee-deductions"] });
      queryClient.invalidateQueries({
        queryKey: ["/api/admin/fee-reconciliation"],
      });
      if (data.skipped) {
        toast({
          title: "Sweep skipped",
          description: data.message ?? "Sweep was not run.",
          variant: "destructive",
        });
      } else if (data.summary) {
        toast({
          title: "Sweep complete",
          description: `Checked ${data.summary.checked}, settled ${data.summary.settled}, still held ${data.summary.stillInsufficient}.`,
        });
      }
    },
    onError: (err: Error) => {
      toast({
        title: "Sweep failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  return (
    <Card data-testid="card-if-sweep">
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base">
              Insufficient-funds re-check
            </CardTitle>
            <CardDescription>
              Manually re-runs the daily sweep that re-attempts settlement
              for every held deduction. Honours the fee-deductions kill
              switch.
            </CardDescription>
          </div>
          <Button
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending}
            data-testid="button-run-if-sweep"
          >
            <Play className="h-4 w-4 mr-1" />
            {runMutation.isPending
              ? "Running…"
              : "Re-check insufficient deductions now"}
          </Button>
        </div>
      </CardHeader>
      {lastResult && (
        <CardContent>
          {lastResult.skipped ? (
            <Alert
              variant="destructive"
              data-testid="alert-if-sweep-skipped"
            >
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Sweep skipped</AlertTitle>
              <AlertDescription>
                {lastResult.message ?? "Sweep was not run."}
              </AlertDescription>
            </Alert>
          ) : lastResult.summary ? (
            <div
              className="grid grid-cols-2 sm:grid-cols-4 gap-3"
              data-testid="card-if-sweep-summary"
            >
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground">Checked</div>
                <div
                  className="text-2xl font-semibold"
                  data-testid="text-sweep-checked"
                >
                  {lastResult.summary.checked}
                </div>
              </div>
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground">Settled</div>
                <div
                  className="text-2xl font-semibold text-green-700 dark:text-green-400"
                  data-testid="text-sweep-settled"
                >
                  {lastResult.summary.settled}
                </div>
              </div>
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground">
                  Still insufficient
                </div>
                <div
                  className="text-2xl font-semibold text-amber-700 dark:text-amber-400"
                  data-testid="text-sweep-still-insufficient"
                >
                  {lastResult.summary.stillInsufficient}
                </div>
              </div>
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground">
                  Errors / not eligible
                </div>
                <div
                  className="text-2xl font-semibold text-red-700 dark:text-red-400"
                  data-testid="text-sweep-errors"
                >
                  {lastResult.summary.errors}
                </div>
              </div>
              <div className="col-span-2 sm:col-span-4 text-xs text-muted-foreground pt-1">
                Client notifications: sent {lastResult.summary.notificationsSent},
                debounced {lastResult.summary.notificationsSkippedDueToDebounce},
                failed {lastResult.summary.notificationsFailed}.
              </div>
            </div>
          ) : null}
        </CardContent>
      )}
    </Card>
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
      toast({
        title: "Deduction settled",
        description:
          "Client debited; adviser + platform credited. Ledger entries posted (Gate B).",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/fee-deductions"] });
    } catch (err: any) {
      toast({ title: "Approve failed", description: err?.message ?? String(err), variant: "destructive" });
      // Task #34: the backend may have updated the row to
      // `insufficient_funds` (or written a new failureReason) before
      // throwing — invalidate so the table reflects the new status
      // immediately rather than waiting for the next manual refresh.
      queryClient.invalidateQueries({ queryKey: ["/api/admin/fee-deductions"] });
    }
  }

  // -------- Reverse settled deduction (Task #33) --------
  const [reverseTarget, setReverseTarget] = useState<FeeDeductionRow | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseSubmitting, setReverseSubmitting] = useState(false);

  function openReverseDialog(row: FeeDeductionRow) {
    setReverseTarget(row);
    setReverseReason("");
  }
  function closeReverseDialog() {
    if (reverseSubmitting) return;
    setReverseTarget(null);
    setReverseReason("");
  }
  async function submitReverse() {
    if (!reverseTarget) return;
    const trimmed = reverseReason.trim();
    if (!trimmed) {
      toast({
        title: "Reason required",
        description: "Tell future-you why this deduction was reversed.",
        variant: "destructive",
      });
      return;
    }
    setReverseSubmitting(true);
    try {
      await apiRequest(
        "POST",
        `/api/admin/fee-deductions/${reverseTarget.id}/reverse`,
        { reason: trimmed },
      );
      toast({
        title: "Deduction reversed",
        description:
          "Opposite ledger triple posted to a new transaction. Client credited; adviser + platform debited.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/fee-deductions"] });
      setReverseTarget(null);
      setReverseReason("");
    } catch (err: any) {
      toast({
        title: "Reverse failed",
        description: err?.message ?? String(err),
        variant: "destructive",
      });
    } finally {
      setReverseSubmitting(false);
    }
  }

  // -------- Search state (one box per tab, debounced server-side filter) --------
  const [rulesSearch, setRulesSearch] = useState("");
  const [accrualsSearch, setAccrualsSearch] = useState("");
  const [deductionsSearch, setDeductionsSearch] = useState("");
  const debouncedRulesSearch = useDebounced(rulesSearch);
  const debouncedAccrualsSearch = useDebounced(accrualsSearch);
  const debouncedDeductionsSearch = useDebounced(deductionsSearch);

  // -------- Deductions filter / sort state (Task #65) --------
  // Status filter is server-side; "all" (the sentinel) maps to omitting the
  // query param. Sort defaults to "newest first" so the table behaves like it
  // always has unless an admin explicitly switches to held-first triage mode.
  const [deductionsStatus, setDeductionsStatus] = useState<string>("all");
  const [deductionsSort, setDeductionsSort] = useState<
    "created_desc" | "created_asc" | "status_held_first"
  >("created_desc");

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
    queryKey: [
      "/api/admin/fee-deductions",
      {
        q: debouncedDeductionsSearch,
        status: deductionsStatus,
        sort: deductionsSort,
      },
    ],
    queryFn: () => {
      const params = new URLSearchParams();
      if (debouncedDeductionsSearch.trim()) params.set("q", debouncedDeductionsSearch.trim());
      if (deductionsStatus && deductionsStatus !== "all") {
        params.set("status", deductionsStatus);
      }
      if (deductionsSort && deductionsSort !== "created_desc") {
        params.set("sort", deductionsSort);
      }
      const qs = params.toString();
      return fetchPaginated<Paginated<FeeDeductionRow>>(
        `/api/admin/fee-deductions${qs ? `?${qs}` : ""}`,
      );
    },
  });

  // ===========================================================================
  // TASK #93 — Reporting tab state.
  // ---------------------------------------------------------------------------
  // Single from/to range shared across all four reporting tabs so admins don't
  // have to re-enter the period every time they switch tab. Defaults to "last
  // 30 days" so a fresh page load is always bounded — the backend rejects an
  // unbounded request anyway, but this keeps the UX clean.
  // ===========================================================================
  const todayEndIso = (): string => {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    return d.toISOString();
  };
  const daysAgoStartIso = (days: number): string => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  };
  // <input type="datetime-local"> needs YYYY-MM-DDTHH:MM (no seconds, no Z),
  // but the API needs full ISO. We keep the source of truth as ISO strings
  // and convert on the boundary.
  const toLocalInput = (iso: string): string => {
    if (!iso) return "";
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const fromLocalInput = (local: string): string => {
    if (!local) return "";
    const d = new Date(local);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString();
  };

  const [reportFrom, setReportFrom] = useState<string>(daysAgoStartIso(30));
  const [reportTo, setReportTo] = useState<string>(todayEndIso());
  const [revenueBucket, setRevenueBucket] = useState<"monthly" | "weekly">(
    "monthly",
  );
  // Adviser-payouts UX: client-side sort. The default ("net_desc") matches
  // the server's default ordering, but admins can flip to "net_asc"
  // (smallest first — useful for spotting reversals dominating settlements)
  // or "name_asc" (alphabetical, easier when scanning a long list).
  const [payoutsSort, setPayoutsSort] = useState<
    "net_desc" | "net_asc" | "settled_desc" | "name_asc"
  >("net_desc");

  // Cross-link state: when an admin clicks "Open in deductions" on an
  // exception row, we jump to the deductions tab, set its status filter,
  // and remember which row id to highlight + scroll to once the deductions
  // table re-fetches.
  const [highlightDeductionId, setHighlightDeductionId] = useState<
    number | null
  >(null);
  useEffect(() => {
    if (!highlightDeductionId) return;
    if (tab !== "deductions") return;
    if (deductionsQ.isLoading) return;
    const el = document.querySelector(
      `[data-testid="row-deduction-${highlightDeductionId}"]`,
    );
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("bg-yellow-100", "dark:bg-yellow-900/30");
      const id = highlightDeductionId;
      const t = setTimeout(() => {
        el.classList.remove("bg-yellow-100", "dark:bg-yellow-900/30");
        setHighlightDeductionId((cur) => (cur === id ? null : cur));
      }, 2500);
      return () => clearTimeout(t);
    }
  }, [highlightDeductionId, tab, deductionsQ.isLoading, deductionsQ.dataUpdatedAt]);

  function openDeductionFromException(d: FeeDeductionRow) {
    if (isInsufficientFundsRow(d)) {
      setDeductionsStatus(INSUFFICIENT_FUNDS_STATUS);
    } else if (d.status === "pending_approval") {
      setDeductionsStatus("pending_approval");
    } else if (d.status === "settled") {
      setDeductionsStatus("settled");
    } else if (d.status === "reversed") {
      setDeductionsStatus("reversed");
    } else {
      setDeductionsStatus("all");
    }
    setHighlightDeductionId(d.id);
    setTab("deductions");
  }

  // Common reporting query options. 60s stale time is plenty for what is
  // effectively a daily-cadence reconciliation page; window-focus refetch
  // means the admin gets fresh numbers when they switch back to the tab
  // after a settlement.
  const reportingQueryOptions = {
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  } as const;

  // The four reporting tabs are only enabled when both bounds parse — this
  // mirrors the backend, which rejects requests with missing bounds.
  const periodValid =
    reportFrom !== "" &&
    reportTo !== "" &&
    !Number.isNaN(new Date(reportFrom).getTime()) &&
    !Number.isNaN(new Date(reportTo).getTime()) &&
    new Date(reportFrom).getTime() <= new Date(reportTo).getTime();

  const reconQ = useQuery<FeeReconciliationResp>({
    queryKey: [
      "/api/admin/fee-reconciliation",
      { from: reportFrom, to: reportTo },
    ],
    queryFn: () => {
      const params = new URLSearchParams({ from: reportFrom, to: reportTo });
      return fetchPaginated<FeeReconciliationResp>(
        `/api/admin/fee-reconciliation?${params.toString()}`,
      );
    },
    enabled: periodValid && tab === "reconciliation",
    ...reportingQueryOptions,
  });

  const payoutsQ = useQuery<AdviserPayoutsResp>({
    queryKey: [
      "/api/admin/adviser-payouts",
      { from: reportFrom, to: reportTo },
    ],
    queryFn: () => {
      const params = new URLSearchParams({ from: reportFrom, to: reportTo });
      return fetchPaginated<AdviserPayoutsResp>(
        `/api/admin/adviser-payouts?${params.toString()}`,
      );
    },
    enabled: periodValid && tab === "adviser-payouts",
    ...reportingQueryOptions,
  });

  // Client-side sort over the payouts response. We don't re-fetch when the
  // sort changes — the response is per-adviser (not per-deduction), so even
  // a large book stays well under a few hundred rows.
  const sortedPayouts = useMemo(() => {
    const items = payoutsQ.data?.items ?? [];
    const copy = items.slice();
    switch (payoutsSort) {
      case "net_asc":
        copy.sort((a, b) => Number(a.netPayable) - Number(b.netPayable));
        break;
      case "settled_desc":
        copy.sort((a, b) => Number(b.settledTotal) - Number(a.settledTotal));
        break;
      case "name_asc":
        copy.sort((a, b) =>
          `${a.lastName} ${a.firstName}`.localeCompare(
            `${b.lastName} ${b.firstName}`,
          ),
        );
        break;
      case "net_desc":
      default:
        copy.sort((a, b) => Number(b.netPayable) - Number(a.netPayable));
    }
    return copy;
  }, [payoutsQ.data, payoutsSort]);

  const revenueQ = useQuery<PlatformRevenueResp>({
    queryKey: [
      "/api/admin/platform-fee-revenue",
      { from: reportFrom, to: reportTo, buckets: revenueBucket },
    ],
    queryFn: () => {
      const params = new URLSearchParams({
        from: reportFrom,
        to: reportTo,
        buckets: revenueBucket,
      });
      return fetchPaginated<PlatformRevenueResp>(
        `/api/admin/platform-fee-revenue?${params.toString()}`,
      );
    },
    enabled: periodValid && tab === "platform-revenue",
    ...reportingQueryOptions,
  });

  const exceptionsQ = useQuery<FeeExceptionsResp>({
    queryKey: [
      "/api/admin/fee-exceptions",
      { from: reportFrom, to: reportTo },
    ],
    queryFn: () => {
      const params = new URLSearchParams({ from: reportFrom, to: reportTo });
      return fetchPaginated<FeeExceptionsResp>(
        `/api/admin/fee-exceptions?${params.toString()}`,
      );
    },
    enabled: periodValid && tab === "exceptions",
    ...reportingQueryOptions,
  });

  // ===========================================================================
  // TASK #100 — CSV download handlers, one per reporting tab.
  // ---------------------------------------------------------------------------
  // Each handler reads from the corresponding query data (already scoped to the
  // selected from/to range and any active client-side sort) and triggers a
  // browser download. Handlers no-op if data hasn't loaded — the buttons that
  // call them are also disabled in that state.
  // ===========================================================================
  function downloadReconciliationCsv() {
    const d = reconQ.data;
    if (!d) return;
    const rows: (string | number)[][] = [
      ["Period from", d.period.from],
      ["Period to", d.period.to],
      [],
      ["Metric", "Count", "Total accrued", "Adviser share", "Platform share"],
      [
        "Settled in period",
        d.settled.count,
        d.settled.totalAccrued,
        d.settled.adviserShare,
        d.settled.platformShare,
      ],
      [
        "Reversed in period",
        d.reversed.count,
        d.reversed.totalAccrued,
        d.reversed.adviserShare,
        d.reversed.platformShare,
      ],
      [
        "Held (insufficient funds)",
        d.insufficientFunds.count,
        d.insufficientFunds.totalAccrued,
        "",
        "",
      ],
      [
        "Pending approval",
        d.pendingApproval.count,
        d.pendingApproval.totalAccrued,
        "",
        "",
      ],
      [
        "Wallet vs ledger drift",
        d.walletLedgerDrift.count,
        `match epsilon ${d.walletLedgerDrift.matchEpsilon}`,
        "",
        "",
      ],
    ];
    downloadCsv(
      `fee-reconciliation_${periodSlug(d.period.from, d.period.to)}.csv`,
      rows,
    );
  }

  function downloadAdviserPayoutsCsv() {
    const d = payoutsQ.data;
    if (!d) return;
    const rows: (string | number)[][] = [
      ["Period from", d.period.from],
      ["Period to", d.period.to],
      [],
      [
        "Adviser ID",
        "First name",
        "Last name",
        "Email",
        "Settled count",
        "Settled adviser share",
        "Settled total accrued",
        "Reversed count",
        "Reversed adviser share",
        "Reversed total accrued",
        "Net payable",
      ],
      // sortedPayouts respects the active client-side sort dropdown so the CSV
      // mirrors what the admin sees in the table.
      ...sortedPayouts.map((r) => [
        r.adviserUserId,
        r.firstName,
        r.lastName,
        r.email,
        r.settledCount,
        r.settledTotal,
        r.settledTotalAccrued,
        r.reversedCount,
        r.reversedTotal,
        r.reversedTotalAccrued,
        r.netPayable,
      ]),
    ];
    downloadCsv(
      `adviser-payouts_${periodSlug(d.period.from, d.period.to)}.csv`,
      rows,
    );
  }

  function downloadPlatformRevenueCsv() {
    const d = revenueQ.data;
    if (!d) return;
    const rows: (string | number)[][] = [
      ["Period from", d.period.from],
      ["Period to", d.period.to],
      ["Bucket", d.bucket],
      [],
      [
        d.bucket === "weekly" ? "Week of" : "Month",
        "Settled count",
        "Total accrued",
        "Platform share",
      ],
      ...d.items.map((r) => [
        r.bucket.slice(0, 10),
        r.count,
        r.totalAccrued,
        r.platformShare,
      ]),
    ];
    downloadCsv(
      `platform-revenue-${d.bucket}_${periodSlug(d.period.from, d.period.to)}.csv`,
      rows,
    );
  }

  function downloadExceptionsCsv() {
    const d = exceptionsQ.data;
    if (!d) return;
    // Task #204 — `failureReason` is IF-only metadata that lingers on the
    // row after settle. Only surface it to non-IF kinds via the synthetic
    // fallback so a stuck/role_corruption row from a previously-IF
    // deduction can't leak the old IF text into the CSV.
    const reasonFor = (x: FeeExceptionRow): string =>
      x.kind === "held"
        ? (x.deduction.failureReason ?? "Insufficient client balance")
        : x.kind === "stuck"
          ? "Pending approval > 7 days"
          : x.kind === "role_corruption"
            ? "Settled or reversed against a non-adviser user"
            : "Last attempt failed";
    const rows: (string | number)[][] = [
      ["Period from", d.period.from],
      ["Period to", d.period.to],
      ["Stuck cutoff", d.stuckCutoff],
      [],
      [
        "Kind",
        "Deduction ID",
        "Client name",
        "Client email",
        "Adviser name",
        "Adviser email",
        "Total accrued",
        "Currency",
        "Age (days)",
        "Last sweep",
        "Client notified at",
        "Notification count",
        "Reason",
      ],
      ...d.items.map((x) => {
        const c = d.users[x.deduction.clientUserId];
        const a = d.users[x.deduction.adviserUserId];
        // Task #204 — gate IF bookkeeping fields by kind === "held" so
        // stuck/role_corruption/failed rows don't carry over stale IF
        // re-check / notification data from a previous IF episode.
        const heldOnly = x.kind === "held";
        return [
          x.kind,
          x.deduction.id,
          c
            ? `${c.firstName} ${c.lastName}`.trim() || c.email
            : `#${x.deduction.clientUserId}`,
          c?.email ?? "",
          a
            ? `${a.firstName} ${a.lastName}`.trim() || a.email
            : `#${x.deduction.adviserUserId}`,
          a?.email ?? "",
          x.deduction.totalAccrued,
          x.deduction.currency,
          x.ageDays,
          heldOnly ? (x.deduction.lastRecheckedAt ?? "") : "",
          heldOnly ? (x.deduction.clientNotifiedAt ?? "") : "",
          heldOnly ? x.deduction.clientNotificationCount : "",
          reasonFor(x),
        ];
      }),
    ];
    downloadCsv(
      `fee-exceptions_${periodSlug(d.period.from, d.period.to)}.csv`,
      rows,
    );
  }

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
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="rules" data-testid="tab-rules">Rules</TabsTrigger>
          <TabsTrigger value="accruals" data-testid="tab-accruals">Accruals</TabsTrigger>
          <TabsTrigger value="deductions" data-testid="tab-deductions">Deductions</TabsTrigger>
          {/* Task #93 — read-only reporting tabs */}
          <TabsTrigger value="reconciliation" data-testid="tab-reconciliation">
            <Scale className="h-3.5 w-3.5 mr-1" /> Reconciliation
          </TabsTrigger>
          <TabsTrigger value="adviser-payouts" data-testid="tab-adviser-payouts">
            <Wallet className="h-3.5 w-3.5 mr-1" /> Adviser payouts
          </TabsTrigger>
          <TabsTrigger value="platform-revenue" data-testid="tab-platform-revenue">
            <TrendingUp className="h-3.5 w-3.5 mr-1" /> Platform revenue
          </TabsTrigger>
          <TabsTrigger value="exceptions" data-testid="tab-exceptions">
            <Bug className="h-3.5 w-3.5 mr-1" /> Exceptions
          </TabsTrigger>
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
                Approving a pending batch posts the client debit and the adviser/platform
                credits to the ledger inside one DB transaction (Gate B).
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

          {/* Task #204 — manual trigger for the insufficient-funds sweep.
              Re-runs the SAME sweep the daily cron uses (no logic
              duplication). Honours the fee_deductions kill switch. */}
          <InsufficientFundsSweepCard />

          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base">Deductions</CardTitle>
                {/* Task #65 — global counter of held rows. Always reflects the
                    real number regardless of the active filter so admins can
                    see at-a-glance how many top-ups need chasing. */}
                {deductionsQ.data && (deductionsQ.data.heldCount ?? 0) > 0 && (
                  <Badge
                    variant="destructive"
                    className="shrink-0"
                    data-testid="badge-held-count"
                  >
                    <AlertCircle className="h-3 w-3 mr-1" />
                    {deductionsQ.data.heldCount}{" "}
                    {deductionsQ.data.heldCount === 1
                      ? "deduction held"
                      : "deductions held"}{" "}
                    for insufficient funds
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="mb-4 flex flex-wrap items-end gap-3">
                <SearchBox
                  value={deductionsSearch}
                  onChange={setDeductionsSearch}
                  placeholder="Search by client or adviser name / email"
                  testId="input-search-deductions"
                />
                <div>
                  <Label className="text-xs text-muted-foreground">Status</Label>
                  <Select
                    value={deductionsStatus}
                    onValueChange={(v) => setDeductionsStatus(v)}
                  >
                    <SelectTrigger
                      className="w-[200px]"
                      data-testid="select-deductions-status"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      <SelectItem value="pending_approval">Pending approval</SelectItem>
                      <SelectItem value={INSUFFICIENT_FUNDS_STATUS}>
                        Held — insufficient funds
                      </SelectItem>
                      <SelectItem value="settled">Settled</SelectItem>
                      <SelectItem value="rejected">Rejected</SelectItem>
                      <SelectItem value="reversed">Reversed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Sort</Label>
                  <Select
                    value={deductionsSort}
                    onValueChange={(v) =>
                      setDeductionsSort(
                        v as "created_desc" | "created_asc" | "status_held_first",
                      )
                    }
                  >
                    <SelectTrigger
                      className="w-[220px]"
                      data-testid="select-deductions-sort"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="created_desc">Newest first</SelectItem>
                      <SelectItem value="created_asc">Oldest first</SelectItem>
                      <SelectItem value="status_held_first">
                        Held first (oldest-held)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {deductionsQ.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : deductionsQ.data && deductionsQ.data.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {debouncedDeductionsSearch.trim() ||
                  deductionsStatus !== "all"
                    ? "No deductions match the current filters."
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
                      <TableHead>Settlement</TableHead>
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
                          <Badge variant={deductionStatusVariant(d.status)}>
                            {d.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          {d.status === "reversed" ? (
                            <div data-testid={`text-reversed-${d.id}`}>
                              <div className="flex items-center gap-1">
                                <Badge variant="destructive" className="text-[10px]">
                                  reversed
                                </Badge>
                                {d.reversedAt && (
                                  <span>{d.reversedAt.slice(0, 10)}</span>
                                )}
                              </div>
                              <div className="text-muted-foreground">
                                settle tx#{d.settledTransactionId ?? "—"} →
                                reversal tx#
                                <span data-testid={`text-reversal-tx-${d.id}`}>
                                  {d.reversalTransactionId ?? "—"}
                                </span>
                              </div>
                              {d.reversedReason && (
                                <div
                                  className="text-muted-foreground italic mt-0.5"
                                  title={d.reversedReason}
                                  data-testid={`text-reversed-reason-${d.id}`}
                                >
                                  "{d.reversedReason.length > 60
                                    ? `${d.reversedReason.slice(0, 60)}…`
                                    : d.reversedReason}"
                                </div>
                              )}
                            </div>
                          ) : d.status === "settled" && d.settledAt ? (
                            <div data-testid={`text-settled-${d.id}`}>
                              <div>{d.settledAt.slice(0, 10)}</div>
                              <div className="text-muted-foreground">
                                tx#{d.settledTransactionId ?? "—"}
                              </div>
                            </div>
                          ) : d.failureReason ? (
                            <div data-testid={`text-failure-${d.id}`}>
                              <span
                                className="text-red-600"
                                title={d.failureReason}
                              >
                                {isInsufficientFundsRow(d)
                                  ? "Insufficient client balance"
                                  : "Last attempt failed"}
                              </span>
                              {isInsufficientFundsRow(d) && (
                                <div
                                  className="text-muted-foreground mt-1 leading-snug"
                                  data-testid={`text-recheck-${d.id}`}
                                >
                                  <div>
                                    Last re-checked:{" "}
                                    {d.lastRecheckedAt ? (
                                      <span title={d.lastRecheckedAt}>
                                        {formatRelative(d.lastRecheckedAt)}
                                      </span>
                                    ) : (
                                      <span className="italic">
                                        not yet (next sweep within 24h)
                                      </span>
                                    )}
                                  </div>
                                  <div>
                                    Client notified:{" "}
                                    {d.clientNotifiedAt ? (
                                      <span
                                        title={d.clientNotifiedAt}
                                        data-testid={`text-notified-${d.id}`}
                                      >
                                        {formatRelative(d.clientNotifiedAt)}
                                        {d.clientNotificationCount > 1 && (
                                          <>
                                            {" "}
                                            (×{d.clientNotificationCount})
                                          </>
                                        )}
                                      </span>
                                    ) : (
                                      <span
                                        className="italic"
                                        data-testid={`text-notified-${d.id}`}
                                      >
                                        not yet
                                      </span>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell>
                          {(d.status === "pending_approval" ||
                            d.status === "approved" ||
                            isInsufficientFundsRow(d)) && (
                            <Button
                              size="sm"
                              variant="default"
                              onClick={() => approveDeduction(d.id)}
                              data-testid={`button-approve-${d.id}`}
                            >
                              <CheckCircle2 className="h-4 w-4 mr-1" />
                              {isInsufficientFundsRow(d)
                                ? "Retry (after top-up)"
                                : d.failureReason
                                  ? "Retry"
                                  : "Approve & settle"}
                            </Button>
                          )}
                          {d.status === "settled" && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openReverseDialog(d)}
                              data-testid={`button-reverse-${d.id}`}
                            >
                              <Undo2 className="h-4 w-4 mr-1" />
                              Reverse
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

        {/* ============================================================ */}
        {/* TASK #93 — REPORTING TABS (read-only)                         */}
        {/* Shared period picker rendered inside each tab so the          */}
        {/* selection survives tab switches.                              */}
        {/* ============================================================ */}
        {(() => {
          const PeriodPicker = () => (
            <Card data-testid="card-reporting-period">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Reporting period</CardTitle>
                <CardDescription>
                  All four reporting tabs are read-only and period-bound. No
                  money moves from this screen — payouts are settled
                  transactionally on approval in the Deductions tab.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-end gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">From</Label>
                  <Input
                    type="datetime-local"
                    value={toLocalInput(reportFrom)}
                    onChange={(e) => {
                      const iso = fromLocalInput(e.target.value);
                      if (iso) setReportFrom(iso);
                    }}
                    className="w-[220px]"
                    data-testid="input-report-from"
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">To</Label>
                  <Input
                    type="datetime-local"
                    value={toLocalInput(reportTo)}
                    onChange={(e) => {
                      const iso = fromLocalInput(e.target.value);
                      if (iso) setReportTo(iso);
                    }}
                    className="w-[220px]"
                    data-testid="input-report-to"
                  />
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setReportFrom(daysAgoStartIso(7));
                      setReportTo(todayEndIso());
                    }}
                    data-testid="button-range-7d"
                  >
                    Last 7d
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setReportFrom(daysAgoStartIso(30));
                      setReportTo(todayEndIso());
                    }}
                    data-testid="button-range-30d"
                  >
                    Last 30d
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setReportFrom(daysAgoStartIso(90));
                      setReportTo(todayEndIso());
                    }}
                    data-testid="button-range-90d"
                  >
                    Last 90d
                  </Button>
                </div>
                {!periodValid && (
                  <span
                    className="text-xs text-destructive"
                    data-testid="text-period-invalid"
                  >
                    Pick a valid range (from must be ≤ to).
                  </span>
                )}
              </CardContent>
            </Card>
          );

          return (
            <>
              {/* ---- RECONCILIATION TAB ---- */}
              <TabsContent value="reconciliation" className="space-y-4">
                <PeriodPicker />
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={downloadReconciliationCsv}
                    disabled={!reconQ.data || reconQ.isLoading}
                    data-testid="button-download-reconciliation-csv"
                  >
                    <Download className="h-4 w-4 mr-1" /> Download CSV
                  </Button>
                </div>
                {reconQ.isLoading || !reconQ.data ? (
                  <Skeleton className="h-48 w-full" />
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    <Card data-testid="card-recon-settled">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">
                          Settled in period
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="text-2xl font-semibold">
                          {reconQ.data.settled.count}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                          <div>Total accrued: {reconQ.data.settled.totalAccrued}</div>
                          <div>Adviser share: {reconQ.data.settled.adviserShare}</div>
                          <div>Platform share: {reconQ.data.settled.platformShare}</div>
                        </div>
                      </CardContent>
                    </Card>
                    <Card data-testid="card-recon-reversed">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">
                          Reversed in period
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="text-2xl font-semibold">
                          {reconQ.data.reversed.count}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                          <div>Total accrued: {reconQ.data.reversed.totalAccrued}</div>
                          <div>Adviser share: {reconQ.data.reversed.adviserShare}</div>
                          <div>Platform share: {reconQ.data.reversed.platformShare}</div>
                        </div>
                      </CardContent>
                    </Card>
                    <Card data-testid="card-recon-held">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">
                          Held — insufficient funds
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="text-2xl font-semibold">
                          {reconQ.data.insufficientFunds.count}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          Total: {reconQ.data.insufficientFunds.totalAccrued}
                        </div>
                      </CardContent>
                    </Card>
                    <Card data-testid="card-recon-pending">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">
                          Pending approval
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="text-2xl font-semibold">
                          {reconQ.data.pendingApproval.count}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          Total: {reconQ.data.pendingApproval.totalAccrued}
                        </div>
                      </CardContent>
                    </Card>
                    {(() => {
                      const drift = reconQ.data.walletLedgerDrift;
                      const hasDrift = drift.count > 0;
                      // Build a `userId:CCY,...` filter mirroring the exact
                      // pairs that produced the count above. The recon page
                      // applies this filter against the same MATCH_EPSILON,
                      // so the row count there always matches this card.
                      const pairsParam = drift.pairs
                        .map((p) => `${p.userId}:${p.currency}`)
                        .join(",");
                      const drilldownHref = pairsParam
                        ? `/admin/reconciliation?status=mismatch&pairs=${encodeURIComponent(pairsParam)}`
                        : "/admin/reconciliation?status=mismatch";
                      const cardBody = (
                        <Card
                          data-testid="card-recon-drift"
                          className={
                            hasDrift
                              ? "transition hover:border-amber-400 hover:shadow-sm cursor-pointer"
                              : ""
                          }
                        >
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center justify-between">
                              <span>Wallet vs ledger drift</span>
                              {hasDrift && (
                                <ExternalLink
                                  className="h-3.5 w-3.5 text-muted-foreground"
                                  aria-hidden
                                />
                              )}
                            </CardTitle>
                          </CardHeader>
                          <CardContent>
                            <div className="text-2xl font-semibold flex items-center gap-2">
                              {drift.count}
                              {hasDrift && (
                                <AlertTriangle className="h-5 w-5 text-amber-500" />
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                              Distinct (user, currency) pairs whose latest recon row
                              drifts by more than {drift.matchEpsilon}.
                              Restricted to users involved in fee deductions in this
                              period.
                              {hasDrift && (
                                <span className="block mt-1 text-violet-700">
                                  View drifted pairs in Reconciliation →
                                </span>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      );
                      return hasDrift ? (
                        <Link
                          href={drilldownHref}
                          data-testid="link-recon-drift-drilldown"
                          aria-label={`View ${drift.count} drifted (user, currency) pair(s) in Reconciliation`}
                        >
                          {cardBody}
                        </Link>
                      ) : (
                        cardBody
                      );
                    })()}
                  </div>
                )}
              </TabsContent>

              {/* ---- ADVISER PAYOUTS TAB ---- */}
              <TabsContent value="adviser-payouts" className="space-y-4">
                <PeriodPicker />
                <Card>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <CardTitle className="text-base">
                          Adviser payouts (read-only)
                        </CardTitle>
                        <CardDescription>
                          Net payable = settled adviser share − reversed
                          adviser share, in the period. This screen does not
                          transfer any money — it shows what each adviser has
                          already had credited to their wallet via the
                          Deductions tab.
                        </CardDescription>
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">
                          Sort
                        </Label>
                        <Select
                          value={payoutsSort}
                          onValueChange={(v) =>
                            setPayoutsSort(
                              v as
                                | "net_desc"
                                | "net_asc"
                                | "settled_desc"
                                | "name_asc",
                            )
                          }
                        >
                          <SelectTrigger
                            className="w-[200px]"
                            data-testid="select-payouts-sort"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="net_desc">
                              Net payable (high → low)
                            </SelectItem>
                            <SelectItem value="net_asc">
                              Net payable (low → high)
                            </SelectItem>
                            <SelectItem value="settled_desc">
                              Settled total (high → low)
                            </SelectItem>
                            <SelectItem value="name_asc">
                              Adviser name (A → Z)
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="mt-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={downloadAdviserPayoutsCsv}
                            disabled={!payoutsQ.data || payoutsQ.isLoading}
                            data-testid="button-download-adviser-payouts-csv"
                          >
                            <Download className="h-4 w-4 mr-1" /> Download CSV
                          </Button>
                        </div>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {payoutsQ.isLoading ? (
                      <Skeleton className="h-32 w-full" />
                    ) : sortedPayouts.length === 0 ? (
                      <p
                        className="text-sm text-muted-foreground"
                        data-testid="text-payouts-empty"
                      >
                        No adviser payouts in this period.
                      </p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Adviser</TableHead>
                            <TableHead>Settled</TableHead>
                            <TableHead>Reversed</TableHead>
                            <TableHead className="text-right">
                              Net payable
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {sortedPayouts.map((row) => (
                            <TableRow
                              key={row.adviserUserId}
                              data-testid={`row-payout-${row.adviserUserId}`}
                            >
                              <TableCell>
                                {/* Deep-link into the advisers list. The
                                    advisers page reads ?userId=<id>, scrolls
                                    that row into view and highlights it so
                                    admins land on the exact adviser. */}
                                <Link
                                  href={`/admin/advisers?userId=${row.adviserUserId}`}
                                  className="font-medium text-primary hover:underline"
                                  data-testid={`link-adviser-${row.adviserUserId}`}
                                >
                                  {row.firstName} {row.lastName}
                                </Link>
                                <div className="text-xs text-muted-foreground">
                                  {row.email}
                                </div>
                              </TableCell>
                              <TableCell>
                                <div>{row.settledTotal}</div>
                                <div className="text-xs text-muted-foreground">
                                  {row.settledCount}{" "}
                                  {row.settledCount === 1
                                    ? "deduction"
                                    : "deductions"}
                                </div>
                              </TableCell>
                              <TableCell>
                                <div>{row.reversedTotal}</div>
                                <div className="text-xs text-muted-foreground">
                                  {row.reversedCount}{" "}
                                  {row.reversedCount === 1
                                    ? "reversal"
                                    : "reversals"}
                                </div>
                              </TableCell>
                              <TableCell
                                className="text-right font-semibold"
                                data-testid={`text-net-payable-${row.adviserUserId}`}
                              >
                                {row.netPayable}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* ---- PLATFORM REVENUE TAB ---- */}
              <TabsContent value="platform-revenue" className="space-y-4">
                <PeriodPicker />
                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <CardTitle className="text-base">
                          Platform fee revenue (settled only)
                        </CardTitle>
                        <CardDescription>
                          Sum of platform_share_amount on settled deductions,
                          bucketed by {revenueBucket}. Reversed deductions
                          are excluded by status.
                        </CardDescription>
                      </div>
                      <div className="flex items-center gap-2">
                        <Select
                          value={revenueBucket}
                          onValueChange={(v) =>
                            setRevenueBucket(v as "monthly" | "weekly")
                          }
                        >
                          <SelectTrigger
                            className="w-[140px]"
                            data-testid="select-revenue-bucket"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="monthly">Monthly</SelectItem>
                            <SelectItem value="weekly">Weekly</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={downloadPlatformRevenueCsv}
                          disabled={!revenueQ.data || revenueQ.isLoading}
                          data-testid="button-download-platform-revenue-csv"
                        >
                          <Download className="h-4 w-4 mr-1" /> Download CSV
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {revenueQ.isLoading ? (
                      <Skeleton className="h-48 w-full" />
                    ) : !revenueQ.data ? null : (
                      <>
                        {/* Sparkline (last 12 buckets) */}
                        {revenueQ.data.sparkline.length > 0 && (
                          <div
                            className="mb-4"
                            data-testid="container-sparkline"
                          >
                            <div className="text-xs text-muted-foreground mb-1">
                              Trend — last 12 {revenueBucket === "weekly" ? "weeks" : "months"}
                            </div>
                            {(() => {
                              const vals = revenueQ.data.sparkline.map((p) =>
                                Number(p.platformShare),
                              );
                              const max = Math.max(1, ...vals);
                              const w = 320;
                              const h = 48;
                              const step = vals.length > 1 ? w / (vals.length - 1) : 0;
                              const points = vals
                                .map(
                                  (v, i) =>
                                    `${(i * step).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`,
                                )
                                .join(" ");
                              return (
                                <svg
                                  viewBox={`0 0 ${w} ${h}`}
                                  className="w-full max-w-sm h-12"
                                  preserveAspectRatio="none"
                                >
                                  <polyline
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    points={points}
                                    className="text-primary"
                                  />
                                </svg>
                              );
                            })()}
                          </div>
                        )}
                        {revenueQ.data.items.length === 0 ? (
                          <p
                            className="text-sm text-muted-foreground"
                            data-testid="text-revenue-empty"
                          >
                            No settled platform revenue in this period.
                          </p>
                        ) : (
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>
                                  {revenueBucket === "weekly"
                                    ? "Week of"
                                    : "Month"}
                                </TableHead>
                                <TableHead>Settled count</TableHead>
                                <TableHead>Total accrued</TableHead>
                                <TableHead className="text-right">
                                  Platform share
                                </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {revenueQ.data.items.map((row) => (
                                <TableRow
                                  key={row.bucket}
                                  data-testid={`row-revenue-${row.bucket}`}
                                >
                                  <TableCell>{row.bucket.slice(0, 10)}</TableCell>
                                  <TableCell>{row.count}</TableCell>
                                  <TableCell>{row.totalAccrued}</TableCell>
                                  <TableCell className="text-right font-semibold">
                                    {row.platformShare}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* ---- EXCEPTIONS TAB ---- */}
              <TabsContent value="exceptions" className="space-y-4">
                <PeriodPicker />
                <Card>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <CardTitle className="text-base">
                          Fee deduction exceptions
                        </CardTitle>
                        <CardDescription>
                          Held (insufficient funds), stuck (pending {">"} 7 days),
                          failed (failure_reason set) and role-corruption
                          (settled/reversed against a non-adviser user) deductions
                          from the selected period. Click "Open in deductions" to
                          jump to the row in the Deductions tab.
                        </CardDescription>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={downloadExceptionsCsv}
                        disabled={!exceptionsQ.data || exceptionsQ.isLoading}
                        data-testid="button-download-exceptions-csv"
                      >
                        <Download className="h-4 w-4 mr-1" /> Download CSV
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {exceptionsQ.isLoading ? (
                      <Skeleton className="h-32 w-full" />
                    ) : !exceptionsQ.data ||
                      exceptionsQ.data.items.length === 0 ? (
                      <p
                        className="text-sm text-muted-foreground"
                        data-testid="text-exceptions-empty"
                      >
                        No exceptions in this period.
                      </p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Kind</TableHead>
                            <TableHead>ID</TableHead>
                            <TableHead>Client</TableHead>
                            <TableHead>Adviser</TableHead>
                            <TableHead>Total</TableHead>
                            <TableHead>Age</TableHead>
                            <TableHead>Last sweep</TableHead>
                            <TableHead>Client notified</TableHead>
                            <TableHead>Reason</TableHead>
                            <TableHead></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {exceptionsQ.data.items.map((x) => (
                            <TableRow
                              key={`${x.kind}-${x.deduction.id}`}
                              data-testid={`row-exception-${x.deduction.id}`}
                            >
                              <TableCell>
                                <Badge
                                  variant={
                                    x.kind === "held" || x.kind === "role_corruption"
                                      ? "destructive"
                                      : "secondary"
                                  }
                                >
                                  {x.kind === "role_corruption"
                                    ? "role corruption"
                                    : x.kind}
                                </Badge>
                              </TableCell>
                              <TableCell>{x.deduction.id}</TableCell>
                              <TableCell>
                                <UserCell
                                  users={exceptionsQ.data?.users}
                                  userId={x.deduction.clientUserId}
                                />
                              </TableCell>
                              <TableCell>
                                <UserCell
                                  users={exceptionsQ.data?.users}
                                  userId={x.deduction.adviserUserId}
                                />
                              </TableCell>
                              <TableCell>
                                {x.deduction.totalAccrued}{" "}
                                {x.deduction.currency}
                              </TableCell>
                              <TableCell>{x.ageDays}d</TableCell>
                              {/* Task #204 — IF bookkeeping (lastRecheckedAt /
                                  clientNotifiedAt / clientNotificationCount /
                                  failureReason) is intentionally retained on
                                  the row after settle for cron debounce. It
                                  must NOT leak onto non-IF exception kinds
                                  (stuck / failed / role_corruption) — those
                                  rows can hold stale IF text from a previous
                                  IF episode. Gate every IF-only column on
                                  kind === "held". */}
                              <TableCell
                                className="text-xs whitespace-nowrap"
                                data-testid={`text-exception-recheck-${x.deduction.id}`}
                              >
                                {x.kind === "held" &&
                                x.deduction.lastRecheckedAt ? (
                                  <span title={x.deduction.lastRecheckedAt}>
                                    {formatRelative(x.deduction.lastRecheckedAt)}
                                  </span>
                                ) : (
                                  <span className="text-slate-400">—</span>
                                )}
                              </TableCell>
                              <TableCell
                                className="text-xs whitespace-nowrap"
                                data-testid={`text-exception-notified-${x.deduction.id}`}
                              >
                                {x.kind === "held" &&
                                x.deduction.clientNotifiedAt ? (
                                  <span title={x.deduction.clientNotifiedAt}>
                                    {formatRelative(x.deduction.clientNotifiedAt)}
                                    {x.deduction.clientNotificationCount > 1 && (
                                      <span className="text-slate-500 ml-1">
                                        (×{x.deduction.clientNotificationCount})
                                      </span>
                                    )}
                                  </span>
                                ) : (
                                  <span className="text-slate-400">—</span>
                                )}
                              </TableCell>
                              <TableCell
                                className="text-xs max-w-[240px] truncate"
                                title={
                                  x.kind === "held"
                                    ? (x.deduction.failureReason ??
                                      "Insufficient client balance")
                                    : x.kind === "stuck"
                                      ? "Pending approval > 7 days"
                                      : x.kind === "role_corruption"
                                        ? "Settled or reversed against a non-adviser user"
                                        : "Last attempt failed"
                                }
                              >
                                {x.kind === "held"
                                  ? (x.deduction.failureReason ??
                                    "Insufficient client balance")
                                  : x.kind === "stuck"
                                    ? "Pending > 7d"
                                    : x.kind === "role_corruption"
                                      ? "Non-adviser user"
                                      : "Last attempt failed"}
                              </TableCell>
                              <TableCell>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    openDeductionFromException(x.deduction)
                                  }
                                  data-testid={`button-open-deduction-${x.deduction.id}`}
                                >
                                  <ExternalLink className="h-3.5 w-3.5 mr-1" />
                                  Open
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </>
          );
        })()}
      </Tabs>

      <Dialog
        open={reverseTarget !== null}
        onOpenChange={(open) => {
          if (!open) closeReverseDialog();
        }}
      >
        <DialogContent data-testid="dialog-reverse">
          <DialogHeader>
            <DialogTitle>Reverse settled deduction #{reverseTarget?.id}</DialogTitle>
            <DialogDescription>
              This will post the OPPOSITE balanced ledger triple against a NEW
              transaction (history is never edited): the client will be credited{" "}
              <strong>
                {reverseTarget?.totalAccrued} {reverseTarget?.currency}
              </strong>
              , and the adviser + platform fee account will be debited their
              respective shares. The deduction's status will become{" "}
              <strong>reversed</strong>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="reverse-reason">
              Reason <span className="text-red-600">*</span>
            </Label>
            <Textarea
              id="reverse-reason"
              data-testid="textarea-reverse-reason"
              value={reverseReason}
              onChange={(e) => setReverseReason(e.target.value)}
              placeholder="e.g. wrong amount, disputed by client, adviser left mid-period"
              rows={4}
              maxLength={1000}
              disabled={reverseSubmitting}
            />
            <p className="text-xs text-muted-foreground">
              Required. Stored on the deduction row and in the audit log so
              future-you (or compliance) can see why this was unwound.
            </p>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeReverseDialog}
              disabled={reverseSubmitting}
              data-testid="button-reverse-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={submitReverse}
              disabled={reverseSubmitting || !reverseReason.trim()}
              data-testid="button-reverse-confirm"
            >
              <Undo2 className="h-4 w-4 mr-1" />
              {reverseSubmitting ? "Reversing…" : "Reverse deduction"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
