import { useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { clientDisplayName } from "@shared/display-name";
import { queryClient, apiRequest } from "@/lib/queryClient";
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
  DialogTrigger,
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
import { Plus, Receipt, ShieldAlert, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  consentRequestDisplayStatus,
  consentStatusBadgeVariant,
  consentStatusLabel,
} from "@/lib/consent-status";

interface FeeConsentRequestRow {
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
  respondedAt: string | null;
  createdAt: string;
}

interface ListResponse {
  items: FeeConsentRequestRow[];
  page: number;
  limit: number;
  total: number;
}

interface ClientLite {
  userId: number;
  firstName: string;
  lastName: string;
  email: string;
  activeFeeConsents?: number;
  feeConsentExpiringAt?: string | null;
}

interface AdviceRecordLite {
  id: number;
  adviceType: string;
  status: string;
  createdAt: string;
}

interface ClientDetailResponse {
  client: { id: number };
  feeConsents: any[];
  adviceRecords: AdviceRecordLite[];
}

const FEE_TYPES = [
  { value: "ongoing_service_fee", label: "Ongoing service fee" },
  { value: "advice_fee", label: "Advice fee" },
  { value: "platform_fee", label: "Platform fee" },
];

const AMOUNT_TYPES = [
  { value: "fixed", label: "Fixed dollar amount" },
  { value: "percentage", label: "Percentage of FUM" },
  { value: "calculation_method", label: "Calculation method (no fixed $)" },
];

const FREQUENCIES = [
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "annually", label: "Annually" },
];

// Task #471 — filter values still target the underlying DB enum so the
// Filter dropdown uses the canonical six-term display vocabulary. The
// "revoked" sentinel value is translated server-side into an `inArray` over
// the two terminal DB enums (`declined`, `withdrawn_by_adviser`) — the
// adviser surface intentionally exposes only the canonical term.
const STATUSES = [
  { value: "all", label: "All statuses" },
  { value: "pending", label: "Pending signature" },
  { value: "consented", label: "Active" },
  { value: "revoked", label: "Revoked" },
  { value: "superseded", label: "Superseded" },
];

const RENEWAL_BEFORE_DAYS = 60;
const RENEWAL_AFTER_DAYS = 150;

const createSchema = z
  .object({
    clientUserId: z.coerce.number().int().positive("Select a client"),
    adviceRecordId: z.coerce.number().int().positive("Select the advice record this consent attaches to"),
    feeType: z.enum(["ongoing_service_fee", "advice_fee", "platform_fee"]),
    amountType: z.enum(["fixed", "percentage", "calculation_method"]),
    amount: z.string().optional(),
    calculationMethod: z.string().optional(),
    accountNumber: z.string().min(1, "Required").max(120),
    accountName: z.string().max(200).optional(),
    deductionFrequency: z.enum(["monthly", "quarterly", "annually"]),
    referenceDay: z.string().min(1, "Required"),
    requestNote: z.string().max(4000).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.amountType !== "calculation_method") {
      if (!val.amount || !/^\d+(\.\d{1,4})?$/.test(val.amount) || Number(val.amount) <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["amount"],
          message: "Enter a positive amount (max 4 decimal places)",
        });
      }
    } else if (!val.calculationMethod || val.calculationMethod.trim().length < 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["calculationMethod"],
        message: "Describe the calculation method (min 5 chars)",
      });
    }
  });
type CreateForm = z.infer<typeof createSchema>;

