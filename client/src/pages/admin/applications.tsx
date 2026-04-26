import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CheckCircle2, XCircle } from "lucide-react";

interface Application {
  id: number;
  fullName: string;
  email: string;
  phone: string;
  country: string;
  accountType: string;
  intendedUse: string;
  status: string;
  reviewNote: string | null;
  emailVerified: boolean;
  createdAt: string | null;
  reviewedAt: string | null;
}

function fmt(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return "—";
  }
}

function statusBadge(status: string) {
  const map: Record<string, { label: string; cls: string }> = {
    email_unverified: { label: "Email unverified", cls: "bg-slate-100 text-slate-700" },
    submitted: { label: "Submitted", cls: "bg-blue-100 text-blue-800" },
    under_review: { label: "Under review", cls: "bg-amber-100 text-amber-800" },
    approved: { label: "Approved", cls: "bg-emerald-100 text-emerald-800" },
    rejected: { label: "Rejected", cls: "bg-red-100 text-red-800" },
  };
  const m = map[status] ?? { label: status, cls: "bg-slate-100 text-slate-700" };
  return <Badge variant="outline" className={`${m.cls} border-transparent`}>{m.label}</Badge>;
}

export default function AdminApplications() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [actionTarget, setActionTarget] = useState<{ app: Application; mode: "approve" | "reject" } | null>(null);
  const [reviewNote, setReviewNote] = useState("");

  const queryKey = statusFilter === "all"
    ? ["/api/admin/applications"]
    : ["/api/admin/applications", { status: statusFilter }];

  const { data, isLoading } = useQuery<Application[]>({
    queryKey,
    queryFn: async () => {
      const url = statusFilter === "all"
        ? "/api/admin/applications"
        : `/api/admin/applications?status=${statusFilter}`;
      const headers: Record<string, string> = {};
      try {
        const t = localStorage.getItem("amax_jwt");
        if (t) headers.Authorization = `Bearer ${t}`;
      } catch {}
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  const mutation = useMutation({
    mutationFn: async ({ id, mode, note }: { id: number; mode: "approve" | "reject"; note: string }) => {
      const body = mode === "approve"
        ? (note ? { reviewNote: note } : {})
        : { reviewNote: note };
      const res = await apiRequest("POST", `/api/admin/applications/${id}/${mode}`, body);
      return res.json();
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/applications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/dashboard"] });
      toast({
        title: vars.mode === "approve" ? "Application approved" : "Application rejected",
        description: vars.mode === "approve"
          ? "The applicant can now register an account."
          : "The applicant has been informed by audit-only flow.",
      });
      setActionTarget(null);
      setReviewNote("");
    },
    onError: (err: Error) => {
      toast({ title: "Action failed", description: err.message, variant: "destructive" });
    },
  });

  function openAction(app: Application, mode: "approve" | "reject") {
    setActionTarget({ app, mode });
    setReviewNote(app.reviewNote ?? "");
  }

  function confirmAction() {
    if (!actionTarget) return;
    if (actionTarget.mode === "reject" && !reviewNote.trim()) {
      toast({ title: "A reason is required for rejection", variant: "destructive" });
      return;
    }
    mutation.mutate({ id: actionTarget.app.id, mode: actionTarget.mode, note: reviewNote.trim() });
  }

  return (
    <div className="space-y-4 max-w-7xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Applications</h1>
          <p className="text-sm text-slate-500 mt-1">
            Review and decision applications for new account access.
          </p>
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-48" data-testid="select-status-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="submitted">Submitted</SelectItem>
            <SelectItem value="under_review">Under review</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="email_unverified">Email unverified</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {isLoading ? "Loading…" : `${data?.length ?? 0} application${data?.length === 1 ? "" : "s"}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : !data || data.length === 0 ? (
            <p className="text-sm text-slate-500">No applications match this filter.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Applicant</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Reviewed</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((a) => {
                  const canDecision = a.status !== "approved" && a.status !== "rejected";
                  return (
                    <TableRow key={a.id} data-testid={`row-application-${a.id}`}>
                      <TableCell>
                        <div className="font-medium text-slate-900">{a.fullName}</div>
                        <div className="text-xs text-slate-500">{a.email}</div>
                        {!a.emailVerified && (
                          <div className="text-[11px] text-amber-700 mt-0.5">Email not verified</div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm capitalize">{a.accountType}</TableCell>
                      <TableCell>{statusBadge(a.status)}</TableCell>
                      <TableCell className="text-sm">{fmt(a.createdAt)}</TableCell>
                      <TableCell className="text-sm">{fmt(a.reviewedAt)}</TableCell>
                      <TableCell className="text-right">
                        {canDecision ? (
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                              onClick={() => openAction(a, "approve")}
                              disabled={!a.emailVerified}
                              title={!a.emailVerified ? "Applicant must verify email first" : ""}
                              data-testid={`button-approve-${a.id}`}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                              Approve
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-red-700 border-red-300 hover:bg-red-50"
                              onClick={() => openAction(a, "reject")}
                              data-testid={`button-reject-${a.id}`}
                            >
                              <XCircle className="h-3.5 w-3.5 mr-1" />
                              Reject
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">Final</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!actionTarget} onOpenChange={(o) => !o && setActionTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {actionTarget?.mode === "approve" ? "Approve application" : "Reject application"}
            </DialogTitle>
            <DialogDescription>
              {actionTarget?.app.fullName} · {actionTarget?.app.email}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">
              {actionTarget?.mode === "approve" ? "Note (optional)" : "Reason for rejection"}
            </label>
            <Textarea
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              rows={4}
              placeholder={
                actionTarget?.mode === "approve"
                  ? "Optional internal note"
                  : "Required — will be recorded in the audit log"
              }
              data-testid="textarea-review-note"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={confirmAction}
              disabled={mutation.isPending}
              className={
                actionTarget?.mode === "approve"
                  ? "bg-emerald-600 hover:bg-emerald-700"
                  : "bg-red-600 hover:bg-red-700"
              }
              data-testid="button-confirm-action"
            >
              {mutation.isPending
                ? "Working…"
                : actionTarget?.mode === "approve"
                  ? "Approve"
                  : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
