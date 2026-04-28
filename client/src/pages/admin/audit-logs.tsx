import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ScrollText,
  ChevronLeft,
  ChevronRight,
  X,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface AuditRow {
  id: number;
  userId: number | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: any;
  ipAddress: string | null;
  createdAt: string | null;
}

interface AuditPage {
  items: AuditRow[];
  page: number;
  limit: number;
  total: number;
}

const TOKEN_KEY = "amax_jwt";

function fmt(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return "—";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isSnapshotValue(v: unknown): boolean {
  // The standardised writer in server/services/audit.ts always sets
  // `before` and `after` to either an object snapshot or null. Anything
  // else (string, number, array, etc.) means it's a legacy metadata
  // entry that just happens to use the same key name.
  return v === null || isPlainObject(v);
}

function hasStandardisedDiff(meta: unknown): boolean {
  if (!isPlainObject(meta)) return false;
  const hasBefore = "before" in meta;
  const hasAfter = "after" in meta;
  if (!hasBefore && !hasAfter) return false;
  if (hasBefore && !isSnapshotValue(meta.before)) return false;
  if (hasAfter && !isSnapshotValue(meta.after)) return false;
  return true;
}

interface DiffSummary {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
}

function computeDiff(before: unknown, after: unknown): DiffSummary {
  const beforeObj = isPlainObject(before) ? before : {};
  const afterObj = isPlainObject(after) ? after : {};
  const allKeys = new Set([
    ...Object.keys(beforeObj),
    ...Object.keys(afterObj),
  ]);
  const out: DiffSummary = { added: [], removed: [], changed: [], unchanged: [] };
  for (const k of Array.from(allKeys).sort()) {
    const inBefore = k in beforeObj;
    const inAfter = k in afterObj;
    if (!inBefore && inAfter) {
      out.added.push(k);
    } else if (inBefore && !inAfter) {
      out.removed.push(k);
    } else {
      const bv = beforeObj[k];
      const av = afterObj[k];
      if (JSON.stringify(bv) === JSON.stringify(av)) out.unchanged.push(k);
      else out.changed.push(k);
    }
  }
  return out;
}

function renderValue(v: unknown): string {
  if (v === undefined) return "—";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function DiffSummaryBadges({ summary }: { summary: DiffSummary }) {
  const items: Array<{ label: string; count: number; cls: string; testid: string }> = [
    {
      label: "changed",
      count: summary.changed.length,
      cls: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/40 dark:text-amber-100 dark:border-amber-800",
      testid: "badge-diff-changed",
    },
    {
      label: "added",
      count: summary.added.length,
      cls: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-100 dark:border-emerald-800",
      testid: "badge-diff-added",
    },
    {
      label: "removed",
      count: summary.removed.length,
      cls: "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-900/40 dark:text-rose-100 dark:border-rose-800",
      testid: "badge-diff-removed",
    },
  ].filter((x) => x.count > 0);
  if (items.length === 0) {
    return (
      <Badge variant="outline" className="text-[10px] font-normal text-slate-500 dark:text-slate-400">
        no field changes
      </Badge>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((it) => (
        <span
          key={it.label}
          className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${it.cls}`}
          data-testid={it.testid}
        >
          {it.count} {it.label}
        </span>
      ))}
    </div>
  );
}

function DiffField({
  fieldKey,
  before,
  after,
  kind,
}: {
  fieldKey: string;
  before: unknown;
  after: unknown;
  kind: "added" | "removed" | "changed" | "unchanged";
}) {
  const beforeText = renderValue(before);
  const afterText = renderValue(after);

  const beforeCellCls = (() => {
    if (kind === "added")
      return "bg-slate-50 text-slate-400 dark:bg-slate-900/40 dark:text-slate-500";
    if (kind === "removed")
      return "bg-rose-50 text-rose-900 line-through dark:bg-rose-950/40 dark:text-rose-200";
    if (kind === "changed")
      return "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100";
    return "bg-slate-50 text-slate-600 dark:bg-slate-900/40 dark:text-slate-300";
  })();

  const afterCellCls = (() => {
    if (kind === "added")
      return "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100";
    if (kind === "removed")
      return "bg-slate-50 text-slate-400 dark:bg-slate-900/40 dark:text-slate-500";
    if (kind === "changed")
      return "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100";
    return "bg-slate-50 text-slate-600 dark:bg-slate-900/40 dark:text-slate-300";
  })();

  return (
    <div
      className="grid grid-cols-[140px_1fr_1fr] gap-2 text-xs border-t border-slate-200 dark:border-slate-700 first:border-t-0 py-1.5"
      data-testid={`diff-field-${fieldKey}`}
    >
      <div
        className="font-mono text-slate-700 dark:text-slate-200 truncate"
        title={fieldKey}
      >
        {fieldKey}
      </div>
      <pre className={`font-mono whitespace-pre-wrap break-all rounded px-2 py-1 ${beforeCellCls}`}>
        {kind === "added" ? "—" : beforeText}
      </pre>
      <pre className={`font-mono whitespace-pre-wrap break-all rounded px-2 py-1 ${afterCellCls}`}>
        {kind === "removed" ? "—" : afterText}
      </pre>
    </div>
  );
}

function MetadataDiff({ metadata }: { metadata: Record<string, unknown> }) {
  const before = metadata.before;
  const after = metadata.after;
  const summary = computeDiff(before, after);

  const beforeObj = isPlainObject(before) ? before : {};
  const afterObj = isPlainObject(after) ? after : {};

  const extraKeys = Object.keys(metadata).filter((k) => k !== "before" && k !== "after");

  const [showUnchanged, setShowUnchanged] = useState(false);

  type FieldKind = "added" | "removed" | "changed" | "unchanged";
  const ordered: Array<{ key: string; kind: FieldKind }> = [
    ...summary.changed.map((k) => ({ key: k, kind: "changed" as const })),
    ...summary.added.map((k) => ({ key: k, kind: "added" as const })),
    ...summary.removed.map((k) => ({ key: k, kind: "removed" as const })),
    ...(showUnchanged
      ? summary.unchanged.map((k) => ({ key: k, kind: "unchanged" as const }))
      : []),
  ];

  return (
    <div className="space-y-3" data-testid="metadata-diff-view">
      <div className="grid grid-cols-[140px_1fr_1fr] gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        <div>Field</div>
        <div>Before</div>
        <div>After</div>
      </div>
      {ordered.length === 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          No before/after fields recorded for this entry.
        </p>
      ) : (
        <div className="rounded border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900 px-2">
          {ordered.map(({ key, kind }) => (
            <DiffField
              key={key}
              fieldKey={key}
              before={beforeObj[key]}
              after={afterObj[key]}
              kind={kind}
            />
          ))}
        </div>
      )}
      {summary.unchanged.length > 0 && (
        <button
          type="button"
          onClick={() => setShowUnchanged((v) => !v)}
          className="text-xs text-violet-700 hover:text-violet-900 dark:text-violet-300 dark:hover:text-violet-100 underline-offset-2 hover:underline"
          data-testid="button-toggle-unchanged"
          aria-label={
            showUnchanged
              ? `Hide ${summary.unchanged.length} unchanged fields`
              : `Show ${summary.unchanged.length} unchanged fields`
          }
        >
          {showUnchanged
            ? `Hide unchanged (${summary.unchanged.length})`
            : `Show unchanged (${summary.unchanged.length})`}
        </button>
      )}
      {extraKeys.length > 0 && (
        <div className="border-t border-slate-200 dark:border-slate-700 pt-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
            Context
          </div>
          <pre
            className="text-[11px] font-mono text-slate-700 dark:text-slate-200 whitespace-pre-wrap break-all bg-slate-50 dark:bg-slate-900/60 rounded px-2 py-1"
            data-testid="metadata-diff-context"
          >
            {JSON.stringify(
              Object.fromEntries(extraKeys.map((k) => [k, metadata[k]])),
              null,
              2,
            )}
          </pre>
        </div>
      )}
    </div>
  );
}

function MetadataCell({
  metadata,
  expanded,
  onToggle,
}: {
  metadata: unknown;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!metadata) {
    return <span className="text-xs text-slate-400 dark:text-slate-500">—</span>;
  }
  if (!hasStandardisedDiff(metadata)) {
    return (
      <pre className="text-[11px] font-mono text-slate-600 dark:text-slate-300 whitespace-pre-wrap break-all bg-slate-50 dark:bg-slate-900/60 rounded px-2 py-1 max-h-32 overflow-auto">
        {JSON.stringify(metadata)}
      </pre>
    );
  }
  const summary = computeDiff(
    (metadata as Record<string, unknown>).before,
    (metadata as Record<string, unknown>).after,
  );
  const totalChanged =
    summary.changed.length + summary.added.length + summary.removed.length;
  const ariaLabel = expanded
    ? "Hide before and after diff"
    : `Show before and after diff (${totalChanged} field${totalChanged === 1 ? "" : "s"} changed)`;
  return (
    <div className="flex items-start gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 -ml-2"
        onClick={onToggle}
        data-testid="button-toggle-diff"
        aria-expanded={expanded}
        aria-label={ariaLabel}
      >
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" />
        )}
        <span className="ml-1 text-xs">{expanded ? "Hide diff" : "View diff"}</span>
      </Button>
      <div className="pt-1">
        <DiffSummaryBadges summary={summary} />
      </div>
    </div>
  );
}

export default function AdminAuditLogs() {
  // Read filters from the querystring once, on first render — other admin
  // pages (e.g. background-jobs) deep-link here with `?action=…&entityType=
  // …&entityId=…` so the operator lands on the exact audit row that backs
  // the surface they clicked from. We deliberately don't subscribe to live
  // querystring changes because the user can also edit the filter inputs;
  // re-syncing on every URL change would clobber their in-progress edits.
  // `entityId` has no input field — it is a deep-link-only narrowing that
  // is preserved across pagination and cleared via the Reset button.
  const initialSearch = useSearch();
  const initialParams = new URLSearchParams(initialSearch);
  const [actionFilter, setActionFilter] = useState(
    (initialParams.get("action") ?? "").slice(0, 200),
  );
  const [entityFilter, setEntityFilter] = useState(
    (initialParams.get("entityType") ?? "").slice(0, 200),
  );
  const [userFilter, setUserFilter] = useState(
    (initialParams.get("userId") ?? "").slice(0, 64),
  );
  const [entityIdFilter, setEntityIdFilter] = useState(
    (initialParams.get("entityId") ?? "").slice(0, 200),
  );
  // Task #399 — exact-row deep-link: callers can pin the page to a single
  // audit row (the `id` URL param). No input field — chip only, cleared
  // via the chip's Clear button or the global Reset.
  const [exactIdFilter, setExactIdFilter] = useState(
    (initialParams.get("id") ?? "").slice(0, 32),
  );
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const limit = 50;

  const queryKey = [
    "/api/admin/audit-logs",
    { actionFilter, entityFilter, userFilter, entityIdFilter, exactIdFilter, page },
  ];

  const { data, isLoading } = useQuery<AuditPage>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (actionFilter.trim()) params.set("action", actionFilter.trim());
      if (entityFilter.trim()) params.set("entityType", entityFilter.trim());
      if (userFilter.trim()) params.set("userId", userFilter.trim());
      if (entityIdFilter.trim()) params.set("entityId", entityIdFilter.trim());
      if (exactIdFilter.trim()) params.set("id", exactIdFilter.trim());
      params.set("page", String(page));
      params.set("limit", String(limit));
      const token = (() => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } })();
      const res = await fetch(`/api/admin/audit-logs?${params.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / limit)) : 1;

  function clearFilters() {
    setActionFilter("");
    setEntityFilter("");
    setUserFilter("");
    setEntityIdFilter("");
    setExactIdFilter("");
    setPage(1);
    setExpandedId(null);
  }

  function applyFilters() {
    setPage(1);
    setExpandedId(null);
  }

  function toggleExpand(id: number) {
    setExpandedId((curr) => (curr === id ? null : id));
  }

  return (
    <div className="space-y-4 max-w-7xl">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Audit log</h1>
        <p className="text-sm text-slate-500 mt-1">
          Every state-changing action across the platform. Read-only.
          Entries that record before/after snapshots show a structured field-level
          diff — click <span className="font-medium">View diff</span>.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-violet-600" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <Input
              placeholder="Action contains…"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              data-testid="input-filter-action"
            />
            <Input
              placeholder="Entity type (exact)"
              value={entityFilter}
              onChange={(e) => setEntityFilter(e.target.value)}
              data-testid="input-filter-entity"
            />
            <Input
              placeholder="User ID"
              type="number"
              value={userFilter}
              onChange={(e) => setUserFilter(e.target.value)}
              data-testid="input-filter-user"
            />
            <div className="flex gap-2">
              <Button onClick={applyFilters} className="flex-1" data-testid="button-apply-filters">
                Apply
              </Button>
              <Button variant="outline" onClick={clearFilters} data-testid="button-clear-filters">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {entityIdFilter.trim() && (
            <div className="mt-3 flex items-center gap-2" data-testid="chip-entity-id-filter">
              <Badge variant="outline" className="bg-violet-50 text-violet-800 border-violet-300">
                Entity ID = {entityIdFilter}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setEntityIdFilter(""); setPage(1); setExpandedId(null); }}
                className="h-6 px-2 text-xs"
                data-testid="button-clear-entity-id"
              >
                Clear
              </Button>
            </div>
          )}
          {exactIdFilter.trim() && (
            <div className="mt-3 flex items-center gap-2" data-testid="chip-exact-id-filter">
              <Badge variant="outline" className="bg-violet-50 text-violet-800 border-violet-300">
                Audit row #{exactIdFilter}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setExactIdFilter(""); setPage(1); setExpandedId(null); }}
                className="h-6 px-2 text-xs"
                data-testid="button-clear-exact-id"
              >
                Clear
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">
            {isLoading ? "Loading…" : `${data?.total ?? 0} entries`}
          </CardTitle>
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setPage((p) => Math.max(1, p - 1)); setExpandedId(null); }}
              disabled={page <= 1 || isLoading}
              data-testid="button-prev-page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span data-testid="text-pagination">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setPage((p) => Math.min(totalPages, p + 1)); setExpandedId(null); }}
              disabled={page >= totalPages || isLoading}
              data-testid="button-next-page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : !data || data.items.length === 0 ? (
            <p className="text-sm text-slate-500">No audit entries match these filters.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>Metadata</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((row) => {
                  const isExpanded = expandedId === row.id;
                  const showsDiff = hasStandardisedDiff(row.metadata);
                  return (
                    <Fragment key={row.id}>
                      <TableRow data-testid={`row-audit-${row.id}`}>
                        <TableCell className="text-xs text-slate-600 whitespace-nowrap align-top">
                          {fmt(row.createdAt)}
                        </TableCell>
                        <TableCell className="align-top">
                          <Badge variant="outline" className="font-mono text-xs">
                            {row.action}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm align-top">
                          {row.entityType ?? "—"}
                          {row.entityId ? ` #${row.entityId}` : ""}
                        </TableCell>
                        <TableCell className="text-sm font-mono align-top">{row.userId ?? "—"}</TableCell>
                        <TableCell className="text-xs text-slate-500 align-top">{row.ipAddress ?? "—"}</TableCell>
                        <TableCell className="max-w-md align-top">
                          <MetadataCell
                            metadata={row.metadata}
                            expanded={isExpanded}
                            onToggle={() => toggleExpand(row.id)}
                          />
                        </TableCell>
                      </TableRow>
                      {isExpanded && showsDiff && (
                        <TableRow
                          data-testid={`row-audit-${row.id}-diff`}
                          className="bg-slate-50/50 hover:bg-slate-50/50 dark:bg-slate-900/40 dark:hover:bg-slate-900/40"
                        >
                          <TableCell colSpan={6} className="py-3">
                            <MetadataDiff metadata={row.metadata as Record<string, unknown>} />
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
