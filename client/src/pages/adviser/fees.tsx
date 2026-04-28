// =============================================================================
// SESSION 23A — ADVISER FEE ENGINE PAGE (READ-ONLY)
// -----------------------------------------------------------------------------
// The adviser sees only their own rules, accruals and pending deductions for
// clients they are linked to. NO write actions on this page.
// =============================================================================

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Link } from "wouter";
import { HandCoins, Undo2, ExternalLink, Search, X } from "lucide-react";
// Task #204 — single canonical source for the IF status string so the
// adviser badge cannot drift from the server/admin/client predicates.
import { INSUFFICIENT_FUNDS_STATUS } from "@/lib/insufficient-funds";
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

function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// Task #294 — searchbox shared by the Active / History rule cards. Each
// card has its own instance so search state is fully independent.
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

// Task #294 — Prev/Next paginator. Each rule card owns its own page state
// and feeds it in here, so paging on one card doesn't touch the other.
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

// Task #294 — clickable in-page anchor pointing at the rule that
// superseded this one. Falls back to a plain "#N" label when the target
// row isn't on this page (because pagination split the chain across pages).
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
  // Task #294 — supersede chain + consent reconciliation columns.
  accountNumber: string | null;
  effectiveDate: string | null;
  pausedAt: string | null;
  pausedReason: string | null;
  supersededByRuleId: number | null;
  supersededAt: string | null;
  supersededReason: string | null;
  createdAt: string;
  updatedAt: string;
  // Task #294 — joined consent context (LEFT JOIN — null if consent missing).
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
  accrualDate: string;
  accrualAmount: string;
  adviserShareAmount: string;
  currency: string;
  gateReason: string | null;
}

interface FeeDeductionRow {
  id: number;
  clientUserId: number;
  periodStart: string;
  periodEnd: string;
  totalAccrued: string;
  adviserShareAmount: string;
  currency: string;
  status: string;
  settledAt: string | null;
  settledTransactionId: number | null;
  failureReason: string | null;
  reversedAt: string | null;
  reversedReason: string | null;
  reversalTransactionId: number | null;
}

function deductionStatusBadge(status: string) {
  if (status === "settled") return <Badge variant="default">settled</Badge>;
  if (status === "pending_approval") return <Badge variant="secondary">{status}</Badge>;
  if (status === "rejected") return <Badge variant="destructive">{status}</Badge>;
  // Task #204 — distinct destructive badge for held rows so advisers see at
  // a glance that the deduction is blocked on the client's wallet, not on
  // approval. Uses the canonical status string from the shared helper.
  if (status === INSUFFICIENT_FUNDS_STATUS) {
    return (
      <Badge
        variant="destructive"
        data-testid={`badge-deduction-status-${status}`}
      >
        held — insufficient funds
      </Badge>
    );
  }
  return <Badge variant="outline">{status}</Badge>;
}

interface UserRef {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
}
type UsersMap = Record<number, UserRef>;
interface AdviserListResponse<T> {
  items: T[];
  users?: UsersMap;
}

