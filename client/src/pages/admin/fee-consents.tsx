import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, apiFetch } from "@/lib/queryClient";
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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ShieldAlert,
  AlertTriangle,
  Eye,
  Download,
  Ban,
  Repeat,
  Clock,
  History,
  ScrollText,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Task #293 — admin oversight rows now carry the supersede chain, the
// renewal window math, the latest-signature trail, and the server-computed
// "would deductions be allowed today?" reason. The UI never recomputes
// any of these — it just renders.
interface AdminRequestRow {
  id: number;
  adviserUserId: number;
  clientUserId: number;
  adviceRecordId: number | null;
  feeType: string;
  amountType: string;
  amount: string | null;
  accountNumber: string;
  deductionFrequency: string;
  proposedReferenceDay: string;
  proposedRenewalWindowStart: string;
  proposedRenewalWindowEnd: string;
  proposedConsentExpiryDate: string;
  status: string;
  declineReason: string | null;
  signedFeeConsentId: number | null;
  supersedesRequestId: number | null;
  respondedAt: string | null;
  createdAt: string;
  adviserUsername: string | null;
  clientUsername: string | null;
  deductionsBlockedReason: string | null;
}

interface AdminLiveRow {
  id: number;
  adviceRecordId: number;
  clientId: number;
  adviserId: number;
  feeType: string;
  amountType: string;
  amount: string | null;
  accountNumber: string;
  accountName: string | null;
  deductionFrequency: string;
  referenceDay: string;
  renewalWindowStart: string;
  renewalWindowEnd: string;
  consentExpiryDate: string;
  renewalStatus: string;
  consentedAt: string;
  withdrawnAt: string | null;
  clientSignatureName: string | null;
  supersededByRequestId: number | null;
  supersededAt: string | null;
  supersededReason: string | null;
  supersedesRequestId: number | null;
  signedIp: string | null;
  adviserUsername: string | null;
  clientUsername: string | null;
  deductionsBlockedReason: string | null;
}

interface PaginatedResponse<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

interface AuditRow {
  id: number;
  userId: number | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

const REQUEST_STATUSES = [
  { value: "all", label: "All statuses" },
  { value: "pending", label: "Pending (sent)" },
  { value: "consented", label: "Consented" },
  { value: "declined", label: "Declined" },
  { value: "withdrawn_by_adviser", label: "Revoked / rescinded" },
];

const RENEWAL_STATUSES = [
  { value: "all", label: "All renewal statuses" },
  { value: "active", label: "Active" },
  { value: "renewal_due", label: "Renewal due" },
  { value: "expired", label: "Expired" },
  { value: "withdrawn", label: "Revoked" },
  { value: "superseded", label: "Superseded" },
];

function statusBadge(status: string) {
  const map: Record<
    string,
    { variant: "default" | "secondary" | "outline" | "destructive"; label: string }
  > = {
    // Task #293 — pending must read as "Sent — pending client signature",
    // NOT "Consented". The previous wording made it look like the client
    // had already signed at the moment the adviser hit Send.
    pending: { variant: "secondary", label: "Sent — pending client signature" },
    consented: { variant: "default", label: "Consented" },
    declined: { variant: "destructive", label: "Declined" },
    withdrawn_by_adviser: { variant: "outline", label: "Revoked" },
    superseded: { variant: "outline", label: "Superseded" },
    active: { variant: "default", label: "Active" },
    renewal_due: { variant: "secondary", label: "Renewal due" },
    expired: { variant: "destructive", label: "Expired" },
    withdrawn: { variant: "outline", label: "Revoked" },
  };
  const e = map[status] ?? { variant: "outline" as const, label: status };
  return <Badge variant={e.variant}>{e.label}</Badge>;
}

function formatAud(value: string | null): string {
  if (value === null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return value as string;
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
  }).format(n);
}

function formatDate(value: string | null): string {
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

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("en-AU", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function formatFeeType(t: string): string {
  return t.replace(/_/g, " ");
}

function formatAmount(amountType: string, amount: string | null): string {
  if (amountType === "calculation_method") return "Calc method";
  if (amountType === "percentage")
    return `${(Number(amount ?? 0) * 100).toFixed(4)}%`;
  return formatAud(amount);
}

// Task #293 — render an inline warning banner driven by the server-side
// `deductionsBlockedReason` projection. Keeping the mapping here means the
// UI cannot disagree with the API about what blocks a deduction.
function blockedReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  switch (reason) {
    case "expired":
      return "Consent expired — deductions blocked";
    case "pending":
      return "Consent pending — deductions blocked";
    case "no_advice_record":
      return "No linked advice record — cannot send";
    default:
      return null;
  }
}

function BlockedReasonBanner({ reason }: { reason: string | null }) {
  const label = blockedReasonLabel(reason);
  if (!label) return null;
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900"
      data-testid={`warn-${reason}`}
    >
      <AlertTriangle className="h-3 w-3" />
      <span>{label}</span>
    </div>
  );
}

