import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Target,
  FileText,
  FileBadge,
  ExternalLink,
  Lock,
  ShieldAlert,
  Download,
  Inbox,
  Mail,
} from "lucide-react";
import { usePortfolioAllocation } from "@/hooks/use-portfolio";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";

// Task #318 — same s912G policy text the adviser surface and the DELETE
// route quote. Surfaced here so a client browsing their own documents
// understands why nothing is removable.
const RETENTION_POLICY_TEXT =
  "Documents are retained for 7 years from creation per Corporations Act s912G. Deletion is locked while the retention window is active.";

interface ClientObjective {
  id: number;
  adviceRecordId: number;
  objectiveType: string;
  label: string;
  targetAmount: string | null;
  targetCurrency: string;
  targetDate: string | null;
  priority: string;
  notes: string | null;
  createdAt: string | null;
}

interface ClientDocument {
  id: number;
  adviceRecordId: number | null;
  documentType: string;
  fileName: string;
  storageKey: string;
  mimeType: string | null;
  fileSizeBytes: number | null;
  description: string | null;
  uploadedAt: string | null;
  // Task #318 — retention metadata. Same fields the adviser surface
  // consumes; the client never sees a Delete button (so no per-row
  // disabling is required) but they DO see the "Retention until" column
  // and the Lock chip so the policy is transparent.
  retentionUntil: string | null;
  deletionLocked: boolean;
}

function isRetentionActive(retentionUntil: string | null | undefined): boolean {
  if (!retentionUntil) return false;
  const t = new Date(retentionUntil).getTime();
  if (!Number.isFinite(t)) return false;
  return t > Date.now();
}

