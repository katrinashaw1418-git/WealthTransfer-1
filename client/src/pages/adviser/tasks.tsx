import { useState } from "react";
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
  DialogDescription,
  DialogFooter,
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
import { Plus, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

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
  // Task #285 — live join fields used to drive the per-row completion gate
  // for KYC follow-ups (only force the notes dialog when the client's KYC
  // is not yet verified).
  clientFirstName: string | null;
  clientLastName: string | null;
  clientEmail: string | null;
  clientKycStatus: string | null;
}

// Task #285 — same compliance gate as the workflow page lives here so the
// legacy /adviser/tasks listing can't bypass the server-side rule.
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
      const tomorrow = new Date();
      tomorrow.setHours(0, 0, 0, 0);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return parsed.getTime() >= tomorrow.getTime();
    }, "Next review date must be in the future"),
});

type KycCompletionForm = z.infer<typeof kycCompletionSchema>;
type ReviewCompletionForm = z.infer<typeof portfolioReviewCompletionSchema>;

function defaultNextReviewIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 90);
  return d.toISOString().slice(0, 10);
}

interface ClientLite {
  userId: number;
  firstName: string;
  lastName: string;
}

// Task #368 — adviser-task surface is locked to the three trigger types
// the automation manages. Manual creation of fee_consent_renewal is
// blocked here too (the route requires a feeConsentId we have no way to
// surface from this generic dialog), leaving the adviser with the two
// types they can manually open: kyc_followup and portfolio_review.
const TASK_TYPES = [
  { value: "portfolio_review", label: "Portfolio review" },
  { value: "kyc_followup", label: "KYC follow-up" },
];
const PRIORITIES = ["low", "normal", "high", "urgent"];

const createTaskFormSchema = z.object({
  clientUserId: z.coerce.number().int().positive(),
  taskType: z.string().min(1, "Required"),
  title: z.string().min(1, "Required").max(200),
  notes: z.string().max(5000).optional(),
  priority: z.string().min(1),
});
type CreateTaskForm = z.infer<typeof createTaskFormSchema>;