// Supersede-chain links: scroll to and briefly highlight the matching row
// when it's on the current page. If the linked row isn't visible (different
// tab or paginated off-screen), surface a toast hint instead of failing
// silently.
function jumpToRow(
  testId: string,
  fallbackLabel: string,
  toast: (args: { title: string; description?: string }) => void,
): void {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  if (el && el instanceof HTMLElement) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-amber-400", "rounded-md");
    window.setTimeout(() => {
      el.classList.remove("ring-2", "ring-amber-400", "rounded-md");
    }, 1800);
    return;
  }
  toast({
    title: `${fallbackLabel} not on this page`,
    description: "Switch tabs or clear filters to find it.",
  });
}

// Authenticated PDF download. The admin endpoints sit behind the same JWT
// gate as every other /api/admin route, so we can't just window.open()
// the URL — the browser won't attach the Authorization header from
// localStorage. Instead, fetch the bytes through `apiFetch`, build a
// transient blob URL, and trigger an <a download> click.
async function downloadPdf(url: string, filename: string): Promise<void> {
  const res = await apiFetch(url);
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next tick so the click handler has time to start
    // the download before the URL is released.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }
}

function downloadConsentPdf(consentId: number): Promise<void> {
  return downloadPdf(
    `/api/admin/fee-consents/${consentId}/pdf`,
    `fee-consent-${consentId}.pdf`,
  );
}

function downloadRequestPdf(requestId: number): Promise<void> {
  return downloadPdf(
    `/api/admin/fee-consent-requests/${requestId}/pdf`,
    `fee-consent-request-${requestId}.pdf`,
  );
}

function AuditTimeline({
  entityType,
  entityId,
  enabled,
}: {
  entityType: string;
  entityId: number;
  enabled: boolean;
}) {
  const url = `/api/admin/audit-logs?entityType=${encodeURIComponent(
    entityType,
  )}&entityId=${encodeURIComponent(String(entityId))}&limit=50`;
  const q = useQuery<{ items: AuditRow[]; page: number; total: number; limit: number }>({
    queryKey: [url],
    enabled,
  });
  if (!enabled) return null;
  if (q.isLoading) return <Skeleton className="h-24 w-full" />;
  if (q.isError) return <p className="text-sm text-red-600">Unable to load audit trail.</p>;
  const items = q.data?.items ?? [];
  if (items.length === 0)
    return <p className="text-sm text-gray-500">No audit entries yet.</p>;
  return (
    <ol className="space-y-3" data-testid="audit-timeline">
      {items.map((row) => (
        <li
          key={row.id}
          className="rounded-md border border-slate-200 bg-white p-3 text-xs"
          data-testid={`audit-row-${row.id}`}
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-slate-800">{row.action}</span>
            <span className="text-slate-500">{formatDateTime(row.createdAt)}</span>
          </div>
          <div className="mt-1 text-slate-600">
            actor #{row.userId ?? "system"} · IP {row.ipAddress ?? "—"}
          </div>
          {row.metadata && (
            <pre className="mt-2 overflow-auto rounded bg-slate-50 p-2 text-[11px] text-slate-700">
              {JSON.stringify(row.metadata, null, 2)}
            </pre>
          )}
        </li>
      ))}
    </ol>
  );
}

// Query keys are full URL strings (so pagination/filter changes get fresh
// rows), but mutations need to invalidate every page+filter variant of the
// admin lists. Predicate-based invalidation matches by URL prefix so the
// stale-after-mutate bug doesn't bite us.
function invalidateAdminFeeConsentLists() {
  queryClient.invalidateQueries({
    predicate: (query) => {
      const k = query.queryKey?.[0];
      return (
        typeof k === "string" &&
        (k.startsWith("/api/admin/fee-consent-requests") ||
          k.startsWith("/api/admin/fee-consents"))
      );
    },
  });
}

