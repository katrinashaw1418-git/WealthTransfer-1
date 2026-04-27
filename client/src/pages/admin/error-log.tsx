// =============================================================================
// Task #165 — Persistent error log viewer
// -----------------------------------------------------------------------------
// Read-only admin page that tails the latest entries from logs/errors.log
// (and rotated logs/errors.log.1 …). The server stream-reads the files so
// nothing is loaded into memory; this page simply renders what comes back
// and offers a "download raw file" link for offline analysis.
// =============================================================================

import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Download,
  FileWarning,
  RefreshCcw,
  X,
} from "lucide-react";

const TOKEN_KEY = "amax_jwt";

interface ErrorLogEntry {
  ts: string | null;
  tag: string | null;
  requestId: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  userId: number | null;
  message: string | null;
  stack: string | null;
  source: string;
  parseError?: boolean;
}

interface ErrorLogFile {
  index: number;
  name: string;
  bytes: number;
  modifiedAt: string;
}

interface ErrorLogResponse {
  entries: ErrorLogEntry[];
  scannedLines: number;
  matchedLines: number;
  truncated: boolean;
  tagsSeen: string[];
  files: ErrorLogFile[];
  limit: number;
  maxRotations: number;
}

// Sentinel value for the "all tags" option — <SelectItem> requires a
// non-empty value, and "all" is reserved for clearing the filter.
const ALL_TAGS_VALUE = "__all__";
const DEFAULT_LIMIT = 200;

