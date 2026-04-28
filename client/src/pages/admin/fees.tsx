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
  // Task #324 — chevron toggles on the consent reconciliation history rows
  ChevronRight,
  ChevronDown,
  History,
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
// Task #204 — canonical IF predicate for the admin surface. Resolved during
// rebase to use the client/src/lib home from main (the client + adviser
// surfaces already use it, and it also exports parseShortfallFromFailureReason
// + the INSUFFICIENT_FUNDS_STATUS string constant). The shared
// fee-deduction-status helpers from this task remain in use on the server side.
import {
  INSUFFICIENT_FUNDS_STATUS,
  isInsufficientFundsRow,
} from "@/lib/insufficient-funds";
// Task #294 — pure forecaster used by the "Next charge" column.
import { formatNextChargeCell } from "@shared/fee-rule-helpers";

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
  // Task #294 — supersede chain + reconciliation columns.
  accountNumber: string | null;
  effectiveDate: string | null;
  pausedAt: string | null;
  pausedReason: string | null;
  supersededByRuleId: number | null;
  supersededAt: string | null;
  supersededReason: string | null;
  createdAt: string;
  updatedAt: string;
  // Task #294 — joined consent context (LEFT JOIN — null if missing).
  consentRenewalStatus: string | null;
  consentExpiryDate: string | null;
  consentWithdrawnAt: string | null;
  consentAccountNumber: string | null;
  consentAccountName: string | null;
  consentDeductionFrequency: string | null;
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
// Task #324 — Consent reconciliation history shape mirrored from the admin
// endpoint /api/admin/fee-rules/consent-reconcile-runs.
// =============================================================================
interface ConsentReconcileRun {
  id: number;
  createdAt: string | null;
  userId: number | null;
  trigger: "cron" | "manual" | null;
  triggeredAt: string | null;
  summary: {
    checked: number | null;
    expired: number | null;
    pausedForWithdrawal: number | null;
    alreadyAligned: number | null;
    consentMissing: number | null;
  };
}
interface ConsentReconcileRunsResp {
  items: ConsentReconcileRun[];
  users?: UsersMap;
}
interface ConsentReconcileTransition {
  id: number;
  createdAt: string | null;
  ruleId: string | null;
  transition: string | null;
  consentId: number | null;
  beforeStatus: string | null;
  afterStatus: string | null;
}
interface ConsentReconcileTransitionsResp {
  items: ConsentReconcileTransition[];
  triggeredAt: string | null;
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
  // Task #29 — present (non-null) when the daily-accruals cron's planned
  // backfill window exceeded the 14-day cap and the oldest dates were
  // dropped. Admins must replay these via the manual "Run today's accruals"
  // trigger below.
  droppedFromBackfill: {
    start: string; // 'YYYY-MM-DD'
    end: string; // 'YYYY-MM-DD'
    count: number;
  } | null;
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
  // Task #34 / Task #204: client couldn't cover the debit. Render as
  // destructive so it pops in the table the same way a rejection does —
  // admins need to see these to top the client up before retrying. Uses
  // the canonical INSUFFICIENT_FUNDS_STATUS constant so a future status
  // rename only has to change in one place.
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
      {run.droppedFromBackfill && (
        <Alert variant="destructive" data-testid="alert-dropped-from-backfill">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>
            {run.droppedFromBackfill.count} day(s) dropped from auto-backfill
          </AlertTitle>
          <AlertDescription className="text-xs space-y-1">
            <div>
              The gap since the last accrual exceeded the 14-day safety cap, so
              UTC dates{" "}
              <strong data-testid="text-dropped-range">
                {run.droppedFromBackfill.start}
              </strong>
              {" through "}
              <strong>{run.droppedFromBackfill.end}</strong>{" "}
              were skipped. Replay them by setting the date below and pressing{" "}
              <strong>Run</strong> for each missed day.
            </div>
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


// Task #294 — admin-side rule status pill. Mirrors the adviser/client
// surfaces but is colour-coded for triage:
//   active     → outline (default)
//   draft      → secondary
//   paused     → destructive (a deduction-blocking event happened)
//   superseded → secondary muted with arrow → replacement rule id
//   expired    → secondary muted (terminal)
function adminRuleStatusBadge(r: FeeRuleRow) {
  if (r.status === "active") return <Badge variant="outline">active</Badge>;
  if (r.status === "draft") return <Badge variant="secondary">draft</Badge>;
  if (r.status === "paused") {
    return (
      <div className="flex flex-col gap-1">
        <Badge variant="destructive" title={r.pausedReason ?? undefined} className="w-fit">
          paused
        </Badge>
        {r.pausedReason && (
          <span className="text-xs text-muted-foreground">{r.pausedReason}</span>
        )}
      </div>
    );
  }
  if (r.status === "superseded") {
    return (
      <div className="flex flex-col gap-1">
        <Badge
          variant="secondary"
          className="w-fit"
          title={r.supersededReason ?? undefined}
        >
          superseded
          {r.supersededByRuleId ? (
            <>
              {" → "}
              <SupersedeLink targetId={r.supersededByRuleId} />
            </>
          ) : null}
        </Badge>
        {r.supersededAt && (
          <span className="text-xs text-muted-foreground">
            {r.supersededAt.slice(0, 10)}
          </span>
        )}
      </div>
    );
  }
  if (r.status === "expired") return <Badge variant="secondary">expired</Badge>;
  return <Badge variant="outline">{r.status}</Badge>;
}

// Renders the admin-side consent context cell — renewal status pill +
// expiry date + (rare) withdrawn marker. Mirrors the adviser cell but uses
// admin-flavoured labels.
function AdminConsentContextCell({ r }: { r: FeeRuleRow }) {
  if (!r.consentRenewalStatus && !r.consentExpiryDate && !r.consentWithdrawnAt) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-col gap-1 text-xs">
      {r.consentRenewalStatus && (
        <Badge
          variant={
            // Task #294 review fix — withdrawn/expired are blocking states,
            // shown destructive. Active and renewed both render as "Signed"
            // (the compliance label the user-facing copy asked for).
            r.consentWithdrawnAt
              ? "destructive"
              : r.consentRenewalStatus === "expired"
                ? "destructive"
                : "outline"
          }
          className="w-fit"
        >
          {r.consentWithdrawnAt
            ? "Withdrawn"
            : r.consentRenewalStatus === "expired"
              ? "Expired"
              : "Signed"}
        </Badge>
      )}
      {r.consentExpiryDate && (
        <span className="text-muted-foreground">
          expires {r.consentExpiryDate.slice(0, 10)}
        </span>
      )}
      {r.consentWithdrawnAt && (
        <span className="text-destructive">
          withdrawn {r.consentWithdrawnAt.slice(0, 10)}
        </span>
      )}
    </div>
  );
}

// Task #294 — paginator for the Active / History rule cards. Each card
// owns its own page state and passes it in here; nothing about pagination
// is shared between the two cards.
function RulesPager({
  page,
  setPage,
  total,
  pageSize,
  testIdPrefix,
}: {
  page: number;
  setPage: (n: number) => void;
  total: number;
  pageSize: number;
  testIdPrefix: string;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-between text-sm">
      <span
        className="text-muted-foreground"
        data-testid={`${testIdPrefix}-pager-status`}
      >
        Page {page} of {totalPages} · {total} total
      </span>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPage(Math.max(1, page - 1))}
          disabled={page <= 1}
          data-testid={`${testIdPrefix}-pager-prev`}
        >
          Prev
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPage(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          data-testid={`${testIdPrefix}-pager-next`}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

// Task #294 — admin can jump straight to the consent detail page; on
// adviser/client surfaces the consent ID is shown but not linked because
// neither role has a dedicated consent admin route.
function ConsentIdLink({ id }: { id: number | null | undefined }) {
  if (!id) return <span>—</span>;
  return (
    <Link
      href={`/admin/fee-consents?focus=${id}`}
      className="text-primary underline-offset-2 hover:underline"
      data-testid={`link-consent-${id}`}
    >
      #{id}
    </Link>
  );
}

// Task #294 — clickable in-page anchor pointing at the rule that
// superseded this one. Falls back to a plain "#N" label when the target
// row isn't on this page (because pagination split the chain across
// pages — at least the user sees the destination ID).
function SupersedeLink({ targetId }: { targetId: number | null | undefined }) {
  if (!targetId) return null;
  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = document.querySelector(`[data-testid="row-rule-${targetId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-primary");
      setTimeout(() => el.classList.remove("ring-2", "ring-primary"), 1500);
    }
  };
  return (
    <a
      href={`#row-rule-${targetId}`}
      onClick={onClick}
      className="text-primary underline-offset-2 hover:underline"
      data-testid={`link-supersede-${targetId}`}
    >
      #{targetId}
    </a>
  );
}

// Shared admin rule table — used by both the Active and History cards so
// the columns can never drift between them. Pause button only renders on
// the Active card via the `showPauseButton` flag.
function AdminRuleTable({
  rows,
  users,
  onPause,
  showPauseButton,
}: {
  rows: FeeRuleRow[];
  users: Record<number, { id: number; firstName: string; lastName: string; email: string }> | undefined;
  onPause: (id: number) => void;
  showPauseButton: boolean;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>ID</TableHead>
          <TableHead>Consent</TableHead>
          <TableHead>Client</TableHead>
          <TableHead>Adviser</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Account</TableHead>
          <TableHead>Amount</TableHead>
          <TableHead>Splits</TableHead>
          <TableHead>Effective</TableHead>
          <TableHead>Next charge</TableHead>
          <TableHead>Consent state</TableHead>
          <TableHead>Status</TableHead>
          {showPauseButton && <TableHead></TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow
            key={r.id}
            id={`row-rule-${r.id}`}
            data-testid={`row-rule-${r.id}`}
          >
            <TableCell>{r.id}</TableCell>
            <TableCell>
              <ConsentIdLink id={r.feeConsentId} />
            </TableCell>
            <TableCell>
              <UserCell users={users} userId={r.clientUserId} />
            </TableCell>
            <TableCell>
              <UserCell users={users} userId={r.adviserUserId} />
            </TableCell>
            <TableCell>{r.feeType}</TableCell>
            <TableCell>
              <div className="leading-tight">
                <div className="text-sm">
                  {r.accountNumber ?? r.consentAccountNumber ?? "—"}
                </div>
                {r.consentAccountName && (
                  <div className="text-xs text-muted-foreground">
                    {r.consentAccountName}
                  </div>
                )}
              </div>
            </TableCell>
            <TableCell>
              {r.amountType === "fixed"
                ? `${r.fixedAmount} ${r.currency} / month`
                : `${(Number(r.rateBps ?? 0) / 100).toFixed(2)}% p.a.`}
            </TableCell>
            <TableCell className="text-xs">
              {/* Admin-facing split copy: "Adviser X% · Platform Y%". */}
              Adviser {bpsLabel(r.adviserSplitBps)} · Platform{" "}
              {bpsLabel(r.platformSplitBps)}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {r.effectiveDate ? r.effectiveDate.slice(0, 10) : "—"}
            </TableCell>
            <TableCell
              className="text-xs text-muted-foreground"
              data-testid={`cell-next-charge-${r.id}`}
            >
              {/* Task #294 — pure forecast from (effectiveDate, frequency).
                  Live rules only — paused/superseded/expired show "—" */}
              {r.status === "active" || r.status === "draft"
                ? formatNextChargeCell(r.effectiveDate, r.consentDeductionFrequency)
                : "—"}
            </TableCell>
            <TableCell>
              <AdminConsentContextCell r={r} />
            </TableCell>
            <TableCell>{adminRuleStatusBadge(r)}</TableCell>
            {showPauseButton && (
              <TableCell>
                {r.status === "active" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onPause(r.id)}
                    data-testid={`button-pause-${r.id}`}
                  >
                    <Pause className="h-4 w-4 mr-1" /> Pause
                  </Button>
                )}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// Task #324 — Compact summary of one reconcile run, used in the history
// table row. Numbers are presented in the order the toast already uses
// (checked / expired / paused / aligned / consent missing) so an operator
// who has been clicking "Reconcile now" sees the same shape on both
// surfaces.
function ReconcileSummaryCell({ s }: { s: ConsentReconcileRun["summary"] }) {
  const fmt = (n: number | null) => (n == null ? "—" : String(n));
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
      <span><span className="text-muted-foreground">checked </span>{fmt(s.checked)}</span>
      <span><span className="text-muted-foreground">expired </span>{fmt(s.expired)}</span>
      <span><span className="text-muted-foreground">paused </span>{fmt(s.pausedForWithdrawal)}</span>
      <span><span className="text-muted-foreground">aligned </span>{fmt(s.alreadyAligned)}</span>
      <span><span className="text-muted-foreground">missing </span>{fmt(s.consentMissing)}</span>
    </div>
  );
}

// Task #324 — single row in the consent reconciliation history table.
// Click anywhere on the row to expand and lazy-load the per-rule audit
// lines emitted by the same run. The transitions query is keyed on the
// rollup row's id so React Query caches each run's expansion
// independently — re-collapsing and re-expanding doesn't refetch.
function ConsentReconcileRunRow({
  run,
  users,
}: {
  run: ConsentReconcileRun;
  users?: UsersMap;
}) {
  const [open, setOpen] = useState(false);
  const transitionsQ = useQuery<ConsentReconcileTransitionsResp>({
    queryKey: [
      "/api/admin/fee-rules/consent-reconcile-runs",
      run.id,
      "transitions",
    ],
    queryFn: () =>
      fetchPaginated<ConsentReconcileTransitionsResp>(
        `/api/admin/fee-rules/consent-reconcile-runs/${run.id}/transitions`,
      ),
    // Lazy-load on first expand. Once fetched, keep the data in cache
    // forever so re-expand is instant.
    enabled: open,
  });
  const triggerLabel =
    run.trigger === "cron"
      ? "Cron"
      : run.trigger === "manual"
        ? "Manual"
        : "—";
  const executor =
    run.userId != null
      ? userLabel(users, run.userId)
      : run.trigger === "cron"
        ? "system"
        : "—";
  const when = run.createdAt ? new Date(run.createdAt) : null;
  const whenLabel = when
    ? `${when.toLocaleString()} (${formatRelative(run.createdAt!)})`
    : "—";
  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/40"
        onClick={() => setOpen((v) => !v)}
        data-testid={`row-reconcile-run-${run.id}`}
      >
        <TableCell className="w-8">
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </TableCell>
        <TableCell className="font-mono text-xs">{whenLabel}</TableCell>
        <TableCell>
          <Badge
            variant={run.trigger === "manual" ? "default" : "secondary"}
            data-testid={`badge-reconcile-trigger-${run.id}`}
          >
            {triggerLabel}
          </Badge>
        </TableCell>
        <TableCell className="text-sm">{executor}</TableCell>
        <TableCell>
          <ReconcileSummaryCell s={run.summary} />
        </TableCell>
      </TableRow>
      {open && (
        <TableRow data-testid={`row-reconcile-run-${run.id}-detail`}>
          <TableCell colSpan={5} className="bg-muted/20">
            {transitionsQ.isLoading ? (
              <Skeleton className="h-12 w-full" />
            ) : transitionsQ.isError ? (
              <p className="text-sm text-destructive">
                Failed to load transitions:{" "}
                {(transitionsQ.error as Error)?.message ?? "unknown error"}
              </p>
            ) : !transitionsQ.data || transitionsQ.data.items.length === 0 ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid={`empty-reconcile-transitions-${run.id}`}
              >
                {transitionsQ.data?.triggeredAt
                  ? "This run produced no rule transitions (every rule was already aligned)."
                  : "No per-rule audit lines available for this run."}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Rule</TableHead>
                    <TableHead>Transition</TableHead>
                    <TableHead>Before → After</TableHead>
                    <TableHead>Consent</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {transitionsQ.data.items.map((t) => (
                    <TableRow
                      key={t.id}
                      data-testid={`row-reconcile-transition-${t.id}`}
                    >
                      <TableCell className="font-mono text-xs">
                        #{t.ruleId ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {t.transition ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {(t.beforeStatus ?? "—") + " → " + (t.afterStatus ?? "—")}
                      </TableCell>
                      <TableCell>
                        <ConsentIdLink id={t.consentId ?? undefined} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export default function AdminFeesPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState("rules");

  // -------- Create rule form --------
  // Task #294 — `effectiveDate` is now an explicit input so an admin can
  // backdate or post-date a rule (the engine accrues from this date).
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
    effectiveDate: "",
  });

  // Task #294 — when the admin types a feeConsentId we fetch the consent
  // detail so we can autofill clientUserId / adviserUserId, surface the
  // bound account + frequency, and warn about supersede preview.
  const consentIdNum = Number(form.feeConsentId);
  const consentLookupQ = useQuery<any>({
    queryKey: ["/api/admin/fee-consents", consentIdNum],
    queryFn: () => fetchPaginated(`/api/admin/fee-consents/${consentIdNum}`),
    enabled: Number.isInteger(consentIdNum) && consentIdNum > 0,
    retry: false,
  });
  // Reflect the lookup back into the form (without clobbering an admin's
  // explicit typed value — only autofill empty fields). useEffect runs once
  // per successful lookup.
  useEffect(() => {
    const c = consentLookupQ.data;
    if (!c) return;
    setForm((prev) => ({
      ...prev,
      clientUserId: prev.clientUserId || (c.clientId != null ? String(c.clientId) : ""),
      adviserUserId: prev.adviserUserId || (c.adviserId != null ? String(c.adviserId) : ""),
    }));
  }, [consentLookupQ.data]);

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
      if (form.effectiveDate) payload.effectiveDate = form.effectiveDate;
      await apiRequest("POST", "/api/admin/fee-rules", payload);
      toast({ title: "Fee rule created" });
      setForm({
        ...form,
        feeConsentId: "",
        clientUserId: "",
        adviserUserId: "",
        fixedAmount: "",
        rateBps: "",
        effectiveDate: "",
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

  // Task #294 — manual reconciliation trigger. Same code path as the daily
  // cron tick; the button exists so the admin can force a reconcile after a
  // renewal flow without waiting for the next sweep. Renders a toast with
  // the summary so the admin can immediately see what changed.
  const [reconcilePending, setReconcilePending] = useState(false);
  async function triggerReconcileConsentState() {
    try {
      setReconcilePending(true);
      const res = await apiRequest(
        "POST",
        "/api/admin/fee-rules/reconcile-consent-state",
        {},
      );
      const summary = (await res.json()) as {
        checked: number;
        expired: number;
        pausedForWithdrawal: number;
        alreadyAligned: number;
        consentMissing: number;
      };
      toast({
        title: "Consent reconciliation complete",
        description: `Checked ${summary.checked}, expired ${summary.expired}, paused ${summary.pausedForWithdrawal}, aligned ${summary.alreadyAligned}, consent missing ${summary.consentMissing}.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/fee-rules"] });
      // Task #324 — refresh the consent reconciliation history card so the
      // new run (just written to audit_logs by the endpoint) shows up
      // immediately instead of waiting for the next refetch interval.
      queryClient.invalidateQueries({
        queryKey: ["/api/admin/fee-rules/consent-reconcile-runs"],
      });
    } catch (err: any) {
      toast({
        title: "Reconcile failed",
        description: err?.message ?? String(err),
        variant: "destructive",
      });
    } finally {
      setReconcilePending(false);
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

  // -------- Manual insufficient-funds sweep (Task #204) --------
  // Stores the most recent sweep summary so the admin can see what happened
  // (settled / still-insufficient / errors) without scraping logs. Reset on
  // every page mount — this is a transient ack, not persisted state.
  interface SweepSummaryResult {
    trigger: "manual";
    checked: number;
    settled: number;
    stillInsufficient: number;
    errors: number;
    notificationsSent: number;
    notificationsSkippedDueToDebounce: number;
    notificationsFailed: number;
    ranAt: string;
    // Code-review follow-up — explicit kill-switch state on the response so
    // the operator sees "skipped because the kill switch is engaged" instead
    // of having to infer it from a bare checked=0 result.
    killSwitchActive?: boolean;
    message?: string;
  }
  const [sweepSummary, setSweepSummary] = useState<SweepSummaryResult | null>(
    null,
  );
  const [sweepRunning, setSweepRunning] = useState(false);
  async function runInsufficientFundsSweep() {
    setSweepRunning(true);
    try {
      const r = await apiRequest(
        "POST",
        "/api/admin/insufficient-funds-sweep/run",
        {},
      );
      const j = (await r.json()) as Omit<SweepSummaryResult, "ranAt">;
      const summary: SweepSummaryResult = {
        ...j,
        ranAt: new Date().toISOString(),
      };
      setSweepSummary(summary);
      // Code-review follow-up — when the kill switch is engaged, the
      // service short-circuits to checked=0. Use the explicit
      // `killSwitchActive` flag (not `checked === 0`, which is also true on
      // a healthy "nothing held" run) to choose the toast wording so the
      // operator can immediately tell the two cases apart.
      if (summary.killSwitchActive) {
        toast({
          title: "Sweep skipped",
          description:
            summary.message ??
            "fee_deductions kill switch is engaged — disable it to allow the sweep to process held rows.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Sweep complete",
          description:
            summary.message ??
            `${summary.checked} checked → ${summary.settled} settled, ${summary.stillInsufficient} still held.`,
        });
      }
      // Re-fetch the deductions table so settled rows drop out of the
      // "insufficient_funds" filter immediately.
      queryClient.invalidateQueries({ queryKey: ["/api/admin/fee-deductions"] });
    } catch (err: any) {
      toast({
        title: "Sweep failed",
        description: err?.message ?? String(err),
        variant: "destructive",
      });
    } finally {
      setSweepRunning(false);
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
  // Task #294 — the rules tab has TWO independent cards (Active and History),
  // each with its own searchbox + paginator state. Sharing one query meant
  // pagination on one card could hide rows on the other; splitting the
  // queries makes each card a self-contained server-side fetch.
  const [rulesActiveSearch, setRulesActiveSearch] = useState("");
  const [rulesActivePage, setRulesActivePage] = useState(1);
  const [rulesHistorySearch, setRulesHistorySearch] = useState("");
  const [rulesHistoryPage, setRulesHistoryPage] = useState(1);
  const [accrualsSearch, setAccrualsSearch] = useState("");
  const [deductionsSearch, setDeductionsSearch] = useState("");
  const debouncedRulesActiveSearch = useDebounced(rulesActiveSearch);
  const debouncedRulesHistorySearch = useDebounced(rulesHistorySearch);
  const debouncedAccrualsSearch = useDebounced(accrualsSearch);
  const debouncedDeductionsSearch = useDebounced(deductionsSearch);
  const RULES_PAGE_SIZE = 25;
  // Reset to page 1 whenever the search text changes — otherwise an empty
  // page-2 lingers when the result set shrinks.
  useEffect(() => {
    setRulesActivePage(1);
  }, [debouncedRulesActiveSearch]);
  useEffect(() => {
    setRulesHistoryPage(1);
  }, [debouncedRulesHistorySearch]);

  // -------- Deductions filter / sort state (Task #65) --------
  // Status filter is server-side; "all" (the sentinel) maps to omitting the
  // query param. Sort defaults to "newest first" so the table behaves like it
  // always has unless an admin explicitly switches to held-first triage mode.
  const [deductionsStatus, setDeductionsStatus] = useState<string>("all");
  const [deductionsSort, setDeductionsSort] = useState<
    "created_desc" | "created_asc" | "status_held_first"
  >("created_desc");

  // -------- Queries --------
  // Task #294 — TWO independent rule queries: one for the Active card
  // (status ∈ {active,draft}) and one for the History card
  // (status ∈ {paused,superseded,expired}). Each carries its own search
  // text and page index so the cards never fight over a single fetch.
  const rulesActiveQ = useQuery<Paginated<FeeRuleRow>>({
    queryKey: [
      "/api/admin/fee-rules",
      { group: "active", q: debouncedRulesActiveSearch, page: rulesActivePage },
    ],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("status", "active,draft");
      params.set("page", String(rulesActivePage));
      params.set("limit", String(RULES_PAGE_SIZE));
      if (debouncedRulesActiveSearch.trim())
        params.set("q", debouncedRulesActiveSearch.trim());
      return fetchPaginated<Paginated<FeeRuleRow>>(
        `/api/admin/fee-rules?${params.toString()}`,
      );
    },
  });
  const rulesHistoryQ = useQuery<Paginated<FeeRuleRow>>({
    queryKey: [
      "/api/admin/fee-rules",
      { group: "history", q: debouncedRulesHistorySearch, page: rulesHistoryPage },
    ],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("status", "paused,superseded,expired");
      params.set("page", String(rulesHistoryPage));
      params.set("limit", String(RULES_PAGE_SIZE));
      if (debouncedRulesHistorySearch.trim())
        params.set("q", debouncedRulesHistorySearch.trim());
      return fetchPaginated<Paginated<FeeRuleRow>>(
        `/api/admin/fee-rules?${params.toString()}`,
      );
    },
  });

  // Task #324 — last 30 reconcile runs (rollup audit_logs rows tagged
  // action = 'fee_rules_consent_reconciled'). Fetched on tab mount and
  // re-invalidated after a manual reconcile so the new run shows up
  // immediately. The endpoint is cheap (one indexed select on audit_logs)
  // so we don't bother polling.
  const reconcileRunsQ = useQuery<ConsentReconcileRunsResp>({
    queryKey: ["/api/admin/fee-rules/consent-reconcile-runs"],
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
    // Task #208 / #229 — the server-side projectFeeExceptionRow helper now
    // nulls failureReason / lastRecheckedAt / clientNotifiedAt and zeroes
    // clientNotificationCount on every non-held row, so we can rely on the
    // server-supplied falsy values directly instead of re-implementing the
    // kind === "held" gate here. The synthetic fallback below only fires
    // when failureReason is absent (held with no recorded reason, or any
    // non-held kind).
    const reasonFor = (x: FeeExceptionRow): string =>
      x.deduction.failureReason ??
      (x.kind === "stuck"
        ? "Pending approval > 7 days"
        : x.kind === "role_corruption"
          ? "Settled or reversed against a non-adviser user"
          : x.kind === "failed"
            ? "Last attempt failed"
            : "Insufficient client balance");
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
          x.deduction.lastRecheckedAt ?? "",
          x.deduction.clientNotifiedAt ?? "",
          // Count column was previously gated by `kind === "held"` so non-held
          // rows rendered as blank. The server now nulls clientNotifiedAt on
          // non-held rows, so we lean on that falsy value to keep the column
          // blank for non-held while still emitting the held row's count
          // (including 0) verbatim, preserving prior CSV output.
          x.deduction.clientNotifiedAt
            ? x.deduction.clientNotificationCount
            : "",
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

      {/* Task #294 — canonical Gate-A copy. Same wording shipped on
          adviser and client surfaces so the legal posture cannot drift
          between the three viewers. */}
      <Alert variant="default" data-testid="alert-gate-a">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Deduction execution is currently disabled</AlertTitle>
        <AlertDescription>
          Rules, accruals and deductions are visible and auditable. When
          deduction execution is enabled, deductions in <strong>Settled</strong>{" "}
          status will represent completed fund movements. Until then,
          approving a deduction here flips its status and writes an audit
          row only — <strong>no money moves</strong>.
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
                {/* Task #294 — autofill summary surfaces what the consent
                    legally authorises so the admin can sanity-check before
                    creating a rule that would otherwise auto-supersede the
                    existing one. */}
                {consentLookupQ.isError && form.feeConsentId && (
                  <p
                    className="text-xs text-destructive mt-1"
                    data-testid="consent-lookup-error"
                  >
                    Consent #{form.feeConsentId} not found.
                  </p>
                )}
                {consentLookupQ.data && (
                  <div
                    className="text-xs text-muted-foreground mt-1 space-y-0.5"
                    data-testid="consent-lookup-summary"
                  >
                    <div>
                      Account:{" "}
                      <span className="font-mono">
                        {consentLookupQ.data.accountNumber ?? "—"}
                      </span>
                      {consentLookupQ.data.accountName ? (
                        <> · {consentLookupQ.data.accountName}</>
                      ) : null}
                    </div>
                    <div>
                      Frequency:{" "}
                      {consentLookupQ.data.deductionFrequency ?? "—"} · Renewal:{" "}
                      {consentLookupQ.data.renewalStatus ?? "—"}
                    </div>
                    {consentLookupQ.data.activeRule && (
                      <div
                        className="text-amber-600 dark:text-amber-400"
                        data-testid="supersede-preview"
                      >
                        Heads-up: this consent already has an{" "}
                        {consentLookupQ.data.activeRule.status} rule (#
                        {consentLookupQ.data.activeRule.id}). Creating a new
                        rule will auto-supersede it.
                      </div>
                    )}
                  </div>
                )}
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
              {/* Task #294 — explicit effective date so the rule can be
                  back/post-dated. Empty → server defaults to today. */}
              <div>
                <Label>Effective date (optional)</Label>
                <Input
                  type="date"
                  data-testid="input-effective-date"
                  value={form.effectiveDate}
                  onChange={(e) =>
                    setForm({ ...form, effectiveDate: e.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Leave blank to default to today.
                </p>
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

          {/* Task #294 — Active rules card. Server-side filtered to
              status ∈ {active,draft} via its own query so the card has a
              dedicated paginator + searchbox; pagination on the History
              card no longer hides Active rows (and vice versa). */}
          <Card data-testid="card-rules-active">
            <CardHeader>
              <CardTitle className="text-base">Active rules</CardTitle>
              <CardDescription>
                Active and draft rules accrue daily. Each rule is anchored on
                a signed fee consent — when the consent expires or is
                withdrawn, the daily reconcile job pauses or expires the
                rule automatically.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-4 flex items-end gap-3 flex-wrap">
                <div className="flex-1 min-w-[260px]">
                  <SearchBox
                    value={rulesActiveSearch}
                    onChange={setRulesActiveSearch}
                    placeholder="Search active rules by client or adviser name / email"
                    testId="input-search-rules-active"
                  />
                </div>
                {/* Task #294 — manual reconcile-now button so an operator
                    can force a sweep after a renewal flow without waiting
                    for the next daily cron tick. */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={triggerReconcileConsentState}
                  disabled={reconcilePending}
                  data-testid="button-reconcile-consent-state"
                >
                  {reconcilePending ? "Reconciling…" : "Reconcile consent state"}
                </Button>
              </div>
              {rulesActiveQ.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : (rulesActiveQ.data?.items.length ?? 0) > 0 ? (
                <>
                  <AdminRuleTable
                    rows={rulesActiveQ.data!.items}
                    users={rulesActiveQ.data?.users}
                    onPause={pauseRule}
                    showPauseButton
                  />
                  <RulesPager
                    page={rulesActivePage}
                    setPage={setRulesActivePage}
                    total={rulesActiveQ.data?.total ?? 0}
                    pageSize={RULES_PAGE_SIZE}
                    testIdPrefix="rules-active"
                  />
                </>
              ) : (
                <p className="text-sm text-muted-foreground" data-testid="empty-rules-active">
                  {debouncedRulesActiveSearch.trim()
                    ? "No active fee rules match your search."
                    : "No active fee rules yet."}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Task #294 — History card. Independent server-side query for
              status ∈ {paused,superseded,expired} with its own paginator
              and search box. Admin always sees this card (even when empty)
              because admins triage these states. */}
          <Card data-testid="card-rules-history">
            <CardHeader>
              <CardTitle className="text-base">Paused, superseded & expired</CardTitle>
              <CardDescription>
                These rules are not driving accruals. <strong>Paused</strong>{" "}
                rows emit a zero-amount audit row with reason{" "}
                <code>rule_paused</code> on each daily tick.{" "}
                <strong>Superseded</strong> rows link to the rule that
                replaced them. <strong>Expired</strong> is terminal and
                requires a fresh consent to re-engage.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-4">
                <SearchBox
                  value={rulesHistorySearch}
                  onChange={setRulesHistorySearch}
                  placeholder="Search history by client or adviser name / email"
                  testId="input-search-rules-history"
                />
              </div>
              {rulesHistoryQ.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : (rulesHistoryQ.data?.items.length ?? 0) > 0 ? (
                <>
                  <AdminRuleTable
                    rows={rulesHistoryQ.data!.items}
                    users={rulesHistoryQ.data?.users}
                    onPause={pauseRule}
                    showPauseButton={false}
                  />
                  <RulesPager
                    page={rulesHistoryPage}
                    setPage={setRulesHistoryPage}
                    total={rulesHistoryQ.data?.total ?? 0}
                    pageSize={RULES_PAGE_SIZE}
                    testIdPrefix="rules-history"
                  />
                </>
              ) : (
                <p className="text-sm text-muted-foreground" data-testid="empty-rules-history">
                  {debouncedRulesHistorySearch.trim()
                    ? "No history rules match your search."
                    : "No paused, superseded or expired rules."}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Task #324 — Consent reconciliation history. Lists the last 30
              rollup audit_logs rows tagged action='fee_rules_consent_reconciled'
              so an operator can see at a glance whether the daily cron
              actually ran (and what it produced) without scraping the
              audit table by hand. Click any row to expand to the per-rule
              transitions emitted by that same run. */}
          <Card data-testid="card-consent-reconcile-history">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <History className="h-4 w-4" />
                Consent reconciliation history
              </CardTitle>
              <CardDescription>
                Each row is one run of the consent ↔ fee-rule reconcile sweep
                (daily <strong>cron</strong> or a <strong>manual</strong>{" "}
                trigger). Click a row to see the per-rule transitions it
                emitted (
                <code>fee_rule_consent_reconciled</code> audit lines). Last
                30 runs only.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {reconcileRunsQ.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : reconcileRunsQ.isError ? (
                <p
                  className="text-sm text-destructive"
                  data-testid="error-consent-reconcile-history"
                >
                  Failed to load reconciliation history:{" "}
                  {(reconcileRunsQ.error as Error)?.message ?? "unknown error"}
                </p>
              ) : !reconcileRunsQ.data ||
                reconcileRunsQ.data.items.length === 0 ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="empty-consent-reconcile-history"
                >
                  No reconciliation runs recorded yet. The daily cron writes
                  one row per tick; clicking{" "}
                  <strong>Reconcile consent state</strong> above also writes
                  one.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8" />
                      <TableHead>When</TableHead>
                      <TableHead>Trigger</TableHead>
                      <TableHead>Executor</TableHead>
                      <TableHead>Summary</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reconcileRunsQ.data.items.map((run) => (
                      <ConsentReconcileRunRow
                        key={run.id}
                        run={run}
                        users={reconcileRunsQ.data?.users}
                      />
                    ))}
                  </TableBody>
                </Table>
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

          {/* Task #204 — manual insufficient-funds sweep. The daily cron
              already runs this; the button is for after-hours operator
              workflows (e.g. a batch of clients just topped up). Calls the
              same service the cron uses, so settlement code paths are not
              duplicated. Honours the fee_deductions kill switch — when the
              switch is engaged the service returns checked=0 cleanly. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Insufficient-funds sweep
              </CardTitle>
              <CardDescription>
                Re-checks every deduction currently held for insufficient
                funds and re-attempts settlement. Same code path as the daily
                cron. The "fee_deductions" kill switch will short-circuit the
                run cleanly without touching any rows.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                onClick={runInsufficientFundsSweep}
                disabled={sweepRunning}
                data-testid="button-run-if-sweep"
              >
                <Play className="h-4 w-4 mr-1" />
                {sweepRunning ? "Running…" : "Run sweep now"}
              </Button>
              {sweepSummary && (
                <div
                  className="rounded-md border bg-muted/40 p-3 text-sm space-y-1"
                  data-testid="card-if-sweep-summary"
                >
                  <div className="font-medium">
                    Last manual run —{" "}
                    {new Date(sweepSummary.ranAt).toLocaleTimeString()}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div data-testid="text-if-sweep-checked">
                      Checked:{" "}
                      <span className="font-mono font-semibold">
                        {sweepSummary.checked}
                      </span>
                    </div>
                    <div data-testid="text-if-sweep-settled">
                      Settled:{" "}
                      <span className="font-mono font-semibold text-green-700">
                        {sweepSummary.settled}
                      </span>
                    </div>
                    <div data-testid="text-if-sweep-still-insufficient">
                      Still held:{" "}
                      <span className="font-mono font-semibold text-red-700">
                        {sweepSummary.stillInsufficient}
                      </span>
                    </div>
                    <div data-testid="text-if-sweep-not-eligible">
                      Not eligible:{" "}
                      <span className="font-mono font-semibold">
                        {Math.max(
                          0,
                          sweepSummary.checked -
                            sweepSummary.settled -
                            sweepSummary.stillInsufficient -
                            sweepSummary.errors,
                        )}
                      </span>
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Notifications sent: {sweepSummary.notificationsSent} ·
                    debounced:{" "}
                    {sweepSummary.notificationsSkippedDueToDebounce} ·
                    failed: {sweepSummary.notificationsFailed} · errors:{" "}
                    {sweepSummary.errors}
                  </div>
                  {sweepSummary.killSwitchActive ? (
                    <div
                      className="text-xs font-medium text-red-700"
                      data-testid="text-if-sweep-kill-switch"
                    >
                      Sweep skipped: fee_deductions kill switch is engaged.
                      Disable it on the kill switches page to allow the next
                      run to process held rows.
                    </div>
                  ) : sweepSummary.checked === 0 ? (
                    <div className="text-xs italic text-muted-foreground">
                      No held rows to re-check.
                    </div>
                  ) : null}
                </div>
              )}
            </CardContent>
          </Card>

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
                              {/* Task #208 / #229 — IF bookkeeping
                                  (lastRecheckedAt / clientNotifiedAt /
                                  clientNotificationCount / failureReason) is
                                  intentionally retained in the DB after
                                  settle for cron debounce, but the server's
                                  projectFeeExceptionRow helper now nulls /
                                  zeroes those fields on every non-held
                                  exception kind before they ship over the
                                  wire. The cells below therefore lean on the
                                  server-supplied falsy values directly
                                  instead of re-checking kind === "held". */}
                              <TableCell
                                className="text-xs whitespace-nowrap"
                                data-testid={`text-exception-recheck-${x.deduction.id}`}
                              >
                                {x.deduction.lastRecheckedAt ? (
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
                                {x.deduction.clientNotifiedAt ? (
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
                                  x.deduction.failureReason ??
                                  (x.kind === "stuck"
                                    ? "Pending approval > 7 days"
                                    : x.kind === "role_corruption"
                                      ? "Settled or reversed against a non-adviser user"
                                      : x.kind === "failed"
                                        ? "Last attempt failed"
                                        : "Insufficient client balance")
                                }
                              >
                                {x.deduction.failureReason ??
                                  (x.kind === "stuck"
                                    ? "Pending > 7d"
                                    : x.kind === "role_corruption"
                                      ? "Non-adviser user"
                                      : x.kind === "failed"
                                        ? "Last attempt failed"
                                        : "Insufficient client balance")}
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
