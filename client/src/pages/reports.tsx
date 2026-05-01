import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link, useLocation } from "wouter";
import { PortalPageHeader } from "@/components/layout/PortalPageHeader";
import { StatusChip } from "@/components/ui/status-chip";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { ArrowRight } from "lucide-react";
import {
  downloadClientDocument,
  explainDownloadError,
} from "@/pages/client/wealth-planner";

/** Wire shape for GET /api/client/documents (see `client/wealth-planner.tsx`). */
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
  retentionUntil: string | null;
  deletionLocked: boolean;
}

function hubButtonClass(path: string, location: string): string {
  const current = location === path;
  return cn(
    "border-slate-200",
    current && "border-sky-400 bg-sky-50 font-medium text-sky-950 shadow-sm hover:bg-sky-50",
  );
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

function isRetentionActive(retentionUntil: string | null | undefined): boolean {
  if (!retentionUntil) return false;
  const t = new Date(retentionUntil).getTime();
  if (!Number.isFinite(t)) return false;
  return t > Date.now();
}

function documentTypeLabel(raw: string): string {
  return raw.replace(/_/g, " ");
}

export default function ReportsPage() {
  const [location] = useLocation();
  const { toast } = useToast();
  const [docAction, setDocAction] = useState<{ id: number; mode: "view" | "download" } | null>(null);

  const documents = useQuery<{ items: ClientDocument[] }>({
    queryKey: ["/api/client/documents"],
    queryFn: async () => (await apiFetch("/api/client/documents")).json(),
  });

  const isError = documents.isError;
  const isLoading = documents.isLoading;
  const items = documents.data?.items ?? [];
  const showEmptyList = !isLoading && !isError && items.length === 0;

  const handleDownload = async (doc: ClientDocument) => {
    setDocAction({ id: doc.id, mode: "download" });
    try {
      await downloadClientDocument(doc.id, doc.fileName);
    } catch (err) {
      const { title, description } = explainDownloadError(err);
      toast({ title, description, variant: "destructive" });
    } finally {
      setDocAction(null);
    }
  };

  const handleView = async (doc: ClientDocument) => {
    const mime = (doc.mimeType ?? "").toLowerCase();
    if (!mime.includes("pdf")) {
      toast({
        title: "Open in browser",
        description: "Preview opens for PDF files. Use Download for this document type.",
      });
      return;
    }
    setDocAction({ id: doc.id, mode: "view" });
    try {
      const res = await apiFetch(`/api/client/documents/${doc.id}/download`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      const { title, description } = explainDownloadError(err);
      toast({ title, description, variant: "destructive" });
    } finally {
      setDocAction(null);
    }
  };

  return (
    <div className="space-y-8 p-6" data-testid="page-reports">
      <PortalPageHeader
        eyebrow="Investor portal"
        title="Reports"
        description="Advice documents, disclosures, and review materials your adviser has issued or placed on file. Use View or Download for your records."
      />

      <nav className="flex flex-wrap gap-2" aria-label="Investor portal sections">
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/dashboard", location)}>
          <Link href="/dashboard">
            Dashboard <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/portfolio", location)}>
          <Link href="/portfolio">Portfolio</Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/ai-insights", location)}>
          <Link href="/ai-insights">AI insights</Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/goals", location)}>
          <Link href="/goals">Goals</Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/reports", location)}>
          <Link href="/reports" aria-current={location === "/reports" ? "page" : undefined}>
            Reports
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/account", location)}>
          <Link href="/account">Account</Link>
        </Button>
      </nav>

      <div
        className="flex flex-wrap items-start gap-3 rounded-lg border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-950"
        role="region"
        aria-label="Advice-only scope"
      >
        <StatusChip domain="advice">Reporting scope</StatusChip>
        <p className="min-w-0 flex-1 leading-relaxed">
          This library lists advice documents, statements, and review history in AFSL-scoped context (managed
          investments, securities, superannuation, life insurance). AMAX Wealth does not hold client assets,
          does not place orders, and does not move funds on your behalf. Use these files with your adviser
          when assessing recommendations.
        </p>
      </div>

      <section className="space-y-4" aria-labelledby="document-library-heading">
        <h2 id="document-library-heading" className="text-sm font-semibold text-slate-900">
          Document library
        </h2>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-base text-slate-900">Adviser-issued files</CardTitle>
            <StatusChip domain="workflow">Version on file</StatusChip>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading ? (
              <>
                <Skeleton className="h-28 w-full rounded-lg" />
                <Skeleton className="h-28 w-full rounded-lg" />
              </>
            ) : isError ? (
              <div className="rounded-lg border border-red-200 bg-red-50/80 px-4 py-6 text-center text-sm text-red-900">
                We couldn&apos;t load your documents. Refresh the page or try again shortly.
              </div>
            ) : showEmptyList ? (
              <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-4 py-8 text-center text-sm text-slate-600">
                <p className="font-medium text-slate-800">No documents on file yet</p>
                <p className="mt-2 max-w-md mx-auto leading-relaxed">
                  When your adviser uploads statements, SOAs, ROAs, or other disclosure files, they will appear
                  here with download links.
                </p>
              </div>
            ) : (
              items.map((row) => {
                const locked = row.deletionLocked || isRetentionActive(row.retentionUntil);
                const rowBusy = docAction?.id === row.id;
                const viewBusy = rowBusy && docAction?.mode === "view";
                const downloadBusy = rowBusy && docAction?.mode === "download";
                return (
                  <div
                    key={row.id}
                    className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 md:flex-row md:items-center md:justify-between"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusChip domain="advice" className="capitalize">
                          {documentTypeLabel(row.documentType)}
                        </StatusChip>
                        <p className="text-sm font-medium text-slate-900">{row.fileName}</p>
                      </div>
                      {row.description ? (
                        <p className="text-xs text-slate-600">{row.description}</p>
                      ) : null}
                      <p className="text-xs text-slate-500">
                        Uploaded {formatDate(row.uploadedAt)} · {formatBytes(row.fileSizeBytes)}
                        {row.adviceRecordId != null ? (
                          <>
                            {" · "}
                            <Link
                              href={`/client/advice/${row.adviceRecordId}`}
                              className="text-sky-700 underline-offset-2 hover:underline"
                            >
                              Advice record #{row.adviceRecordId}
                            </Link>
                          </>
                        ) : null}
                        {" · "}
                        Retention until {formatDate(row.retentionUntil)}
                      </p>
                    </div>
                    <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
                      {locked ? (
                        <StatusChip domain="report" className="border-slate-300 bg-slate-100 text-slate-800">
                          Retention active
                        </StatusChip>
                      ) : (
                        <StatusChip domain="report">On file</StatusChip>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        type="button"
                        disabled={rowBusy}
                        onClick={() => void handleView(row)}
                      >
                        {viewBusy ? "Opening…" : "View"}
                      </Button>
                      <Button
                        size="sm"
                        type="button"
                        disabled={rowBusy}
                        onClick={() => void handleDownload(row)}
                      >
                        {downloadBusy ? "Downloading…" : "Download"}
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </section>

      <p className="text-xs leading-relaxed text-slate-500">
        Documents are issued as part of adviser-led financial product advice. Contact your adviser if anything
        is unclear.
      </p>
    </div>
  );
}
