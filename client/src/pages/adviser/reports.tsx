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
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, FileText, Download, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ReportRequest {
  id: number;
  clientUserId: number;
  reportType: string;
  format: string;
  status: string;
  requestedAt: string | null;
  generatedAt: string | null;
  downloadUrl: string | null;
  failureReason: string | null;
  notes: string | null;
}

const TOKEN_KEY = "amax_jwt";

async function downloadReport(reportId: number, clientLabel: string, toast: ReturnType<typeof useToast>["toast"]) {
  try {
    const token = (() => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } })();
    const res = await fetch(`/api/adviser/reports/${reportId}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`${res.status}: ${txt || res.statusText}`);
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

interface ClientLite {
  userId: number;
  firstName: string;
  lastName: string;
}

const REPORT_TYPES = [
  { value: "portfolio_summary", label: "Portfolio summary" },
  { value: "fee_summary", label: "Fee summary" },
  { value: "transaction_history", label: "Transaction history" },
  { value: "full_statement", label: "Full statement" },
];

const formSchema = z.object({
  clientUserId: z.coerce.number().int().positive(),
  reportType: z.string().min(1),
  notes: z.string().max(2000).optional(),
});
type FormValues = z.infer<typeof formSchema>;

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("en-AU");
  } catch {
    return "—";
  }
}

function statusBadge(status: string) {
  const variant: "default" | "secondary" | "destructive" | "outline" =
    status === "ready"
      ? "default"
      : status === "failed" || status === "expired"
        ? "destructive"
        : "secondary";
  return (
    <Badge variant={variant} className="capitalize">
      {status}
    </Badge>
  );
}

export default function AdviserReports() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const reports = useQuery<ReportRequest[]>({ queryKey: ["/api/adviser/reports"] });
  // /api/adviser/clients now returns { asOfDate, clients } (Task #287). Adapt
  // to the rows-only shape this page uses everywhere downstream.
  const clientsResponse = useQuery<{ asOfDate: string; clients: ClientLite[] }>({
    queryKey: ["/api/adviser/clients"],
  });
  const clients = {
    data: clientsResponse.data?.clients,
    isLoading: clientsResponse.isLoading,
  };

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { clientUserId: 0, reportType: "portfolio_summary", notes: "" },
  });

  const createReport = useMutation({
    mutationFn: async (values: FormValues) => {
      const res = await apiRequest("POST", "/api/adviser/reports", values);
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
      form.reset();
    },
    onError: (err: Error) => {
      toast({ title: "Request failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="p-6 space-y-6" data-testid="page-adviser-reports">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
          <p className="text-sm text-gray-500 mt-1">
            Request statement-style reports for any of your linked clients. Generation is handled
            by the platform; you'll see a download link once ready.
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
              <form
                onSubmit={form.handleSubmit((v) => createReport.mutate(v))}
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
                          <SelectTrigger data-testid="select-report-client">
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
                  disabled={createReport.isPending}
                  data-testid="button-submit-report"
                >
                  {createReport.isPending ? "Submitting…" : "Submit request"}
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4 text-violet-500" />
            Your report requests
          </CardTitle>
        </CardHeader>
        <CardContent>
          {reports.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !reports.data || reports.data.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="text-no-reports">
              No report requests yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead>Download</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reports.data.map((r) => (
                  <TableRow key={r.id} data-testid={`row-report-${r.id}`}>
                    <TableCell className="text-sm">#{r.clientUserId}</TableCell>
                    <TableCell className="capitalize text-sm">
                      {r.reportType.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell>{statusBadge(r.status)}</TableCell>
                    <TableCell className="text-sm">{formatDateTime(r.requestedAt)}</TableCell>
                    <TableCell>
                      {r.status === "ready" && r.downloadUrl ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => downloadReport(r.id, `#${r.clientUserId}`, toast)}
                          data-testid={`button-download-report-${r.id}`}
                        >
                          <Download className="h-3.5 w-3.5 mr-1.5" />
                          Download
                        </Button>
                      ) : r.status === "failed" ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                className="inline-flex items-center text-xs text-red-600 cursor-help"
                                data-testid={`text-failed-report-${r.id}`}
                              >
                                <AlertCircle className="h-3.5 w-3.5 mr-1" />
                                Failed
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p className="max-w-xs text-xs">{r.failureReason ?? "Unknown error"}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
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
