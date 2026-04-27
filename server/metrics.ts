// =============================================================================
// Task #173 — /metrics endpoint (Prometheus text format)
// =============================================================================
// Mounted alongside /health and /ready (see server/health.ts) so dashboards
// can chart trends — request rate / latency percentiles / error counts per
// route, DB pool saturation, and background-job durations + success/error
// counts — that the one-shot /health and /ready endpoints can't give.
//
// Design choices:
//
//   * Zero-dependency: the Prometheus text format (v0.0.4) is small enough
//     that we hand-render it instead of pulling in `prom-client`. This keeps
//     the dependency surface stable AND keeps the histogram cumulative-
//     bucket invariant (each bucket's count includes everything ≤ le)
//     under our direct control — handy when we need to reason about it
//     during incident triage.
//
//   * In-process counters: an Express middleware (`metricsMiddleware`)
//     records every HTTP response into a module-level Map of counters and
//     a fixed-bucket histogram, keyed by `(route, method, status_class)`.
//     Route is taken from `req.route?.path` (the Express-matched pattern,
//     so `/api/users/:id` instead of `/api/users/123`) to keep label
//     cardinality bounded — see `cardinalityCheck()`.
//
//   * Self-skipping: /metrics, /health, /ready don't get recorded. They're
//     monitor traffic and would skew the request-rate signal. The endpoint
//     is also exempt from the per-IP rate limiter and the request logger
//     (it lives outside /api, see server/index.ts).
//
//   * Background-job metrics are sourced live from `background_job_runs`
//     so they reflect the canonical record (the same table the admin
//     "Background Jobs" page reads from), not a divergent in-memory copy.
// =============================================================================

