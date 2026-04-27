// =============================================================================
// TASK #155 — Admin write kill switch panel
// =============================================================================
// Sits at the top of the admin dashboard. Shows the current effective
// state, who flipped it last + when, the reason, and a confirm dialog
// that flips the switch in either direction.
//
// UX rules:
//   * Reason is REQUIRED when enabling (the server enforces this too;
//     we mirror it client-side so the button stays disabled until valid).
//   * The env-override case is read-only — when WRITE_KILL_SWITCH=on is
//     set in the environment, the toggle button is disabled and a help
//     line explains how to clear it.
//   * Every successful toggle invalidates the dashboard, system-status,
//     and public write-state queries so the banner updates immediately.
// =============================================================================

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, Power, Lock, Unlock } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface SystemStatus {
  writeKillSwitch: {
    enabled: boolean;
    envOverride: boolean;
    reason: string | null;
    enabledByUserId: number | null;
    enabledAt: string | null;
    updatedAt: string | null;
  };
}

function fmt(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return "—";
  }
}

export default function WriteKillSwitchPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<SystemStatus>({
    queryKey: ["/api/admin/system-status"],
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState("");

  const mutation = useMutation({
    mutationFn: async (vars: { enabled: boolean; reason: string | null }) => {
      const res = await apiRequest("POST", "/api/admin/write-kill-switch", vars);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Toggle failed" }));
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ ok: true; changed: boolean }>;
    },
    onSuccess: (result) => {
      toast({
        title: result.changed ? "Write kill switch updated" : "No change",
        description: result.changed
          ? "The new state is now in effect."
          : "Submitted state matched the current state.",
      });
      setConfirmOpen(false);
      setReason("");
      // Invalidate every consumer of the kill switch state so the admin
      // banner + every other layout's banner update immediately.
      queryClient.invalidateQueries({ queryKey: ["/api/admin/system-status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/system/write-state"] });
    },
    onError: (err: Error) => {
      toast({
        title: "Toggle failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  if (isLoading || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Power className="h-4 w-4" />
            Write kill switch
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  const { enabled, envOverride, enabledByUserId, enabledAt } = data.writeKillSwitch;
  const targetEnabled = !enabled;
  const cardClass = enabled
    ? "border-amber-300 bg-amber-50/40"
    : "border-slate-200";

  function openDialog() {
    setReason(enabled ? "" : "");
    setConfirmOpen(true);
  }

  function submit() {
    mutation.mutate({
      enabled: targetEnabled,
      reason: targetEnabled ? reason.trim() : null,
    });
  }

  return (
    <>
      <Card className={cardClass} data-testid="card-write-kill-switch">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Power className={`h-4 w-4 ${enabled ? "text-amber-700" : "text-slate-500"}`} />
            Write kill switch
          </CardTitle>
          <Badge
            variant="outline"
            className={enabled ? "bg-amber-100 border-amber-300 text-amber-900" : "bg-slate-50 text-slate-600"}
            data-testid="badge-write-kill-switch-state"
          >
            {enabled ? (
              <span className="flex items-center gap-1"><Lock className="h-3 w-3" /> ON</span>
            ) : (
              <span className="flex items-center gap-1"><Unlock className="h-3 w-3" /> OFF</span>
            )}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {enabled ? (
            <div className="space-y-1">
              <div className="flex items-start gap-2 text-amber-900">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-medium">All non-admin writes are returning 503.</div>
                  <div className="text-amber-800">
                    Background write jobs are skipping cleanly. GETs and admin endpoints continue to work.
                  </div>
                </div>
              </div>
              <div className="text-slate-700 mt-2">
                <div>
                  <span className="text-slate-500">Reason:</span>{" "}
                  <span data-testid="text-write-kill-switch-reason">
                    {data.writeKillSwitch.reason ?? "—"}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500">Enabled at:</span> {fmt(enabledAt)}
                </div>
                <div>
                  <span className="text-slate-500">Enabled by user id:</span> {enabledByUserId ?? "—"}
                </div>
                {envOverride && (
                  <div className="mt-2 text-xs text-slate-600 bg-white border border-slate-200 rounded px-2 py-1">
                    Forced ON via the <code>WRITE_KILL_SWITCH</code> env var. Remove
                    the env var and restart the server to allow toggling from this panel.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className="text-slate-600">
              Writes are flowing normally. Use this control during incidents
              (data store outage, security event, payments cutover) to pause
              every non-admin POST/PATCH/PUT/DELETE in seconds.
            </p>
          )}
          <div className="flex justify-end">
            <Button
              variant={enabled ? "outline" : "destructive"}
              size="sm"
              onClick={openDialog}
              disabled={envOverride}
              data-testid="button-write-kill-switch-toggle"
              title={envOverride ? "Disabled — forced ON via env var" : undefined}
            >
              {enabled ? "Resume writes" : "Pause all writes"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent data-testid="dialog-write-kill-switch-confirm">
          <DialogHeader>
            <DialogTitle>
              {targetEnabled ? "Pause all writes?" : "Resume writes?"}
            </DialogTitle>
            <DialogDescription>
              {targetEnabled
                ? "Every non-admin POST, PATCH, PUT, and DELETE will return 503 immediately. Background jobs that perform writes will skip their next tick. GETs and admin endpoints remain available."
                : "Writes will resume on the next request. Background jobs will run on their next scheduled tick."}
            </DialogDescription>
          </DialogHeader>

          {targetEnabled && (
            <div className="space-y-2">
              <Label htmlFor="write-kill-switch-reason">Reason (required)</Label>
              <Textarea
                id="write-kill-switch-reason"
                data-testid="input-write-kill-switch-reason"
                placeholder="e.g. Incident #4123 — DB failover in progress"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                maxLength={500}
              />
              <p className="text-xs text-slate-500">
                Recorded in the audit log alongside your user id and timestamp.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant={targetEnabled ? "destructive" : "default"}
              onClick={submit}
              disabled={
                mutation.isPending ||
                (targetEnabled && reason.trim().length === 0)
              }
              data-testid="button-write-kill-switch-confirm"
            >
              {mutation.isPending
                ? "Working…"
                : targetEnabled
                ? "Pause writes"
                : "Resume writes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