// Task #471 — render every fee_consent_requests.status row using the
// canonical six-term display vocabulary. The mapping lives in
// `@/lib/consent-status` so Fee rules, Client detail and any future surface
// can never disagree with this page.
function statusBadge(status: string) {
  const display = consentRequestDisplayStatus(status);
  return (
    <Badge
      variant={consentStatusBadgeVariant(display)}
      data-testid={`badge-consent-status-${display}`}
    >
      {consentStatusLabel(display)}
    </Badge>
  );
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

function formatFeeType(t: string): string {
  return t.replace(/_/g, " ");
}

export default function AdviserFeeConsents() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const limit = 50;

  // Task #304 — when the Business page "+N more" pill links here with
  // ?status=active, surface a dedicated card listing every client that
  // currently holds an active consent, sorted by soonest expiry. The
  // existing requests table stays beneath so the rest of the page is
  // unchanged.
  const searchString = useSearch();
  const showActiveConsents = useMemo(
    () => new URLSearchParams(searchString).get("status") === "active",
    [searchString],
  );

  const requests = useQuery<ListResponse>({
    queryKey: [
      "/api/adviser/fee-consent-requests",
      { status: statusFilter, page, limit },
    ],
  });
  // /api/adviser/clients now returns { asOfDate, clients } (Task #287). Adapt
  // to the rows-only shape this page uses everywhere downstream.
  const clientsResponse = useQuery<{ asOfDate: string; clients: ClientLite[] }>({
    queryKey: ["/api/adviser/clients"],
  });
  const clients = {
    data: clientsResponse.data?.clients,
    isLoading: clientsResponse.isLoading,
  };

  const form = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      clientUserId: 0,
      adviceRecordId: 0,
      feeType: "ongoing_service_fee",
      amountType: "fixed",
      amount: "",
      calculationMethod: "",
      accountNumber: "",
      accountName: "",
      deductionFrequency: "monthly",
      referenceDay: new Date().toISOString().slice(0, 10),
      requestNote: "",
    },
  });

  const selectedClientId = form.watch("clientUserId");
  const selectedAmountType = form.watch("amountType");
  // Task #293 — keep the Send button disabled until both a client and an
  // advice record are picked. The server will reject either way (advice
  // record is required) but failing fast on the form is friendlier and
  // keeps adviser audit noise down.
  const selectedAdviceRecordId = form.watch("adviceRecordId");

  // Pull advice records for the picked client so the adviser can attach the
  // consent to a specific piece of advice (required by the backend).
  const clientDetail = useQuery<ClientDetailResponse>({
    queryKey: ["/api/adviser/clients", selectedClientId],
    enabled: selectedClientId > 0,
  });

  const createReq = useMutation({
    mutationFn: async (values: CreateForm) => {
      const ref = new Date(values.referenceDay + "T00:00:00.000Z");
      const start = new Date(ref.getTime() - RENEWAL_BEFORE_DAYS * 24 * 60 * 60 * 1000);
      const end = new Date(ref.getTime() + RENEWAL_AFTER_DAYS * 24 * 60 * 60 * 1000);
      const payload: any = {
        clientUserId: values.clientUserId,
        adviceRecordId: values.adviceRecordId,
        feeType: values.feeType,
        amountType: values.amountType,
        accountNumber: values.accountNumber,
        accountName: values.accountName || null,
        deductionFrequency: values.deductionFrequency,
        proposedReferenceDay: ref.toISOString(),
        proposedRenewalWindowStart: start.toISOString(),
        proposedRenewalWindowEnd: end.toISOString(),
        proposedConsentExpiryDate: end.toISOString(),
        requestNote: values.requestNote || null,
      };
      if (values.amountType === "calculation_method") {
        payload.calculationMethod = values.calculationMethod;
      } else {
        payload.amount = values.amount;
      }
      const res = await apiRequest("POST", "/api/adviser/fee-consent-requests", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/adviser/fee-consent-requests"] });
      toast({
        title: "Fee consent requested",
        description:
          "Sent to client to sign or decline. No money will be moved by this consent — AMAX requires separate admin-approved deduction controls (currently disabled).",
      });
      setOpen(false);
      form.reset();
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to create request",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const withdrawReq = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest(
        "PATCH",
        `/api/adviser/fee-consent-requests/${id}/withdraw`,
        { reason: "Withdrawn from adviser portal" },
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/adviser/fee-consent-requests"] });
      toast({ title: "Request withdrawn" });
    },
    onError: (err: Error) => {
      toast({ title: "Withdraw failed", description: err.message, variant: "destructive" });
    },
  });

  const clientLookup = useMemo(() => {
    const map = new Map<number, ClientLite>();
    (clients.data ?? []).forEach((c) => map.set(c.userId, c));
    return map;
  }, [clients.data]);

  // Task #304 — derive the active-consent client roster from the same
  // /api/adviser/clients payload the Business card uses, so the deep-link
  // shows exactly the set the pill summarised. Sort by soonest expiry.
  const activeFeeClients = useMemo(() => {
    const rows = (clients.data ?? []) as ClientLite[];
    return rows
      .filter((r) => (r.activeFeeConsents ?? 0) > 0 && r.feeConsentExpiringAt)
      .sort(
        (a, b) =>
          new Date(a.feeConsentExpiringAt as string).getTime() -
          new Date(b.feeConsentExpiringAt as string).getTime(),
      );
  }, [clients.data]);

  const totalPages = requests.data ? Math.max(1, Math.ceil(requests.data.total / limit)) : 1;

  return (
    <div className="p-6 space-y-6" data-testid="page-adviser-fee-consents">
      <div
        className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700"
        data-testid="fee-consent-hardening-notice"
      >
        <ShieldAlert className="h-4 w-4 text-slate-600 flex-shrink-0 mt-0.5" />
        <p>
          <span className="font-medium">No money will be moved by this consent.</span> AMAX requires
          separate admin-approved deduction controls (currently disabled). This screen records the
          DBFO request and (once signed) the executed consent only.
        </p>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Receipt className="h-6 w-6 text-emerald-600" />
            Fee consents (DBFO)
          </h1>
          <p className="text-sm text-gray-500 mt-1 max-w-2xl">
            Send a fee consent request to a linked client. Renewal window auto-derives from
            referenceDay (60 days before → 150 days after, per RG175).
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-new-fee-consent-request">
              <Plus className="h-4 w-4 mr-2" />
              Request fee consent
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Request fee consent</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit((v) => createReq.mutate(v))}
                className="space-y-4"
              >
                <FormField
                  control={form.control}
                  name="clientUserId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Client</FormLabel>
                      <Select
                        value={field.value > 0 ? String(field.value) : undefined}
                        onValueChange={(v) => {
                          field.onChange(Number(v));
                          form.setValue("adviceRecordId", 0);
                        }}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-client">
                            <SelectValue placeholder="Select client" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(clients.data ?? []).map((c) => (
                            <SelectItem key={c.userId} value={String(c.userId)}>
                              {c.firstName} {c.lastName} ({c.email})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="adviceRecordId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Linked advice record</FormLabel>
                      <Select
                        value={field.value > 0 ? String(field.value) : undefined}
                        onValueChange={(v) => field.onChange(Number(v))}
                        disabled={!selectedClientId}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-advice-record">
                            <SelectValue
                              placeholder={
                                selectedClientId
                                  ? "Select advice record"
                                  : "Pick a client first"
                              }
                            />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(clientDetail.data?.adviceRecords ?? []).map((r) => (
                            <SelectItem key={r.id} value={String(r.id)}>
                              #{r.id} — {r.adviceType} ({r.status})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {/* Task #293 — promote the previously buried "no advice records"
                         hint into a high-contrast inline alert so an adviser cannot
                         miss it and try to send a request that the server will reject. */}
                      {selectedClientId &&
                        clientDetail.isSuccess &&
                        (clientDetail.data?.adviceRecords ?? []).length === 0 && (
                          <div
                            className="mt-2 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900"
                            data-testid="alert-no-advice-records"
                          >
                            <ShieldAlert className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                            <span>
                              <strong>This client has no advice records.</strong> A fee
                              consent request must attach to an advice record. Create one
                              before sending.
                            </span>
                          </div>
                        )}
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="feeType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Fee type</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger data-testid="select-fee-type">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {FEE_TYPES.map((t) => (
                              <SelectItem key={t.value} value={t.value}>
                                {t.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="amountType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Amount type</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger data-testid="select-amount-type">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {AMOUNT_TYPES.map((t) => (
                              <SelectItem key={t.value} value={t.value}>
                                {t.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {selectedAmountType === "calculation_method" ? (
                  <FormField
                    control={form.control}
                    name="calculationMethod"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Calculation method</FormLabel>
                        <FormControl>
                          <Textarea
                            rows={3}
                            placeholder="e.g. 0.55% p.a. of FUM in growth account, charged monthly in arrears"
                            data-testid="input-calculation-method"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                ) : (
                  <FormField
                    control={form.control}
                    name="amount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Amount {selectedAmountType === "percentage" ? "(decimal, e.g. 0.0055 for 0.55%)" : "(AUD)"}
                        </FormLabel>
                        <FormControl>
                          <Input
                            inputMode="decimal"
                            placeholder={
                              selectedAmountType === "percentage" ? "0.0055" : "495.00"
                            }
                            data-testid="input-amount"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="accountNumber"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Account number</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="AMAX-0001"
                            data-testid="input-account-number"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="accountName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Account name (optional)</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Cash hub"
                            data-testid="input-account-name"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="deductionFrequency"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Frequency</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger data-testid="select-frequency">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {FREQUENCIES.map((f) => (
                              <SelectItem key={f.value} value={f.value}>
                                {f.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="referenceDay"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Reference day</FormLabel>
                        <FormControl>
                          <Input
                            type="date"
                            data-testid="input-reference-day"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="requestNote"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Note for client (optional)</FormLabel>
                      <FormControl>
                        <Textarea
                          rows={2}
                          placeholder="Why this consent is needed."
                          data-testid="input-note"
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
                    No money will be moved by this consent — AMAX requires separate
                    admin-approved deduction controls (currently disabled).
                  </span>
                </div>

                <Button
                  type="submit"
                  className="w-full"
                  disabled={
                    createReq.isPending ||
                    !selectedClientId ||
                    !selectedAdviceRecordId ||
                    selectedAdviceRecordId <= 0
                  }
                  data-testid="button-submit-request"
                >
                  {createReq.isPending ? "Sending..." : "Send to client"}
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {showActiveConsents && (
        <Card data-testid="card-active-fee-clients">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="h-4 w-4 text-emerald-600" />
                Active fee consents
              </CardTitle>
              <p className="text-xs text-slate-500 mt-1">
                Clients holding at least one active consent, sorted by soonest expiry.
              </p>
            </div>
            <Badge variant="outline" data-testid="badge-active-fee-clients-count">
              {activeFeeClients.length}{" "}
              {activeFeeClients.length === 1 ? "client" : "clients"}
            </Badge>
          </CardHeader>
          <CardContent>
            {clients.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : activeFeeClients.length === 0 ? (
              <p
                className="text-sm text-gray-500"
                data-testid="text-no-active-fee-clients"
              >
                No clients currently hold an active fee consent.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Active consents</TableHead>
                    <TableHead>Soonest expiry</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeFeeClients.map((c) => (
                    <TableRow
                      key={c.userId}
                      data-testid={`row-active-fee-client-${c.userId}`}
                    >
                      <TableCell className="text-sm font-medium">
                        {clientDisplayName(c, c.userId)}
                      </TableCell>
                      <TableCell className="text-sm text-gray-600">
                        {c.email}
                      </TableCell>
                      <TableCell className="text-sm tabular-nums">
                        {c.activeFeeConsents ?? 0}
                      </TableCell>
                      <TableCell className="text-sm">
                        {formatDate(c.feeConsentExpiringAt ?? null)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Link href={`/adviser/clients/${c.userId}`}>
                          <Button
                            variant="outline"
                            size="sm"
                            data-testid={`button-open-client-${c.userId}`}
                          >
                            Open client
                          </Button>
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">All requests</CardTitle>
          <div className="flex items-center gap-2">
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-48" data-testid="select-status-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {requests.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : requests.isError ? (
            <p className="text-sm text-red-600">Unable to load requests.</p>
          ) : !requests.data || requests.data.items.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="text-no-requests">
              No fee consent requests yet.
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Created</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Fee type</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Frequency</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests.data.items.map((r) => {
                    const c = clientLookup.get(r.clientUserId);
                    return (
                      <TableRow key={r.id} data-testid={`row-fee-consent-request-${r.id}`}>
                        <TableCell className="text-sm">{formatDate(r.createdAt)}</TableCell>
                        <TableCell className="text-sm">
                          <div className="font-medium">
                            {c ? `${c.firstName} ${c.lastName}` : `Client #${r.clientUserId}`}
                          </div>
                          {c && <div className="text-xs text-gray-500">{c.email}</div>}
                        </TableCell>
                        <TableCell className="text-sm capitalize">
                          {formatFeeType(r.feeType)}
                          <div className="text-xs text-gray-500 capitalize">
                            {formatFeeType(r.amountType)}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm tabular-nums text-right">
                          {r.amountType === "calculation_method"
                            ? "Calc method"
                            : r.amountType === "percentage"
                              ? `${(Number(r.amount ?? 0) * 100).toFixed(4)}%`
                              : formatAud(r.amount)}
                        </TableCell>
                        <TableCell className="text-sm capitalize">{r.deductionFrequency}</TableCell>
                        <TableCell className="text-sm">
                          {formatDate(r.proposedConsentExpiryDate)}
                        </TableCell>
                        <TableCell>{statusBadge(r.status)}</TableCell>
                        <TableCell className="text-right">
                          {r.status === "pending" ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => withdrawReq.mutate(r.id)}
                              disabled={withdrawReq.isPending}
                              data-testid={`button-withdraw-${r.id}`}
                            >
                              Withdraw
                            </Button>
                          ) : (
                            <span className="text-xs text-gray-500">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4 text-sm">
                  <span className="text-gray-500">
                    Page {requests.data.page} of {totalPages} ({requests.data.total} total)
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      data-testid="button-prev-page"
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= totalPages}
                      onClick={() => setPage((p) => p + 1)}
                      data-testid="button-next-page"
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
