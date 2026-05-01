// =============================================================================
// TASK #146 — Admin Kill switches page
// -----------------------------------------------------------------------------
// One-row-per-switch table with a toggle and a per-switch history sheet.
// Toggling REQUIRES a free-text reason — the dialog will not enable the
// confirm button until the operator types one. Env-forced switches show a
// locked badge + tooltip; the toggle is disabled because clearing them
// requires a redeploy of the env var.
//
// All four switches always render (even if no DB row exists yet) — the
// backend lists `killSwitchKeyValues` and seeds defaults so the UI never
// has to invent an empty state.
// =============================================================================
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Power, Lock, History, AlertTriangle, ShieldOff } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// -----------------------------------------------------------------------------
// Types — mirror the admin route response shape (server/admin-routes.ts).
// -----------------------------------------------------------------------------
type SwitchKey =
  | "transactions"
  | "deposits"
  | "withdrawals"
  | "fee_deductions";

interface KillSwitchRow {
  key: SwitchKey;
  label: string;
  envVar: string;
  enabled: boolean;
  envForced: boolean;
  reason: string | null;
  lastToggledByUserId: number | null;
  lastToggledAt: string | null;
}

interface BlockedAttemptStat {
  key: SwitchKey;
  last5m: number;
  last15m: number;
  last60m: number;
  lastBlockedAt: string | null;
}

interface KillSwitchListResponse {
  switches: KillSwitchRow[];
  users: Record<string, { displayName: string }>;
  blockedAttempts: BlockedAttemptStat[];
}

interface BlockedAttemptsResponse {
  blockedAttempts: BlockedAttemptStat[];
}

interface KillSwitchHistoryEntry {
  id: number;
  userId: number | null;
  action: string;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: string | null;
}

interface KillSwitchHistoryResponse {
  key: SwitchKey;
  label: string;
  history: KillSwitchHistoryEntry[];
  users: Record<string, { displayName: string }>;
}

/** User-visible switch title; API `key` and server payloads stay unchanged. */
function killSwitchUiLabel(key: SwitchKey, serverLabel: string): string {
  switch (key) {
    case "deposits":
      return "Inbound client-managed funds";
    case "withdrawals":
      return "Outbound client-managed funds";
    default:
      return serverLabel || key.replace(/_/g, " ");
  }
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "—";
  }
}

function userDisplayName(
  userId: number | null,
  users: Record<string, { displayName: string }>,
): string {
  if (userId === null || userId === undefined) return "—";
  return users[String(userId)]?.displayName ?? `User #${userId}`;
}

