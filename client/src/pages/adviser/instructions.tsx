import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Plus, ClipboardList, ShieldAlert, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { productCategoryLabel } from "@shared/product-categories";

interface InstructionRow {
  id: number;
  adviserUserId: number;
  clientUserId: number;
  productId: number;
  action: string;
  amount: string;
  status: string;
  notes: string | null;
  rejectionReason: string | null;
  consentedAt: string | null;
  rejectedAt: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  clientFirstName: string;
  clientLastName: string;
  clientEmail: string;
  productName: string;
  productCategory: string;
  adviceRecordId: number | null;
  adviceRecordNotLinked: boolean;
  suitabilityBasis: string | null;
  switchFromProductId: number | null;
}

interface ClientLite {
  userId: number;
  firstName: string;
  lastName: string;
  email: string;
}

interface ProductLite {
  id: number;
  name: string;
  category: string;
  isActive: boolean;
  riskProfile: string;
}

interface AdviceRecordLite {
  id: number;
  adviceType: string;
  status: string;
  createdAt: string | null;
  clientAcknowledged: boolean;
}

const ACTIONS = [
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Sell" },
  { value: "switch", label: "Switch" },
];

// Status filter values mirror the underlying status enum, plus "Approved" for
// `processing` (instructions that have cleared consent and are awaiting
// downstream platform execution) and "Executed" for `completed`. These are
// the labels the adviser sees on the instruction lifecycle.
const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending_consent", label: "Pending consent" },
  { value: "consented", label: "Consent recorded" },
  { value: "processing", label: "Approved" },
  { value: "completed", label: "Executed" },
  { value: "cancelled", label: "Cancelled" },
];

// Sentinel value used by the "Linked advice record" select to represent the
// adviser's explicit "no linked advice record" choice. Kept off the wire as
// a boolean flag (adviceRecordNotLinked) — this string only lives in the
// form state.
const ADVICE_NONE_VALUE = "__none__";

const createInstructionFormSchema = z
  .object({
    clientUserId: z.coerce.number().int().positive("Select a client"),
    productId: z.coerce.number().int().positive("Select a product"),
    action: z.enum(["buy", "sell", "switch"]),
    amount: z
      .string()
      .min(1, "Required")
      .regex(/^\d+(\.\d{1,2})?$/, "Must be a number with up to 2 dp")
      .refine((v) => Number(v) > 0, "Must be greater than 0"),
    notes: z.string().max(2000).optional(),
    adviceRecordChoice: z
      .string()
      .min(1, "Choose an advice record or 'No linked advice record'"),
    suitabilityBasis: z.string().max(4000).optional(),
    switchFromProductId: z.coerce.number().int().nonnegative().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === "switch") {
      if (!v.switchFromProductId || v.switchFromProductId <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Choose the product being switched out of",
          path: ["switchFromProductId"],
        });
      } else if (v.switchFromProductId === v.productId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Switch source must differ from destination",
          path: ["switchFromProductId"],
        });
      }
    }
  });
type CreateInstructionForm = z.infer<typeof createInstructionFormSchema>;

function statusBadge(status: string) {
  const map: Record<string, { variant: "default" | "secondary" | "outline" | "destructive"; label: string }> = {
    pending_consent: { variant: "secondary", label: "Pending consent" },
    consented: {
      variant: "default",
      label: "Consent recorded · Awaiting AMAX platform approval",
    },
    processing: { variant: "secondary", label: "Approved" },
    completed: { variant: "default", label: "Executed" },
    rejected: { variant: "destructive", label: "Rejected" },
    cancelled: { variant: "outline", label: "Cancelled" },
  };
  const entry = map[status] ?? { variant: "outline" as const, label: status };
  return <Badge variant={entry.variant}>{entry.label}</Badge>;
}

