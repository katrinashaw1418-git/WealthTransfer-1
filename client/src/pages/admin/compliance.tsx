import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ShieldCheck,
  UserCheck,
  Receipt,
  ListChecks,
  ScrollText,
  AlertTriangle,
} from "lucide-react";

interface ComplianceOverview {
  kyc: Record<string, number>;
  feeConsent: Record<string, number>;
  instructions: Record<string, number>;
  adviceRecordsTotal: number;
  adviceAcknowledgementsTotal: number;
  expiringFeeConsents: Array<{
    id: number;
    clientId: number;
    adviserId: number | null;
    feeType: string;
    consentExpiryDate: string;
    renewalStatus: string;
    clientUsername: string;
    adviserUsername: string | null;
  }>;
  recentComplianceAudit: Array<{
    id: number;
    userId: number;
    action: string;
    entityType: string | null;
    entityId: string | null;
    createdAt: string | null;
  }>;
}

function fmt(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return "—";
  }
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString();
  } catch {
    return "—";
  }
}

function CountBlock({ entries }: { entries: [string, number][] }) {
  if (entries.length === 0) {
    return <p className="text-xs text-slate-500">No data yet.</p>;
  }
  return (
    <div className="space-y-1.5">
      {entries.map(([k, v]) => (
        <div key={k} className="flex justify-between text-sm">
          <span className="capitalize text-slate-600">{k.replace(/_/g, " ")}</span>
          <Badge variant="outline">{v}</Badge>
        </div>
      ))}
    </div>
  );
}

export default function AdminCompliance() {
  const { data, isLoading } = useQuery<ComplianceOverview>({
    queryKey: ["/api/admin/compliance/overview"],
  });

  const kycEntries = Object.entries(data?.kyc ?? {});
  const feeEntries = Object.entries(data?.feeConsent ?? {});
  const instrEntries = Object.entries(data?.instructions ?? {});
  const ackRate =
    data && data.adviceRecordsTotal > 0
      ? Math.round((data.adviceAcknowledgementsTotal / data.adviceRecordsTotal) * 100)
      : 0;

  return (
    <div className="space-y-4 max-w-7xl">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900 flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-violet-600" />
          Compliance Overview
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          AFSL-grade health check: KYC mix, fee-consent renewal status, instruction-pipeline mix,
          and recent compliance-shaped audit events.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <UserCheck className="h-4 w-4 text-violet-600" />
              KYC status (clients)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-20 w-full" /> : <CountBlock entries={kycEntries} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Receipt className="h-4 w-4 text-violet-600" />
              Fee consents (DBFO)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-20 w-full" /> : <CountBlock entries={feeEntries} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-violet-600" />
              Instructions
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-20 w-full" /> : (
              <CountBlock entries={instrEntries} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <ScrollText className="h-4 w-4 text-violet-600" />
              Advice acks
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : (
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-600">Records</span>
                  <Badge variant="outline">{data?.adviceRecordsTotal ?? 0}</Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Acknowledged</span>
                  <Badge variant="outline">{data?.adviceAcknowledgementsTotal ?? 0}</Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Ack rate</span>
                  <Badge variant={ackRate >= 80 ? "default" : "destructive"}>{ackRate}%</Badge>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            Fee consents expiring within 30 days
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !data?.expiringFeeConsents || data.expiringFeeConsents.length === 0 ? (
            <p className="text-sm text-slate-500">None expiring soon.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Adviser</TableHead>
                  <TableHead>Fee type</TableHead>
                  <TableHead>Renewal status</TableHead>
                  <TableHead>Expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.expiringFeeConsents.map((c) => (
                  <TableRow key={c.id} data-testid={`row-expiring-${c.id}`}>
                    <TableCell className="text-sm">{c.clientUsername}</TableCell>
                    <TableCell className="text-sm">{c.adviserUsername ?? "—"}</TableCell>
                    <TableCell className="text-sm capitalize">
                      {c.feeType.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          c.renewalStatus === "renewal_due" ? "destructive" : "outline"
                        }
                        className="capitalize"
                      >
                        {c.renewalStatus.replace(/_/g, " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{fmtDate(c.consentExpiryDate)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-violet-600" />
            Recent compliance events
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !data?.recentComplianceAudit || data.recentComplianceAudit.length === 0 ? (
            <p className="text-sm text-slate-500">No matching audit events yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>By user</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentComplianceAudit.map((a) => (
                  <TableRow key={a.id} data-testid={`row-audit-${a.id}`}>
                    <TableCell className="text-sm">{fmt(a.createdAt)}</TableCell>
                    <TableCell className="font-mono text-xs">{a.action}</TableCell>
                    <TableCell className="text-xs text-slate-600">
                      {a.entityType ? `${a.entityType}#${a.entityId ?? "—"}` : "—"}
                    </TableCell>
                    <TableCell className="text-sm">#{a.userId}</TableCell>
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