function RequestsTab() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const limit = 50;
  const [viewing, setViewing] = useState<AdminRequestRow | null>(null);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [supersedingConsentId, setSupersedingConsentId] = useState<number | null>(null);
  const [supersedeReason, setSupersedeReason] = useState("");
  const [auditingId, setAuditingId] = useState<number | null>(null);

  const requestsUrl = `/api/admin/fee-consent-requests?page=${page}&limit=${limit}${
    statusFilter !== "all" ? `&status=${encodeURIComponent(statusFilter)}` : ""
  }`;
  const q = useQuery<PaginatedResponse<AdminRequestRow>>({
    queryKey: [requestsUrl],
  });
  const totalPages = q.data ? Math.max(1, Math.ceil(q.data.total / limit)) : 1;

  const revokeMut = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason: string }) => {
      const res = await apiRequest(
        "POST",
        `/api/admin/fee-consent-requests/${id}/revoke`,
        { reason: reason || null },
      );
      return res.json();
    },
    onSuccess: () => {
      invalidateAdminFeeConsentLists();
      toast({ title: "Request revoked" });
      setRevokingId(null);
      setRevokeReason("");
    },
    onError: (err: Error) => {
      toast({ title: "Revoke failed", description: err.message, variant: "destructive" });
    },
  });

  const supersedeMut = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason: string }) => {
      const res = await apiRequest(
        "POST",
        `/api/admin/fee-consents/${id}/supersede`,
        { reason },
      );
      return res.json();
    },
    onSuccess: () => {
      invalidateAdminFeeConsentLists();
      toast({
        title: "Consent superseded",
        description: "A fresh pending request has been created.",
      });
      setSupersedingConsentId(null);
      setSupersedeReason("");
    },
    onError: (err: Error) => {
      toast({ title: "Supersede failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Fee consent requests</CardTitle>
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-56" data-testid="select-admin-request-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REQUEST_STATUSES.map((s) => (
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
          <p className="text-sm text-red-600">Unable to load requests.</p>
        ) : !q.data || q.data.items.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="text-no-admin-requests">
            No fee consent requests.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Created</TableHead>
                    <TableHead>Adviser</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Advice</TableHead>
                    <TableHead>Fee type</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Frequency</TableHead>
                    <TableHead>Reference day</TableHead>
                    <TableHead>Renewal window</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {q.data.items.map((r) => (
                    <TableRow key={r.id} data-testid={`row-admin-request-${r.id}`}>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatDate(r.createdAt)}
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.adviserUsername ?? `#${r.adviserUserId}`}
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.clientUsername ?? `#${r.clientUserId}`}
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.adviceRecordId ? (
                          `#${r.adviceRecordId}`
                        ) : (
                          <span
                            className="text-amber-700"
                            data-testid={`legacy-no-advice-${r.id}`}
                          >
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm capitalize">
                        {formatFeeType(r.feeType)}
                        <div className="text-xs text-gray-500 capitalize">
                          {formatFeeType(r.amountType)}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm tabular-nums text-right">
                        {formatAmount(r.amountType, r.amount)}
                      </TableCell>
                      <TableCell className="text-sm capitalize">
                        {r.deductionFrequency}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatDate(r.proposedReferenceDay)}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap text-slate-600">
                        {formatDate(r.proposedRenewalWindowStart)} →{" "}
                        {formatDate(r.proposedRenewalWindowEnd)}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatDate(r.proposedConsentExpiryDate)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          {statusBadge(r.status)}
                          <BlockedReasonBanner reason={r.deductionsBlockedReason} />
                        </div>
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <div className="inline-flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            title="View"
                            onClick={() => setViewing(r)}
                            data-testid={`button-view-request-${r.id}`}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Download PDF"
                            onClick={() => downloadRequestPdf(r.id)}
                            data-testid={`button-download-request-${r.id}`}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                          {/* Revoke is only valid for adviser-issued
                              pending requests. Admin-generated supersede
                              requests carry a non-null supersedesRequestId
                              and must be unwound via the original consent
                              instead. */}
                          {r.status === "pending" && r.supersedesRequestId === null && (
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Revoke"
                              onClick={() => {
                                setRevokingId(r.id);
                                setRevokeReason("");
                              }}
                              data-testid={`button-revoke-${r.id}`}
                            >
                              <Ban className="h-3.5 w-3.5 text-red-600" />
                            </Button>
                          )}
                          {r.status === "consented" && r.signedFeeConsentId && (
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Supersede"
                              onClick={() => {
                                setSupersedingConsentId(r.signedFeeConsentId);
                                setSupersedeReason("");
                              }}
                              data-testid={`button-supersede-request-${r.id}`}
                            >
                              <Repeat className="h-3.5 w-3.5 text-amber-600" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Audit log"
                            onClick={() => setAuditingId(r.id)}
                            data-testid={`button-audit-request-${r.id}`}
                          >
                            <ScrollText className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 text-sm">
                <span className="text-gray-500">
                  Page {q.data.page} of {totalPages} ({q.data.total} total)
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    data-testid="button-admin-req-prev"
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => p + 1)}
                    data-testid="button-admin-req-next"
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>

      <Sheet open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <SheetContent
          className="w-full sm:max-w-xl overflow-y-auto"
          data-testid="sheet-request-view"
        >
          <SheetHeader>
            <SheetTitle>
              Fee consent request #{viewing?.id} —{" "}
              {viewing && statusBadge(viewing.status)}
            </SheetTitle>
          </SheetHeader>
          {viewing && (
            <div className="mt-4 space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-slate-500 text-xs">Adviser</div>
                  <div>{viewing.adviserUsername ?? `#${viewing.adviserUserId}`}</div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs">Client</div>
                  <div>{viewing.clientUsername ?? `#${viewing.clientUserId}`}</div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs">Linked advice record</div>
                  <div>
                    {viewing.adviceRecordId ? `#${viewing.adviceRecordId}` : "— (legacy)"}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs">Account</div>
                  <div>{viewing.accountNumber}</div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs">Fee</div>
                  <div className="capitalize">
                    {formatFeeType(viewing.feeType)} ·{" "}
                    {formatAmount(viewing.amountType, viewing.amount)} ·{" "}
                    {viewing.deductionFrequency}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs">Reference day</div>
                  <div>{formatDate(viewing.proposedReferenceDay)}</div>
                </div>
                <div className="col-span-2">
                  <div className="text-slate-500 text-xs">Renewal window</div>
                  <div className="flex items-center gap-1">
                    <Clock className="h-3 w-3 text-slate-400" />
                    {formatDate(viewing.proposedRenewalWindowStart)} →{" "}
                    {formatDate(viewing.proposedRenewalWindowEnd)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs">Expiry</div>
                  <div>{formatDate(viewing.proposedConsentExpiryDate)}</div>
                </div>
                {viewing.supersedesRequestId && (
                  <div>
                    <div className="text-slate-500 text-xs">Supersedes</div>
                    <button
                      type="button"
                      className="text-blue-700 hover:underline"
                      data-testid={`link-view-supersedes-${viewing.id}`}
                      onClick={() => {
                        const target = viewing.supersedesRequestId;
                        setViewing(null);
                        if (target) {
                          window.setTimeout(
                            () =>
                              jumpToRow(
                                `row-admin-request-${target}`,
                                `Request #${target}`,
                                toast,
                              ),
                            200,
                          );
                        }
                      }}
                    >
                      request #{viewing.supersedesRequestId}
                    </button>
                  </div>
                )}
              </div>
              <BlockedReasonBanner reason={viewing.deductionsBlockedReason} />

              <div>
                <h4 className="text-sm font-medium flex items-center gap-1">
                  <History className="h-4 w-4" /> Audit trail
                </h4>
                <div className="mt-2">
                  <AuditTimeline
                    entityType="fee_consent_request"
                    entityId={viewing.id}
                    enabled
                  />
                </div>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={revokingId !== null} onOpenChange={(o) => !o && setRevokingId(null)}>
        <AlertDialogContent data-testid="dialog-revoke-request">
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this pending request?</AlertDialogTitle>
            <AlertDialogDescription>
              The client will no longer be able to sign request #{revokingId}. This is
              recorded in the audit log as <code>revokedByAdmin: true</code>. No money
              moves either way.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            placeholder="Reason (shown on the audit row)"
            value={revokeReason}
            onChange={(e) => setRevokeReason(e.target.value)}
            data-testid="input-revoke-reason"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (revokingId !== null) {
                  revokeMut.mutate({ id: revokingId, reason: revokeReason });
                }
              }}
              data-testid="button-confirm-revoke"
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={supersedingConsentId !== null}
        onOpenChange={(o) => !o && setSupersedingConsentId(null)}
      >
        <AlertDialogContent data-testid="dialog-supersede-from-request">
          <AlertDialogHeader>
            <AlertDialogTitle>Supersede this consent?</AlertDialogTitle>
            <AlertDialogDescription>
              The signed consent will be marked superseded and a fresh pending
              request will be created mirroring the same terms. The client will
              need to re-sign. No money moves either way.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            placeholder="Reason (shown on the audit row, required)"
            value={supersedeReason}
            onChange={(e) => setSupersedeReason(e.target.value)}
            data-testid="input-supersede-reason-from-request"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!supersedeReason.trim()}
              onClick={() => {
                if (supersedingConsentId !== null) {
                  supersedeMut.mutate({
                    id: supersedingConsentId,
                    reason: supersedeReason.trim(),
                  });
                }
              }}
              data-testid="button-confirm-supersede-from-request"
            >
              Supersede
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={auditingId !== null} onOpenChange={(o) => !o && setAuditingId(null)}>
        <DialogContent
          className="max-w-2xl max-h-[80vh] overflow-y-auto"
          data-testid="dialog-audit-request"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ScrollText className="h-4 w-4" /> Audit log — request #{auditingId}
            </DialogTitle>
          </DialogHeader>
          {auditingId !== null && (
            <AuditTimeline
              entityType="fee_consent_request"
              entityId={auditingId}
              enabled={true}
            />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function LiveTab() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const limit = 50;
  const [viewing, setViewing] = useState<AdminLiveRow | null>(null);
  const [supersedingId, setSupersedingId] = useState<number | null>(null);
  const [supersedeReason, setSupersedeReason] = useState("");
  const [auditingId, setAuditingId] = useState<number | null>(null);

  const liveUrl = `/api/admin/fee-consents?page=${page}&limit=${limit}${
    statusFilter !== "all" ? `&status=${encodeURIComponent(statusFilter)}` : ""
  }`;
  const q = useQuery<PaginatedResponse<AdminLiveRow>>({
    queryKey: [liveUrl],
  });
  const totalPages = q.data ? Math.max(1, Math.ceil(q.data.total / limit)) : 1;

  const supersedeMut = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason: string }) => {
      const res = await apiRequest(
        "POST",
        `/api/admin/fee-consents/${id}/supersede`,
        { reason },
      );
      return res.json();
    },
    onSuccess: () => {
      invalidateAdminFeeConsentLists();
      toast({
        title: "Consent superseded",
        description: "A fresh pending request has been created.",
      });
      setSupersedingId(null);
      setSupersedeReason("");
    },
    onError: (err: Error) => {
      toast({ title: "Supersede failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Live fee consents</CardTitle>
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-56" data-testid="select-admin-renewal-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RENEWAL_STATUSES.map((s) => (
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
          <p className="text-sm text-red-600">Unable to load consents.</p>
        ) : !q.data || q.data.items.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="text-no-admin-fee-consents">
            No live fee consents.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Signed</TableHead>
                    <TableHead>Adviser</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Advice</TableHead>
                    <TableHead>Fee type</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Frequency</TableHead>
                    <TableHead>Reference day</TableHead>
                    <TableHead>Renewal window</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead>Signed by</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {q.data.items.map((c) => (
                    <TableRow key={c.id} data-testid={`row-admin-live-${c.id}`}>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatDate(c.consentedAt)}
                      </TableCell>
                      <TableCell className="text-sm">
                        {c.adviserUsername ?? `#${c.adviserId}`}
                      </TableCell>
                      <TableCell className="text-sm">
                        {c.clientUsername ?? `#${c.clientId}`}
                      </TableCell>
                      <TableCell className="text-sm">#{c.adviceRecordId}</TableCell>
                      <TableCell className="text-sm capitalize">
                        {formatFeeType(c.feeType)}
                      </TableCell>
                      <TableCell className="text-sm tabular-nums text-right">
                        {formatAmount(c.amountType, c.amount)}
                      </TableCell>
                      <TableCell className="text-sm capitalize">
                        {c.deductionFrequency}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatDate(c.referenceDay)}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap text-slate-600">
                        {formatDate(c.renewalWindowStart)} →{" "}
                        {formatDate(c.renewalWindowEnd)}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatDate(c.consentExpiryDate)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {c.clientSignatureName ?? "—"}
                        <div className="text-[11px] text-slate-500">
                          IP {c.signedIp ?? "—"}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          {statusBadge(c.renewalStatus)}
                          <BlockedReasonBanner reason={c.deductionsBlockedReason} />
                          {c.supersededByRequestId && (
                            <button
                              type="button"
                              className="text-[11px] text-blue-700 hover:underline text-left"
                              data-testid={`link-superseded-by-${c.id}`}
                              onClick={() =>
                                jumpToRow(
                                  `row-admin-request-${c.supersededByRequestId}`,
                                  `Request #${c.supersededByRequestId}`,
                                  toast,
                                )
                              }
                            >
                              Superseded by → request #{c.supersededByRequestId}
                            </button>
                          )}
                          {c.supersedesRequestId && (
                            <button
                              type="button"
                              className="text-[11px] text-blue-700 hover:underline text-left"
                              data-testid={`link-supersedes-${c.id}`}
                              onClick={() =>
                                jumpToRow(
                                  `row-admin-request-${c.supersedesRequestId}`,
                                  `Request #${c.supersedesRequestId}`,
                                  toast,
                                )
                              }
                            >
                              Supersedes → request #{c.supersedesRequestId}
                            </button>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <div className="inline-flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            title="View"
                            onClick={() => setViewing(c)}
                            data-testid={`button-view-consent-${c.id}`}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Download PDF"
                            onClick={() => downloadConsentPdf(c.id)}
                            data-testid={`button-download-consent-${c.id}`}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                          {(c.renewalStatus === "active" ||
                            c.renewalStatus === "renewal_due") && (
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Supersede"
                              onClick={() => {
                                setSupersedingId(c.id);
                                setSupersedeReason("");
                              }}
                              data-testid={`button-supersede-${c.id}`}
                            >
                              <Repeat className="h-3.5 w-3.5 text-amber-600" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Audit log"
                            onClick={() => setAuditingId(c.id)}
                            data-testid={`button-audit-consent-${c.id}`}
                          >
                            <ScrollText className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 text-sm">
                <span className="text-gray-500">
                  Page {q.data.page} of {totalPages} ({q.data.total} total)
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    data-testid="button-admin-live-prev"
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => p + 1)}
                    data-testid="button-admin-live-next"
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>

      <Sheet open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <SheetContent
          className="w-full sm:max-w-xl overflow-y-auto"
          data-testid="sheet-consent-view"
        >
          <SheetHeader>
            <SheetTitle>
              Fee consent #{viewing?.id} —{" "}
              {viewing && statusBadge(viewing.renewalStatus)}
            </SheetTitle>
          </SheetHeader>
          {viewing && (
            <div className="mt-4 space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-slate-500 text-xs">Adviser</div>
                  <div>{viewing.adviserUsername ?? `#${viewing.adviserId}`}</div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs">Client</div>
                  <div>{viewing.clientUsername ?? `#${viewing.clientId}`}</div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs">Linked advice record</div>
                  <div>#{viewing.adviceRecordId}</div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs">Account</div>
                  <div>
                    {viewing.accountNumber}
                    {viewing.accountName && (
                      <span className="text-slate-500"> — {viewing.accountName}</span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs">Fee</div>
                  <div className="capitalize">
                    {formatFeeType(viewing.feeType)} ·{" "}
                    {formatAmount(viewing.amountType, viewing.amount)} ·{" "}
                    {viewing.deductionFrequency}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs">Reference day</div>
                  <div>{formatDate(viewing.referenceDay)}</div>
                </div>
                <div className="col-span-2">
                  <div className="text-slate-500 text-xs">Renewal window</div>
                  <div className="flex items-center gap-1">
                    <Clock className="h-3 w-3 text-slate-400" />
                    {formatDate(viewing.renewalWindowStart)} →{" "}
                    {formatDate(viewing.renewalWindowEnd)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs">Expiry</div>
                  <div>{formatDate(viewing.consentExpiryDate)}</div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs">Signed</div>
                  <div>
                    {formatDateTime(viewing.consentedAt)}
                    <div className="text-[11px] text-slate-500">
                      by {viewing.clientSignatureName ?? "—"} from IP{" "}
                      {viewing.signedIp ?? "—"}
                    </div>
                  </div>
                </div>
                {viewing.supersededByRequestId && (
                  <div>
                    <div className="text-slate-500 text-xs">Superseded by</div>
                    <button
                      type="button"
                      className="text-blue-700 hover:underline"
                      data-testid={`link-view-superseded-by-${viewing.id}`}
                      onClick={() => {
                        const target = viewing.supersededByRequestId;
                        setViewing(null);
                        if (target) {
                          window.setTimeout(
                            () =>
                              jumpToRow(
                                `row-admin-request-${target}`,
                                `Request #${target}`,
                                toast,
                              ),
                            200,
                          );
                        }
                      }}
                    >
                      request #{viewing.supersededByRequestId}
                    </button>
                    {viewing.supersededReason && (
                      <div className="text-[11px] text-slate-500">
                        {viewing.supersededReason}
                      </div>
                    )}
                  </div>
                )}
                {viewing.supersedesRequestId && (
                  <div>
                    <div className="text-slate-500 text-xs">Supersedes</div>
                    <button
                      type="button"
                      className="text-blue-700 hover:underline"
                      data-testid={`link-view-supersedes-consent-${viewing.id}`}
                      onClick={() => {
                        const target = viewing.supersedesRequestId;
                        setViewing(null);
                        if (target) {
                          window.setTimeout(
                            () =>
                              jumpToRow(
                                `row-admin-request-${target}`,
                                `Request #${target}`,
                                toast,
                              ),
                            200,
                          );
                        }
                      }}
                    >
                      request #{viewing.supersedesRequestId}
                    </button>
                  </div>
                )}
              </div>
              <BlockedReasonBanner reason={viewing.deductionsBlockedReason} />

              <div>
                <h4 className="text-sm font-medium flex items-center gap-1">
                  <History className="h-4 w-4" /> Audit trail
                </h4>
                <div className="mt-2">
                  <AuditTimeline
                    entityType="fee_consent"
                    entityId={viewing.id}
                    enabled
                  />
                </div>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={supersedingId !== null}
        onOpenChange={(o) => !o && setSupersedingId(null)}
      >
        <AlertDialogContent data-testid="dialog-supersede-consent">
          <AlertDialogHeader>
            <AlertDialogTitle>Supersede this consent?</AlertDialogTitle>
            <AlertDialogDescription>
              Consent #{supersedingId} will be marked <code>superseded</code>. A fresh
              pending request will be created with the same terms — the client must
              sign it for it to become live. No money moves either way.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            placeholder="Reason (required, recorded in audit log)"
            value={supersedeReason}
            onChange={(e) => setSupersedeReason(e.target.value)}
            data-testid="input-supersede-reason"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={supersedeReason.trim().length < 3}
              onClick={() => {
                if (supersedingId !== null) {
                  supersedeMut.mutate({
                    id: supersedingId,
                    reason: supersedeReason.trim(),
                  });
                }
              }}
              data-testid="button-confirm-supersede"
            >
              Supersede
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={auditingId !== null} onOpenChange={(o) => !o && setAuditingId(null)}>
        <DialogContent
          className="max-w-2xl max-h-[80vh] overflow-y-auto"
          data-testid="dialog-audit-consent"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ScrollText className="h-4 w-4" /> Audit log — consent #{auditingId}
            </DialogTitle>
          </DialogHeader>
          {auditingId !== null && (
            <AuditTimeline
              entityType="fee_consent"
              entityId={auditingId}
              enabled={true}
            />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function AdminFeeConsents() {
  return (
    <div className="max-w-7xl space-y-6" data-testid="page-admin-fee-consents">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900">Fee consents</h1>
        <p className="text-sm text-slate-500">
          Oversee adviser-issued fee consent requests and recorded consent outcomes.
        </p>
      </div>

      <div
        className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700"
        data-testid="fee-consent-hardening-notice"
      >
        <ShieldAlert className="h-4 w-4 text-slate-600 flex-shrink-0 mt-0.5" />
        <p>
          <span className="font-medium">No money will be moved by these consents.</span>{" "}
          AMAX requires separate admin-approved deduction controls (currently disabled).
          This page is read-only oversight of DBFO requests and signed consents.
        </p>
      </div>

      <Tabs defaultValue="requests" className="space-y-4">
        <div className="flex flex-wrap items-end justify-start gap-3">
          <TabsList>
            <TabsTrigger value="requests" data-testid="tab-admin-fee-consent-requests">
              Requests
            </TabsTrigger>
            <TabsTrigger value="live" data-testid="tab-admin-fee-consents-live">
              Live consents
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="requests">
          <RequestsTab />
        </TabsContent>
        <TabsContent value="live">
          <LiveTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
