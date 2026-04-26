import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { Bell, AlertCircle, Clock, FileText, ShieldCheck, UserCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";

type NotificationType = "consent" | "task" | "fee_consent" | "report" | "kyc";
type NotificationSeverity = "info" | "warning" | "urgent";

interface NotificationItem {
  id: string;
  type: NotificationType;
  title: string;
  description: string;
  severity: NotificationSeverity;
  deepLink: string;
  createdAt: string;
}

interface NotificationsPayload {
  counts: {
    pendingClientConsents: number;
    openHighUrgentTasks: number;
    feeConsentsExpiring: number;
    pendingReports: number;
    kycPending: number;
  };
  totalCount: number;
  items: NotificationItem[];
}

const TYPE_ICON: Record<NotificationType, typeof Bell> = {
  consent: ShieldCheck,
  task: AlertCircle,
  fee_consent: Clock,
  report: FileText,
  kyc: UserCheck,
};

const TYPE_LABEL: Record<NotificationType, string> = {
  consent: "Client consent required",
  task: "High-priority task",
  fee_consent: "Fee consent expiring",
  report: "Report",
  kyc: "KYC pending",
};

const SEVERITY_DOT: Record<NotificationSeverity, string> = {
  urgent: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-sky-500",
};

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = then - Date.now();
  const absMs = Math.abs(diff);
  const day = 86_400_000;
  const hour = 3_600_000;
  const minute = 60_000;
  if (absMs >= day) {
    const d = Math.round(absMs / day);
    return diff >= 0 ? `in ${d}d` : `${d}d ago`;
  }
  if (absMs >= hour) {
    const h = Math.round(absMs / hour);
    return diff >= 0 ? `in ${h}h` : `${h}h ago`;
  }
  if (absMs >= minute) {
    const m = Math.round(absMs / minute);
    return diff >= 0 ? `in ${m}m` : `${m}m ago`;
  }
  return "just now";
}

export default function NotificationsPopover() {
  const [open, setOpen] = useState(false);

  const { data, isLoading } = useQuery<NotificationsPayload>({
    queryKey: ["/api/adviser/notifications"],
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  // SESSION 15B: dismiss preference layer. The aggregator filters dismissed
  // items out of both list AND counts, so an optimistic invalidation gives
  // the user instant feedback without waiting the 60s refetch interval.
  const dismiss = useMutation({
    mutationFn: async ({ sourceType, sourceId }: { sourceType: NotificationType; sourceId: number }) => {
      await apiRequest("POST", "/api/adviser/notifications/dismiss", { sourceType, sourceId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/adviser/notifications"] });
    },
  });

  const total = data?.totalCount ?? 0;
  const items = data?.items ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative text-slate-500 hover:text-slate-900"
          aria-label={`Notifications${total > 0 ? ` (${total} pending)` : ""}`}
          data-testid="button-notifications"
        >
          <Bell className="h-5 w-5" />
          {total > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold"
              data-testid="badge-notification-count"
            >
              {total > 99 ? "99+" : total}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        className="w-[380px] p-0"
        data-testid="popover-notifications"
      >
        <div className="flex items-center justify-between p-3 border-b border-slate-200">
          <div>
            <p className="font-semibold text-sm text-slate-900">Notifications</p>
            {data && (
              <p className="text-xs text-slate-500">
                {total === 0 ? "All caught up" : `${total} item${total === 1 ? "" : "s"} need attention`}
              </p>
            )}
          </div>
          {data && total > 0 && (
            <Badge variant="outline" className="text-xs">
              {data.counts.pendingClientConsents > 0 && `${data.counts.pendingClientConsents} consent`}
            </Badge>
          )}
        </div>

        {isLoading ? (
          <div className="p-3 space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center" data-testid="notifications-empty">
            <Bell className="h-8 w-8 mx-auto text-slate-300 mb-2" />
            <p className="text-sm text-slate-600">All caught up</p>
            <p className="text-xs text-slate-400 mt-1">
              You'll see consent requests, urgent tasks, expiring fee consents and pending reports
              here.
            </p>
          </div>
        ) : (
          <ScrollArea className="max-h-[420px]">
            <ul className="divide-y divide-slate-100" data-testid="notifications-list">
              {items.map((item) => {
                const Icon = TYPE_ICON[item.type];
                // item.id is composed as `${sourceType}:${sourceId}` in the
                // aggregator — split here so the dismiss button can post the
                // structured (sourceType, sourceId) the API expects.
                const colonIdx = item.id.indexOf(":");
                const sourceId = Number(item.id.slice(colonIdx + 1));
                const isDismissing =
                  dismiss.isPending &&
                  dismiss.variables?.sourceType === item.type &&
                  dismiss.variables?.sourceId === sourceId;
                return (
                  <li
                    key={item.id}
                    className="group flex gap-3 p-3 hover:bg-slate-50 transition-colors"
                    data-testid={`notification-${item.id}`}
                  >
                    <Link
                      href={item.deepLink}
                      onClick={() => setOpen(false)}
                      className="flex flex-1 min-w-0 gap-3"
                    >
                      <div className="flex-shrink-0 mt-0.5 relative">
                        <div className="h-8 w-8 rounded-full bg-slate-100 flex items-center justify-center">
                          <Icon className="h-4 w-4 text-slate-600" />
                        </div>
                        <span
                          className={`absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white ${SEVERITY_DOT[item.severity]}`}
                          aria-hidden
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="text-sm font-medium text-slate-900 truncate">{item.title}</p>
                          <span className="text-xs text-slate-400 flex-shrink-0">
                            {formatRelative(item.createdAt)}
                          </span>
                        </div>
                        <p className="text-xs text-slate-600 mt-0.5 line-clamp-2">
                          {item.description}
                        </p>
                        <p className="text-[10px] text-slate-400 mt-1 uppercase tracking-wide">
                          {TYPE_LABEL[item.type]}
                        </p>
                      </div>
                    </Link>
                    <button
                      type="button"
                      aria-label={`Dismiss ${item.title}`}
                      title="Dismiss"
                      disabled={isDismissing || !Number.isFinite(sourceId)}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!Number.isFinite(sourceId)) return;
                        dismiss.mutate({ sourceType: item.type, sourceId });
                      }}
                      className="flex-shrink-0 self-start mt-0.5 rounded p-1 text-slate-300 opacity-0 hover:bg-slate-200 hover:text-slate-700 group-hover:opacity-100 focus:opacity-100 disabled:opacity-50"
                      data-testid={`dismiss-${item.id}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}

        {data && total > 0 && (
          <div className="border-t border-slate-200 p-2 grid grid-cols-2 gap-1 text-xs">
            <Link
              href="/adviser/workflow"
              onClick={() => setOpen(false)}
              className="text-center py-1.5 rounded hover:bg-slate-50 text-slate-700"
              data-testid="link-view-workflow"
            >
              View workflow
            </Link>
            <Link
              href="/adviser/instructions"
              onClick={() => setOpen(false)}
              className="text-center py-1.5 rounded hover:bg-slate-50 text-slate-700"
              data-testid="link-view-instructions"
            >
              View instructions
            </Link>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
