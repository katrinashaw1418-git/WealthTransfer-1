import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useSearch, useLocation } from "wouter";
import { clientDisplayName } from "@shared/display-name";
import { queryClient, apiRequest, apiFetch } from "@/lib/queryClient";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Plus,
  FileText,
  Download,
  AlertCircle,
  RotateCcw,
  Layers,
  Info,
  MoreHorizontal,
  XCircle,
  History,
  Filter as FilterIcon,
  X as XIcon,
  Inbox,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
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
  // Task #345 — when true, the generated PDF carries an extra DRAFT
  // overlay on every page. Surfaced in the row as a "Draft" badge so
  // the adviser can spot in-review v2s at a glance.
  isDraft?: boolean | null;
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
    // Task #345 — opt-in DRAFT flag. When ticked the generated PDF
    // carries a stronger DRAFT overlay on every page (the standard
    // AMAX brand watermark stays in place either way).
    isDraft: z.boolean().optional().default(false),
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

// Task #299 — distinct, accessible per-status colour palette. Each known
// status renders with a dedicated chip class (no Badge variant fallbacks)
// so adviser eyes can sort the table at a glance:
//   requested  → neutral grey   (waiting in the queue, no action needed)
//   generating → blue + pulse   (actively being built right now)
//   ready      → emerald green  (success — has download link)
//   failed     → red            (terminal error — adviser should regenerate)
//   expired    → amber          (data validity window passed)
//   cancelled  → slate          (adviser cancelled before generation)
//   expired_link → slate (Task #315 — recoverable via Regenerate)
// Anything not in this map renders as a generic outline so a future status
// cannot accidentally appear as "Ready".
const STATUS_BADGE_CLASS: Record<string, string> = {
  requested:
    "bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-100",
  generating:
    "bg-blue-100 text-blue-800 border-blue-300 hover:bg-blue-100 animate-pulse",
  ready:
    "bg-emerald-100 text-emerald-800 border-emerald-300 hover:bg-emerald-100",
  failed:
    "bg-red-100 text-red-800 border-red-300 hover:bg-red-100",
  expired:
    "bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-100",
  expired_link:
    "bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-100",
  cancelled:
    "bg-slate-100 text-slate-600 border-slate-300 hover:bg-slate-100 line-through",
};

const STATUS_LABEL: Record<string, string> = {
  requested: "Requested",
  generating: "Generating",
  ready: "Ready",
  failed: "Failed",
  expired: "Expired",
  expired_link: "Link expired",
  cancelled: "Cancelled",
};

function statusBadge(status: string) {
  const cls = STATUS_BADGE_CLASS[status] ?? "bg-white text-slate-600 border-slate-300";
  const label = STATUS_LABEL[status] ?? status.replace(/_/g, " ");
  return (
    <Badge
      variant="outline"
      className={`font-medium ${cls}`}
      data-testid={`badge-status-${status}`}
    >
      {label}
    </Badge>
  );
}

function reportTypeLabel(type: string): string {
  return REPORT_TYPES.find((t) => t.value === type)?.label ?? type.replace(/_/g, " ");
}

// All known statuses, in fixed display order. Used to render the multi-
// select status filter dropdown — when a user picks none we treat that
// as "show all".
const STATUS_FILTER_KEYS = [
  "requested",
  "generating",
  "ready",
  "failed",
  "expired",
  "expired_link",
  "cancelled",
] as const;
type StatusKey = (typeof STATUS_FILTER_KEYS)[number];
function isStatusKey(s: string): s is StatusKey {
  return (STATUS_FILTER_KEYS as readonly string[]).includes(s);
}

// Status counts strip — kept for at-a-glance summary above the filter bar.
const COUNT_BUCKETS: Array<{ key: StatusKey; label: string; chipClass: string }> = [
  { key: "requested", label: "Requested", chipClass: "bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200" },
  { key: "generating", label: "Generating", chipClass: "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100" },
  { key: "ready", label: "Ready", chipClass: "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100" },
  { key: "failed", label: "Failed", chipClass: "bg-red-50 text-red-700 border-red-200 hover:bg-red-100" },
  { key: "expired", label: "Expired", chipClass: "bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100" },
  { key: "expired_link", label: "Link expired", chipClass: "bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200" },
  { key: "cancelled", label: "Cancelled", chipClass: "bg-slate-100 text-slate-600 border-slate-300 hover:bg-slate-200" },
];

// Audit-log row shape returned by GET /api/adviser/reports/:id/audit-log.
interface AuditLogRow {
  id: number;
  userId: number | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: any;
  createdAt: string | null;
}

