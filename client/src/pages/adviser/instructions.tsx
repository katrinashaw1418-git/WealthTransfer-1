import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
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
import { Plus, ClipboardList, ShieldAlert } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

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
  clientFirstName: string;
  clientLastName: string;
  clientEmail: string;
  productName: string;
  productCategory: string;
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
}

const ACTIONS = [
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Sell" },
  { value: "switch", label: "Switch" },
];

const createInstructionFormSchema = z.object({
  clientUserId: z.coerce.number().int().positive("Select a client"),
  productId: z.coerce.number().int().positive("Select a product"),
  action: z.enum(["buy", "sell", "switch"]),
  amount: z
    .string()
    .min(1, "Required")
    .regex(/^\d+(\.\d{1,2})?$/, "Must be a number with up to 2 dp")
    .refine((v) => Number(v) > 0, "Must be greater than 0"),
  notes: z.string().max(2000).optional(),
});
type CreateInstructionForm = z.infer<typeof createInstructionFormSchema>;

function statusBadge(status: string) {
  const map: Record<string, { variant: "default" | "secondary" | "outline" | "destructive"; label: string }> = {
    pending_consent: { variant: "secondary", label: "Pending consent" },
    consented: { variant: "default", label: "Consent recorded" },
    processing: { variant: "secondary", label: "Processing" },
    completed: { variant: "default", label: "Completed" },
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

export default function AdviserInstructions() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const instructions = useQuery<InstructionRow[]>({ queryKey: ["/api/adviser/instructions"] });
  const clients = useQuery<ClientLite[]>({ queryKey: ["/api/adviser/clients"] });
  const products = useQuery<ProductLite[]>({ queryKey: ["/api/adviser/products"] });

  const form = useForm<CreateInstructionForm>({
    resolver: zodResolver(createInstructionFormSchema),
    defaultValues: {
      clientUserId: 0,
      productId: 0,
      action: "buy",
      amount: "",
      notes: "",
    },
  });

  const createInstruction = useMutation({
    mutationFn: async (values: CreateInstructionForm) => {
      const res = await apiRequest("POST", "/api/adviser/instructions", values);
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
        <Dialog open={open} onOpenChange={setOpen}>
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
                onSubmit={form.handleSubmit((v) => createInstruction.mutate(v))}
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
                          {(products.data ?? [])
                            .filter((p) => p.isActive)
                            .map((p) => (
                              <SelectItem key={p.id} value={String(p.id)}>
                                {p.name} — {p.category}
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
                        <FormLabel>Amount (AUD)</FormLabel>
                        <FormControl>
                          <Input
                            inputMode="decimal"
                            placeholder="10000.00"
                            data-testid="input-amount"
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
                <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900 flex gap-2">
                  <ShieldAlert className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span>
                    This instruction will be created with status{" "}
                    <strong>pending consent</strong>. Client approval records consent only.
                    No instruction is executed and no funds move until AMAX platform approval
                    and execution controls are enabled.
                  </span>
                </div>
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All instructions</CardTitle>
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {instructions.data.map((i) => (
                  <TableRow key={i.id} data-testid={`row-instruction-${i.id}`}>
                    <TableCell className="text-sm">{formatDate(i.createdAt)}</TableCell>
                    <TableCell className="text-sm">
                      <div className="font-medium">
                        {i.clientFirstName} {i.clientLastName}
                      </div>
                      <div className="text-xs text-gray-500">{i.clientEmail}</div>
                    </TableCell>
                    <TableCell className="text-sm">
                      <div className="font-medium">{i.productName}</div>
                      <div className="text-xs text-gray-500 capitalize">
                        {i.productCategory.replace(/_/g, " ")}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm capitalize">{i.action}</TableCell>
                    <TableCell className="text-sm tabular-nums text-right">
                      {formatAud(i.amount)}
                    </TableCell>
                    <TableCell>{statusBadge(i.status)}</TableCell>
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
