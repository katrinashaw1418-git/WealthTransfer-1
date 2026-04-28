import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { queryClient, apiRequest, apiFetch } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Receipt, ShieldAlert, AlertTriangle, Clock, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Task #300 — client-side rows now carry the same supersede chain links,
// renewal-window dates, and server-computed `deductionsBlockedReason` the
// admin oversight surface uses. The UI never recomputes — it just renders
// what the server returned so a client and an admin can never disagree
// about why a consent isn't live.
interface ClientFeeConsentRequestRow {
  id: number;
  adviserUserId: number;
  clientUserId: number;
  adviceRecordId: number | null;
  feeType: string;
  amountType: string;
  amount: string | null;
  calculationMethod: string | null;
  accountNumber: string;
  accountName: string | null;
  deductionFrequency: string;
  proposedReferenceDay: string;
  proposedRenewalWindowStart: string;
  proposedRenewalWindowEnd: string;
  proposedConsentExpiryDate: string;
  requestNote: string | null;
  status: string;
  declineReason: string | null;
  signedFeeConsentId: number | null;
  supersedesRequestId: number | null;
  respondedAt: string | null;
  createdAt: string;
  deductionsBlockedReason: string | null;
}

interface ClientFeeConsentRow {
  id: number;
  adviceRecordId: number;
  clientId: number;
  adviserId: number;
  feeType: string;
  amountType: string;
  amount: string | null;
  calculationMethod: string | null;
  accountNumber: string;
  accountName: string | null;
  deductionFrequency: string;
  referenceDay: string;
  renewalWindowStart: string;
  renewalWindowEnd: string;
  consentExpiryDate: string;
  renewalStatus: string;
  clientSignatureName: string | null;
  consentedAt: string;
  withdrawnAt: string | null;
  supersededByRequestId: number | null;
  supersededAt: string | null;
  supersededReason: string | null;
  supersedesRequestId: number | null;
  deductionsBlockedReason: string | null;
}

const signSchema = z.object({
  signatureName: z.string().min(2, "Type your full name to sign").max(200),
});
type SignForm = z.infer<typeof signSchema>;

const declineSchema = z.object({
  reason: z.string().max(2000).optional(),
});
type DeclineForm = z.infer<typeof declineSchema>;

function statusBadge(status: string) {
  // Task #300 — pending must read as "Sent — pending client signature" to
  // match the admin surface. The previous wording made it ambiguous about
  // who needed to act next.
  const map: Record<string, { variant: "default" | "secondary" | "outline" | "destructive"; label: string }> = {
    pending: { variant: "secondary", label: "Sent — pending client signature" },
    consented: { variant: "default", label: "You signed" },
    declined: { variant: "destructive", label: "You declined" },
    withdrawn_by_adviser: { variant: "outline", label: "Adviser withdrew" },
    superseded: { variant: "outline", label: "Superseded" },
  };
  const e = map[status] ?? { variant: "outline" as const, label: status };
  return <Badge variant={e.variant}>{e.label}</Badge>;
}

