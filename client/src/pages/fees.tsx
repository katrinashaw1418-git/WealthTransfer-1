// =============================================================================
// SESSION 23A — CLIENT FEE TRANSPARENCY PAGE (READ-ONLY)
// -----------------------------------------------------------------------------
// Single combined view at /client/fees. Reads from /api/client/fees which
// returns { rules, recentAccruals, pendingDeductions } scoped to the caller.
// =============================================================================

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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

interface ClientFeesPayload {
  rules: Array<{
    id: number;
    feeConsentId: number;
    adviserUserId: number;
    feeType: string;
    amountType: string;
    rateBps: number | null;
    fixedAmount: string | null;
    currency: string;
    status: string;
    pausedReason: string | null;
    createdAt: string;
  }>;
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

export default function ClientFeesPage() {
  const q = useQuery<ClientFeesPayload>({ queryKey: ["/api/client/fees"] });
  const deductionsQ = useQuery<ClientDeductionsPayload>({
    queryKey: ["/api/client/fee-deductions"],
  });

  const hasSettled =
    !!deductionsQ.data?.items.some((d) => d.status === "settled");

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

      <Alert variant="default" data-testid="alert-gate-a">
        <ShieldAlert className="h-4 w-4" />
        {hasSettled ? (
          <>
            <AlertTitle>How to read this page</AlertTitle>
            <AlertDescription>
              The rules below show what your adviser is allowed to deduct
              under your signed fee consents. The <strong>Deductions</strong>
              section lists each batch your adviser has prepared, along with
              its current status. Settled rows link to the underlying
              transaction in your account.
            </AlertDescription>
          </>
        ) : (
          <>
            <AlertTitle>Nothing has been deducted yet</AlertTitle>
            <AlertDescription>
              This page shows what your adviser would deduct based on your
              signed fee consents. <strong>No money has actually moved.</strong>{" "}
              Any future deduction will require an additional, explicit step
              that is recorded against your account.
            </AlertDescription>
          </>
        )}
      </Alert>

      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Fee rules linked to you</CardTitle>
              <CardDescription>
                Each rule is anchored to a fee consent you signed. If a rule is
                paused, the reason is shown.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {q.data && q.data.rules.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Adviser</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Paused reason</TableHead>
                      <TableHead>Consent ID</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {q.data.rules.map((r) => (
                      <TableRow key={r.id} data-testid={`row-rule-${r.id}`}>
                        <TableCell>
                          <AdviserCell users={q.data?.users} userId={r.adviserUserId} />
                        </TableCell>
                        <TableCell>{r.feeType}</TableCell>
                        <TableCell>
                          {r.amountType === "fixed"
                            ? `${r.fixedAmount} ${r.currency} / month`
                            : `${(Number(r.rateBps ?? 0) / 100).toFixed(2)}% p.a.`}
                        </TableCell>
                        <TableCell>
                          <Badge variant={r.status === "active" ? "outline" : "secondary"}>
                            {r.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {r.pausedReason ?? "—"}
                        </TableCell>
                        <TableCell>{r.feeConsentId}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground">No fee rules.</p>
              )}
            </CardContent>
          </Card>

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
