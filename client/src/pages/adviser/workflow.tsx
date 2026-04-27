import { Fragment, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { clientDisplayName } from "@shared/display-name";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
  ListChecks,
  ClipboardCheck,
  AlertTriangle,
  Check,
  Clock,
  ChevronDown,
  ChevronRight,
  ArrowRight,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// =============================================================================
// Task #285 — adviser workflow page
// -----------------------------------------------------------------------------
// Three classes of fixes consolidated here:
//
//   1. Data display:
//      * Each task row renders the LIVE client name (sourced from the new
//        join on /api/adviser/tasks) in a dedicated Client column. Old rows
//        whose stored title says "Follow up KYC for Client #22" still
//        render the correct current name in this column.
//      * The full description is hidden behind a chevron-expand and only
//        appears on demand. Defaults to collapsed.
//
//   2. Compliance gates:
//      * Done on a `kyc_followup` opens a small note-required dialog
//        UNLESS the linked client's current KYC is already verified, in
//        which case it closes with a single click.
//      * Done on a `portfolio_review` opens a dialog requiring
//        non-empty review-outcome notes AND a future next-review date.
//      * Both gates are also enforced server-side; this UI is a courtesy.
//
//   3. Workflow page UX:
//      * Column order: Client / Task / Type / Due / Priority / Action.
//      * The Done CTA is a clear primary/outline button, not a muted ghost.
//      * Pending reports stat card sub-line + footer link reworded.
//      * Fee-consents card surfaces the next-expiry detail when the count
//        is zero (pulled from the dashboard summary endpoint).
//      * Empty instructions state has a CTA back to /adviser/clients.
// =============================================================================

interface AdviserTask {
  id: number;
  clientUserId: number;
  taskType: string;
  title: string;
  notes: string | null;
  status: string;
  priority: string;
  dueAt: string | null;
  completedAt: string | null;
  completionNotes: string | null;
  nextReviewAt: string | null;
  createdAt: string | null;
  clientFirstName: string | null;
  clientLastName: string | null;
  clientEmail: string | null;
  clientKycStatus: string | null;
}

interface InstructionRow {
  id: number;
  clientUserId: number;
  productId: number;
  action: string;
  amount: string;
  status: string;
  createdAt: string | null;
  clientFirstName: string;
  clientLastName: string;
  productName: string;
}

interface NextFeeConsentExpiry {
  feeConsentId: number;
  clientUserId: number;
  clientName: string;
  expiryDate: string;
}

interface DashboardSummary {
  linkedClients: number;
  openTasks: number;
  feeConsentsExpiringSoon: number;
  pendingReports: number;
  nextFeeConsentExpiry: NextFeeConsentExpiry | null;
}

function priorityScore(priority: string): number {
  switch (priority) {
    case "urgent":
      return 3;
    case "high":
      return 2;
    case "low":
      return 0;
    default:
      return 1;
  }
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString("en-AU", { month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

function formatLongDate(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

function formatAud(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 0,
  }).format(n);
}

// HTML date inputs require yyyy-mm-dd; default to 90 days from today as the
// next-review default (the cron's quarterly cadence).
function defaultNextReviewIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 90);
  return d.toISOString().slice(0, 10);
}

const kycCompletionSchema = z.object({
  completionNotes: z.string().trim().min(1, "Please describe what action you took"),
});

const portfolioReviewCompletionSchema = z.object({
  completionNotes: z.string().trim().min(1, "Outcome notes are required"),
  nextReviewAt: z
    .string()
    .min(1, "Next review date is required")
    .refine((v) => {
      const parsed = new Date(v);
      if (Number.isNaN(parsed.getTime())) return false;
      // Must be strictly in the future (compare against tomorrow midnight to
      // be friendly to today's timezone).
      const tomorrow = new Date();
      tomorrow.setHours(0, 0, 0, 0);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return parsed.getTime() >= tomorrow.getTime();
    }, "Next review date must be in the future"),
});

type KycForm = z.infer<typeof kycCompletionSchema>;
type ReviewForm = z.infer<typeof portfolioReviewCompletionSchema>;

export default function AdviserWorkflow() {
  const { toast } = useToast();

  const tasks = useQuery<AdviserTask[]>({ queryKey: ["/api/adviser/tasks"] });
  const instructions = useQuery<InstructionRow[]>({ queryKey: ["/api/adviser/instructions"] });
  const summary = useQuery<DashboardSummary>({ queryKey: ["/api/adviser/dashboard"] });

  // Track which task rows are expanded to show their description.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpanded = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Completion-dialog state. Only one dialog is open at a time; the type
  // discriminator selects which form renders.
  const [activeDialog, setActiveDialog] = useState<
    | { kind: "kyc"; task: AdviserTask }
    | { kind: "review"; task: AdviserTask }
    | null
  >(null);

  const kycForm = useForm<KycForm>({
    resolver: zodResolver(kycCompletionSchema),
    defaultValues: { completionNotes: "" },
  });
  const reviewForm = useForm<ReviewForm>({
    resolver: zodResolver(portfolioReviewCompletionSchema),
    defaultValues: { completionNotes: "", nextReviewAt: defaultNextReviewIso() },
  });

  const completeTask = useMutation({
    mutationFn: async (input: {
      id: number;
      completionNotes?: string;
      nextReviewAt?: string;
    }) => {
      const body: Record<string, unknown> = { status: "done" };
      if (input.completionNotes) body.completionNotes = input.completionNotes;
      if (input.nextReviewAt) body.nextReviewAt = new Date(input.nextReviewAt).toISOString();
      const res = await apiRequest("PATCH", `/api/adviser/tasks/${input.id}`, body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/adviser/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/adviser/dashboard"] });
      toast({ title: "Task marked done" });
      setActiveDialog(null);
      kycForm.reset({ completionNotes: "" });
      reviewForm.reset({ completionNotes: "", nextReviewAt: defaultNextReviewIso() });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    },
  });

  const openTasks = useMemo(
    () =>
      (tasks.data ?? [])
        .filter((t) => t.status === "open" || t.status === "in_progress")
        .sort((a, b) => {
          const p = priorityScore(b.priority) - priorityScore(a.priority);
          if (p !== 0) return p;
          // Older tasks first if same priority
          const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return at - bt;
        }),
    [tasks.data],
  );

  const pendingInstructions = useMemo(
    () => (instructions.data ?? []).filter((i) => i.status === "pending_consent"),
    [instructions.data],
  );

  const urgentCount = openTasks.filter((t) => t.priority === "urgent" || t.priority === "high").length;

  // Click handler for the Done button: routes to the right dialog or
  // closes the task immediately depending on the type + KYC state.
  const handleDoneClick = (task: AdviserTask) => {
    if (task.taskType === "portfolio_review") {
      reviewForm.reset({
        completionNotes: "",
        nextReviewAt: defaultNextReviewIso(),
      });
      setActiveDialog({ kind: "review", task });
      return;
    }
    if (task.taskType === "kyc_followup") {
      const verified = task.clientKycStatus === "verified";
      if (!verified) {
        kycForm.reset({ completionNotes: "" });
        setActiveDialog({ kind: "kyc", task });
        return;
      }
    }
    completeTask.mutate({ id: task.id });
  };

  const renderClientCell = (task: AdviserTask) => {
    const label = clientDisplayName(
      {
        firstName: task.clientFirstName,
        lastName: task.clientLastName,
        email: task.clientEmail,
      },
      task.clientUserId,
    );
    return (
      <Link
        href={`/adviser/clients/${task.clientUserId}`}
        className="text-sky-700 hover:text-sky-800 hover:underline font-medium"
        data-testid={`link-task-client-${task.id}`}
      >
        {label}
      </Link>
    );
  };

  const renderFeeExpiringSubline = () => {
    if (summary.isLoading) return null;
    const count = summary.data?.feeConsentsExpiringSoon ?? 0;
    if (count > 0) {
      return (
        <p className="text-[11px] text-slate-500 mt-1">
          Renew before lapse to keep deductions valid
        </p>
      );
    }
    const next = summary.data?.nextFeeConsentExpiry ?? null;
    if (!next) {
      return (
        <p className="text-[11px] text-slate-500 mt-1" data-testid="text-fee-next-expiry">
          No active fee consents
        </p>
      );
    }
    return (
      <p className="text-[11px] text-slate-500 mt-1" data-testid="text-fee-next-expiry">
        Next expiry: {formatLongDate(next.expiryDate)} · {next.clientName}
      </p>
    );
  };

  return (
    <div className="p-6 space-y-6" data-testid="page-adviser-workflow">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <ListChecks className="h-6 w-6 text-slate-500" />
          Workflow
        </h1>
        <p className="text-sm text-slate-500 mt-1 max-w-2xl">
          Your live priority queue. Open tasks, instructions requiring client consent, and the
          items that need attention this week — in one place.
        </p>
      </div>

      {/* Priority strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-slate-200 bg-white">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium text-slate-600">Open tasks</CardTitle>
            <ListChecks className="h-4 w-4 text-slate-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900" data-testid="metric-open-tasks">
              {tasks.isLoading ? <Skeleton className="h-7 w-10" /> : openTasks.length}
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              {urgentCount} urgent / high
            </p>
          </CardContent>
        </Card>
        <Card className="border-sky-200 bg-sky-50/40">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium text-slate-600">Client consent required</CardTitle>
            <ClipboardCheck className="h-4 w-4 text-sky-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900" data-testid="metric-pending-consent">
              {instructions.isLoading ? <Skeleton className="h-7 w-10" /> : pendingInstructions.length}
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              No funds move until the client approves
            </p>
          </CardContent>
        </Card>
        <Card className="border-rose-200 bg-rose-50/40">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium text-slate-600">Fee consents expiring ≤30d</CardTitle>
            <AlertTriangle className="h-4 w-4 text-rose-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900" data-testid="metric-fee-expiring">
              {summary.isLoading ? <Skeleton className="h-7 w-10" /> : summary.data?.feeConsentsExpiringSoon ?? 0}
            </div>
            {renderFeeExpiringSubline()}
          </CardContent>
        </Card>
        <Card className="border-violet-200 bg-violet-50/40">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium text-slate-600">Pending reports</CardTitle>
            <Clock className="h-4 w-4 text-violet-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900" data-testid="metric-pending-reports">
              {summary.isLoading ? <Skeleton className="h-7 w-10" /> : summary.data?.pendingReports ?? 0}
            </div>
            <p className="text-[11px] text-slate-500 mt-1" data-testid="text-pending-reports-subline">
              {(summary.data?.pendingReports ?? 0)} awaiting generation
            </p>
            <p className="text-[11px] mt-1">
              <Link
                href="/adviser/reports"
                className="text-violet-600 hover:underline inline-flex items-center gap-1"
                data-testid="link-view-reports"
              >
                View reports <ArrowRight className="h-3 w-3" />
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Pending instructions */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-sky-500" />
            Instructions requiring client consent
          </CardTitle>
          <Link href="/adviser/instructions">
            <Button variant="outline" size="sm" data-testid="button-view-all-instructions">
              View all
            </Button>
          </Link>
        </CardHeader>
        <CardContent>
          {instructions.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : pendingInstructions.length === 0 ? (
            <div className="space-y-2" data-testid="empty-pending-consent">
              <p className="text-sm text-slate-600" data-testid="text-no-pending-consent">
                No instructions are currently waiting for client consent.
              </p>
              <p className="text-xs text-slate-500">
                To send an investment instruction for client consent, open a client record
                and use the instruction workflow.
              </p>
              <p className="text-xs">
                <Link
                  href="/adviser/clients"
                  className="text-sky-600 hover:underline inline-flex items-center gap-1"
                  data-testid="link-view-clients"
                >
                  View clients <ArrowRight className="h-3 w-3" />
                </Link>
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sent</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingInstructions.slice(0, 8).map((i) => (
                  <TableRow key={i.id} data-testid={`row-pending-instruction-${i.id}`}>
                    <TableCell className="text-sm">{formatDate(i.createdAt)}</TableCell>
                    <TableCell className="text-sm font-medium">
                      {i.clientFirstName} {i.clientLastName}
                    </TableCell>
                    <TableCell className="text-sm capitalize">{i.action}</TableCell>
                    <TableCell className="text-sm">{i.productName}</TableCell>
                    <TableCell className="text-sm tabular-nums text-right">
                      {formatAud(i.amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Open tasks */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-slate-500" />
            Open tasks (priority order)
          </CardTitle>
          <Link href="/adviser/tasks">
            <Button variant="outline" size="sm" data-testid="button-view-all-tasks">
              View all
            </Button>
          </Link>
        </CardHeader>
        <CardContent>
          {tasks.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : openTasks.length === 0 ? (
            <p className="text-sm text-slate-500" data-testid="text-no-open-tasks">
              No open tasks. You're clear.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Task</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {openTasks.slice(0, 10).map((t) => {
                  const colour =
                    t.priority === "urgent"
                      ? "bg-rose-100 text-rose-800"
                      : t.priority === "high"
                        ? "bg-slate-200 text-slate-800"
                        : t.priority === "low"
                          ? "bg-slate-100 text-slate-700"
                          : "bg-sky-100 text-sky-800";
                  const isOpen = expanded.has(t.id);
                  const isCompleting =
                    completeTask.isPending && completeTask.variables?.id === t.id;
                  return (
                    <Fragment key={t.id}>
                      <TableRow data-testid={`row-task-${t.id}`}>
                        <TableCell className="text-sm whitespace-nowrap">
                          {renderClientCell(t)}
                        </TableCell>
                        <TableCell className="text-sm">
                          <button
                            type="button"
                            onClick={() => toggleExpanded(t.id)}
                            className="flex items-center gap-1 text-left font-medium text-slate-900 hover:text-slate-700"
                            data-testid={`button-expand-task-${t.id}`}
                            aria-expanded={isOpen}
                          >
                            {isOpen ? (
                              <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                            )}
                            <span>{t.title}</span>
                          </button>
                        </TableCell>
                        <TableCell className="text-sm capitalize text-slate-600">
                          {t.taskType.replace(/_/g, " ")}
                        </TableCell>
                        <TableCell className="text-sm text-slate-600">{formatDate(t.dueAt)}</TableCell>
                        <TableCell>
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colour}`}>
                            {t.priority}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="default"
                            size="sm"
                            onClick={() => handleDoneClick(t)}
                            disabled={isCompleting}
                            data-testid={`button-complete-task-${t.id}`}
                          >
                            <Check className="h-4 w-4 mr-1" />
                            Done
                          </Button>
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow
                          data-testid={`row-task-detail-${t.id}`}
                          className="bg-slate-50/60"
                        >
                          <TableCell colSpan={6} className="text-xs text-slate-600">
                            <div className="space-y-1 pl-5">
                              <div>
                                <span className="font-semibold text-slate-700">Description:</span>{" "}
                                {t.notes ? t.notes : <span className="text-slate-400">No description provided.</span>}
                              </div>
                              {t.completionNotes && (
                                <div>
                                  <span className="font-semibold text-slate-700">Completion notes:</span>{" "}
                                  {t.completionNotes}
                                </div>
                              )}
                              {t.nextReviewAt && (
                                <div>
                                  <span className="font-semibold text-slate-700">Next review:</span>{" "}
                                  {formatLongDate(t.nextReviewAt)}
                                </div>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* KYC follow-up completion dialog */}
      <Dialog
        open={activeDialog?.kind === "kyc"}
        onOpenChange={(open) => {
          if (!open) setActiveDialog(null);
        }}
      >
        <DialogContent data-testid="dialog-kyc-completion">
          <DialogHeader>
            <DialogTitle>Close KYC follow-up</DialogTitle>
            <DialogDescription>
              The client's KYC is not yet verified. Please record what action you took
              before closing this task.
            </DialogDescription>
          </DialogHeader>
          <Form {...kycForm}>
            <form
              onSubmit={kycForm.handleSubmit((values) => {
                if (activeDialog?.kind !== "kyc") return;
                completeTask.mutate({
                  id: activeDialog.task.id,
                  completionNotes: values.completionNotes,
                });
              })}
              className="space-y-4"
            >
              <FormField
                control={kycForm.control}
                name="completionNotes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>What action did you take?</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={4}
                        placeholder="e.g. Sent reminder email and uploaded passport copy."
                        {...field}
                        data-testid="input-kyc-notes"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setActiveDialog(null)}
                  data-testid="button-kyc-cancel"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={completeTask.isPending}
                  data-testid="button-kyc-submit"
                >
                  {completeTask.isPending ? "Saving…" : "Save and complete"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Portfolio review completion dialog */}
      <Dialog
        open={activeDialog?.kind === "review"}
        onOpenChange={(open) => {
          if (!open) setActiveDialog(null);
        }}
      >
        <DialogContent data-testid="dialog-portfolio-review-completion">
          <DialogHeader>
            <DialogTitle>Close portfolio review</DialogTitle>
            <DialogDescription>
              Record the outcome of this review and the next scheduled review date.
              Both fields are required.
            </DialogDescription>
          </DialogHeader>
          <Form {...reviewForm}>
            <form
              onSubmit={reviewForm.handleSubmit((values) => {
                if (activeDialog?.kind !== "review") return;
                completeTask.mutate({
                  id: activeDialog.task.id,
                  completionNotes: values.completionNotes,
                  nextReviewAt: values.nextReviewAt,
                });
              })}
              className="space-y-4"
            >
              <FormField
                control={reviewForm.control}
                name="completionNotes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Review outcome notes</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={4}
                        placeholder="Summary of the review discussion, agreed actions, etc."
                        {...field}
                        data-testid="input-review-notes"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={reviewForm.control}
                name="nextReviewAt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Next review date</FormLabel>
                    <FormControl>
                      <Input
                        type="date"
                        {...field}
                        data-testid="input-next-review-date"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setActiveDialog(null)}
                  data-testid="button-review-cancel"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={completeTask.isPending}
                  data-testid="button-review-submit"
                >
                  {completeTask.isPending ? "Saving…" : "Save and complete"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
