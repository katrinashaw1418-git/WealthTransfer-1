// =============================================================================
// SESSION 23A — ADVISER FEE ENGINE PAGE (READ-ONLY)
// -----------------------------------------------------------------------------
// The adviser sees only their own rules, accruals and pending deductions for
// clients they are linked to. NO write actions on this page.
// =============================================================================

import { useQuery } from "@tanstack/react-query";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Link } from "wouter";
import { ShieldAlert, HandCoins, Undo2, ExternalLink } from "lucide-react";

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

export default function AdviserFeesPage() {
  const rulesQ = useQuery<AdviserListResponse<FeeRuleRow>>({
    queryKey: ["/api/adviser/fee-rules"],
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

      <Alert variant="default" data-testid="alert-gate-b">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Settlement is now live</AlertTitle>
        <AlertDescription>
          Fee rules are created and managed by the licensee. Deductions in{" "}
          <strong>Settled</strong> status have moved real funds — your share has
          been credited to your wallet. Anything still in{" "}
          <strong>Pending approval</strong> has not moved any money yet.
        </AlertDescription>
      </Alert>

      <Tabs defaultValue="rules">
        <TabsList>
          <TabsTrigger value="rules" data-testid="tab-rules">Rules</TabsTrigger>
          <TabsTrigger value="accruals" data-testid="tab-accruals">Accruals</TabsTrigger>
          <TabsTrigger value="deductions" data-testid="tab-deductions">Deductions</TabsTrigger>
        </TabsList>

        <TabsContent value="rules">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Active rules</CardTitle>
              <CardDescription>Each rule is anchored on a signed fee consent.</CardDescription>
            </CardHeader>
            <CardContent>
              {rulesQ.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : rulesQ.data && rulesQ.data.items.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Adviser split</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rulesQ.data.items.map((r) => (
                      <TableRow key={r.id} data-testid={`row-rule-${r.id}`}>
                        <TableCell>{r.id}</TableCell>
                        <TableCell>
                          <ClientCell users={rulesQ.data?.users} userId={r.clientUserId} />
                        </TableCell>
                        <TableCell>{r.feeType}</TableCell>
                        <TableCell>
                          {r.amountType === "fixed"
                            ? `${r.fixedAmount} ${r.currency} / month`
                            : `${(Number(r.rateBps ?? 0) / 100).toFixed(2)}% p.a.`}
                        </TableCell>
                        <TableCell>{(r.adviserSplitBps / 100).toFixed(2)}%</TableCell>
                        <TableCell>
                          <Badge variant={r.status === "active" ? "outline" : "secondary"}>
                            {r.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground">No fee rules yet.</p>
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
