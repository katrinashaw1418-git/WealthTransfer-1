import { useState, useMemo, Fragment } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { clientDisplayName } from "@shared/display-name";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/contexts/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, FileText, Download, AlertCircle, RotateCcw, Layers, Info } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface PriorVersion {
  id: number;
  versionNumber: number;
  generatedAt: string | null;
  status: string;
}

interface ReportRequest {
  id: number;
  adviserUserId: number;
  clientUserId: number;
  reportType: string;
  format: string;
  status: string;
  requestedAt: string | null;
  generatedAt: string | null;
  expiresAt: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  downloadUrl: string | null;
  failureReason: string | null;
  notes: string | null;
  versionNumber?: number | null;
  supersedesReportId?: number | null;
  downloadLinkExpiresAt?: string | null;
  versions?: PriorVersion[];
}

interface ReportsListResponse {
  rows: ReportRequest[];
  counts: Record<string, number>;
}

interface ClientLite {
  userId: number;
  firstName: string;
  lastName: string;
  email: string;
}

const TOKEN_KEY = "amax_jwt";

async function downloadReport(reportId: number, toast: ReturnType<typeof useToast>["toast"]) {
  try {
    const token = (() => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } })();
    const res = await fetch(`/api/adviser/reports/${reportId}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      // Task #315 — link-expired (410 with code='link_expired') gets a
      // dedicated toast that points the adviser at the Regenerate action.
      let body: any = null;
      try { body = await res.json(); } catch { /* not json */ }
      if (res.status === 410 && body?.code === "link_expired") {
        toast({
          title: "Download link expired",
          description: "This download link is older than 7 days. Use the Regenerate button to get a fresh PDF.",
          variant: "destructive",
        });
        // Refresh the list so the row's status flips to 'expired_link' in the UI.
        queryClient.invalidateQueries({ queryKey: ["/api/adviser/reports"] });
        return;
      }
      throw new Error(body?.error ?? `${res.status}: ${res.statusText}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `amax-report-${reportId}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    toast({
      title: "Download failed",
      description: err instanceof Error ? err.message : "Unknown error",
      variant: "destructive",
    });
  }
}

const REPORT_TYPES = [
  { value: "portfolio_summary", label: "Portfolio summary" },
  { value: "fee_summary", label: "Fee summary" },
  { value: "transaction_history", label: "Transaction history" },
  { value: "full_statement", label: "Full statement" },
];

const PERIOD_PRESETS = [
  { value: "this_month", label: "This month" },
  { value: "last_quarter", label: "Last quarter" },
  { value: "fytd", label: "FYTD" },
  { value: "custom", label: "Custom" },
];

// YYYY-MM-DD ISO date string. Validated server-side too.
const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;

const formSchema = z
  .object({
    clientUserId: z.coerce.number().int().positive("Pick a client"),
    reportType: z.string().min(1),
    periodPreset: z.enum(["this_month", "last_quarter", "fytd", "custom"]),
    periodFrom: z.string().regex(isoDateRe, "Pick a start date"),
    periodTo: z.string().regex(isoDateRe, "Pick an end date"),
    notes: z.string().max(2000).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.periodFrom > val.periodTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["periodTo"],
        message: "End date must be on or after start date",
      });
    }
  });
type FormValues = z.infer<typeof formSchema>;

function toIsoDate(d: Date): string {
  // Local-date YYYY-MM-DD. Avoid toISOString() because that converts to UTC
  // and silently shifts the calendar day for users east of UTC.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Australian fiscal year runs 1 July → 30 June.
function presetToRange(preset: string, today: Date = new Date()): { from: string; to: string } {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (preset === "this_month") {
    const from = new Date(t.getFullYear(), t.getMonth(), 1);
    return { from: toIsoDate(from), to: toIsoDate(t) };
  }
  if (preset === "last_quarter") {
    const q = Math.floor(t.getMonth() / 3); // 0..3 (current quarter)
    const lastQStartMonth = (q - 1) * 3;
    let year = t.getFullYear();
    let startMonth = lastQStartMonth;
    if (lastQStartMonth < 0) {
      year -= 1;
      startMonth = 9; // Q4 of prev year (Oct-Dec)
    }
    const from = new Date(year, startMonth, 1);
    const to = new Date(year, startMonth + 3, 0); // last day of the quarter
    return { from: toIsoDate(from), to: toIsoDate(to) };
  }
  if (preset === "fytd") {
    // If we're on/after July 1, FY started this calendar year. Otherwise it
    // started 1 July of the previous calendar year.
    const fyStartYear = t.getMonth() >= 6 ? t.getFullYear() : t.getFullYear() - 1;
    const from = new Date(fyStartYear, 6, 1); // 1 July
    return { from: toIsoDate(from), to: toIsoDate(t) };
  }
  // custom: caller fills in manually; default to "this_month" so the pickers
  // start populated rather than empty (and the user edits from there).
  return presetToRange("this_month", today);
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("en-AU");
  } catch {
    return "—";
  }
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString("en-AU", {
      year: "numeric",
      month: "short",
      day: "2-digit",
    });
  } catch {
    return "—";
  }
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
function isExpiringSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const ts = new Date(expiresAt).getTime();
  if (!Number.isFinite(ts)) return false;
  const remaining = ts - Date.now();
  return remaining > 0 && remaining < ONE_DAY_MS;
}

// Task #298 — explicit five-status mapping. Anything not in this map renders
// as a neutral "Unknown" badge so a future status (e.g. "cancelled") cannot
// accidentally render as "Ready".
function statusBadge(status: string) {
  const variant: "default" | "secondary" | "destructive" | "outline" =
    status === "ready"
      ? "default"
      : status === "failed" || status === "expired" || status === "expired_link"
        ? "destructive"
        : "secondary";
  return (
    <Badge variant={variant} className="capitalize" data-testid={`badge-status-${status}`}>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

function reportTypeLabel(type: string): string {
  return REPORT_TYPES.find((t) => t.value === type)?.label ?? type.replace(/_/g, " ");
}

// Status counts strip — order is fixed so the visual layout is stable
// regardless of which buckets happen to be empty in the response.
const COUNT_BUCKETS: Array<{ key: string; label: string; chipClass: string }> = [
  { key: "requested", label: "Pending", chipClass: "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100" },
  { key: "generating", label: "Generating", chipClass: "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100" },
  { key: "ready", label: "Ready", chipClass: "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100" },
  { key: "failed", label: "Failed", chipClass: "bg-red-50 text-red-700 border-red-200 hover:bg-red-100" },
  { key: "expired_link", label: "Link expired", chipClass: "bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200" },
  { key: "expired", label: "Expired", chipClass: "bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200" },
];

export default function AdviserReports() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const reports = useQuery<ReportsListResponse>({ queryKey: ["/api/adviser/reports"] });
  // /api/adviser/clients now returns { asOfDate, clients } (Task #287). Adapt
  // to the rows-only shape this page uses everywhere downstream.
  const clientsResponse = useQuery<{ asOfDate: string; clients: ClientLite[] }>({
    queryKey: ["/api/adviser/clients"],
  });
  const clients = clientsResponse.data?.clients;

  // Build a single client lookup map so each table row resolves the display
  // name without an N+1 round-trip. Falls back gracefully when the clients
  // query is still loading or when a client has been unlinked since the
  // report was generated.
  const clientMap = useMemo(() => {
    const m = new Map<number, ClientLite>();
    (clients ?? []).forEach((c) => m.set(c.userId, c));
    return m;
  }, [clients]);

  const adviserDisplayName = (() => {
    if (!user) return "—";
    const full = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
    if (full) return full;
    return user.email ?? user.username ?? "—";
  })();

  const initialPreset = "this_month";
  const initialRange = presetToRange(initialPreset);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      clientUserId: 0,
      reportType: "portfolio_summary",
      periodPreset: initialPreset,
      periodFrom: initialRange.from,
      periodTo: initialRange.to,
      notes: "",
    },
  });

  const periodPreset = form.watch("periodPreset");
  const isCustomRange = periodPreset === "custom";

  const submitReport = useMutation({
    mutationFn: async (values: FormValues) => {
      const { periodPreset: _preset, ...payload } = values;
      const res = await apiRequest("POST", "/api/adviser/reports", payload);
      return res.json();
    },
    onSuccess: (data: ReportRequest) => {
      queryClient.invalidateQueries({ queryKey: ["/api/adviser/reports"] });
      queryClient.invalidateQueries({ queryKey: ["/api/adviser/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/adviser/notifications"] });
      if (data?.status === "ready") {
        toast({
          title: "Report ready",
          description: "Your PDF has been generated and is available for download.",
        });
      } else if (data?.status === "failed") {
        toast({
          title: "Generation failed",
          description: data.failureReason ?? "Unknown error",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Report requested",
          description: "Your request has been recorded.",
        });
      }
      setOpen(false);
      form.reset({
        clientUserId: 0,
        reportType: "portfolio_summary",
        periodPreset: initialPreset,
        periodFrom: initialRange.from,
        periodTo: initialRange.to,
        notes: "",
      });
    },
    onError: (err: any) => {
      // Task #315 — duplicate guard (409, code=duplicate_report_request)
      // gets a softer toast. apiRequest rejects with the error envelope
      // attached as `.body`.
      const body = err?.body ?? null;
      if (body?.code === "duplicate_report_request") {
        toast({
          title: "Recent duplicate",
          description: `A report of this type was already requested in the last 30 minutes (id #${body.existingReportId}, status ${body.existingStatus}). Open it from the list below.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Request failed",
          description: err instanceof Error ? err.message : "Unknown error",
          variant: "destructive",
        });
      }
    },
  });

  function applyPreset(preset: string) {
    form.setValue("periodPreset", preset as FormValues["periodPreset"]);
    if (preset !== "custom") {
      const { from, to } = presetToRange(preset);
      form.setValue("periodFrom", from, { shouldValidate: true });
      form.setValue("periodTo", to, { shouldValidate: true });
    }
  }

  function onSubmit(values: FormValues) {
    submitReport.mutate(values);
  }

  // Task #315 — Regenerate. Inserts a new versioned row and runs the
  // generator inline; on success we invalidate the list so the new row
  // appears at the top with the expected version chip.
  const regenerate = useMutation({
    mutationFn: async (reportId: number) => {
      const res = await apiRequest("POST", `/api/adviser/reports/${reportId}/regenerate`, {});
      return res.json();
    },
    onSuccess: (data: ReportRequest) => {
      queryClient.invalidateQueries({ queryKey: ["/api/adviser/reports"] });
      toast({
        title: data?.status === "ready" ? "Regenerated" : "Regeneration submitted",
        description:
          data?.status === "ready"
            ? `Version ${data.versionNumber ?? "?"} is ready to download.`
            : data?.failureReason ?? "Submitted; check status above.",
        variant: data?.status === "failed" ? "destructive" : "default",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Regenerate failed", description: err.message, variant: "destructive" });
    },
  });

  const counts = reports.data?.counts ?? {};
  const allRows = reports.data?.rows ?? [];
  const filtered = useMemo(
    () => (statusFilter ? allRows.filter((r) => r.status === statusFilter) : allRows),
    [allRows, statusFilter],
  );

  return (
    <div className="p-6 space-y-6" data-testid="page-adviser-reports">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
          <p className="text-sm text-gray-500 mt-1">
            Request statement-style reports for any of your linked clients. Generation is handled
            by the platform; you'll see a download link once ready. Download links expire after 7 days.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-new-report">
              <Plus className="h-4 w-4 mr-2" /> Request report
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Request a report</DialogTitle>
            </DialogHeader>

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="clientUserId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Client</FormLabel>
                      <Select
                        onValueChange={(v) => field.onChange(Number(v))}
                        value={field.value ? String(field.value) : ""}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-report-client">
                            <SelectValue placeholder="Select a linked client…" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {clients?.map((c) => (
                            <SelectItem key={c.userId} value={String(c.userId)}>
                              {clientDisplayName(c, c.userId)}
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
                  name="reportType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Report type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-report-type">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {REPORT_TYPES.map((t) => (
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
                  name="periodPreset"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Period</FormLabel>
                      <Select onValueChange={(v) => applyPreset(v)} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-period-preset">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {PERIOD_PRESETS.map((p) => (
                            <SelectItem key={p.value} value={p.value}>
                              {p.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="periodFrom"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>From</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="date"
                            disabled={!isCustomRange}
                            data-testid="input-period-from"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="periodTo"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>To</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="date"
                            disabled={!isCustomRange}
                            data-testid="input-period-to"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Notes (optional)</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          placeholder="e.g. cover Q1 only"
                          data-testid="input-report-notes"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  disabled={submitReport.isPending}
                  data-testid="button-submit-report"
                >
                  {submitReport.isPending ? "Submitting…" : "Submit request"}
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Status counts strip with click-to-filter */}
      <div className="flex flex-wrap items-center gap-2" data-testid="strip-status-counts">
        <button
          type="button"
          onClick={() => setStatusFilter(null)}
          className={`text-xs font-medium px-3 py-1.5 rounded-full border transition ${
            statusFilter === null
              ? "bg-slate-900 text-white border-slate-900"
              : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
          }`}
          data-testid="chip-count-all"
        >
          All ({allRows.length})
        </button>
        {COUNT_BUCKETS.map((b) => {
          const n = counts[b.key] ?? 0;
          const active = statusFilter === b.key;
          return (
            <button
              key={b.key}
              type="button"
              onClick={() => setStatusFilter(active ? null : b.key)}
              className={`text-xs font-medium px-3 py-1.5 rounded-full border transition ${
                active ? "ring-2 ring-offset-1 ring-slate-400 " : ""
              }${b.chipClass}`}
              data-testid={`chip-count-${b.key}`}
            >
              {b.label}: {n}
            </button>
          );
        })}
      </div>

      <Alert
        className="border-violet-200 bg-violet-50 text-violet-900"
        data-testid="alert-reports-access-notice"
      >
        <Info className="h-4 w-4 text-violet-600" />
        <AlertDescription>
          Every report download is logged to the adviser audit trail.
          Only request reports for clients you have an active engagement with.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4 text-violet-500" />
            Your report requests
            {statusFilter && (
              <span className="text-xs font-normal text-slate-500">
                · filtered by <span className="font-mono">{statusFilter}</span>
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {reports.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="text-no-reports">
              {statusFilter ? `No reports with status "${statusFilter}".` : "No report requests yet."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => {
                  const isFailed = r.status === "failed";
                  const isExpiredLink = r.status === "expired_link";
                  const showRetry = isFailed || isExpiredLink || r.status === "expired";
                  const versionNum = r.versionNumber ?? 1;
                  const priorCount = r.versions?.length ?? 0;
                  const client = clientMap.get(r.clientUserId);
                  const clientName = client ? `${client.firstName ?? ""} ${client.lastName ?? ""}`.trim() : `Client #${r.clientUserId}`;

                  return (
                    <TableRow
                      key={r.id}
                      data-testid={`row-report-${r.id}`}
                      className={
                        isFailed
                          ? "border-l-4 border-l-red-500 bg-red-50/40"
                          : isExpiredLink
                            ? "border-l-4 border-l-slate-400 bg-slate-50/40"
                            : ""
                      }
                    >
                      <TableCell className="text-sm">
                        <div className="font-medium text-gray-900">{clientName}</div>
                        {client?.email && <div className="text-xs text-gray-500">{client.email}</div>}
                      </TableCell>
                      <TableCell className="capitalize text-sm">
                        <div className="flex flex-col">
                          <span>{reportTypeLabel(r.reportType)}</span>
                          {priorCount > 0 ? (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span
                                    className="inline-flex items-center text-[10px] gap-1 text-violet-700 bg-violet-50 border border-violet-200 px-1.5 py-0 rounded w-fit mt-1 cursor-help"
                                    data-testid={`chip-version-${r.id}`}
                                  >
                                    <Layers className="h-2.5 w-2.5" />v{versionNum}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p className="text-xs">
                                    {priorCount} prior version{priorCount === 1 ? "" : "s"}: {" "}
                                    {r.versions!
                                      .map((v) => `#${v.id} v${v.versionNumber}`)
                                      .join(", ")}
                                  </p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          ) : (
                            <span className="text-[10px] text-slate-500" data-testid={`chip-version-${r.id}`}>v{versionNum}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {r.periodFrom && r.periodTo ? (
                          <span className="text-xs text-gray-600">
                            {formatDate(r.periodFrom)} – {formatDate(r.periodTo)}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">All on record</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {statusBadge(r.status)}
                          {isFailed && r.failureReason && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span
                                    className="inline-flex items-center text-[10px] uppercase tracking-wide bg-red-100 text-red-700 border border-red-200 px-1.5 py-0.5 rounded cursor-help"
                                    data-testid={`chip-reason-${r.id}`}
                                  >
                                    <AlertCircle className="h-3 w-3 mr-1" />
                                    {r.failureReason === "sweeper_timeout"
                                      ? "timeout"
                                      : r.failureReason.slice(0, 24)}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p className="max-w-xs text-xs">{r.failureReason}</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{formatDateTime(r.requestedAt)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {r.status === "ready" && r.downloadUrl ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => downloadReport(r.id, toast)}
                              data-testid={`button-download-report-${r.id}`}
                            >
                              <Download className="h-3.5 w-3.5 mr-1.5" />
                              Download
                            </Button>
                          ) : null}
                          {showRetry && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => regenerate.mutate(r.id)}
                              disabled={regenerate.isPending}
                              data-testid={`button-retry-report-${r.id}`}
                            >
                              <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                              Regenerate
                            </Button>
                          )}
                          {!showRetry && r.status !== "ready" && (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </div>
                      </TableCell>
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
