// =============================================================================
// SESSION 23A — CLIENT FEE TRANSPARENCY PAGE (READ-ONLY)
// -----------------------------------------------------------------------------
// Single combined view at /client/fees. Reads from /api/client/fees which
// returns { rules, recentAccruals, pendingDeductions } scoped to the caller.
// =============================================================================

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ShieldAlert, Receipt, ExternalLink, Undo2 } from "lucide-react";
// Task #294 — pure forecaster reused across the 3 fee surfaces.
import { formatNextChargeCell } from "@shared/fee-rule-helpers";

const TOKEN_KEY = "amax_jwt";

async function fetchJson<T>(url: string): Promise<T> {
  const token = (() => {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  })();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

const RULES_PAGE_SIZE = 25;

// Task #294 review fix — Prev/Next paginator for the client fees rule
// cards. Each card owns its own page state so paging on Active never
// truncates History (the original review concern at scale).
function ClientRulesPager({
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
      <span className="text-muted-foreground" data-testid={`${testIdPrefix}-pager-status`}>
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
// Task #204 — banner + client-side IF predicate. Resolved during rebase to
// use the canonical client/src/components + client/src/lib homes from main
// (more polished — the banner has parsed-shortfall + compact variants and
// the predicate file also exports parseShortfallFromFailureReason). The
// shared/fee-deduction-status helpers from this task remain in use on the
// server side (admin + adviser routes + projection contract).
import { InsufficientFundsBanner } from "@/components/insufficient-funds-banner";

interface UserRef {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
}
type UsersMap = Record<number, UserRef>;

// Task #294 — extracted so the helper functions below can refer to a named
// type. Mirrors the server projection in /api/client/fees.
interface ClientFeeRuleRow {
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
  accountNumber: string | null;
  effectiveDate: string | null;
  pausedAt: string | null;
  pausedReason: string | null;
  supersededByRuleId: number | null;
  supersededAt: string | null;
  supersededReason: string | null;
  createdAt: string;
  updatedAt: string;
  consentRenewalStatus: string | null;
  consentExpiryDate: string | null;
  consentWithdrawnAt: string | null;
  consentAccountNumber: string | null;
  consentAccountName: string | null;
  consentDeductionFrequency: string | null;
}

interface ClientFeesPayload {
  rules: ClientFeeRuleRow[];
  recentAccruals: Array<{
    id: number;
    feeRuleId: number;
    adviserUserId: number;
    accrualDate: string;
    accrualAmount: string;
    currency: string;
    gateReason: string | null;
  }>;
  pendingDeductions: Array<{
    id: number;
    adviserUserId: number;
    periodStart: string;
    periodEnd: string;
    totalAccrued: string;
    currency: string;
    status: string;
  }>;
  recentReversals?: ClientDeductionRow[];
  users?: UsersMap;
}

interface ClientDeductionRow {
  id: number;
  adviserUserId: number;
  periodStart: string;
  periodEnd: string;
  totalAccrued: string;
  adviserShareAmount: string;
  platformShareAmount: string;
  currency: string;
  status: string;
  settledAt: string | null;
  settledTransactionId: number | null;
  reversedAt: string | null;
  reversedReason: string | null;
  reversalTransactionId: number | null;
  createdAt: string;
}

interface ClientDeductionsPayload {
  items: ClientDeductionRow[];
  users?: UsersMap;
}

function statusBadgeVariant(status: string): "default" | "outline" | "secondary" | "destructive" {
  switch (status) {
    case "settled":
      return "default";
    case "pending_approval":
      return "secondary";
    case "approved":
      return "outline";
    case "rejected":
      return "destructive";
    case "reversed":
      return "outline";
    default:
      return "secondary";
  }
}

// Task #294 — client-facing rule status pill. Mirrors the adviser surface
// but uses client-friendly labels (the client doesn't care about "draft").
function clientRuleStatusBadge(r: ClientFeeRuleRow) {
  if (r.status === "active") return <Badge variant="outline">active</Badge>;
  if (r.status === "draft") return <Badge variant="secondary">pending</Badge>;
  if (r.status === "paused") {
    return (
      <Badge variant="destructive" title={r.pausedReason ?? undefined}>
        paused{r.pausedReason ? ` · ${r.pausedReason}` : ""}
      </Badge>
    );
  }
  if (r.status === "superseded") {
    // Client never sees rule IDs as actionable links — but we keep the
    // human label "replaced by rule #N" since the History card lists the
    // replacement rule on the same page if it's in the active set.
    return (
      <Badge variant="secondary" title={r.supersededReason ?? undefined}>
        replaced{r.supersededByRuleId ? ` by rule #${r.supersededByRuleId}` : ""}
      </Badge>
    );
  }
  if (r.status === "expired") return <Badge variant="secondary">expired</Badge>;
  return <Badge variant="outline">{r.status}</Badge>;
}

// Client-facing consent context cell. Surfaces the legal anchor:
// renewal status + expiry + (rare) withdrawn marker.
function ClientConsentContextCell({ r }: { r: ClientFeeRuleRow }) {
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

// Shared rule table — used by both Active and History cards on the
// client-facing fees page. One component = one source of truth for columns.
function ClientRuleTable({
  rows,
  users,
}: {
  rows: ClientFeeRuleRow[];
  users: UsersMap | undefined;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Adviser</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Account</TableHead>
          <TableHead>Amount</TableHead>
          <TableHead>Split</TableHead>
          <TableHead>Effective</TableHead>
          <TableHead>Next charge</TableHead>
          <TableHead>Consent</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id} data-testid={`row-rule-${r.id}`}>
            <TableCell>
              <AdviserCell users={users} userId={r.adviserUserId} />
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
              {/* Client-facing split copy: "Adviser receives X% · Licensee receives Y%". */}
              Adviser receives {(r.adviserSplitBps / 100).toFixed(2)}% ·
              Licensee receives {(r.platformSplitBps / 100).toFixed(2)}%
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
              <ClientConsentContextCell r={r} />
            </TableCell>
            <TableCell>{clientRuleStatusBadge(r)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function AdviserCell({
  users,
  userId,
}: {
  users: UsersMap | undefined;
  userId: number;
}) {
  const u = users?.[userId];
  if (!u) {
    return (
      <span className="text-sm text-muted-foreground" title={`Adviser #${userId}`}>
        Adviser #{userId}
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

interface PaginatedClientFees extends ClientFeesPayload {
  rulesPage?: number;
  rulesLimit?: number;
  rulesTotal?: number;
}

export default function ClientFeesPage() {
  // Task #294 review fix — TWO independent server-paged rule queries
  // (Active vs History). Pagination on one card no longer truncates the
  // other, eliminating the silent-omission risk at scale (>50 rules).
  const [activePage, setActivePage] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);

  // Bundle query — used for recentAccruals / pendingDeductions /
  // recentReversals / users only. Rules are deliberately ignored here.
  const q = useQuery<PaginatedClientFees>({ queryKey: ["/api/client/fees"] });

  const rulesActiveQ = useQuery<PaginatedClientFees>({
    queryKey: ["/api/client/fees", { group: "active", page: activePage }],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("status", "active,draft");
      params.set("rulesPage", String(activePage));
      params.set("rulesLimit", String(RULES_PAGE_SIZE));
      return fetchJson<PaginatedClientFees>(`/api/client/fees?${params.toString()}`);
    },
  });
  const rulesHistoryQ = useQuery<PaginatedClientFees>({
    queryKey: ["/api/client/fees", { group: "history", page: historyPage }],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("status", "paused,superseded,expired");
      params.set("rulesPage", String(historyPage));
      params.set("rulesLimit", String(RULES_PAGE_SIZE));
      return fetchJson<PaginatedClientFees>(`/api/client/fees?${params.toString()}`);
    },
  });
  const deductionsQ = useQuery<ClientDeductionsPayload>({
    queryKey: ["/api/client/fee-deductions"],
  });

  const activeRules = rulesActiveQ.data?.rules ?? [];
  const historyRules = rulesHistoryQ.data?.rules ?? [];

  return (
    <div className="space-y-6 p-6" data-testid="page-client-fees">
      <div className="flex items-center gap-2">
        <Receipt className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-semibold">Your fees</h1>
      </div>

      {/* Task #204 — full-detail banner above the page content for any
          deduction currently held due to insufficient funds. Renders nothing
          when no IF rows exist. */}
      <InsufficientFundsBanner />

      {/* Task #294 — canonical Gate-A copy. Until deduction execution is
          enabled at the platform level, no money has moved regardless of
          whether a deduction is shown as Settled. The previous "How to read
          this page" branch was misleading once Settled rows appeared while
          Gate-B was still off. */}
      <Alert variant="default" data-testid="alert-gate-a">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Deduction execution is currently disabled</AlertTitle>
        <AlertDescription>
          The rules below show what your adviser is authorised to deduct
          under your signed fee consents. When deduction execution is
          enabled, deductions in <strong>Settled</strong> status will
          represent completed fund movements. Until then,{" "}
          <strong>no money has actually moved</strong>.
        </AlertDescription>
      </Alert>

      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="space-y-6">
          {/* Task #294 review fix — Active card uses its own paged query
              (status=active,draft) with own paginator. */}
          <Card data-testid="card-rules-active">
            <CardHeader>
              <CardTitle className="text-base">Fee rules linked to you</CardTitle>
              <CardDescription>
                Each rule is anchored to a fee consent you signed. Only the
                rules below currently authorise deductions.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {rulesActiveQ.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : activeRules.length > 0 ? (
                <>
                  <ClientRuleTable rows={activeRules} users={q.data?.users} />
                  <ClientRulesPager
                    page={activePage}
                    setPage={setActivePage}
                    total={rulesActiveQ.data?.rulesTotal ?? 0}
                    pageSize={RULES_PAGE_SIZE}
                    testIdPrefix="rules-active"
                  />
                </>
              ) : (
                <p className="text-sm text-muted-foreground" data-testid="empty-rules-active">
                  No active fee rules.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Task #294 review fix — History card uses its own paged query
              (status=paused,superseded,expired). Hidden when totally empty
              so a fresh client doesn't see an empty section. */}
          {(rulesHistoryQ.data?.rulesTotal ?? 0) > 0 && (
            <Card data-testid="card-rules-history">
              <CardHeader>
                <CardTitle className="text-base">Paused, replaced & expired</CardTitle>
                <CardDescription>
                  These rules no longer authorise deductions. Kept here so
                  you can see the history of what was previously in place.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {rulesHistoryQ.isLoading ? (
                  <Skeleton className="h-32 w-full" />
                ) : (
                  <>
                    <ClientRuleTable rows={historyRules} users={q.data?.users} />
                    <ClientRulesPager
                      page={historyPage}
                      setPage={setHistoryPage}
                      total={rulesHistoryQ.data?.rulesTotal ?? 0}
                      pageSize={RULES_PAGE_SIZE}
                      testIdPrefix="rules-history"
                    />
                  </>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent fee activity (last 90 days)</CardTitle>
              <CardDescription>
                These rows show what would have been accrued each day. Skipped
                rows include the reason (e.g. consent expired).
              </CardDescription>
            </CardHeader>
            <CardContent>
              {q.data && q.data.recentAccruals.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Adviser</TableHead>
                      <TableHead>Rule</TableHead>
                      <TableHead>Would accrue</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {q.data.recentAccruals.map((a) => (
                      <TableRow key={a.id} data-testid={`row-accrual-${a.id}`}>
                        <TableCell>{a.accrualDate.slice(0, 10)}</TableCell>
                        <TableCell>
                          <AdviserCell users={q.data?.users} userId={a.adviserUserId} />
                        </TableCell>
                        <TableCell>{a.feeRuleId}</TableCell>
                        <TableCell>{a.accrualAmount} {a.currency}</TableCell>
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
              ) : (
                <p className="text-sm text-muted-foreground">No activity in the last 90 days.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Deductions</CardTitle>
              <CardDescription>
                Every adviser fee deduction batch covering you. Pending rows
                are awaiting licensee approval. Settled rows have been posted
                to your wallet — click the transaction link to reconcile.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {deductionsQ.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : deductionsQ.data && deductionsQ.data.items.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID</TableHead>
                      <TableHead>Adviser</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead>Total</TableHead>
                      <TableHead>Adviser share</TableHead>
                      <TableHead>Platform share</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Settled</TableHead>
                      <TableHead>Transaction</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deductionsQ.data.items.map((d) => (
                      <TableRow key={d.id} data-testid={`row-deduction-${d.id}`}>
                        <TableCell>{d.id}</TableCell>
                        <TableCell>
                          <AdviserCell users={deductionsQ.data?.users} userId={d.adviserUserId} />
                        </TableCell>
                        <TableCell>{d.periodStart.slice(0, 10)} → {d.periodEnd.slice(0, 10)}</TableCell>
                        <TableCell>{d.totalAccrued} {d.currency}</TableCell>
                        <TableCell>{d.adviserShareAmount} {d.currency}</TableCell>
                        <TableCell>{d.platformShareAmount} {d.currency}</TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <Badge
                              variant={statusBadgeVariant(d.status)}
                              data-testid={`badge-deduction-status-${d.id}`}
                            >
                              {d.status}
                            </Badge>
                            {d.reversedAt && (
                              <Badge
                                variant="secondary"
                                className="inline-flex items-center gap-1 w-fit"
                                data-testid={`badge-deduction-reversed-${d.id}`}
                                title={d.reversedReason ?? undefined}
                              >
                                <Undo2 className="h-3 w-3" />
                                Reversed {d.reversedAt.slice(0, 10)}
                                {d.reversedReason ? ` — ${d.reversedReason}` : ""}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {d.settledAt ? d.settledAt.slice(0, 10) : "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            {d.settledTransactionId ? (
                              <Link
                                href={`/transactions?txn=${d.settledTransactionId}`}
                                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                                data-testid={`link-deduction-txn-${d.id}`}
                              >
                                #{d.settledTransactionId}
                                <ExternalLink className="h-3 w-3" />
                              </Link>
                            ) : (
                              <span className="text-sm text-muted-foreground">—</span>
                            )}
                            {d.reversalTransactionId && (
                              <Link
                                href={`/transactions?txn=${d.reversalTransactionId}`}
                                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
                                data-testid={`link-deduction-reversal-txn-${d.id}`}
                              >
                                Reversal #{d.reversalTransactionId}
                                <ExternalLink className="h-3 w-3" />
                              </Link>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground">No deductions yet.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
