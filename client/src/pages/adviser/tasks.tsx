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
  createdAt: string | null;
}

interface ClientLite {
  userId: number;
  firstName: string;
  lastName: string;
}

const TASK_TYPES = [
  { value: "portfolio_review", label: "Portfolio review" },
  { value: "fee_consent_renewal", label: "Fee consent renewal" },
  { value: "kyc_followup", label: "KYC follow-up" },
  { value: "document_request", label: "Document request" },
  { value: "meeting_prep", label: "Meeting prep" },
  { value: "other", label: "Other" },
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
  const clients = useQuery<ClientLite[]>({ queryKey: ["/api/adviser/clients"] });

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

  const completeTask = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("PATCH", `/api/adviser/tasks/${id}`, { status: "done" });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/adviser/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/adviser/dashboard"] });
      toast({ title: "Task marked done" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    },
  });

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
                              {/* Task #283 — name -> email -> Client #<id> */}
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
                          onClick={() => completeTask.mutate(t.id)}
                          disabled={completeTask.isPending}
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
    </div>
  );
}