function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function fmt(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return d;
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function isoFromLocalInput(value: string): string | null {
  if (!value) return null;
  // datetime-local returns YYYY-MM-DDTHH:mm with no timezone — interpret
  // as the operator's local timezone so "from 9am" filters as expected.
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export default function AdminErrorLog() {
  const [tagFilter, setTagFilter] = useState<string>(ALL_TAGS_VALUE);
  const [searchInput, setSearchInput] = useState<string>("");
  const [appliedSearch, setAppliedSearch] = useState<string>("");
  const [fromInput, setFromInput] = useState<string>("");
  const [toInput, setToInput] = useState<string>("");
  const [appliedFrom, setAppliedFrom] = useState<string>("");
  const [appliedTo, setAppliedTo] = useState<string>("");
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [downloadFileIndex, setDownloadFileIndex] = useState<string>("0");

  const queryKey = [
    "/api/admin/error-log",
    {
      tag: tagFilter === ALL_TAGS_VALUE ? "" : tagFilter,
      q: appliedSearch,
      from: appliedFrom,
      to: appliedTo,
    },
  ];

  const { data, isLoading, isFetching, refetch, error } = useQuery<ErrorLogResponse>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (tagFilter && tagFilter !== ALL_TAGS_VALUE) params.set("tag", tagFilter);
      if (appliedSearch.trim()) params.set("q", appliedSearch.trim());
      if (appliedFrom) params.set("from", appliedFrom);
      if (appliedTo) params.set("to", appliedTo);
      params.set("limit", String(DEFAULT_LIMIT));
      const token = getToken();
      const res = await fetch(`/api/admin/error-log?${params.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      return res.json();
    },
  });

  // Build the dropdown options from the union of tags the server has seen
  // (stable across refetches) plus whatever is currently selected so the
  // selection doesn't disappear after a refetch with a narrower window.
  const tagOptions = useMemo(() => {
    const seen = new Set<string>(data?.tagsSeen ?? []);
    if (tagFilter !== ALL_TAGS_VALUE) seen.add(tagFilter);
    return Array.from(seen).sort();
  }, [data?.tagsSeen, tagFilter]);

  const downloadableFiles = data?.files ?? [];
  const availableForDownload = downloadableFiles.find(
    (f) => String(f.index) === downloadFileIndex,
  );
  // If the user picked a file that no longer exists (e.g. just rotated),
  // fall back to the active log automatically.
  const effectiveDownloadIndex = availableForDownload
    ? downloadFileIndex
    : downloadableFiles.length > 0
      ? String(downloadableFiles[0].index)
      : "0";

  function applyFilters() {
    setAppliedSearch(searchInput);
    setAppliedFrom(isoFromLocalInput(fromInput) ?? "");
    setAppliedTo(isoFromLocalInput(toInput) ?? "");
    setExpandedIndex(null);
  }

  function clearFilters() {
    setTagFilter(ALL_TAGS_VALUE);
    setSearchInput("");
    setAppliedSearch("");
    setFromInput("");
    setToInput("");
    setAppliedFrom("");
    setAppliedTo("");
    setExpandedIndex(null);
  }

  function downloadActiveFile() {
    const token = getToken();
    const idx = effectiveDownloadIndex;
    // We cannot use a plain anchor: the endpoint requires a Bearer token in
    // the Authorization header. Fetch the file as a Blob and trigger the
    // browser's "save as" dialog client-side.
    fetch(`/api/admin/error-log/download?file=${encodeURIComponent(idx)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = (await res.text()) || res.statusText;
          throw new Error(`${res.status}: ${text}`);
        }
        const blob = await res.blob();
        const filename = (() => {
          const f = downloadableFiles.find((d) => String(d.index) === idx);
          return f?.name ?? "errors.log";
        })();
        const href = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = href;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(href);
      })
      .catch((err) => {
        console.error("[admin/error-log] download failed", err);
        alert(`Download failed: ${err instanceof Error ? err.message : err}`);
      });
  }

  return (
    <div className="space-y-4 max-w-7xl">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Error log</h1>
        <p className="text-sm text-slate-500 mt-1">
          The last {DEFAULT_LIMIT} entries written to{" "}
          <code className="text-xs">logs/errors.log</code> (and rotated
          copies). Read-only — useful for spotting recurring 5xx patterns
          without SSH'ing into the box.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileWarning className="h-4 w-4 text-violet-600" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <div className="md:col-span-1">
              <label className="text-xs text-slate-500 block mb-1">Tag</label>
              <Select
                value={tagFilter}
                onValueChange={(v) => {
                  setTagFilter(v);
                  setExpandedIndex(null);
                }}
              >
                <SelectTrigger data-testid="select-tag">
                  <SelectValue placeholder="All tags" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_TAGS_VALUE} data-testid="option-tag-all">
                    All tags
                  </SelectItem>
                  {tagOptions.map((t) => (
                    <SelectItem key={t} value={t} data-testid={`option-tag-${t}`}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <label className="text-xs text-slate-500 block mb-1">
                Search (message or path)
              </label>
              <Input
                placeholder="e.g. timeout, /api/admin"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyFilters();
                }}
                data-testid="input-search"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">From</label>
              <Input
                type="datetime-local"
                value={fromInput}
                onChange={(e) => setFromInput(e.target.value)}
                data-testid="input-from"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">To</label>
              <Input
                type="datetime-local"
                value={toInput}
                onChange={(e) => setToInput(e.target.value)}
                data-testid="input-to"
              />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={applyFilters} data-testid="button-apply-filters">
              Apply
            </Button>
            <Button
              variant="outline"
              onClick={clearFilters}
              data-testid="button-clear-filters"
            >
              <X className="h-4 w-4 mr-1" />
              Clear
            </Button>
            <Button
              variant="outline"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="button-refresh"
            >
              <RefreshCcw
                className={`h-4 w-4 mr-1 ${isFetching ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
            <div className="ml-auto flex items-center gap-2">
              {downloadableFiles.length > 1 && (
                <Select
                  value={effectiveDownloadIndex}
                  onValueChange={setDownloadFileIndex}
                >
                  <SelectTrigger
                    className="w-[180px]"
                    data-testid="select-download-file"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {downloadableFiles.map((f) => (
                      <SelectItem
                        key={f.index}
                        value={String(f.index)}
                        data-testid={`option-download-${f.name}`}
                      >
                        {f.name} ({fmtBytes(f.bytes)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button
                variant="outline"
                onClick={downloadActiveFile}
                disabled={downloadableFiles.length === 0}
                data-testid="button-download"
              >
                <Download className="h-4 w-4 mr-1" />
                Download raw file
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="pt-6">
            <div
              className="flex items-start gap-2 text-sm text-rose-700"
              data-testid="text-error"
            >
              <AlertCircle className="h-4 w-4 mt-0.5" />
              Failed to load error log: {error instanceof Error ? error.message : String(error)}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">
            {isLoading ? (
              "Loading…"
            ) : data ? (
              <span data-testid="text-summary">
                Showing {data.entries.length} of {data.matchedLines} matching
                ({data.scannedLines} lines scanned)
                {data.truncated ? " — truncated" : ""}
              </span>
            ) : (
              "No data"
            )}
          </CardTitle>
          {data && data.files.length > 0 && (
            <div
              className="text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-1"
              data-testid="text-files"
            >
              {data.files.map((f) => (
                <span key={f.index} data-testid={`file-${f.name}`}>
                  <span className="font-mono">{f.name}</span> · {fmtBytes(f.bytes)} ·{" "}
                  {fmt(f.modifiedAt)}
                </span>
              ))}
            </div>
          )}
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : !data || data.entries.length === 0 ? (
            <p className="text-sm text-slate-500" data-testid="text-empty">
              {data && data.files.length === 0
                ? "No error log file has been written yet."
                : "No entries match these filters."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[170px]">When</TableHead>
                  <TableHead className="w-[150px]">Tag</TableHead>
                  <TableHead className="w-[80px]">Status</TableHead>
                  <TableHead className="w-[80px]">Method</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead className="w-[80px]">User</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead className="w-[40px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.entries.map((entry, idx) => {
                  const isExpanded = expandedIndex === idx;
                  return (
                    <Fragment key={`${entry.ts}-${idx}`}>
                      <TableRow data-testid={`row-error-${idx}`}>
                        <TableCell className="text-xs text-slate-600 whitespace-nowrap align-top">
                          {fmt(entry.ts)}
                        </TableCell>
                        <TableCell className="align-top">
                          {entry.tag ? (
                            <Badge
                              variant="outline"
                              className="font-mono text-[11px]"
                              data-testid={`badge-tag-${idx}`}
                            >
                              {entry.tag}
                            </Badge>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm font-mono align-top">
                          {entry.status ?? "—"}
                        </TableCell>
                        <TableCell className="text-sm font-mono align-top">
                          {entry.method ?? "—"}
                        </TableCell>
                        <TableCell className="text-xs font-mono text-slate-700 align-top break-all">
                          {entry.path ?? "—"}
                        </TableCell>
                        <TableCell className="text-sm font-mono align-top">
                          {entry.userId ?? "—"}
                        </TableCell>
                        <TableCell className="text-xs text-slate-700 align-top">
                          <div className="line-clamp-2 break-words">
                            {entry.parseError
                              ? `(unparseable line) ${entry.message ?? ""}`
                              : entry.message ?? "—"}
                          </div>
                          <div className="text-[10px] text-slate-400 mt-1">
                            from <span className="font-mono">{entry.source}</span>
                            {entry.requestId
                              ? ` · rid ${entry.requestId}`
                              : ""}
                          </div>
                        </TableCell>
                        <TableCell className="align-top">
                          {entry.stack || entry.parseError ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2"
                              onClick={() =>
                                setExpandedIndex(isExpanded ? null : idx)
                              }
                              data-testid={`button-toggle-${idx}`}
                              aria-expanded={isExpanded}
                              aria-label={
                                isExpanded ? "Hide stack" : "Show stack"
                              }
                            >
                              {isExpanded ? (
                                <ChevronUp className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow
                          data-testid={`row-error-${idx}-stack`}
                          className="bg-slate-50/60 hover:bg-slate-50/60"
                        >
                          <TableCell colSpan={8} className="py-3">
                            <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-white border border-slate-200 rounded px-2 py-2 max-h-96 overflow-auto">
                              {entry.stack ?? entry.message ?? "(no stack recorded)"}
                            </pre>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