import type { Express, NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import type { Pool } from "@neondatabase/serverless";
import { db, pool as defaultPool } from "./db";
import { KNOWN_BACKGROUND_JOBS } from "./services/background-jobs";

// ---------------------------------------------------------------------------
// Histogram buckets (seconds). The standard Prometheus default ladder —
// covers everything from a 5ms cache hit to a 10s slow query in the same
// chart, which is the right range for an HTTP API.
// ---------------------------------------------------------------------------
export const HTTP_DURATION_BUCKETS_SECONDS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

// Hard cap on distinct (route, method, status_class) tuples. If an unmatched
// path pushed this past the cap we'd have a cardinality explosion — instead
// we bucket everything beyond the cap into `__overflow__` so the metrics
// endpoint stays cheap to render even under URL-fuzz traffic.
const MAX_LABEL_TUPLES = 500;

interface HttpSeries {
  route: string;
  method: string;
  statusClass: string;
  count: number;
  sumSeconds: number;
  bucketCounts: number[]; // same length as HTTP_DURATION_BUCKETS_SECONDS
}

// Module-level state. Reset via `__resetMetricsForTests` so the test suite
// can run isolated cases without standing up a fresh process.
const httpSeriesByKey = new Map<string, HttpSeries>();

function seriesKey(route: string, method: string, statusClass: string): string {
  return `${method}\u0001${route}\u0001${statusClass}`;
}

function statusClassFor(status: number): string {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  return "1xx";
}

/**
 * Record one HTTP response. Exposed for tests and any future caller that
 * wants to seed the counters directly; the production caller is the
 * middleware below.
 */
export function recordHttpRequest(args: {
  method: string;
  route: string;
  status: number;
  durationSeconds: number;
}): void {
  const method = args.method.toUpperCase();
  const statusClass = statusClassFor(args.status);
  // Cardinality guard — see MAX_LABEL_TUPLES.
  let route = args.route;
  if (
    !httpSeriesByKey.has(seriesKey(route, method, statusClass)) &&
    httpSeriesByKey.size >= MAX_LABEL_TUPLES
  ) {
    route = "__overflow__";
  }
  const key = seriesKey(route, method, statusClass);
  let s = httpSeriesByKey.get(key);
  if (!s) {
    s = {
      route,
      method,
      statusClass,
      count: 0,
      sumSeconds: 0,
      bucketCounts: new Array(HTTP_DURATION_BUCKETS_SECONDS.length).fill(0),
    };
    httpSeriesByKey.set(key, s);
  }
  s.count += 1;
  s.sumSeconds += args.durationSeconds;
  // Cumulative buckets — every bucket whose le >= duration gets a +1.
  for (let i = 0; i < HTTP_DURATION_BUCKETS_SECONDS.length; i++) {
    if (args.durationSeconds <= HTTP_DURATION_BUCKETS_SECONDS[i]) {
      s.bucketCounts[i] += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Middleware. Mount BEFORE registerRoutes so the matched-route (req.route)
// is set by the time the response finishes. /metrics, /health, /ready are
// skipped — they're monitor traffic, not real app traffic, and recording
// them would skew the request-rate signal an operator is actually trying
// to chart.
// ---------------------------------------------------------------------------
const SKIP_PATHS = new Set(["/metrics", "/health", "/ready"]);

export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (SKIP_PATHS.has(req.path)) {
    return next();
  }
  const startNs = process.hrtime.bigint();
  res.on("finish", () => {
    try {
      const durationNs = process.hrtime.bigint() - startNs;
      const durationSeconds = Number(durationNs) / 1e9;
      // `req.route` is set by Express only when a route handler matched.
      // For 404s / static files / other middleware-only responses we
      // bucket into `<unmatched>` so we don't explode label cardinality
      // by recording every fuzzed URL as its own series.
      const matched = (req as Request & { route?: { path?: string } }).route;
      const route = matched?.path ? matched.path : "<unmatched>";
      recordHttpRequest({
        method: req.method,
        route,
        status: res.statusCode,
        durationSeconds,
      });
    } catch (e) {
      // Never let a metrics hiccup break a real client response.
      console.error("[metrics] failed to record HTTP request", e);
    }
  });
  next();
}

// ---------------------------------------------------------------------------
// DB pool stats. The neon-serverless Pool extends pg-pool, which exposes
// the three counters Prometheus scrapers expect. If a future driver swap
// drops these getters we fall back to NaN (rendered as 0) so the endpoint
// keeps working — the absence will show up as a flat-line on the dashboard
// and an operator will notice.
// ---------------------------------------------------------------------------
export interface DbPoolStats {
  total: number;
  idle: number;
  waiting: number;
  inUse: number;
}

export function getDbPoolStats(p: Pool = defaultPool): DbPoolStats {
  const anyPool = p as unknown as {
    totalCount?: number;
    idleCount?: number;
    waitingCount?: number;
  };
  const total = typeof anyPool.totalCount === "number" ? anyPool.totalCount : 0;
  const idle = typeof anyPool.idleCount === "number" ? anyPool.idleCount : 0;
  const waiting =
    typeof anyPool.waitingCount === "number" ? anyPool.waitingCount : 0;
  // `inUse` isn't a separate getter — it's the obvious derived quantity
  // (`total - idle`). Surface it so dashboards don't have to do the math
  // on every panel.
  const inUse = Math.max(0, total - idle);
  return { total, idle, waiting, inUse };
}

// ---------------------------------------------------------------------------
// Background-job metrics. Read from `background_job_runs` so what /metrics
// reports always matches the admin "Background Jobs" page.
//   * runs_total{job, status}            counter (success + error counts)
//   * last_duration_seconds{job}         gauge (most recent run, any status)
//   * last_success_age_seconds{job}      gauge (age of most recent success)
// ---------------------------------------------------------------------------
export interface BackgroundJobMetricRow {
  jobName: string;
  successCount: number;
  errorCount: number;
  lastDurationSeconds: number | null;
  lastSuccessAgeSeconds: number | null;
}

function extractRows<T>(result: unknown): T[] {
  const r = result as { rows?: unknown } | null | undefined;
  if (r && Array.isArray(r.rows)) return r.rows as T[];
  if (Array.isArray(result)) return result as T[];
  return [];
}

export async function getBackgroundJobMetrics(
  now: Date = new Date(),
): Promise<BackgroundJobMetricRow[]> {
  // Counts by (jobName, status). LEFT-joined onto KNOWN_BACKGROUND_JOBS
  // below so a registered job that has never run still appears with
  // `successCount=0, errorCount=0` — operators want a flat-line zero,
  // not a missing series.
  const countsRes = await db.execute(sql`
    SELECT job_name AS "jobName",
           status,
           COUNT(*)::bigint AS "n"
      FROM background_job_runs
     GROUP BY job_name, status
  `);
  const countsRows = extractRows<{ jobName: string; status: string; n: string | number }>(countsRes);

  // Most recent run per job (any status) — for last_duration_seconds.
  const lastRunRes = await db.execute(sql`
    SELECT DISTINCT ON (job_name)
           job_name AS "jobName",
           duration_ms AS "durationMs"
      FROM background_job_runs
     ORDER BY job_name, started_at DESC, id DESC
  `);
  const lastRunRows = extractRows<{ jobName: string; durationMs: number | null }>(lastRunRes);

  // Most recent SUCCESSFUL run per job — for last_success_age_seconds.
  const lastSuccessRes = await db.execute(sql`
    SELECT DISTINCT ON (job_name)
           job_name AS "jobName",
           started_at AS "startedAt"
      FROM background_job_runs
     WHERE status = 'success'
     ORDER BY job_name, started_at DESC, id DESC
  `);
  const lastSuccessRows = extractRows<{ jobName: string; startedAt: Date | string }>(lastSuccessRes);

  const successByJob = new Map<string, number>();
  const errorByJob = new Map<string, number>();
  for (const r of countsRows) {
    const n = typeof r.n === "string" ? Number(r.n) : r.n;
    if (r.status === "success") successByJob.set(r.jobName, n);
    else if (r.status === "error") errorByJob.set(r.jobName, n);
  }
  const lastDurationByJob = new Map(
    lastRunRows.map((r) => [r.jobName, r.durationMs]),
  );
  const lastSuccessAtByJob = new Map(
    lastSuccessRows.map((r) => [r.jobName, new Date(r.startedAt)]),
  );

  // Iterate KNOWN jobs (so newly-registered crons appear immediately),
  // PLUS any jobName seen in the DB that isn't in the catalogue (so a
  // legacy / orphaned series doesn't disappear from the dashboard).
  const allNames = new Set<string>(KNOWN_BACKGROUND_JOBS.map((j) => j.name));
  for (const r of countsRows) allNames.add(r.jobName);

  const result: BackgroundJobMetricRow[] = [];
  for (const jobName of Array.from(allNames)) {
    const lastDurationMs = lastDurationByJob.get(jobName) ?? null;
    const lastSuccessAt = lastSuccessAtByJob.get(jobName) ?? null;
    result.push({
      jobName,
      successCount: successByJob.get(jobName) ?? 0,
      errorCount: errorByJob.get(jobName) ?? 0,
      lastDurationSeconds:
        lastDurationMs === null ? null : lastDurationMs / 1000,
      lastSuccessAgeSeconds: lastSuccessAt
        ? Math.max(0, (now.getTime() - lastSuccessAt.getTime()) / 1000)
        : null,
    });
  }
  // Stable order — alphabetical by jobName so diff'ing two scrapes is easy.
  result.sort((a, b) => a.jobName.localeCompare(b.jobName));
  return result;
}

// ---------------------------------------------------------------------------
// Renderer. Prometheus text format v0.0.4. Each metric is preceded by a
// `# HELP` line and a `# TYPE` line; series lines have label sets in
// `{name="value",…}` form. Label values that could contain a quote, newline,
// or backslash are escaped per the spec.
// ---------------------------------------------------------------------------
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatLabels(labels: Record<string, string>): string {
  const parts: string[] = [];
  for (const k of Object.keys(labels)) {
    parts.push(`${k}="${escapeLabelValue(labels[k])}"`);
  }
  return parts.length === 0 ? "" : `{${parts.join(",")}}`;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? "+Inf" : n < 0 ? "-Inf" : "NaN";
  // Avoid exponent notation for small integers (Prometheus accepts both,
  // but the integer form is friendlier when grepping a raw response).
  return Number.isInteger(n) ? n.toString() : n.toString();
}

export interface RenderMetricsDeps {
  poolStats?: () => DbPoolStats;
  jobMetrics?: () => Promise<BackgroundJobMetricRow[]>;
  now?: Date;
}

export async function renderMetrics(
  deps: RenderMetricsDeps = {},
): Promise<string> {
  const poolStats = (deps.poolStats ?? (() => getDbPoolStats()))();
  const jobMetrics = await (deps.jobMetrics ?? (() => getBackgroundJobMetrics(deps.now)))();

  const lines: string[] = [];

  // -- HTTP request count ---------------------------------------------------
  lines.push("# HELP http_requests_total Total HTTP requests handled by the server, labelled by route, method, and status class.");
  lines.push("# TYPE http_requests_total counter");
  // Stable iteration — sort keys so two scrapes of the same state diff cleanly.
  const sortedKeys = Array.from(httpSeriesByKey.keys()).sort();
  for (const k of sortedKeys) {
    const s = httpSeriesByKey.get(k)!;
    lines.push(
      `http_requests_total${formatLabels({
        route: s.route,
        method: s.method,
        status_class: s.statusClass,
      })} ${formatNumber(s.count)}`,
    );
  }

  // -- HTTP request latency histogram ---------------------------------------
  lines.push(
    "# HELP http_request_duration_seconds HTTP request latency in seconds, labelled by route, method, and status class.",
  );
  lines.push("# TYPE http_request_duration_seconds histogram");
  for (const k of sortedKeys) {
    const s = httpSeriesByKey.get(k)!;
    const baseLabels = {
      route: s.route,
      method: s.method,
      status_class: s.statusClass,
    };
    for (let i = 0; i < HTTP_DURATION_BUCKETS_SECONDS.length; i++) {
      const le = HTTP_DURATION_BUCKETS_SECONDS[i];
      lines.push(
        `http_request_duration_seconds_bucket${formatLabels({
          ...baseLabels,
          le: le.toString(),
        })} ${formatNumber(s.bucketCounts[i])}`,
      );
    }
    // The mandatory +Inf bucket equals the total count.
    lines.push(
      `http_request_duration_seconds_bucket${formatLabels({
        ...baseLabels,
        le: "+Inf",
      })} ${formatNumber(s.count)}`,
    );
    lines.push(
      `http_request_duration_seconds_sum${formatLabels(baseLabels)} ${formatNumber(s.sumSeconds)}`,
    );
    lines.push(
      `http_request_duration_seconds_count${formatLabels(baseLabels)} ${formatNumber(s.count)}`,
    );
  }

  // -- DB pool --------------------------------------------------------------
  lines.push("# HELP db_pool_total Total number of clients in the primary DB pool (idle + in-use).");
  lines.push("# TYPE db_pool_total gauge");
  lines.push(`db_pool_total{pool="primary"} ${formatNumber(poolStats.total)}`);

  lines.push("# HELP db_pool_idle Idle clients in the primary DB pool, available for immediate use.");
  lines.push("# TYPE db_pool_idle gauge");
  lines.push(`db_pool_idle{pool="primary"} ${formatNumber(poolStats.idle)}`);

  lines.push("# HELP db_pool_in_use Clients in the primary DB pool currently executing a query (total - idle).");
  lines.push("# TYPE db_pool_in_use gauge");
  lines.push(`db_pool_in_use{pool="primary"} ${formatNumber(poolStats.inUse)}`);

  lines.push("# HELP db_pool_waiting Callers waiting on the primary DB pool for a free client (saturation indicator).");
  lines.push("# TYPE db_pool_waiting gauge");
  lines.push(`db_pool_waiting{pool="primary"} ${formatNumber(poolStats.waiting)}`);

  // -- Background jobs ------------------------------------------------------
  lines.push("# HELP background_job_runs_total Total background_job_runs rows persisted by the cron wrappers, labelled by job and outcome.");
  lines.push("# TYPE background_job_runs_total counter");
  for (const j of jobMetrics) {
    lines.push(
      `background_job_runs_total${formatLabels({ job: j.jobName, status: "success" })} ${formatNumber(j.successCount)}`,
    );
    lines.push(
      `background_job_runs_total${formatLabels({ job: j.jobName, status: "error" })} ${formatNumber(j.errorCount)}`,
    );
  }

  lines.push("# HELP background_job_last_duration_seconds Duration of the most recent run of each background job, in seconds.");
  lines.push("# TYPE background_job_last_duration_seconds gauge");
  for (const j of jobMetrics) {
    if (j.lastDurationSeconds !== null) {
      lines.push(
        `background_job_last_duration_seconds${formatLabels({ job: j.jobName })} ${formatNumber(j.lastDurationSeconds)}`,
      );
    }
  }

  lines.push("# HELP background_job_last_success_age_seconds Age in seconds of the most recent SUCCESSFUL run of each background job. Pair with overdueAfterMs to alert on staleness.");
  lines.push("# TYPE background_job_last_success_age_seconds gauge");
  for (const j of jobMetrics) {
    if (j.lastSuccessAgeSeconds !== null) {
      lines.push(
        `background_job_last_success_age_seconds${formatLabels({ job: j.jobName })} ${formatNumber(j.lastSuccessAgeSeconds)}`,
      );
    }
  }

  // Trailing newline — Prometheus text format is line-oriented and the
  // standard scrapers tolerate either, but the canonical examples include it.
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Route registration. Kept here (instead of in `server/health.ts`) so the
// metrics module owns its own route, but called from `registerHealthRoutes`
// so all three monitoring endpoints mount in one place.
// ---------------------------------------------------------------------------
export interface MetricsRouteDeps {
  render?: (deps?: RenderMetricsDeps) => Promise<string>;
}

export function registerMetricsRoute(
  app: Express,
  deps: MetricsRouteDeps = {},
): void {
  const render = deps.render ?? renderMetrics;
  app.get("/metrics", async (_req, res) => {
    try {
      const body = await render();
      // Prometheus expects this exact content type (v0.0.4 text format).
      res.setHeader(
        "Content-Type",
        "text/plain; version=0.0.4; charset=utf-8",
      );
      // Don't let an upstream cache turn a stale snapshot into a fresh one
      // — every scrape must hit live counters.
      res.setHeader("Cache-Control", "no-store");
      res.status(200).send(body);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(500).send(`# metrics render failed: ${escapeLabelValue(message)}\n`);
    }
  });
}

// ---------------------------------------------------------------------------
// Test seam — clears in-process counters so each test starts from a clean
// slate. Not used in production.
// ---------------------------------------------------------------------------
export function __resetMetricsForTests(): void {
  httpSeriesByKey.clear();
}

/** Internal accessor for tests that want to assert the current cardinality. */
export function __getMetricsCardinalityForTests(): number {
  return httpSeriesByKey.size;
}
