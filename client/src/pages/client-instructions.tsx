import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Check, X, ClipboardCheck, ShieldAlert } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface PendingInstruction {
  id: number;
  adviserUserId: number;
  productId: number;
  action: string;
  amount: string;
  status: string;
  notes: string | null;
  createdAt: string | null;
  productName: string;
  productCategory: string;
  productSubCategory: string;
  adviserFirstName: string | null;
  adviserLastName: string | null;
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

export default function ClientInstructions() {
  const { toast } = useToast();
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const pending = useQuery<PendingInstruction[]>({
    queryKey: ["/api/client/instructions/pending"],
  });

  const consentMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/client/instructions/${id}/consent`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/client/instructions/pending"] });
      toast({
        title: "Instruction approved",
        description: "Your adviser has been notified.",
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to approve",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason: string }) => {
      const res = await apiRequest(
        "POST",
        `/api/client/instructions/${id}/reject`,
        reason ? { reason } : {},
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/client/instructions/pending"] });
      toast({ title: "Instruction rejected" });
      setRejectingId(null);
      setRejectReason("");
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to reject",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  return (
    <div className="p-6 space-y-6" data-testid="page-client-instructions">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <ClipboardCheck className="h-6 w-6 text-emerald-600" />
          Investment instructions
        </h1>
        <p className="text-sm text-gray-500 mt-1 max-w-2xl">
          Your adviser has prepared the following instructions for your account. Nothing
          will happen until you approve them. You can reject any instruction at any time.
        </p>
      </div>

      <div className="rounded-md bg-sky-50 border border-sky-200 p-3 text-xs text-sky-900 flex gap-2">
        <ShieldAlert className="h-4 w-4 flex-shrink-0 mt-0.5" />
        <span>
          You are in control of every transaction on your account. Approving an
          instruction here records your consent — no funds move automatically yet, and
          you can always revoke fee consents from your account settings.
        </span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pending instructions</CardTitle>
        </CardHeader>
        <CardContent>
          {pending.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : pending.isError ? (
            <p className="text-sm text-red-600">Unable to load instructions.</p>
          ) : !pending.data || pending.data.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="text-no-pending">
              You have no pending instructions from your adviser.
            </p>
          ) : (
            <div className="space-y-4">
              {pending.data.map((i) => (
                <div
                  key={i.id}
                  className="border rounded-lg p-4 hover:shadow-sm transition-shadow"
                  data-testid={`card-instruction-${i.id}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="capitalize">
                          {i.action}
                        </Badge>
                        <span className="text-lg font-semibold tabular-nums">
                          {formatAud(i.amount)}
                        </span>
                        <span className="text-sm text-gray-500">in</span>
                        <span className="font-medium">{i.productName}</span>
                      </div>
                      <div className="text-xs text-gray-500 capitalize">
                        {i.productCategory.replace(/_/g, " ")}
                        {i.productSubCategory ? ` · ${i.productSubCategory.replace(/_/g, " ")}` : ""}
                      </div>
                      {i.adviserFirstName && (
                        <div className="text-sm text-gray-600">
                          From your adviser:{" "}
                          <span className="font-medium">
                            {i.adviserFirstName} {i.adviserLastName ?? ""}
                          </span>
                        </div>
                      )}
                      {i.notes && (
                        <div className="text-sm text-gray-700 bg-gray-50 rounded px-3 py-2 border">
                          {i.notes}
                        </div>
                      )}
                      <div className="text-xs text-gray-500">
                        Sent on {formatDate(i.createdAt)}
                      </div>
                    </div>
                    <div className="flex flex-col gap-2 w-32">
                      <Button
                        size="sm"
                        onClick={() => consentMutation.mutate(i.id)}
                        disabled={
                          consentMutation.isPending && consentMutation.variables === i.id
                        }
                        data-testid={`button-consent-${i.id}`}
                      >
                        <Check className="h-4 w-4 mr-1" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setRejectingId(i.id)}
                        data-testid={`button-reject-${i.id}`}
                      >
                        <X className="h-4 w-4 mr-1" />
                        Reject
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={rejectingId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRejectingId(null);
            setRejectReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this instruction?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              Your adviser will see that you rejected this instruction. You can include
              a reason (optional).
            </p>
            <Textarea
              rows={3}
              placeholder="Reason (optional)"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              data-testid="input-reject-reason"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setRejectingId(null);
                  setRejectReason("");
                }}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  if (rejectingId !== null) {
                    rejectMutation.mutate({ id: rejectingId, reason: rejectReason });
                  }
                }}
                disabled={rejectMutation.isPending}
                data-testid="button-confirm-reject"
              >
                {rejectMutation.isPending ? "Rejecting..." : "Reject instruction"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
