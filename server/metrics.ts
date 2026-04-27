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
import { isIPv4, isIPv6 } from "node:net";
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
// Task #242 — /metrics access control.
// The endpoint exposes the full route table plus live DB-pool saturation —
// fine for an internal scrape target, but a recon goldmine on a public
// deployment. We support two layered controls, configurable via env so the
// existing scraper setup keeps working:
//
//   * `METRICS_TOKEN`        — shared secret, presented as `Authorization:
//                              Bearer <token>`. Compared in length-safe time.
//   * `METRICS_ALLOW_FROM`   — CSV of CIDRs (IPv4 or IPv6) and/or the
//                              shortcuts `loopback` / `private`. Matched
//                              against `req.ip` (which respects the
//                              `trust proxy` setting).
//
// Either env var alone locks the endpoint down. With both set, a request
// passes if it satisfies EITHER (so a Prometheus pod inside the private
// network can scrape without a token, while an external dashboard with the
// token can still scrape from anywhere). With NEITHER set we fall back to
// the original open behaviour and emit a one-line startup warning so a
// production deployment notices the gap during boot.
// ---------------------------------------------------------------------------

const ALLOW_FROM_SHORTCUTS: Record<string, string[]> = {
  // Loopback only — for a sidecar Prometheus on the same host.
  loopback: ["127.0.0.0/8", "::1/128"],
  // RFC1918 IPv4 + ULA IPv6 + loopback. Matches the typical "anywhere
  // inside the VPC" allow-list operators reach for first.
  private: [
    "127.0.0.0/8",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "::1/128",
    "fc00::/7",
  ],
};

export interface MetricsAuthConfig {
  /** Shared secret. When set, Bearer-token presentation is one valid path. */
  token: string | null;
  /** CSV string of CIDRs / shortcuts. When set, source-IP allow-list is one valid path. */
  allowFrom: string | null;
}

/** Read the auth config from env. Empty / whitespace strings are treated as
 *  "not set" so an unset Replit secret behaves the same as a deleted one. */
export function loadMetricsAuthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MetricsAuthConfig {
  const token = env.METRICS_TOKEN?.trim();
  const allowFrom = env.METRICS_ALLOW_FROM?.trim();
  return {
    token: token ? token : null,
    allowFrom: allowFrom ? allowFrom : null,
  };
}

/** Length-safe string compare. Avoids leaking the token length-prefix via
 *  early-return timing differences on a guess. */
function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) {
    r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return r === 0;
}

// IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is what Node hands you for an IPv4
// connection on a dual-stack listener. Strip the prefix so the same allow
// list entry matches both transports without operators having to dual-list.
function normalizeIp(ip: string): string {
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const rest = ip.slice(7);
    if (isIPv4(rest)) return rest;
  }
  return ip;
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".");
  return (
    ((Number(parts[0]) << 24) >>> 0) +
    (Number(parts[1]) << 16) +
    (Number(parts[2]) << 8) +
    Number(parts[3])
  );
}