// Friendly labels for the audit-log side sheet. Anything not in this map
// renders verbatim so we don't lose information for unforeseen actions.
const AUDIT_ACTION_LABEL: Record<string, string> = {
  adviser_report_requested: "Requested",
  adviser_report_generated: "Generated",
  adviser_report_failed: "Failed",
  adviser_report_downloaded: "Downloaded",
  adviser_report_regenerated: "Regenerated",
  adviser_report_superseded: "Superseded",
  adviser_report_cancelled: "Cancelled",
  adviser_report_expired: "Auto-expired",
  adviser_report_link_expired: "Link expired",
};

export default function AdviserReports() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  // Task #299 — id of the report whose audit-log side sheet is open.
  // Null means no sheet is currently open.
  const [auditOpenForId, setAuditOpenForId] = useState<number | null>(null);

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
      isDraft: false,
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
        isDraft: false,
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

  // Task #299 — Cancel. Only enabled in the row-actions menu when status
  // is requested or generating (server enforces the same rule with 409).
  const cancel = useMutation({
    mutationFn: async (reportId: number) => {
      const res = await apiRequest("POST", `/api/adviser/reports/${reportId}/cancel`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/adviser/reports"] });
      toast({
        title: "Report cancelled",
        description: "The request has been cancelled and will not be generated.",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Cancel failed",
        description: err?.body?.error ?? err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  // Task #299 — URL-synced filter bar. We use wouter's useSearch hook (live
  // querystring) plus useLocation to push updates without leaving the page.
  // Recognised params:
  //   client     → linked client userId or "all"
  //   type       → report type or "all"
  //   status     → comma-separated subset of STATUS_FILTER_KEYS (omit = all)
  //   from / to  → YYYY-MM-DD; matches r.requestedAt within the inclusive range
  const searchString = useSearch();
  const [, setLocation] = useLocation();

  const filters = useMemo(() => {
    const params = new URLSearchParams(searchString);
    const rawClient = params.get("client") ?? "all";
    const clientUserId =
      rawClient === "all" || !/^\d+$/.test(rawClient) ? "all" : rawClient;
    const rawType = params.get("type") ?? "all";
    const type =
      REPORT_TYPES.some((t) => t.value === rawType) ? rawType : "all";
    const rawStatus = params.get("status") ?? "";
    const statuses: StatusKey[] = rawStatus
      .split(",")
      .map((s) => s.trim())
      .filter(isStatusKey);
    const rawFrom = params.get("from") ?? "";
    const rawTo = params.get("to") ?? "";
    const from = isoDateRe.test(rawFrom) ? rawFrom : "";
    const to = isoDateRe.test(rawTo) ? rawTo : "";
    return { clientUserId, type, statuses, from, to };
  }, [searchString]);

  const updateFilter = useCallback(
    (next: {
      client?: string;
      type?: string;
      statuses?: StatusKey[];
      from?: string;
      to?: string;
    }) => {
      const params = new URLSearchParams(searchString);
      const setOrDelete = (key: string, value: string | undefined) => {
        if (!value || value === "" || value === "all") params.delete(key);
        else params.set(key, value);
      };
      if (next.client !== undefined) setOrDelete("client", next.client);
      if (next.type !== undefined) setOrDelete("type", next.type);
      if (next.statuses !== undefined) {
        if (next.statuses.length === 0) params.delete("status");
        else params.set("status", next.statuses.join(","));
      }
      if (next.from !== undefined) setOrDelete("from", next.from);
      if (next.to !== undefined) setOrDelete("to", next.to);
      const qs = params.toString();
      setLocation(qs ? `/adviser/reports?${qs}` : "/adviser/reports", {
        replace: true,
      });
    },
    [searchString, setLocation],
  );

  const counts = reports.data?.counts ?? {};
  const allRows = reports.data?.rows ?? [];

  const filtered = useMemo(() => {
    let rows = allRows;
    if (filters.clientUserId !== "all") {
      const cid = Number(filters.clientUserId);
      rows = rows.filter((r) => r.clientUserId === cid);
    }
    if (filters.type !== "all") {
      rows = rows.filter((r) => r.reportType === filters.type);
    }
    if (filters.statuses.length > 0) {
      const set = new Set<string>(filters.statuses);
      rows = rows.filter((r) => set.has(r.status));
    }
    if (filters.from) {
      // YYYY-MM-DD < ISO timestamp comparison works lexicographically because
      // both are zero-padded ISO-8601. Inclusive bounds at day granularity:
      // include any row whose requestedAt date >= from.
      rows = rows.filter((r) =>
        r.requestedAt ? r.requestedAt.slice(0, 10) >= filters.from : false,
      );
    }
    if (filters.to) {
      rows = rows.filter((r) =>
        r.requestedAt ? r.requestedAt.slice(0, 10) <= filters.to : false,
      );
    }
    return rows;
  }, [allRows, filters]);

  const filtersActive =
    filters.clientUserId !== "all" ||
    filters.type !== "all" ||
    filters.statuses.length > 0 ||
    filters.from !== "" ||
    filters.to !== "";

  // -----------------------------------------------------------------------
  // Audit-log side sheet — fetch on demand, keyed by the open report id so
  // closing & reopening the sheet for the same report uses the cache, while
  // switching to a different report fetches fresh rows.
  // -----------------------------------------------------------------------
  const auditQuery = useQuery<{ items: AuditLogRow[] }>({
    queryKey: ["/api/adviser/reports", auditOpenForId, "audit-log"],
    enabled: auditOpenForId != null,
    // Explicit queryFn — the default fetcher uses queryKey[0] which would
    // hit /api/adviser/reports (the list endpoint) and silently return the
    // wrong payload shape. Build the per-id URL from queryKey[1].
    queryFn: async ({ queryKey }) => {
      const id = queryKey[1] as number;
      const res = await apiFetch(`/api/adviser/reports/${id}/audit-log`);
      return res.json();
    },
  });

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
                {/* Task #345 — opt-in DRAFT flag. Sits next to notes
                    rather than at the top of the form so the default
                    (final report) stays the path of least resistance —
                    the adviser only ticks this when they're previewing
                    or sharing for review. */}
                <FormField
                  control={form.control}
                  name="isDraft"
                  render={({ field }) => (
                    <FormItem className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50/40 p-3">
                      <FormControl>
                        <Checkbox
                          checked={field.value === true}
                          onCheckedChange={(v) => field.onChange(v === true)}
                          data-testid="checkbox-report-draft"
                          className="mt-0.5"
                        />
                      </FormControl>
                      <div className="space-y-0.5">
                        <FormLabel className="text-sm font-medium text-amber-900">
                          Mark as draft
                        </FormLabel>
                        <p className="text-xs text-amber-800">
                          Stamps a strong "DRAFT" overlay on every page
                          so a preview or in-review copy can't be
                          mistaken for a final statement.
                        </p>
                      </div>
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

      {/* Status counts strip — at-a-glance summary; clicking a bucket sets
          the URL `status` filter to that single status. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="strip-status-counts">
        <button
          type="button"
          onClick={() => updateFilter({ statuses: [] })}
          className={`text-xs font-medium px-3 py-1.5 rounded-full border transition ${
            filters.statuses.length === 0
              ? "bg-slate-900 text-white border-slate-900"
              : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
          }`}
          data-testid="chip-count-all"
        >
          All ({allRows.length})
        </button>
        {COUNT_BUCKETS.map((b) => {
          const n = counts[b.key] ?? 0;
          const active =
            filters.statuses.length === 1 && filters.statuses[0] === b.key;
          return (
            <button
              key={b.key}
              type="button"
              onClick={() => updateFilter({ statuses: active ? [] : [b.key] })}
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

      {/* Task #299 — URL-synced filter bar. Lives above the table so the
          state of the filters is always visible alongside the rows they're
          narrowing down. Sharing the URL preserves the same view for the
          recipient. */}
      <Card data-testid="card-filter-bar">
        <CardContent className="py-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1 min-w-[180px]">
              <label className="text-xs text-slate-500">Client</label>
              <Select
                value={filters.clientUserId}
                onValueChange={(v) => updateFilter({ client: v })}
              >
                <SelectTrigger data-testid="filter-client" className="h-9">
                  <SelectValue placeholder="All clients" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All clients</SelectItem>
                  {clients?.map((c) => (
                    <SelectItem key={c.userId} value={String(c.userId)}>
                      {clientDisplayName(c, c.userId)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1 min-w-[180px]">
              <label className="text-xs text-slate-500">Type</label>
              <Select
                value={filters.type}
                onValueChange={(v) => updateFilter({ type: v })}
              >
                <SelectTrigger data-testid="filter-type" className="h-9">
                  <SelectValue placeholder="All types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {REPORT_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500">Status</label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    className="h-9 justify-start font-normal min-w-[180px]"
                    data-testid="filter-status"
                  >
                    <FilterIcon className="h-3.5 w-3.5 mr-2 text-slate-500" />
                    {filters.statuses.length === 0
                      ? "All statuses"
                      : filters.statuses.length === 1
                        ? STATUS_LABEL[filters.statuses[0]]
                        : `${filters.statuses.length} selected`}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuLabel>Filter by status</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {STATUS_FILTER_KEYS.map((s) => {
                    const checked = filters.statuses.includes(s);
                    return (
                      <DropdownMenuCheckboxItem
                        key={s}
                        checked={checked}
                        onCheckedChange={(next) => {
                          const set = new Set(filters.statuses);
                          if (next) set.add(s);
                          else set.delete(s);
                          updateFilter({
                            statuses: STATUS_FILTER_KEYS.filter((k) => set.has(k)),
                          });
                        }}
                        data-testid={`filter-status-option-${s}`}
                      >
                        {STATUS_LABEL[s]}
                      </DropdownMenuCheckboxItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500">Requested from</label>
              <Input
                type="date"
                className="h-9 w-[160px]"
                value={filters.from}
                max={filters.to || undefined}
                onChange={(e) => updateFilter({ from: e.target.value })}
                data-testid="filter-from"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500">Requested to</label>
              <Input
                type="date"
                className="h-9 w-[160px]"
                value={filters.to}
                min={filters.from || undefined}
                onChange={(e) => updateFilter({ to: e.target.value })}
                data-testid="filter-to"
              />
            </div>

            {filtersActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  updateFilter({
                    client: "all",
                    type: "all",
                    statuses: [],
                    from: "",
                    to: "",
                  })
                }
                data-testid="filter-clear"
              >
                <XIcon className="h-3.5 w-3.5 mr-1.5" /> Clear filters
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4 text-violet-500" />
            Your report requests
            {filtersActive && (
              <span className="text-xs font-normal text-slate-500">
                · {filtered.length} of {allRows.length} shown
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
          ) : reports.isError ? (
            // Task #299 — explicit error state so a fetch failure does not
            // silently appear as "no reports yet" (which it would have under
            // the previous fallthrough).
            <div
              className="flex flex-col items-center justify-center py-12 text-center"
              data-testid="state-reports-error"
            >
              <div className="rounded-full bg-red-50 p-3 mb-3">
                <AlertTriangle className="h-6 w-6 text-red-600" />
              </div>
              <h3 className="text-sm font-semibold text-slate-900">
                Couldn't load your reports
              </h3>
              <p className="text-xs text-slate-500 mt-1 max-w-md">
                {(reports.error as Error)?.message ??
                  "The server didn't respond. Try again, and if the problem persists, contact your platform admin."}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-4"
                onClick={() => reports.refetch()}
                data-testid="button-reports-retry"
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            // Task #299 — distinct empty states. If the adviser hasn't
            // requested any reports at all, the empty state doubles as a
            // primary CTA. If the user has rows but they're filtered out,
            // we show a softer state with a Clear filters shortcut.
            allRows.length === 0 ? (
              <div
                className="flex flex-col items-center justify-center py-12 text-center"
                data-testid="state-reports-empty-first"
              >
                <div className="rounded-full bg-violet-50 p-3 mb-3">
                  <Inbox className="h-6 w-6 text-violet-600" />
                </div>
                <h3 className="text-sm font-semibold text-slate-900">
                  No reports yet
                </h3>
                <p className="text-xs text-slate-500 mt-1 max-w-md">
                  Generate a portfolio summary, fee summary, transaction
                  history or full statement for any of your linked clients.
                  Downloads stay available for 7 days.
                </p>
                <Button
                  size="sm"
                  className="mt-4"
                  onClick={() => setOpen(true)}
                  data-testid="button-empty-request-first"
                >
                  <Plus className="h-4 w-4 mr-1.5" /> Request your first report
                </Button>
              </div>
            ) : (
              <div
                className="flex flex-col items-center justify-center py-10 text-center"
                data-testid="state-reports-empty-filtered"
              >
                <div className="rounded-full bg-slate-100 p-3 mb-3">
                  <FilterIcon className="h-6 w-6 text-slate-500" />
                </div>
                <h3 className="text-sm font-semibold text-slate-900">
                  No reports match the current filters
                </h3>
                <p className="text-xs text-slate-500 mt-1 max-w-md">
                  Try removing one of the filters or widening the date range.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-4"
                  onClick={() =>
                    updateFilter({
                      client: "all",
                      type: "all",
                      statuses: [],
                      from: "",
                      to: "",
                    })
                  }
                  data-testid="button-empty-clear-filters"
                >
                  <XIcon className="h-3.5 w-3.5 mr-1.5" /> Clear filters
                </Button>
              </div>
            )
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
                        <div className="flex items-center gap-2 flex-wrap">
                          {statusBadge(r.status)}
                          {/* Task #345 — Draft badge. Surfaced next to
                              the status pill so an adviser scanning the
                              list can spot in-review v2s without opening
                              each PDF. */}
                          {r.isDraft && (
                            <Badge
                              variant="outline"
                              className="font-medium bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-100"
                              data-testid={`badge-draft-${r.id}`}
                            >
                              Draft
                            </Badge>
                          )}
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
                        {/* Task #299 — single row-actions menu. Each item is
                            disabled when its precondition isn't met (e.g.
                            Cancel only for in-flight reports) so we never
                            present an action that would reliably 4xx. */}
                        <div className="flex items-center justify-end gap-2">
                          {r.status === "ready" && r.downloadUrl && (
                            // Keep Download as a primary inline button so the
                            // most common action is one click away.
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => downloadReport(r.id, toast)}
                              data-testid={`button-download-report-${r.id}`}
                            >
                              <Download className="h-3.5 w-3.5 mr-1.5" />
                              Download
                            </Button>
                          )}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                data-testid={`button-row-actions-${r.id}`}
                                aria-label="Row actions"
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                              <DropdownMenuItem
                                disabled={!(r.status === "ready" && r.downloadUrl)}
                                onClick={() => downloadReport(r.id, toast)}
                                data-testid={`menu-download-${r.id}`}
                              >
                                <Download className="h-3.5 w-3.5 mr-2" />
                                Download
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={!showRetry || regenerate.isPending}
                                onClick={() => regenerate.mutate(r.id)}
                                data-testid={`menu-regenerate-${r.id}`}
                              >
                                <RotateCcw className="h-3.5 w-3.5 mr-2" />
                                Regenerate
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={
                                  !(r.status === "requested" || r.status === "generating") ||
                                  cancel.isPending
                                }
                                onClick={() => cancel.mutate(r.id)}
                                className="text-red-600 focus:text-red-700"
                                data-testid={`menu-cancel-${r.id}`}
                              >
                                <XCircle className="h-3.5 w-3.5 mr-2" />
                                Cancel
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => setAuditOpenForId(r.id)}
                                data-testid={`menu-audit-${r.id}`}
                              >
                                <History className="h-3.5 w-3.5 mr-2" />
                                View audit log
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
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

      {/* Task #299 — Audit log side sheet. Populated on demand when an
          adviser picks "View audit log" from the row-actions menu. */}
      <Sheet
        open={auditOpenForId != null}
        onOpenChange={(o) => {
          if (!o) setAuditOpenForId(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-[480px] sm:max-w-[480px] overflow-y-auto"
          data-testid="sheet-audit-log"
        >
          <SheetHeader>
            <SheetTitle>
              Audit log
              {auditOpenForId != null && (
                <span className="text-sm font-normal text-slate-500 ml-2">
                  Report #{auditOpenForId}
                </span>
              )}
            </SheetTitle>
            <SheetDescription>
              Every lifecycle event for this report — request, generation,
              downloads, regenerations and expiry — is recorded for auditors.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-4 space-y-3">
            {auditQuery.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : auditQuery.isError ? (
              <div
                className="text-sm text-red-600 flex items-start gap-2"
                data-testid="audit-log-error"
              >
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-medium">Couldn't load audit log</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {(auditQuery.error as Error)?.message ?? "Unknown error"}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => auditQuery.refetch()}
                    data-testid="audit-log-retry"
                  >
                    <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
                  </Button>
                </div>
              </div>
            ) : (auditQuery.data?.items ?? []).length === 0 ? (
              <p className="text-sm text-slate-500" data-testid="audit-log-empty">
                No audit events yet for this report.
              </p>
            ) : (
              <ol className="relative border-l border-slate-200 pl-4 space-y-3">
                {auditQuery.data!.items.map((row) => (
                  <li key={row.id} data-testid={`audit-log-item-${row.id}`}>
                    <span className="absolute -left-1.5 mt-1 h-3 w-3 rounded-full border border-slate-300 bg-white" />
                    <div className="text-sm font-medium text-slate-900">
                      {AUDIT_ACTION_LABEL[row.action] ?? row.action}
                    </div>
                    <div className="text-xs text-slate-500">
                      {formatDateTime(row.createdAt)}
                      {row.userId != null ? ` · user #${row.userId}` : " · system"}
                    </div>
                    {row.metadata && Object.keys(row.metadata).length > 0 && (
                      <pre className="mt-1 text-[11px] bg-slate-50 border border-slate-200 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words text-slate-700">
                        {JSON.stringify(row.metadata, null, 2)}
                      </pre>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