function statusBadge(status: string) {
  const variant: "default" | "secondary" | "outline" =
    status === "done" ? "default" : status === "cancelled" ? "outline" : "secondary";
  return (
    <Badge variant={variant} className="capitalize">
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

function priorityBadge(priority: string) {
  const colour =
    priority === "urgent"
      ? "bg-red-100 text-red-800"
      : priority === "high"
        ? "bg-amber-100 text-amber-800"
        : priority === "low"
          ? "bg-gray-100 text-gray-700"
          : "bg-sky-100 text-sky-800";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colour}`}>
      {priority}
    </span>
  );
}

export default function AdviserTasks() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const tasks = useQuery<AdviserTask[]>({ queryKey: ["/api/adviser/tasks"] });
  // /api/adviser/clients now returns { asOfDate, clients } (Task #287). Adapt
  // to the rows-only shape this page uses everywhere downstream.
  const clientsResponse = useQuery<{ asOfDate: string; clients: ClientLite[] }>({
    queryKey: ["/api/adviser/clients"],
  });
  const clients = {
    data: clientsResponse.data?.clients,
    isLoading: clientsResponse.isLoading,
  };

  const form = useForm<CreateTaskForm>({
    resolver: zodResolver(createTaskFormSchema),
    defaultValues: {
      clientUserId: 0,
      taskType: "portfolio_review",
      title: "",
      notes: "",
      priority: "normal",
    },
  });

  const createTask = useMutation({
    mutationFn: async (values: CreateTaskForm) => {
      const res = await apiRequest("POST", "/api/adviser/tasks", values);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/adviser/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/adviser/dashboard"] });
      toast({ title: "Task created" });
      setOpen(false);
      form.reset();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create task", description: err.message, variant: "destructive" });
    },
  });

  // Task #285 — same dialog-driven completion flow as the workflow page.
  // The Done button routes through a per-type gate (KYC notes for
  // unverified-KYC follow-ups; outcome notes + future next-review date
  // for portfolio reviews) before mutating, so the legacy listing can't
  // hit the new server-side 400 from a one-click Done.
  const [activeDialog, setActiveDialog] = useState<
    | { kind: "kyc"; task: AdviserTask }
    | { kind: "review"; task: AdviserTask }
    | null
  >(null);

  const kycForm = useForm<KycCompletionForm>({
    resolver: zodResolver(kycCompletionSchema),
    defaultValues: { completionNotes: "" },
  });
  const reviewForm = useForm<ReviewCompletionForm>({
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
      if (input.nextReviewAt) {
        body.nextReviewAt = new Date(input.nextReviewAt).toISOString();
      }
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

  return (
    <div className="p-6 space-y-6" data-testid="page-adviser-tasks">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tasks</h1>
          <p className="text-sm text-gray-500 mt-1">
            Internal working list. These are not visible to clients.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-new-task">
              <Plus className="h-4 w-4 mr-2" /> New task
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New task</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit((v) => createTask.mutate(v))}
                className="space-y-4"
              >
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
                          <SelectTrigger data-testid="select-client">
                            <SelectValue placeholder="Select a linked client…" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {clients.data?.map((c) => (
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
                  name="taskType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-task-type">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {TASK_TYPES.map((t) => (
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
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Title</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-title" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="priority"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Priority</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-priority">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {PRIORITIES.map((p) => (
                            <SelectItem key={p} value={p}>
                              {p}
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
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Notes (optional)</FormLabel>
                      <FormControl>
                        <Textarea {...field} data-testid="input-notes" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  disabled={createTask.isPending}
                  data-testid="button-submit-task"
                >
                  {createTask.isPending ? "Creating…" : "Create task"}
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All tasks</CardTitle>
        </CardHeader>
        <CardContent>
          {tasks.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !tasks.data || tasks.data.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="text-no-tasks">
              No tasks yet. Click "New task" to add one.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.data.map((t) => (
                  <TableRow key={t.id} data-testid={`row-task-${t.id}`}>
                    <TableCell>
                      <div className="font-medium text-gray-900">{t.title}</div>
                      {t.notes && (
                        <div className="text-xs text-gray-500 truncate max-w-md">{t.notes}</div>
                      )}
                    </TableCell>
                    <TableCell className="capitalize text-sm">
                      {t.taskType.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell>{priorityBadge(t.priority)}</TableCell>
                    <TableCell>{statusBadge(t.status)}</TableCell>
                    <TableCell>
                      {t.status !== "done" && t.status !== "cancelled" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDoneClick(t)}
                          disabled={
                            completeTask.isPending &&
                            completeTask.variables?.id === t.id
                          }
                          data-testid={`button-complete-${t.id}`}
                        >
                          <Check className="h-4 w-4 mr-1" /> Done
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* KYC follow-up completion dialog (Task #285) */}
      <Dialog
        open={activeDialog?.kind === "kyc"}
        onOpenChange={(o) => {
          if (!o) setActiveDialog(null);
        }}
      >
        <DialogContent data-testid="dialog-kyc-completion">
          <DialogHeader>
            <DialogTitle>Close KYC follow-up</DialogTitle>
            <DialogDescription>
              The client's KYC is not yet verified. Please record what action you
              took before closing this task.
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

      {/* Portfolio review completion dialog (Task #285) */}
      <Dialog
        open={activeDialog?.kind === "review"}
        onOpenChange={(o) => {
          if (!o) setActiveDialog(null);
        }}
      >
        <DialogContent data-testid="dialog-portfolio-review-completion">
          <DialogHeader>
            <DialogTitle>Close portfolio review</DialogTitle>
            <DialogDescription>
              Record the outcome of this review and the next scheduled review
              date. Both fields are required.
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
