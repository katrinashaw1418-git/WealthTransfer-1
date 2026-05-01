import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ListChecks, MessageSquarePlus } from "lucide-react";

interface AdminInstruction {
  id: number;
  adviserUserId: number;
  clientUserId: number;
  productId: number;
  action: string;
  amount: string;
  status: string;
  adviceRecordId: number | null;
  feeConsentId: number | null;
  executionAuthorisationId: number | null;
  notes: string | null;
  rejectionReason: string | null;
  consentedAt: string | null;
  rejectedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  adviserUsername: string;
  adviserEmail: string;
  clientUsername: string;
  clientEmail: string;
  productName: string;
}

interface ReviewNote {
  id: number;
  adminUserId: number;
  entityType: string;
  entityId: string;
  note: string;
  createdAt: string | null;
  adminUsername: string;
}

interface InstructionListResp {
  items: AdminInstruction[];
  page: number;
  limit: number;
  total: number;
}

const STATUSES = [
  "pending_consent",
  "consented",
  "processing",
  "completed",
  "rejected",
  "cancelled",
] as const;

function fmtMoney(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function fmt(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return "—";
  }
}

function statusVariant(s: string): "default" | "secondary" | "outline" | "destructive" {
  if (s === "completed") return "default";
  if (s === "rejected" || s === "cancelled") return "destructive";
  if (s === "processing" || s === "consented") return "secondary";
  return "outline";
}

const PAGE_SIZE = 50;

export default function AdminInstructions() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AdminInstruction | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  // Reset to page 1 whenever the filter changes so the user never lands on
  // an empty out-of-range page when narrowing the result set.
  function changeStatus(s: string) {
    setStatusFilter(s);
    setPage(1);
  }

  const queryKey = ["/api/admin/instructions", statusFilter, page];
  const { data, isLoading } = useQuery<InstructionListResp>({
    queryKey,
    queryFn: async () => {
      const qs: string[] = [`page=${page}`, `limit=${PAGE_SIZE}`];
      if (statusFilter && statusFilter !== "all") {
        qs.push(`status=${encodeURIComponent(statusFilter)}`);
      }
      const res = await apiRequest("GET", `/api/admin/instructions?${qs.join("&")}`);
      return res.json();
    },
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  const notesQuery = useQuery<ReviewNote[]>({
    queryKey: ["/api/admin/instructions", selected?.id, "review-notes"],
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/admin/instructions/${selected!.id}/review-notes`,
      );
      return res.json();
    },
    enabled: !!selected,
  });

  const noteMut = useMutation({
    mutationFn: async (note: string) => {
      const res = await apiRequest("POST", "/api/admin/review-notes", {
        entityType: "investment_instruction",
        entityId: String(selected!.id),
        note,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/admin/instructions", selected?.id, "review-notes"],
      });
      setNoteDraft("");
      toast({ title: "Note added" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add note", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="max-w-7xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900">Investment instructions</h1>
        <p className="text-sm text-slate-500">
          Read-only review of adviser-raised instructions with admin review notes.
        </p>
      </div>
      <div className="flex flex-wrap items-end justify-end gap-3">
        <Select value={statusFilter} onValueChange={changeStatus}>
          <SelectTrigger className="w-56" data-testid="select-instruction-status-filter">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s.replace(/_/g, " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-violet-600" />
            {isLoading
              ? "Loading…"
              : `${data?.total ?? 0} instruction${data?.total === 1 ? "" : "s"}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !data || data.items.length === 0 ? (
            <p className="text-sm text-slate-500">No instructions match this filter.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Created</TableHead>
                  <TableHead>Adviser</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Gates</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((i) => (
                  <TableRow key={i.id} data-testid={`row-instruction-${i.id}`}>
                    <TableCell className="text-sm">{fmt(i.createdAt)}</TableCell>
                    <TableCell className="text-sm">{i.adviserUsername}</TableCell>
                    <TableCell className="text-sm">{i.clientUsername}</TableCell>
                    <TableCell className="text-sm">{i.productName}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {i.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{fmtMoney(i.amount)}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(i.status)} className="capitalize">
                        {i.status.replace(/_/g, " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-slate-600 space-y-0.5">
                      <div>SOA {i.adviceRecordId ? "✓" : "—"}</div>
                      <div>Fee {i.feeConsentId ? "✓" : "—"}</div>
                      <div>Auth {i.executionAuthorisationId ? "✓" : "—"}</div>
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelected(i)}
                        data-testid={`button-review-${i.id}`}
                      >
                        Review
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {data && data.total > PAGE_SIZE && (
            <div className="flex items-center justify-between mt-3 text-sm">
              <div className="text-slate-500">
                Page {page} of {totalPages} · {data.total} total
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  data-testid="button-instructions-prev"
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  data-testid="button-instructions-next"
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Instruction #{selected?.id}</SheetTitle>
            <SheetDescription>
              Read-only view. Notes added here are recorded in the audit log.
            </SheetDescription>
          </SheetHeader>
          {selected && (
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-xs text-slate-500">Adviser</div>
                  <div>{selected.adviserUsername}</div>
                  <div className="text-xs text-slate-500">{selected.adviserEmail}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Client</div>
                  <div>{selected.clientUsername}</div>
                  <div className="text-xs text-slate-500">{selected.clientEmail}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Product</div>
                  <div>{selected.productName}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Amount</div>
                  <div>{fmtMoney(selected.amount)}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Action</div>
                  <div className="capitalize">{selected.action}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Status</div>
                  <Badge variant={statusVariant(selected.status)} className="capitalize">
                    {selected.status.replace(/_/g, " ")}
                  </Badge>
                </div>
              </div>

              {selected.notes && (
                <div className="text-sm">
                  <div className="text-xs text-slate-500 mb-1">Adviser notes</div>
                  <div className="rounded border p-2 bg-slate-50">{selected.notes}</div>
                </div>
              )}
              {selected.rejectionReason && (
                <div className="text-sm">
                  <div className="text-xs text-slate-500 mb-1">Rejection reason</div>
                  <div className="rounded border p-2 bg-rose-50 text-rose-900">
                    {selected.rejectionReason}
                  </div>
                </div>
              )}

              <div>
                <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-2">
                  <MessageSquarePlus className="h-4 w-4 text-violet-600" />
                  Admin review notes
                </h3>
                <div className="space-y-2">
                  {notesQuery.isLoading ? (
                    <Skeleton className="h-20 w-full" />
                  ) : notesQuery.data && notesQuery.data.length > 0 ? (
                    notesQuery.data.map((n) => (
                      <div
                        key={n.id}
                        className="rounded border p-2 text-sm"
                        data-testid={`note-${n.id}`}
                      >
                        <div className="text-xs text-slate-500 flex justify-between">
                          <span>{n.adminUsername}</span>
                          <span>{fmt(n.createdAt)}</span>
                        </div>
                        <div className="mt-1 whitespace-pre-wrap">{n.note}</div>
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-slate-500">No notes yet.</p>
                  )}
                </div>
                <div className="mt-3 space-y-2">
                  <Textarea
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder="Add a review note…"
                    rows={3}
                    data-testid="textarea-note"
                  />
                  <Button
                    size="sm"
                    disabled={!noteDraft.trim() || noteMut.isPending}
                    onClick={() => noteMut.mutate(noteDraft.trim())}
                    data-testid="button-submit-note"
                  >
                    {noteMut.isPending ? "Adding…" : "Add note"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