function formatAud(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
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

// Render a client option per spec: "First Last (email)" when both a
// non-empty display name and an email resolve, otherwise the email
// alone — never an empty "(email)" or anonymous "Linked Client" row,
// and never a name-only label (a missing email implies an unusable
// account record). Returns null when the email is missing so the
// caller can drop the row entirely.
function clientOptionLabel(c: ClientLite): string | null {
  const first = (c.firstName ?? "").trim();
  const last = (c.lastName ?? "").trim();
  const email = (c.email ?? "").trim();
  if (email.length === 0) return null;
  const fullName = `${first} ${last}`.trim();
  if (fullName.length > 0) return `${fullName} (${email})`;
  return email;
}

function adviceRecordLabel(r: AdviceRecordLite): string {
  const created = r.createdAt ? formatDate(r.createdAt) : "—";
  const ack = r.clientAcknowledged ? "acknowledged" : "not acknowledged";
  return `#${r.id} · ${r.status} · ${created} · ${ack}`;
}

export default function AdviserInstructions() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [, setLocation] = useLocation();

  const instructions = useQuery<InstructionRow[]>({ queryKey: ["/api/adviser/instructions"] });
  // /api/adviser/clients now returns { asOfDate, clients } (Task #287). Adapt
  // to the rows-only shape this page uses everywhere downstream.
  const clientsResponse = useQuery<{ asOfDate: string; clients: ClientLite[] }>({
    queryKey: ["/api/adviser/clients"],
  });
  const clients = {
    data: clientsResponse.data?.clients,
    isLoading: clientsResponse.isLoading,
  };
  const products = useQuery<ProductLite[]>({ queryKey: ["/api/adviser/products"] });

  const form = useForm<CreateInstructionForm>({
    resolver: zodResolver(createInstructionFormSchema),
    defaultValues: {
      clientUserId: 0,
      productId: 0,
      action: "buy",
      amount: "",
      notes: "",
      adviceRecordChoice: "",
      suitabilityBasis: "",
      switchFromProductId: 0,
    },
  });

  const watchedClientId = form.watch("clientUserId");
  const watchedProductId = form.watch("productId");
  const watchedAction = form.watch("action");

  // Advice records depend on the chosen client. Skip the query until the
  // adviser actually picks one so the form's first paint is one round trip.
  // Use a single string key — the project's default queryFn fetches
  // `queryKey[0]` directly, so the URL needs to live there.
  const adviceRecords = useQuery<AdviceRecordLite[]>({
    queryKey: [`/api/adviser/clients/${watchedClientId}/advice-records`],
    enabled: watchedClientId > 0,
  });

  // Reset the advice-record choice every time the client changes so a
  // stale selection from a previous client can never tag along.
  useEffect(() => {
    form.setValue("adviceRecordChoice", "", { shouldValidate: false });
    // form is stable; intentionally only react to client change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedClientId]);

  // Same defensive reset for "switch from" when the destination product
  // changes — choosing the same id on both sides would be rejected.
  useEffect(() => {
    if (form.getValues("switchFromProductId") === watchedProductId) {
      form.setValue("switchFromProductId", 0, { shouldValidate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedProductId]);

  const visibleProducts = useMemo(
    () => (products.data ?? []).filter((p) => p.isActive),
    [products.data],
  );
  const productById = useMemo(() => {
    const m = new Map<number, ProductLite>();
    for (const p of visibleProducts) m.set(p.id, p);
    return m;
  }, [visibleProducts]);

  const selectedProduct = watchedProductId > 0 ? productById.get(watchedProductId) : undefined;
  // Task #339 — match the server-side suitability rule, which now requires a
  // suitability basis for both "high" and "very_high" canonical risk bands.
  // Keeping these in sync prevents a UX where the form lets the adviser
  // submit without a basis and the API then rejects it.
  const selectedProductIsHighRisk =
    selectedProduct?.riskProfile === "high" ||
    selectedProduct?.riskProfile === "very_high";

  // Deep-link support: when arriving from /adviser/products via the
  // "Raise instruction" CTA, open the create dialog and pre-select the
  // requested product. The query string is then cleared so a refresh
  // doesn't keep re-opening the dialog.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("productId");
    if (!raw) return;
    const productId = Number(raw);
    if (!Number.isFinite(productId) || productId <= 0) return;
    form.setValue("productId", productId, { shouldValidate: false });
    setOpen(true);
    setLocation("/adviser/instructions", { replace: true });
    // location is intentionally not in deps — we only act on the initial mount URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createInstruction = useMutation({
    mutationFn: async (values: CreateInstructionForm) => {
      // Translate the form's adviceRecordChoice sentinel into the wire shape
      // (adviceRecordId / adviceRecordNotLinked) the server expects.
      const adviceRecordNotLinked = values.adviceRecordChoice === ADVICE_NONE_VALUE;
      const adviceRecordIdRaw = adviceRecordNotLinked
        ? null
        : Number(values.adviceRecordChoice);
      const adviceRecordId =
        Number.isFinite(adviceRecordIdRaw) && (adviceRecordIdRaw ?? 0) > 0
          ? adviceRecordIdRaw
          : null;

      const payload = {
        clientUserId: values.clientUserId,
        productId: values.productId,
        action: values.action,
        amount: values.amount,
        notes: values.notes && values.notes.length > 0 ? values.notes : null,
        adviceRecordId,
        adviceRecordNotLinked,
        suitabilityBasis:
          values.suitabilityBasis && values.suitabilityBasis.trim().length > 0
            ? values.suitabilityBasis.trim()
            : null,
        switchFromProductId:
          values.action === "switch" && values.switchFromProductId
            ? values.switchFromProductId
            : null,
      };
      const res = await apiRequest("POST", "/api/adviser/instructions", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/adviser/instructions"] });
      toast({
        title: "Instruction created",
        description:
          "Sent to client to record consent. Client approval records consent only — execution requires AMAX platform approval and execution controls.",
      });
      setOpen(false);
      form.reset();
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to create instruction",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  function handleSubmit(values: CreateInstructionForm): void {
    // Conditional client-side guard: zodResolver doesn't have visibility into
    // the chosen product's risk profile, so the high-risk suitability rule
    // is checked here against the watched product. The server enforces the
    // same rule independently — this is just for a clean UX message.
    if (selectedProductIsHighRisk) {
      const v = (values.suitabilityBasis ?? "").trim();
      if (v.length === 0) {
        form.setError("suitabilityBasis", {
          type: "manual",
          message: "Suitability basis is required for high-risk products",
        });
        return;
      }
    }
    createInstruction.mutate(values);
  }

  function isFormDirty(): boolean {
    // form.formState.isDirty only flips when a field deviates from its
    // default. That's exactly the "user has typed/picked something" signal
    // the discard-confirm dialog needs.
    return form.formState.isDirty;
  }

  function handleDialogOpenChange(next: boolean): void {
    if (next) {
      setOpen(true);
      return;
    }
    if (createInstruction.isPending) return;
    if (isFormDirty()) {
      setConfirmDiscardOpen(true);
      return;
    }
    setOpen(false);
  }

  function discardAndClose(): void {
    form.reset();
    setConfirmDiscardOpen(false);
    setOpen(false);
  }

  // Select-renderable client list, with fixture/empty rows already dropped
  // by the server filter. Defensive: skip any row whose label resolves to
  // null (no name AND no email) so we never render an anonymous option.
  const clientOptions = useMemo(() => {
    return (clients.data ?? [])
      .map((c) => ({ client: c, label: clientOptionLabel(c) }))
      .filter((o): o is { client: ClientLite; label: string } => o.label !== null);
  }, [clients.data]);

  // Filtered instruction rows for the table (status filter only — search /
  // pagination are out of scope for this task).
  const filteredInstructions = useMemo(() => {
    const rows = instructions.data ?? [];
    if (statusFilter === "all") return rows;
    return rows.filter((r) => r.status === statusFilter);
  }, [instructions.data, statusFilter]);

  return (
    <div className="p-6 space-y-6" data-testid="page-adviser-instructions">
      <div
        className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700"
        data-testid="instructions-hardening-notice"
      >
        <ShieldAlert className="h-4 w-4 text-slate-600 flex-shrink-0 mt-0.5" />
        <p>
          <span className="font-medium">Consent recorded ≠ executed.</span> When a client approves
          an instruction, AMAX records the consent and audit trail. The instruction is{" "}
          <span className="font-medium">not</span> placed with the fund manager and no funds move
          until AMAX platform approval and execution controls are enabled.
        </p>
      </div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <ClipboardList className="h-6 w-6 text-emerald-600" />
            Investment Instructions
          </h1>
          <p className="text-sm text-gray-500 mt-1 max-w-2xl">
            Adviser-created investment actions. Every instruction is created in{" "}
            <span className="font-medium">pending consent</span>. Client approval records consent
            only. No instruction is executed and no funds move until AMAX platform approval and
            execution controls are enabled.
          </p>
        </div>
        <Dialog open={open} onOpenChange={handleDialogOpenChange}>
          <DialogTrigger asChild>
            <Button data-testid="button-new-instruction">
              <Plus className="h-4 w-4 mr-2" />
              New instruction
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create investment instruction</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(handleSubmit)}
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
                        onValueChange={(v) => field.onChange(Number(v))}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-client">
                            <SelectValue placeholder="Select client" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {clientOptions.length === 0 ? (
                            <div className="px-2 py-1.5 text-xs text-gray-500">
                              No linked clients yet.
                            </div>
                          ) : (
                            clientOptions.map(({ client, label }) => (
                              <SelectItem key={client.userId} value={String(client.userId)}>
                                {label}
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="productId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Product</FormLabel>
                      <Select
                        value={field.value > 0 ? String(field.value) : undefined}
                        onValueChange={(v) => field.onChange(Number(v))}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-product">
                            <SelectValue placeholder="Select product" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {visibleProducts.length === 0 ? (
                            <div className="px-2 py-1.5 text-xs text-gray-500">
                              No products available.
                            </div>
                          ) : (
                            visibleProducts.map((p) => (
                              <SelectItem key={p.id} value={String(p.id)}>
                                {p.name} — {productCategoryLabel(p.category)}
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="action"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Action</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger data-testid="select-action">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {ACTIONS.map((a) => (
                              <SelectItem key={a.value} value={a.value}>
                                {a.label}
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
                    name="amount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Amount</FormLabel>
                        <FormControl>
                          <Input
                            inputMode="decimal"
                            placeholder="10000.00"
                            data-testid="input-amount"
                            {...field}
                          />
                        </FormControl>
                        <p className="text-[11px] text-gray-500 mt-1">
                          All instructions are denominated in AUD.
                        </p>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                {watchedAction === "switch" && (
                  <FormField
                    control={form.control}
                    name="switchFromProductId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Switch from product</FormLabel>
                        <Select
                          value={
                            field.value && field.value > 0 ? String(field.value) : undefined
                          }
                          onValueChange={(v) => field.onChange(Number(v))}
                        >
                          <FormControl>
                            <SelectTrigger data-testid="select-switch-from-product">
                              <SelectValue placeholder="Select source product" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {visibleProducts
                              .filter((p) => p.id !== watchedProductId)
                              .map((p) => (
                                <SelectItem key={p.id} value={String(p.id)}>
                                  {p.name} — {productCategoryLabel(p.category)}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
                <FormField
                  control={form.control}
                  name="adviceRecordChoice"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Linked advice record</FormLabel>
                      <Select
                        value={field.value || undefined}
                        onValueChange={field.onChange}
                        disabled={watchedClientId <= 0}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-advice-record">
                            <SelectValue
                              placeholder={
                                watchedClientId <= 0
                                  ? "Select a client first"
                                  : adviceRecords.isLoading
                                  ? "Loading advice records…"
                                  : "Select advice record or 'No linked advice record'"
                              }
                            />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value={ADVICE_NONE_VALUE}>
                            No linked advice record
                          </SelectItem>
                          {(adviceRecords.data ?? []).map((r) => (
                            <SelectItem key={r.id} value={String(r.id)}>
                              {adviceRecordLabel(r)}
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
                  name="suitabilityBasis"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Suitability basis{" "}
                        {selectedProductIsHighRisk ? (
                          <span className="text-red-600">(required for high-risk product)</span>
                        ) : (
                          <span className="text-gray-400">(optional)</span>
                        )}
                      </FormLabel>
                      <FormControl>
                        <Textarea
                          rows={3}
                          placeholder={
                            selectedProductIsHighRisk
                              ? "Document why this high-risk product is suitable for the client (e.g. wholesale verification, risk tolerance, time horizon)."
                              : "Optional rationale for why this instruction is suitable."
                          }
                          data-testid="input-suitability-basis"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Notes (optional)</FormLabel>
                      <FormControl>
                        <Textarea
                          rows={3}
                          placeholder="Context for the client (rationale, source of funds, etc.)"
                          data-testid="input-notes"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  className="w-full"
                  disabled={createInstruction.isPending}
                  data-testid="button-submit-instruction"
                >
                  {createInstruction.isPending ? "Creating..." : "Send for client consent"}
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <AlertDialog open={confirmDiscardOpen} onOpenChange={setConfirmDiscardOpen}>
        <AlertDialogContent data-testid="dialog-discard-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this instruction?</AlertDialogTitle>
            <AlertDialogDescription>Your changes will not be saved.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-continue-editing">
              Continue editing
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={discardAndClose}
              data-testid="button-discard-instruction"
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle className="text-base">All instructions</CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Status</span>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-8 w-[200px]" data-testid="select-status-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {instructions.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : instructions.isError ? (
            <p className="text-sm text-red-600">Unable to load instructions.</p>
          ) : !instructions.data || instructions.data.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="text-no-instructions">
              No instructions yet. Use "New instruction" above to send one to a linked client.
            </p>
          ) : filteredInstructions.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="text-no-instructions-for-filter">
              No instructions match the selected status.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Created</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Advice record</TableHead>
                  <TableHead>Suitability assessed</TableHead>
                  <TableHead>Expiry</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredInstructions.map((i) => {
                  const clientName = `${i.clientFirstName ?? ""} ${i.clientLastName ?? ""}`.trim();
                  return (
                    <TableRow key={i.id} data-testid={`row-instruction-${i.id}`}>
                      <TableCell className="text-sm">{formatDate(i.createdAt)}</TableCell>
                      <TableCell className="text-sm">
                        {clientName.length > 0 ? (
                          <>
                            <div className="font-medium">{clientName}</div>
                            <div className="text-xs text-gray-500">{i.clientEmail}</div>
                          </>
                        ) : (
                          <div className="font-medium">{i.clientEmail}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        <div className="font-medium">{i.productName}</div>
                        <div className="text-xs text-gray-500">
                          {productCategoryLabel(i.productCategory)}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm capitalize">{i.action}</TableCell>
                      <TableCell className="text-sm tabular-nums text-right">
                        {formatAud(i.amount)}
                      </TableCell>
                      <TableCell>{statusBadge(i.status)}</TableCell>
                      <TableCell className="text-sm">
                        {i.adviceRecordId ? (
                          <span className="font-mono text-xs">#{i.adviceRecordId}</span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800"
                            data-testid={`advice-none-${i.id}`}
                          >
                            <AlertTriangle className="h-3 w-3" />
                            None linked
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {i.suitabilityBasis && i.suitabilityBasis.trim().length > 0 ? "Yes" : "No"}
                      </TableCell>
                      <TableCell className="text-sm">{formatDate(i.expiresAt)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