function matchIpv4Cidr(ip: string, base: string, bits: number): boolean {
  if (!isIPv4(base) || !isIPv4(ip)) return false;
  if (bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

// Tiny IPv6 parser — handles `::` shorthand. Returns 16 bytes or null on
// anything unparseable. We only need this for CIDR-prefix matching, not for
// rendering, so we don't bother with the canonicalisation algorithms.
function ipv6ToBytes(ip: string): Uint8Array | null {
  if (!isIPv6(ip)) return null;
  const parts = ip.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] === "" ? [] : parts[0].split(":");
  const tail =
    parts.length === 2 ? (parts[1] === "" ? [] : parts[1].split(":")) : [];
  const fillCount = 8 - head.length - tail.length;
  if (fillCount < 0) return null;
  const groups = [...head, ...new Array(fillCount).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const v = parseInt(groups[i], 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    bytes[i * 2] = (v >> 8) & 0xff;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}

function matchIpv6Cidr(ip: string, base: string, bits: number): boolean {
  if (bits < 0 || bits > 128) return false;
  const a = ipv6ToBytes(ip);
  const b = ipv6ToBytes(base);
  if (!a || !b) return false;
  const fullBytes = Math.floor(bits / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (a[i] !== b[i]) return false;
  }
  const remBits = bits - fullBytes * 8;
  if (remBits === 0) return true;
  const mask = (0xff << (8 - remBits)) & 0xff;
  return (a[fullBytes] & mask) === (b[fullBytes] & mask);
}

/** Expand the env-string into a flat list of CIDRs, resolving the
 *  `loopback` / `private` shortcuts. Unrecognised shortcut names are
 *  treated as raw entries — they'll just fail to match anything. */
export function expandMetricsAllowList(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const lower = piece.toLowerCase();
    const expanded = ALLOW_FROM_SHORTCUTS[lower];
    if (expanded) out.push(...expanded);
    else out.push(piece);
  }
  return out;
}

function ipMatchesAny(ip: string, cidrs: string[]): boolean {
  const norm = normalizeIp(ip);
  for (const entry of cidrs) {
    const slashIdx = entry.indexOf("/");
    const base = slashIdx === -1 ? entry : entry.slice(0, slashIdx);
    const bitsStr = slashIdx === -1 ? null : entry.slice(slashIdx + 1);
    if (isIPv4(base)) {
      const bits = bitsStr === null ? 32 : Number(bitsStr);
      if (Number.isInteger(bits) && matchIpv4Cidr(norm, base, bits)) return true;
    } else if (isIPv6(base)) {
      const bits = bitsStr === null ? 128 : Number(bitsStr);
      if (Number.isInteger(bits) && matchIpv6Cidr(norm, base, bits)) return true;
    }
  }
  return false;
}

export type MetricsAuthDecision =
  | { ok: true; reason: "open" | "token" | "allow-list" }
  | { ok: false; status: 401 | 403; reason: "missing-or-bad-token" | "ip-not-allowed" };

/**
 * Decide whether a /metrics request is allowed under the given config.
 * Pure function over (req, config) so the access-control logic is unit
 * testable without standing up an HTTP server.
 *
 *   * If neither token nor allow-list configured → `{ ok: true, reason: "open" }`.
 *   * If token configured AND a matching Bearer is presented → allowed.
 *   * If allow-list configured AND req.ip matches → allowed.
 *   * Otherwise denied. Status is 401 when a token was configured (so the
 *     scraper has something to retry with credentials), 403 when ONLY the
 *     IP allow-list was configured (no credential will help).
 */
export function authorizeMetricsRequest(
  req: Request,
  config: MetricsAuthConfig,
): MetricsAuthDecision {
  const tokenConfigured = !!config.token;
  const allowConfigured = !!config.allowFrom;
  if (!tokenConfigured && !allowConfigured) {
    return { ok: true, reason: "open" };
  }

  if (tokenConfigured) {
    const header =
      req.header?.("authorization") ?? req.header?.("Authorization") ?? null;
    if (header && /^Bearer\s+/i.test(header)) {
      const presented = header.replace(/^Bearer\s+/i, "").trim();
      if (timingSafeStringEqual(presented, config.token!)) {
        return { ok: true, reason: "token" };
      }
    }
  }

  if (allowConfigured) {
    // `req.ip` already respects `trust proxy`. Fall back to the raw socket
    // address so a unit test that builds a bare Request still works.
    const ip =
      req.ip ??
      (req.socket && req.socket.remoteAddress) ??
      "";
    if (ip && ipMatchesAny(ip, expandMetricsAllowList(config.allowFrom!))) {
      return { ok: true, reason: "allow-list" };
    }
  }

  return tokenConfigured
    ? { ok: false, status: 401, reason: "missing-or-bad-token" }
    : { ok: false, status: 403, reason: "ip-not-allowed" };
}

// ---------------------------------------------------------------------------
// Route registration. Kept here (instead of in `server/health.ts`) so the
// metrics module owns its own route, but called from `registerHealthRoutes`
// so all three monitoring endpoints mount in one place.
// ---------------------------------------------------------------------------
export interface MetricsRouteDeps {
  render?: (deps?: RenderMetricsDeps) => Promise<string>;
  /** Inject auth config (tests). When omitted, loaded from process.env and
   *  a one-line warning is logged on startup if neither var is set. */
  authConfig?: MetricsAuthConfig;
  /** Logger seam for the open-mode startup warning (tests use a noop). */
  warn?: (msg: string) => void;
}

export const METRICS_OPEN_MODE_WARNING =
  "[metrics] WARNING: /metrics is unauthenticated and exposes the route table " +
  "and live DB pool stats. Set METRICS_TOKEN and/or METRICS_ALLOW_FROM to lock it down.";

export function registerMetricsRoute(
  app: Express,
  deps: MetricsRouteDeps = {},
): void {
  const render = deps.render ?? renderMetrics;
  // When a caller (production) doesn't inject a config, read the env and
  // emit the one-shot startup warning if both vars are unset. Tests that
  // want to lock down /metrics inject `authConfig` directly and so don't
  // trigger the warning regardless of the ambient env.
  let authConfig: MetricsAuthConfig;
  if (deps.authConfig) {
    authConfig = deps.authConfig;
  } else {
    authConfig = loadMetricsAuthConfigFromEnv();
    if (!authConfig.token && !authConfig.allowFrom) {
      const warn = deps.warn ?? ((msg: string) => console.warn(msg));
      warn(METRICS_OPEN_MODE_WARNING);
    }
  }

  app.get("/metrics", async (req, res) => {
    const auth = authorizeMetricsRequest(req, authConfig);
    if (!auth.ok) {
      // Deliberately terse — no route info, no version, no pool stats.
      // We still emit the Prometheus content type so a scraper parser
      // that's mid-stream doesn't choke trying to interpret an HTML page.
      res.setHeader(
        "Content-Type",
        "text/plain; version=0.0.4; charset=utf-8",
      );
      res.setHeader("Cache-Control", "no-store");
      if (auth.status === 401) {
        // RFC 7235 — tells a credentialed client which scheme to retry with.
        res.setHeader("WWW-Authenticate", 'Bearer realm="metrics"');
      }
      res.status(auth.status).send("# metrics access denied\n");
      return;
    }
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