function ClientCell({
  users,
  userId,
}: {
  users: UsersMap | undefined;
  userId: number;
}) {
  const u = users?.[userId];
  if (!u) {
    return (
      <span className="text-sm" title={`Client #${userId}`}>
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

// Task #294 — adviser-side rule status pill. The colour signal is opinionated:
//   active   → outline (default state)
//   draft    → secondary (created but not yet effective)
//   paused   → destructive (a deduction-blocking event happened)
//   superseded / expired → muted secondary (terminal — kept for audit only)
function ruleStatusBadge(r: FeeRuleRow) {
  if (r.status === "active") return <Badge variant="outline">active</Badge>;
  if (r.status === "draft") return <Badge variant="secondary">draft</Badge>;
  if (r.status === "paused") {
    return (
      <Badge variant="destructive" title={r.pausedReason ?? undefined}>
        paused{r.pausedReason ? ` · ${r.pausedReason}` : ""}
      </Badge>
    );
  }
  if (r.status === "superseded") {
    return (
      <Badge variant="secondary" title={r.supersededReason ?? undefined}>
        superseded
        {r.supersededByRuleId ? (
          <>
            {" → "}
            <SupersedeLink targetId={r.supersededByRuleId} />
          </>
        ) : null}
      </Badge>
    );
  }
  if (r.status === "expired") return <Badge variant="secondary">expired</Badge>;
  return <Badge variant="outline">{r.status}</Badge>;
}

// Renders the consent-context pill column shown on every rule row. The
// adviser only needs the renewal status + expiry — the account number /
// account name live in the existing Account column.
function ConsentContextCell({ r }: { r: FeeRuleRow }) {
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

// Shared rule table — used by both the Active card and the
// Paused/Superseded/Expired card. Keeping it as one component means the
// columns can never drift between the two surfaces.
function RuleTable({
  rows,
  users,
}: {
  rows: FeeRuleRow[];
  users: UsersMap | undefined;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>ID</TableHead>
          <TableHead>Client</TableHead>
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
          <TableRow
            key={r.id}
            id={`row-rule-${r.id}`}
            data-testid={`row-rule-${r.id}`}
          >
            <TableCell>{r.id}</TableCell>
            <TableCell>
              <ClientCell users={users} userId={r.clientUserId} />
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
              {/* Adviser-facing split copy: "Your share X% · Licensee Y%". */}
              Your share {(r.adviserSplitBps / 100).toFixed(2)}% · Licensee{" "}
              {(r.platformSplitBps / 100).toFixed(2)}%
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
              <ConsentContextCell r={r} />
            </TableCell>
            <TableCell>{ruleStatusBadge(r)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

interface PaginatedRules extends AdviserListResponse<FeeRuleRow> {
  page?: number;
  limit?: number;
  total?: number;
}

const RULES_PAGE_SIZE = 25;

export default function AdviserFeesPage() {
  // Task #294 — TWO independent rule queries (Active vs History), each
  // with its own search box + paginator. Pagination on one card no longer
  // truncates rows on the other.
  const [rulesActiveSearch, setRulesActiveSearch] = useState("");
  const [rulesActivePage, setRulesActivePage] = useState(1);
  const [rulesHistorySearch, setRulesHistorySearch] = useState("");
  const [rulesHistoryPage, setRulesHistoryPage] = useState(1);
  const debouncedRulesActiveSearch = useDebounced(rulesActiveSearch);
  const debouncedRulesHistorySearch = useDebounced(rulesHistorySearch);
  // Reset to page 1 on a search-text change so the user doesn't end up
  // staring at an empty page-2 after the result set shrinks.
  useEffect(() => { setRulesActivePage(1); }, [debouncedRulesActiveSearch]);
  useEffect(() => { setRulesHistoryPage(1); }, [debouncedRulesHistorySearch]);

  const rulesActiveQ = useQuery<PaginatedRules>({
    queryKey: [
      "/api/adviser/fee-rules",
      { group: "active", q: debouncedRulesActiveSearch, page: rulesActivePage },
    ],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("status", "active,draft");
      params.set("page", String(rulesActivePage));
      params.set("limit", String(RULES_PAGE_SIZE));
      if (debouncedRulesActiveSearch.trim()) params.set("q", debouncedRulesActiveSearch.trim());
      return fetchJson<PaginatedRules>(`/api/adviser/fee-rules?${params.toString()}`);
    },
  });
  const rulesHistoryQ = useQuery<PaginatedRules>({
    queryKey: [
      "/api/adviser/fee-rules",
      { group: "history", q: debouncedRulesHistorySearch, page: rulesHistoryPage },
    ],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("status", "paused,superseded,expired");
      params.set("page", String(rulesHistoryPage));
      params.set("limit", String(RULES_PAGE_SIZE));
      if (debouncedRulesHistorySearch.trim()) params.set("q", debouncedRulesHistorySearch.trim());
      return fetchJson<PaginatedRules>(`/api/adviser/fee-rules?${params.toString()}`);
    },
  });
  const accrualsQ = useQuery<AdviserListResponse<FeeAccrualRow>>({
    queryKey: ["/api/adviser/fee-accruals"],
  });
  const deductionsQ = useQuery<AdviserListResponse<FeeDeductionRow>>({
    queryKey: ["/api/adviser/fee-deductions"],
  });

  return (
    <div className="space-y-6 p-6" data-testid="page-adviser-fees">
      <div className="flex items-center gap-2">
        <HandCoins className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-semibold">Your fee rules</h1>
      </div>

      {/* Task #307 — page-local Gate-A banner removed. The exact same copy
          is now rendered shell-level by <DeductionExecutionBanner /> in
          AdviserLayout so it appears on every adviser page (not just this
          one) and a future page can never forget to surface it. */}

      <Tabs defaultValue="rules">
        <TabsList>
          <TabsTrigger value="rules" data-testid="tab-rules">Rules</TabsTrigger>
          <TabsTrigger value="accruals" data-testid="tab-accruals">Accruals</TabsTrigger>
          <TabsTrigger value="deductions" data-testid="tab-deductions">Deductions</TabsTrigger>
        </TabsList>

        <TabsContent value="rules" className="space-y-4">
          {/* Task #294 — Active card. Independent server-side query for
              status ∈ {active,draft} with its own search + paginator. */}
          <Card data-testid="card-rules-active">
            <CardHeader>
              <CardTitle className="text-base">Active rules</CardTitle>
              <CardDescription>
                Each rule is anchored on a signed fee consent. Only rules in
                <strong> active</strong> (or <strong>draft</strong>) status
                drive new accruals.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-4">
                <SearchBox
                  value={rulesActiveSearch}
                  onChange={setRulesActiveSearch}
                  placeholder="Search active rules by client name / email"
                  testId="input-search-rules-active"
                />
              </div>
              {rulesActiveQ.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : (rulesActiveQ.data?.items.length ?? 0) > 0 ? (
                <>
                  <RuleTable
                    rows={rulesActiveQ.data!.items}
                    users={rulesActiveQ.data?.users}
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
                    : "No active fee rules."}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Task #294 — History card. Independent server-side query for
              status ∈ {paused,superseded,expired}. Always rendered so the
              adviser can search history even when nothing is shown
              currently — superseded rows link to the replacement rule. */}
          <Card data-testid="card-rules-history">
            <CardHeader>
              <CardTitle className="text-base">Paused, superseded & expired</CardTitle>
              <CardDescription>
                These rules are no longer driving accruals. Kept for audit
                history — superseded rows link to the rule that replaced
                them.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-4">
                <SearchBox
                  value={rulesHistorySearch}
                  onChange={setRulesHistorySearch}
                  placeholder="Search history by client name / email"
                  testId="input-search-rules-history"
                />
              </div>
              {rulesHistoryQ.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : (rulesHistoryQ.data?.items.length ?? 0) > 0 ? (
                <>
                  <RuleTable
                    rows={rulesHistoryQ.data!.items}
                    users={rulesHistoryQ.data?.users}
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
        </TabsContent>

        <TabsContent value="accruals">
          <Card>
            <CardHeader><CardTitle className="text-base">Recent accruals</CardTitle></CardHeader>
            <CardContent>
              {accrualsQ.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : accrualsQ.data && accrualsQ.data.items.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead>Rule</TableHead>
                      <TableHead>Accrued</TableHead>
                      <TableHead>Your share</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accrualsQ.data.items.map((a) => (
                      <TableRow key={a.id} data-testid={`row-accrual-${a.id}`}>
                        <TableCell>{a.accrualDate.slice(0, 10)}</TableCell>
                        <TableCell>
                          <ClientCell users={accrualsQ.data?.users} userId={a.clientUserId} />
                        </TableCell>
                        <TableCell>{a.feeRuleId}</TableCell>
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
              ) : (
                <p className="text-sm text-muted-foreground">No accruals yet.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="deductions">
          <Card>
            <CardHeader><CardTitle className="text-base">Deductions</CardTitle></CardHeader>
            <CardContent>
              {deductionsQ.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : deductionsQ.data && deductionsQ.data.items.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead>Total</TableHead>
                      <TableHead>Your share</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Settled</TableHead>
                      <TableHead>Reversal</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deductionsQ.data.items.map((d) => (
                      <TableRow key={d.id} data-testid={`row-deduction-${d.id}`}>
                        <TableCell>{d.id}</TableCell>
                        <TableCell>
                          <ClientCell users={deductionsQ.data?.users} userId={d.clientUserId} />
                        </TableCell>
                        <TableCell>{d.periodStart.slice(0, 10)} → {d.periodEnd.slice(0, 10)}</TableCell>
                        <TableCell>{d.totalAccrued} {d.currency}</TableCell>
                        <TableCell>{d.adviserShareAmount}</TableCell>
                        <TableCell>{deductionStatusBadge(d.status)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {d.settledAt ? d.settledAt.slice(0, 10) : "—"}
                        </TableCell>
                        <TableCell>
                          {d.reversedAt ? (
                            <div className="flex flex-col gap-1">
                              <Badge
                                variant="secondary"
                                className="inline-flex items-center gap-1 w-fit"
                                data-testid={`badge-deduction-reversed-${d.id}`}
                                title={d.reversedReason ?? undefined}
                              >
                                <Undo2 className="h-3 w-3" />
                                Reversed {d.reversedAt.slice(0, 10)}
                              </Badge>
                              {d.reversedReason && (
                                <span className="text-xs text-muted-foreground max-w-[14rem] truncate">
                                  {d.reversedReason}
                                </span>
                              )}
                              {d.reversalTransactionId && (
                                <Link
                                  href={`/transactions?txn=${d.reversalTransactionId}`}
                                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                  data-testid={`link-deduction-reversal-txn-${d.id}`}
                                >
                                  Txn #{d.reversalTransactionId}
                                  <ExternalLink className="h-3 w-3" />
                                </Link>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
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
        </TabsContent>
      </Tabs>
    </div>
  );
}
