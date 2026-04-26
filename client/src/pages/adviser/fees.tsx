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
import { ShieldAlert, HandCoins } from "lucide-react";

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

      <Alert variant="default" data-testid="alert-gate-a">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Gate A — read-only</AlertTitle>
        <AlertDescription>
          Fee rules are created and managed by the licensee. Daily accruals and
          pending deductions show what would be deducted; <strong>no money has
          moved yet</strong>.
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
            <CardHeader><CardTitle className="text-base">Pending & approved deductions</CardTitle></CardHeader>
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
                        <TableCell>
                          <Badge variant={d.status === "pending_approval" ? "secondary" : "outline"}>
                            {d.status}
                          </Badge>
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