// -----------------------------------------------------------------------------
// Toggle confirmation dialog
// -----------------------------------------------------------------------------
function ToggleDialog({
  row,
  open,
  onOpenChange,
}: {
  row: KillSwitchRow | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");

  // Reset the reason field when the dialog re-opens for a different switch.
  // useEffect (not useMemo) — this is a side effect, not a derived value.
  useEffect(() => {
    if (open) setReason("");
  }, [open, row?.key]);

  const targetEnabled = row ? !row.enabled : false;

  const mut = useMutation({
    mutationFn: async () => {
      if (!row) return;
      await apiRequest("POST", `/api/admin/kill-switches/${row.key}`, {
        enabled: targetEnabled,
        reason: reason.trim(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/kill-switches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/kill-switches/status"] });
      toast({
        title: targetEnabled
          ? `Kill switch engaged: ${row ? killSwitchUiLabel(row.key, row.label) : ""}`
          : `Kill switch cleared: ${row ? killSwitchUiLabel(row.key, row.label) : ""}`,
      });
      onOpenChange(false);
    },
    onError: (err: any) => {
      toast({
        variant: "destructive",
        title: "Toggle failed",
        description: err?.message ?? "Unknown error",
      });
    },
  });

  const reasonValid = reason.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-kill-switch-toggle">
        <DialogHeader>
          <DialogTitle>
            {targetEnabled ? "Engage" : "Clear"} kill switch:{" "}
            {row ? killSwitchUiLabel(row.key, row.label) : ""}
          </DialogTitle>
          <DialogDescription>
            {targetEnabled
              ? "Affected operations will return HTTP 503 immediately and the matching client UI will show a 'Temporarily unavailable' banner. Scheduled jobs in this area will skip cleanly until the switch is cleared."
              : "Affected operations will resume on the next request. Reason is recorded for the audit log."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="kill-switch-reason">Reason (required)</Label>
          <Textarea
            id="kill-switch-reason"
            data-testid="input-kill-switch-reason"
            placeholder={
              targetEnabled
                ? "e.g. Stripe outage — pausing inbound client-managed funds while we investigate"
                : "e.g. Stripe restored — clearing pause"
            }
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={1000}
          />
          <div className="text-xs text-muted-foreground">
            {reason.length}/1000 — recorded in the audit log and the
            operator alert payload.
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="button-kill-switch-cancel"
          >
            Cancel
          </Button>
          <Button
            variant={targetEnabled ? "destructive" : "default"}
            disabled={!reasonValid || mut.isPending}
            onClick={() => mut.mutate()}
            data-testid="button-kill-switch-confirm"
          >
            {mut.isPending
              ? "Saving..."
              : targetEnabled
                ? "Engage switch"
                : "Clear switch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// History sheet (audit log entries for one switch)
// -----------------------------------------------------------------------------
function HistorySheet({
  switchKey,
  open,
  onOpenChange,
}: {
  switchKey: SwitchKey | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  // Explicit queryFn — the default fetcher only fetches queryKey[0], so a
  // hierarchical key like ["/api/admin/kill-switches", key, "history"]
  // would otherwise hit the LIST endpoint instead of the per-switch
  // history endpoint. We build the URL from the parts ourselves.
  const { data, isLoading } = useQuery<KillSwitchHistoryResponse>({
    queryKey: ["/api/admin/kill-switches", switchKey, "history"],
    enabled: open && switchKey !== null,
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/admin/kill-switches/${switchKey}/history`,
      );
      return (await res.json()) as KillSwitchHistoryResponse;
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl"
        data-testid="sheet-kill-switch-history"
      >
        <SheetHeader>
          <SheetTitle>
            History:{" "}
            {data
              ? killSwitchUiLabel(data.key, data.label)
              : switchKey
                ? killSwitchUiLabel(switchKey, "")
                : ""}
          </SheetTitle>
          <SheetDescription>
            Recent kill-switch toggles for this switch, derived from the
            audit log.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="h-[80vh] mt-4 pr-3">
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : !data || data.history.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6">
              No toggles recorded yet for this switch.
            </div>
          ) : (
            <div className="space-y-3">
              {data.history.map((h) => {
                const meta = (h.metadata ?? {}) as Record<string, unknown>;
                const after = (meta.after ?? {}) as Record<string, unknown>;
                const reason =
                  (meta.reason as string | undefined) ??
                  (after.reason as string | undefined) ??
                  null;
                return (
                  <div
                    key={h.id}
                    className="border rounded-md p-3 text-sm"
                    data-testid={`history-entry-${h.id}`}
                  >
                    <div className="flex items-center justify-between">
                      <Badge
                        variant="outline"
                        className={
                          h.action === "kill_switch_enabled"
                            ? "bg-red-100 text-red-800 border-red-300"
                            : "bg-emerald-100 text-emerald-800 border-emerald-300"
                        }
                      >
                        {h.action === "kill_switch_enabled"
                          ? "Engaged"
                          : "Cleared"}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(h.createdAt)}
                      </span>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      By {userDisplayName(h.userId, data.users)}
                      {h.ipAddress ? ` from ${h.ipAddress}` : ""}
                    </div>
                    {reason && (
                      <div className="mt-2">
                        <span className="text-xs font-medium">Reason: </span>
                        <span className="text-sm">{reason}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

// -----------------------------------------------------------------------------
// Task #182 — Blocked attempts widget
// -----------------------------------------------------------------------------
// Shows operators a per-switch live count of HTTP 503 `operation_disabled`
// responses for the last 5/15/60 minutes plus the most-recent timestamp.
// Counts come from a tiny in-memory ring buffer on the server and reset on
// boot, so the widget is a "right now" health check rather than an audit
// (which is already covered by the audit log + operator alerts).
// -----------------------------------------------------------------------------
function BlockedAttemptsWidget({
  switches,
  initialStats,
}: {
  switches: KillSwitchRow[];
  initialStats: BlockedAttemptStat[];
}) {
  const { data } = useQuery<BlockedAttemptsResponse>({
    queryKey: ["/api/admin/kill-switches/blocked-attempts"],
    initialData: { blockedAttempts: initialStats },
    // Cheap endpoint (in-memory only) — poll often so operators see the
    // counter tick up within a few seconds of engaging a switch.
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });

  const statsByKey = new Map<SwitchKey, BlockedAttemptStat>();
  for (const s of data?.blockedAttempts ?? []) statsByKey.set(s.key, s);

  return (
    <Card data-testid="card-blocked-attempts">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldOff className="h-4 w-4" />
          Blocked attempts
        </CardTitle>
        <CardDescription>
          HTTP 503 <code>operation_disabled</code> responses returned by the
          guarded money-movement endpoints. Counts come from an in-memory
          buffer (resets on server restart) so you can confirm traffic is
          actually being rejected after engaging a switch.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {switches.map((row) => {
            const s = statsByKey.get(row.key) ?? {
              key: row.key,
              last5m: 0,
              last15m: 0,
              last60m: 0,
              lastBlockedAt: null,
            };
            return (
              <div
                key={row.key}
                className="border rounded-md p-3 space-y-2"
                data-testid={`blocked-stats-${row.key}`}
              >
                <div className="flex items-center justify-between">
                  <div className="font-medium text-sm">
                    {killSwitchUiLabel(row.key, row.label)}
                  </div>
                  {row.enabled ? (
                    <Badge
                      variant="outline"
                      className="bg-red-100 text-red-800 border-red-300 text-xs"
                    >
                      Engaged
                    </Badge>
                  ) : null}
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div
                      className="text-lg font-semibold tabular-nums"
                      data-testid={`blocked-count-5m-${row.key}`}
                    >
                      {s.last5m}
                    </div>
                    <div className="text-[10px] uppercase text-muted-foreground">
                      5 min
                    </div>
                  </div>
                  <div>
                    <div
                      className="text-lg font-semibold tabular-nums"
                      data-testid={`blocked-count-15m-${row.key}`}
                    >
                      {s.last15m}
                    </div>
                    <div className="text-[10px] uppercase text-muted-foreground">
                      15 min
                    </div>
                  </div>
                  <div>
                    <div
                      className="text-lg font-semibold tabular-nums"
                      data-testid={`blocked-count-60m-${row.key}`}
                    >
                      {s.last60m}
                    </div>
                    <div className="text-[10px] uppercase text-muted-foreground">
                      60 min
                    </div>
                  </div>
                </div>
                <div
                  className="text-xs text-muted-foreground border-t pt-2"
                  data-testid={`blocked-last-seen-${row.key}`}
                >
                  Last blocked:{" "}
                  {s.lastBlockedAt
                    ? formatDateTime(s.lastBlockedAt)
                    : "never since boot"}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// -----------------------------------------------------------------------------
// Main page
// -----------------------------------------------------------------------------
export default function AdminKillSwitches() {
  const { data, isLoading } = useQuery<KillSwitchListResponse>({
    queryKey: ["/api/admin/kill-switches"],
  });

  const [toggleRow, setToggleRow] = useState<KillSwitchRow | null>(null);
  const [historyKey, setHistoryKey] = useState<SwitchKey | null>(null);

  const anyEngaged = (data?.switches ?? []).some((s) => s.enabled);

  return (
    <TooltipProvider>
      <div className="max-w-7xl space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-slate-900">Kill switches</h1>
          <p className="text-sm text-slate-500">
            Engage to immediately stop a class of money-movement operations.
            Affected APIs return HTTP 503 and client UIs show a temporary
            unavailability banner. Toggling requires a reason and is
            recorded in the audit log.
          </p>
        </div>

        {anyEngaged && (
          <Card
            className="border-red-300 bg-red-50"
            data-testid="card-active-warning"
          >
            <CardContent className="py-3 flex items-center gap-2 text-sm text-red-800">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                One or more kill switches are currently engaged. Affected
                operations are returning 503.
              </span>
            </CardContent>
          </Card>
        )}

        {!isLoading && (
          <BlockedAttemptsWidget
            switches={data?.switches ?? []}
            initialStats={data?.blockedAttempts ?? []}
          />
        )}

        <Card>
          <CardHeader>
            <CardTitle>Switches</CardTitle>
            <CardDescription>
              The <code>transactions</code> switch is a master that also
              blocks inbound client-managed funds, outbound client-managed funds, and fee deductions because they
              all post a transaction row.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Switch</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Last toggled</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.switches ?? []).map((row) => (
                    <TableRow
                      key={row.key}
                      data-testid={`row-switch-${row.key}`}
                    >
                      <TableCell>
                        <div className="font-medium">
                          {killSwitchUiLabel(row.key, row.label)}
                        </div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {row.key} · env {row.envVar}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={row.enabled}
                            disabled={row.envForced}
                            onCheckedChange={() => setToggleRow(row)}
                            data-testid={`switch-${row.key}`}
                          />
                          {row.enabled ? (
                            <Badge
                              variant="outline"
                              className="bg-red-100 text-red-800 border-red-300"
                            >
                              Engaged
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="bg-emerald-100 text-emerald-800 border-emerald-300"
                            >
                              Available
                            </Badge>
                          )}
                          {row.envForced && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge
                                  variant="outline"
                                  className="bg-slate-100 text-slate-700 border-slate-300"
                                >
                                  <Lock className="h-3 w-3 mr-1" />
                                  Env-forced
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                Forced ON by env var {row.envVar}. Clear
                                the env var and redeploy to release.
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        <div>{formatDateTime(row.lastToggledAt)}</div>
                        <div className="text-xs text-muted-foreground">
                          {userDisplayName(
                            row.lastToggledByUserId,
                            data?.users ?? {},
                          )}
                        </div>
                      </TableCell>
                      <TableCell
                        className="text-sm max-w-xs truncate"
                        title={row.reason ?? undefined}
                      >
                        {row.reason ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setHistoryKey(row.key)}
                          data-testid={`button-history-${row.key}`}
                        >
                          <History className="h-4 w-4 mr-1" />
                          History
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <ToggleDialog
        row={toggleRow}
        open={toggleRow !== null}
        onOpenChange={(v) => {
          if (!v) setToggleRow(null);
        }}
      />
      <HistorySheet
        switchKey={historyKey}
        open={historyKey !== null}
        onOpenChange={(v) => {
          if (!v) setHistoryKey(null);
        }}
      />
    </TooltipProvider>
  );
}