function formatDate(value: string | null | undefined): string {
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

function formatBytes(n: number | null): string {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// Task #338 — required compound annual growth rate to grow `current` into
// `target` by `targetDate`. Returns null when we can't honestly compute it
// (no current value, no target date, or target already met). When the
// horizon is shorter than ~5 weeks the annualised number is unstable, so we
// fall back to the simple-return percentage instead — the same guard the
// real-metrics route uses for its CAGR readout.
function computeRequiredCagr(
  current: number,
  target: number,
  targetDate: string | null,
): { value: number; mode: "cagr" | "simple" } | null {
  if (!Number.isFinite(current) || current <= 0) return null;
  if (!Number.isFinite(target) || target <= 0) return null;
  if (target <= current) return { value: 0, mode: "cagr" };
  if (!targetDate) return null;
  const t = new Date(targetDate).getTime();
  if (!Number.isFinite(t)) return null;
  const years = (t - Date.now()) / (365.25 * 24 * 60 * 60 * 1000);
  if (years <= 0) return null;
  const ratio = target / current;
  if (years < 0.1) {
    return { value: (ratio - 1) * 100, mode: "simple" };
  }
  const rate = Math.pow(ratio, 1 / years) - 1;
  if (!Number.isFinite(rate)) return null;
  return { value: rate * 100, mode: "cagr" };
}

export default function ClientWealthPlanner() {
  const objectives = useQuery<{ items: ClientObjective[] }>({
    queryKey: ["/api/client/objectives"],
  });
  const documents = useQuery<{ items: ClientDocument[] }>({
    queryKey: ["/api/client/documents"],
  });
  const { toast } = useToast();
  // Per-row "downloading…" state. A Set rather than a single id so that
  // clicking Download on row B while row A is still in flight does NOT
  // erase row A's spinner — both rows stay correctly marked until each
  // download settles.
  const [downloadingIds, setDownloadingIds] = useState<Set<number>>(
    () => new Set(),
  );
  const markDownloading = (id: number, on: boolean) =>
    setDownloadingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  // Task #113 — the download endpoint requires a Bearer token, so a plain
  // <a href> would 401. We fetch the bytes with the same auth header the
  // rest of the app uses, then trigger a save via a transient blob URL.
  // The server resolves the storageKey to the underlying object-storage
  // bytes; the browser never sees the storageKey at all.
  const handleDownload = async (doc: ClientDocument) => {
    markDownloading(doc.id, true);
    try {
      const token =
        (typeof localStorage !== "undefined" &&
          localStorage.getItem("amax_jwt")) ||
        "";
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`/api/client/documents/${doc.id}/download`, {
        headers,
      });
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.fileName || `document-${doc.id}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({
        title: "Could not download document",
        description: String(err?.message ?? "Unexpected error"),
        variant: "destructive",
      });
    } finally {
      markDownloading(doc.id, false);
    }
  };

  // Task #338 — pull the current portfolio total so each objective can show a
  // progress-against-target bar and the required-CAGR readout. Reusing the
  // shared usePortfolioAllocation hook keeps the polling cadence consistent
  // with the portfolio page (30s refetch) so the two surfaces always agree
  // on the live total.
  const allocation = usePortfolioAllocation();
  const portfolioValue = Number(allocation.data?.totalValue ?? 0);

  return (
    <div className="p-6 space-y-6" data-testid="page-client-wealth-planner">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Wealth planner</h1>
        <p className="text-sm text-gray-500">
          Your structured objectives and the documents your adviser has on file.
        </p>
      </div>

      <Tabs defaultValue="objectives" className="space-y-4">
        <TabsList>
          <TabsTrigger value="objectives" data-testid="tab-client-objectives">
            <Target className="h-4 w-4 mr-2" /> Objectives
          </TabsTrigger>
          <TabsTrigger value="documents" data-testid="tab-client-documents">
            <FileText className="h-4 w-4 mr-2" /> Documents
          </TabsTrigger>
        </TabsList>

        {/* OBJECTIVES */}
        <TabsContent value="objectives">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Target className="h-4 w-4 text-violet-500" />
                Your objectives
              </CardTitle>
            </CardHeader>
            <CardContent>
              {objectives.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : objectives.isError ? (
                <p className="text-sm text-red-600">
                  Unable to load your objectives.
                </p>
              ) : (objectives.data?.items ?? []).length === 0 ? (
                <p
                  className="text-sm text-gray-500"
                  data-testid="text-no-objectives"
                >
                  Your adviser has not recorded any objectives yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Label</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead className="text-right">Target</TableHead>
                      <TableHead className="min-w-[200px]">Progress</TableHead>
                      <TableHead className="text-right">Required CAGR</TableHead>
                      <TableHead>Advice</TableHead>
                      <TableHead>Recorded</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(objectives.data?.items ?? []).map((o) => {
                      // Task #338 — per-objective progress + required CAGR.
                      // Progress is the share of the target already covered
                      // by the live portfolio total (capped at 100% so a
                      // completed goal renders as a full bar). Required CAGR
                      // uses the same formula the real-metrics route uses,
                      // with the short-horizon simple-return guard. Both
                      // numbers update automatically because the underlying
                      // /api/portfolio/allocation query refetches.
                      const targetAmount = o.targetAmount
                        ? Number(o.targetAmount)
                        : null;
                      const progressPct =
                        targetAmount && targetAmount > 0
                          ? Math.max(
                              0,
                              Math.min(
                                100,
                                (portfolioValue / targetAmount) * 100,
                              ),
                            )
                          : null;
                      const requiredCagr =
                        targetAmount != null
                          ? computeRequiredCagr(
                              portfolioValue,
                              targetAmount,
                              o.targetDate,
                            )
                          : null;
                      return (
                        <TableRow
                          key={o.id}
                          data-testid={`row-client-objective-${o.id}`}
                        >
                          <TableCell className="text-sm font-medium">
                            {o.label}
                            {o.notes ? (
                              <p className="text-xs text-gray-500 mt-1">
                                {o.notes}
                              </p>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-sm capitalize">
                            {o.objectiveType}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                o.priority === "primary"
                                  ? "default"
                                  : "secondary"
                              }
                              className="capitalize"
                            >
                              {o.priority}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm tabular-nums text-right">
                            {targetAmount != null
                              ? `${targetAmount.toLocaleString("en-AU", {
                                  maximumFractionDigits: 2,
                                })} ${o.targetCurrency}`
                              : "—"}
                            {o.targetDate ? (
                              <div className="text-xs text-gray-500">
                                by {formatDate(o.targetDate)}
                              </div>
                            ) : null}
                          </TableCell>
                          <TableCell
                            className="text-sm"
                            data-testid={`cell-objective-progress-${o.id}`}
                          >
                            {progressPct == null ? (
                              <span className="text-xs text-gray-400">—</span>
                            ) : (
                              <div className="space-y-1">
                                <Progress
                                  value={progressPct}
                                  className="h-1.5"
                                  data-testid={`progress-objective-${o.id}`}
                                />
                                <div className="flex items-center justify-between text-xs text-gray-500 tabular-nums">
                                  <span>
                                    {portfolioValue.toLocaleString("en-AU", {
                                      maximumFractionDigits: 0,
                                    })}{" "}
                                    /{" "}
                                    {targetAmount!.toLocaleString("en-AU", {
                                      maximumFractionDigits: 0,
                                    })}
                                  </span>
                                  <span className="font-medium text-gray-700">
                                    {progressPct.toFixed(1)}%
                                  </span>
                                </div>
                              </div>
                            )}
                          </TableCell>
                          <TableCell
                            className="text-sm tabular-nums text-right"
                            data-testid={`cell-objective-required-cagr-${o.id}`}
                          >
                            {requiredCagr == null ? (
                              <span className="text-xs text-gray-400">—</span>
                            ) : requiredCagr.value === 0 ? (
                              <Badge
                                variant="secondary"
                                className="text-[10px]"
                              >
                                Met
                              </Badge>
                            ) : (
                              <span>
                                {requiredCagr.value > 0 ? "+" : ""}
                                {requiredCagr.value.toFixed(1)}%
                                {requiredCagr.mode === "simple" ? (
                                  <span className="text-[10px] text-gray-400 ml-1">
                                    simple
                                  </span>
                                ) : (
                                  <span className="text-[10px] text-gray-400 ml-1">
                                    p.a.
                                  </span>
                                )}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">
                            <Link
                              href={`/client/advice/${o.adviceRecordId}`}
                              className="text-sky-600 hover:underline inline-flex items-center gap-1"
                              data-testid={`link-advice-${o.adviceRecordId}`}
                            >
                              #{o.adviceRecordId}
                              <ExternalLink className="h-3 w-3" />
                            </Link>
                          </TableCell>
                          <TableCell className="text-sm text-gray-500">
                            {formatDate(o.createdAt)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* DOCUMENTS */}
        <TabsContent value="documents">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileBadge className="h-4 w-4 text-sky-500" />
                Your documents
              </CardTitle>
            </CardHeader>
            <CardContent>
              {/* Task #318 — retention disclosure shown above the documents
                  list so the client understands why nothing is deletable
                  and how long their fact-finds will be retained. */}
              <div
                className="rounded-md border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800 mb-3 flex items-start gap-2"
                data-testid="strip-retention-policy"
              >
                <ShieldAlert className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>{RETENTION_POLICY_TEXT}</span>
              </div>
              {documents.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : documents.isError ? (
                <p className="text-sm text-red-600">
                  Unable to load your documents.
                </p>
              ) : (documents.data?.items ?? []).length === 0 ? (
                // Task #338 — proper designed empty state instead of a single
                // sentence on a blank panel. Clients cannot upload documents
                // themselves (uploads are an adviser action, gated by
                // assertAdviserClientLink) so the CTA is a "request from your
                // adviser" mailto, which is the realistic upload affordance
                // from the client's side of the relationship.
                <div
                  className="flex flex-col items-center text-center py-10 px-4 border border-dashed border-gray-200 rounded-md bg-gray-50/40"
                  data-testid="text-no-documents"
                >
                  <div className="h-10 w-10 rounded-full bg-sky-100 flex items-center justify-center mb-3">
                    <Inbox className="h-5 w-5 text-sky-600" />
                  </div>
                  <h3 className="text-sm font-semibold text-gray-900">
                    No documents on file yet
                  </h3>
                  <p className="text-xs text-gray-500 max-w-sm mt-1">
                    Your adviser uploads fact-finds, risk questionnaires and
                    statements here as your engagement progresses. They will
                    appear in this list as soon as they are saved.
                  </p>
                  <Button
                    asChild
                    size="sm"
                    variant="outline"
                    className="mt-4"
                    data-testid="button-request-document"
                  >
                    <a
                      href="mailto:compliance@amaxwealth.com.au?subject=Request%20to%20upload%20a%20document"
                    >
                      <Mail className="h-3.5 w-3.5 mr-1.5" />
                      Ask your adviser to upload one
                    </a>
                  </Button>
                </div>
              ) : (
                <TooltipProvider delayDuration={150}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>File</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Advice</TableHead>
                        <TableHead>Size</TableHead>
                        <TableHead>Uploaded</TableHead>
                        <TableHead>Retention until</TableHead>
                        <TableHead className="text-right">Download</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(documents.data?.items ?? []).map((d) => {
                        const locked =
                          d.deletionLocked || isRetentionActive(d.retentionUntil);
                        return (
                          <TableRow
                            key={d.id}
                            data-testid={`row-client-document-${d.id}`}
                          >
                            <TableCell className="text-sm">
                              <div className="font-medium">{d.fileName}</div>
                              {d.description ? (
                                <div className="text-xs text-gray-500 mt-1">
                                  {d.description}
                                </div>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-sm capitalize">
                              {d.documentType.replace(/_/g, " ")}
                            </TableCell>
                            <TableCell className="text-sm">
                              {d.adviceRecordId ? (
                                <Link
                                  href={`/client/advice/${d.adviceRecordId}`}
                                  className="text-sky-600 hover:underline inline-flex items-center gap-1"
                                >
                                  #{d.adviceRecordId}
                                  <ExternalLink className="h-3 w-3" />
                                </Link>
                              ) : (
                                "—"
                              )}
                            </TableCell>
                            <TableCell className="text-sm tabular-nums">
                              {formatBytes(d.fileSizeBytes)}
                            </TableCell>
                            <TableCell className="text-sm text-gray-500">
                              {formatDate(d.uploadedAt)}
                            </TableCell>
                            <TableCell className="text-sm">
                              <div className="flex items-center gap-2">
                                <span
                                  className="text-gray-700"
                                  data-testid={`text-retention-until-${d.id}`}
                                >
                                  {formatDate(d.retentionUntil)}
                                </span>
                                {locked ? (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Badge
                                        variant="secondary"
                                        className="flex items-center gap-1 cursor-help"
                                        data-testid={`badge-document-locked-${d.id}`}
                                      >
                                        <Lock className="h-3 w-3" />
                                        Locked
                                      </Badge>
                                    </TooltipTrigger>
                                    <TooltipContent className="max-w-xs">
                                      {RETENTION_POLICY_TEXT}
                                    </TooltipContent>
                                  </Tooltip>
                                ) : null}
                              </div>
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={downloadingIds.has(d.id)}
                                onClick={() => handleDownload(d)}
                                data-testid={`button-download-document-${d.id}`}
                                aria-label={`Download ${d.fileName}`}
                              >
                                <Download className="h-4 w-4 mr-1" />
                                {downloadingIds.has(d.id)
                                  ? "Downloading…"
                                  : "Download"}
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TooltipProvider>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