function renewalBadge(status: string) {
  const map: Record<string, { variant: "default" | "secondary" | "outline" | "destructive"; label: string }> = {
    active: { variant: "default", label: "Active" },
    renewal_due: { variant: "secondary", label: "Renewal due" },
    expired: { variant: "destructive", label: "Expired" },
    withdrawn: { variant: "outline", label: "Withdrawn" },
    superseded: { variant: "outline", label: "Superseded" },
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

function daysUntil(value: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime() - Date.now();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function formatFeeType(t: string): string {
  return t.replace(/_/g, " ");
}

// Task #343 — authenticated PDF download. The new client endpoints sit
// behind the same JWT gate as every other /api/client route, so we can't
// just window.open() the URL — the browser won't attach the Authorization
// header from localStorage. Mirrors the helper used by the admin surface
// (see client/src/pages/admin/fee-consents.tsx) so both downloads behave
// identically: fetch the bytes, build a transient blob URL, click an
// invisible <a download>, then revoke.
async function downloadPdf(url: string, filename: string): Promise<void> {
  const res = await apiFetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`);
  }
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
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }
}

// Task #300 — same mapping the admin page uses. Keeping it here verbatim
// means the two surfaces always describe the same condition with the same
// words.
function blockedReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  switch (reason) {
    case "expired":
      return "Consent expired — deductions blocked";
    case "pending":
      return "Consent pending — deductions blocked";
    case "no_advice_record":
      return "No linked advice record — cannot sign";
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

// Task #300 — supersede-chain links: scroll to and briefly highlight the
// matching row when it's on the same page. Mirrors the admin helper so the
// behaviour is identical between surfaces.
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
    description: "Scroll the other table or check back later to find it.",
  });
}

export default function ClientFeeConsents() {
  const { toast } = useToast();
  const [signTarget, setSignTarget] = useState<ClientFeeConsentRequestRow | null>(null);
  const [declineTarget, setDeclineTarget] = useState<ClientFeeConsentRequestRow | null>(null);

  const requests = useQuery<ClientFeeConsentRequestRow[]>({
    queryKey: ["/api/client/fee-consent-requests"],
  });
  const live = useQuery<ClientFeeConsentRow[]>({ queryKey: ["/api/client/fee-consents"] });

  const signForm = useForm<SignForm>({
    resolver: zodResolver(signSchema),
    defaultValues: { signatureName: "" },
  });
  const declineForm = useForm<DeclineForm>({
    resolver: zodResolver(declineSchema),
    defaultValues: { reason: "" },
  });

  const signMut = useMutation({
    mutationFn: async (vars: { id: number; values: SignForm }) => {
      const res = await apiRequest(
        "POST",
        `/api/client/fee-consent-requests/${vars.id}/sign`,
        vars.values,
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/client/fee-consent-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/client/fee-consents"] });
      toast({
        title: "Consent signed",
        description:
          "Your signature has been recorded. No money will be moved by this consent — AMAX requires separate admin-approved deduction controls (currently disabled).",
      });
      setSignTarget(null);
      signForm.reset();
    },
    onError: (err: Error) => {
      toast({ title: "Sign failed", description: err.message, variant: "destructive" });
    },
  });

  const declineMut = useMutation({
    mutationFn: async (vars: { id: number; values: DeclineForm }) => {
      const res = await apiRequest(
        "POST",
        `/api/client/fee-consent-requests/${vars.id}/decline`,
        vars.values,
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/client/fee-consent-requests"] });
      toast({ title: "Request declined" });
      setDeclineTarget(null);
      declineForm.reset();
    },
    onError: (err: Error) => {
      toast({ title: "Decline failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="p-6 space-y-6" data-testid="page-client-fee-consents">
      <div
        className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700"
        data-testid="fee-consent-hardening-notice"
      >
        <ShieldAlert className="h-4 w-4 text-slate-600 flex-shrink-0 mt-0.5" />
        <p>
          <span className="font-medium">No money will be moved by this consent.</span> AMAX requires
          separate admin-approved deduction controls (currently disabled). Signing only authorises
          the fee terms — no charge is taken from your account here.
        </p>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Receipt className="h-6 w-6 text-emerald-600" />
          Adviser fee consents
        </h1>
        <p className="text-sm text-gray-500 mt-1 max-w-2xl">
          Review fee consent requests sent by your adviser. You can sign or decline each one.
          Signed consents and their renewal status are listed below.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pending requests</CardTitle>
        </CardHeader>
        <CardContent>
          {requests.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : requests.isError ? (
            <p className="text-sm text-red-600">Unable to load requests.</p>
          ) : !requests.data || requests.data.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="text-no-client-requests">
              No fee consent requests at the moment.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Sent</TableHead>
                    <TableHead>Fee type</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Frequency</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Renewal window</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests.data.map((r) => (
                    <TableRow key={r.id} data-testid={`row-client-fee-consent-request-${r.id}`}>
                      <TableCell className="text-sm">{formatDate(r.createdAt)}</TableCell>
                      <TableCell className="text-sm capitalize">
                        {formatFeeType(r.feeType)}
                        {r.requestNote && (
                          <div className="text-xs text-gray-500 mt-1">{r.requestNote}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm tabular-nums text-right">
                        {r.amountType === "calculation_method"
                          ? r.calculationMethod ?? "Calc method"
                          : r.amountType === "percentage"
                            ? `${(Number(r.amount ?? 0) * 100).toFixed(4)}%`
                            : formatAud(r.amount)}
                      </TableCell>
                      <TableCell className="text-sm capitalize">{r.deductionFrequency}</TableCell>
                      <TableCell className="text-sm">
                        {r.accountNumber}
                        {r.accountName && (
                          <div className="text-xs text-gray-500">{r.accountName}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap text-slate-600">
                        <div className="flex items-center gap-1">
                          <Clock className="h-3 w-3 text-slate-400" />
                          {formatDate(r.proposedRenewalWindowStart)} →{" "}
                          {formatDate(r.proposedRenewalWindowEnd)}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {formatDate(r.proposedConsentExpiryDate)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          {statusBadge(r.status)}
                          <BlockedReasonBanner reason={r.deductionsBlockedReason} />
                          {r.supersedesRequestId && (
                            <button
                              type="button"
                              className="text-[11px] text-blue-700 hover:underline text-left"
                              data-testid={`link-client-supersedes-request-${r.id}`}
                              onClick={() =>
                                jumpToRow(
                                  `row-client-fee-consent-request-${r.supersedesRequestId}`,
                                  `Request #${r.supersedesRequestId}`,
                                  toast,
                                )
                              }
                            >
                              Supersedes → request #{r.supersedesRequestId}
                            </button>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex gap-2 justify-end">
                          {r.status === "pending" ? (
                            <>
                              <Button
                                size="sm"
                                onClick={() => {
                                  setSignTarget(r);
                                  signForm.reset({ signatureName: "" });
                                }}
                                data-testid={`button-sign-${r.id}`}
                              >
                                Sign
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setDeclineTarget(r);
                                  declineForm.reset({ reason: "" });
                                }}
                                data-testid={`button-decline-${r.id}`}
                              >
                                Decline
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                downloadPdf(
                                  `/api/client/fee-consent-requests/${r.id}/pdf`,
                                  `fee-consent-request-${r.id}.pdf`,
                                ).catch((err: Error) =>
                                  toast({
                                    title: "Download failed",
                                    description: err.message,
                                    variant: "destructive",
                                  }),
                                )
                              }
                              data-testid={`button-download-request-${r.id}`}
                            >
                              <Download className="h-3 w-3 mr-1" />
                              PDF
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active fee consents</CardTitle>
        </CardHeader>
        <CardContent>
          {live.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : live.isError ? (
            <p className="text-sm text-red-600">Unable to load consents.</p>
          ) : !live.data || live.data.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="text-no-client-fee-consents">
              You haven't signed any fee consents yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Signed</TableHead>
                    <TableHead>Fee type</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Frequency</TableHead>
                    <TableHead>Renewal window</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {live.data.map((c) => {
                    const dleft = daysUntil(c.consentExpiryDate);
                    return (
                      <TableRow key={c.id} data-testid={`row-client-fee-consent-${c.id}`}>
                        <TableCell className="text-sm">{formatDate(c.consentedAt)}</TableCell>
                        <TableCell className="text-sm capitalize">
                          {formatFeeType(c.feeType)}
                          {c.accountName && (
                            <div className="text-xs text-gray-500">{c.accountName}</div>
                          )}
                        </TableCell>
                        <TableCell className="text-sm tabular-nums text-right">
                          {c.amountType === "calculation_method"
                            ? c.calculationMethod ?? "Calc method"
                            : c.amountType === "percentage"
                              ? `${(Number(c.amount ?? 0) * 100).toFixed(4)}%`
                              : formatAud(c.amount)}
                        </TableCell>
                        <TableCell className="text-sm capitalize">{c.deductionFrequency}</TableCell>
                        <TableCell className="text-xs whitespace-nowrap text-slate-600">
                          <div className="flex items-center gap-1">
                            <Clock className="h-3 w-3 text-slate-400" />
                            {formatDate(c.renewalWindowStart)} →{" "}
                            {formatDate(c.renewalWindowEnd)}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">
                          {formatDate(c.consentExpiryDate)}
                          {dleft !== null && c.renewalStatus !== "expired" && (
                            <div className="text-xs text-gray-500">
                              {dleft >= 0 ? `in ${dleft} days` : `${Math.abs(dleft)} days ago`}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            {renewalBadge(c.renewalStatus)}
                            <BlockedReasonBanner reason={c.deductionsBlockedReason} />
                            {c.supersededByRequestId && (
                              <button
                                type="button"
                                className="text-[11px] text-blue-700 hover:underline text-left"
                                data-testid={`link-client-superseded-by-${c.id}`}
                                onClick={() =>
                                  jumpToRow(
                                    `row-client-fee-consent-request-${c.supersededByRequestId}`,
                                    `Request #${c.supersededByRequestId}`,
                                    toast,
                                  )
                                }
                              >
                                Superseded by → request #{c.supersededByRequestId}
                              </button>
                            )}
                            {c.supersededReason && (
                              <div className="text-[11px] text-slate-500">
                                {c.supersededReason}
                              </div>
                            )}
                            {c.supersedesRequestId && (
                              <button
                                type="button"
                                className="text-[11px] text-blue-700 hover:underline text-left"
                                data-testid={`link-client-supersedes-consent-${c.id}`}
                                onClick={() =>
                                  jumpToRow(
                                    `row-client-fee-consent-request-${c.supersedesRequestId}`,
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
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              downloadPdf(
                                `/api/client/fee-consents/${c.id}/pdf`,
                                `fee-consent-${c.id}.pdf`,
                              ).catch((err: Error) =>
                                toast({
                                  title: "Download failed",
                                  description: err.message,
                                  variant: "destructive",
                                }),
                              )
                            }
                            data-testid={`button-download-consent-${c.id}`}
                          >
                            <Download className="h-3 w-3 mr-1" />
                            PDF
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sign dialog */}
      <Dialog open={!!signTarget} onOpenChange={(o) => !o && setSignTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign fee consent</DialogTitle>
          </DialogHeader>
          {signTarget && (
            <div className="space-y-3 text-sm">
              <div className="rounded-md bg-slate-50 border border-slate-200 p-3 text-xs text-slate-700">
                <div>
                  <span className="font-medium capitalize">{formatFeeType(signTarget.feeType)}</span>{" "}
                  •{" "}
                  {signTarget.amountType === "calculation_method"
                    ? signTarget.calculationMethod
                    : signTarget.amountType === "percentage"
                      ? `${(Number(signTarget.amount ?? 0) * 100).toFixed(4)}% per ${signTarget.deductionFrequency}`
                      : `${formatAud(signTarget.amount)} per ${signTarget.deductionFrequency}`}
                </div>
                <div className="mt-1">
                  Account: {signTarget.accountNumber} • Expires{" "}
                  {formatDate(signTarget.proposedConsentExpiryDate)}
                </div>
                <div className="mt-1 flex items-center gap-1">
                  <Clock className="h-3 w-3 text-slate-400" />
                  Renewal window: {formatDate(signTarget.proposedRenewalWindowStart)} →{" "}
                  {formatDate(signTarget.proposedRenewalWindowEnd)}
                </div>
              </div>
              <Form {...signForm}>
                <form
                  onSubmit={signForm.handleSubmit((v) =>
                    signMut.mutate({ id: signTarget.id, values: v }),
                  )}
                  className="space-y-3"
                >
                  <FormField
                    control={signForm.control}
                    name="signatureName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Type your full name to sign</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Your full legal name"
                            data-testid="input-signature-name"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900 flex gap-2">
                    <ShieldAlert className="h-4 w-4 flex-shrink-0 mt-0.5" />
                    <span>
                      Signing only records your authorisation. No money will be moved by this
                      consent — AMAX requires separate admin-approved deduction controls
                      (currently disabled).
                    </span>
                  </div>
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={signMut.isPending}
                    data-testid="button-confirm-sign"
                  >
                    {signMut.isPending ? "Signing..." : "Sign consent"}
                  </Button>
                </form>
              </Form>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Decline dialog */}
      <Dialog open={!!declineTarget} onOpenChange={(o) => !o && setDeclineTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline fee consent</DialogTitle>
          </DialogHeader>
          {declineTarget && (
            <Form {...declineForm}>
              <form
                onSubmit={declineForm.handleSubmit((v) =>
                  declineMut.mutate({ id: declineTarget.id, values: v }),
                )}
                className="space-y-3"
              >
                <FormField
                  control={declineForm.control}
                  name="reason"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Reason (optional)</FormLabel>
                      <FormControl>
                        <Textarea
                          rows={3}
                          placeholder="Tell your adviser why."
                          data-testid="input-decline-reason"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  variant="destructive"
                  className="w-full"
                  disabled={declineMut.isPending}
                  data-testid="button-confirm-decline"
                >
                  {declineMut.isPending ? "Declining..." : "Decline consent"}
                </Button>
              </form>
            </Form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
