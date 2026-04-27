// =============================================================================
// Task #173 — /metrics endpoint tests
// =============================================================================
// Locks in the contracts a Prometheus scraper relies on:
//
//   * /metrics responds 200 with the v0.0.4 text content type and renders
//     every required family (HTTP counts + latency histogram, DB pool
//     gauges, background-job counts + last-duration + last-success-age)
//     even when no traffic and no jobs have run yet.
//
//   * The HTTP middleware records the matched route pattern (not the raw
//     URL), bucketed by status class, and increments the cumulative
//     histogram correctly.
//
//   * The middleware skips /metrics, /health, /ready so monitor traffic
//     doesn't contaminate the request-rate signal it's used to chart.
//
//   * Cardinality is bounded — high-cardinality routes are bucketed into
//     `__overflow__` once the cap is hit.
//
//   * The endpoint stays available even if `renderMetrics` throws (the
//     route returns 500 with a Prometheus comment line, never an HTML
//     error page that would break a scrape parser).
// =============================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  HTTP_DURATION_BUCKETS_SECONDS,
  METRICS_OPEN_MODE_WARNING,
  __getMetricsCardinalityForTests,
  __resetMetricsForTests,
  authorizeMetricsRequest,
  expandMetricsAllowList,
  loadMetricsAuthConfigFromEnv,
  metricsMiddleware,
  recordHttpRequest,
  registerMetricsRoute,
  renderMetrics,
  type BackgroundJobMetricRow,
  type DbPoolStats,
  type MetricsAuthConfig,
} from "./metrics";
import type { Request } from "express";

function emptyJobMetrics(): Promise<BackgroundJobMetricRow[]> {
  return Promise.resolve([]);
}

function emptyPool(): DbPoolStats {
  return { total: 0, idle: 0, waiting: 0, inUse: 0 };
}

describe("recordHttpRequest", () => {
  beforeEach(() => __resetMetricsForTests());

  it("buckets a request by method, route, and status class", async () => {
    recordHttpRequest({
      method: "get",
      route: "/api/users/:id",
      status: 200,
      durationSeconds: 0.012,
    });
    const body = await renderMetrics({
      poolStats: emptyPool,
      jobMetrics: emptyJobMetrics,
    });
    expect(body).toMatch(
      /http_requests_total\{route="\/api\/users\/:id",method="GET",status_class="2xx"\} 1/,
    );
    // 0.012s falls into the 0.025 bucket and every larger bucket.
    expect(body).toMatch(
      /http_request_duration_seconds_bucket\{route="\/api\/users\/:id",method="GET",status_class="2xx",le="0\.025"\} 1/,
    );
    // Anything ≤ 0.01 should NOT have incremented (0.012 > 0.01).
    expect(body).toMatch(
      /http_request_duration_seconds_bucket\{route="\/api\/users\/:id",method="GET",status_class="2xx",le="0\.01"\} 0/,
    );
    // The +Inf bucket equals the count.
    expect(body).toMatch(
      /http_request_duration_seconds_bucket\{route="\/api\/users\/:id",method="GET",status_class="2xx",le="\+Inf"\} 1/,
    );
    expect(body).toMatch(
      /http_request_duration_seconds_count\{route="\/api\/users\/:id",method="GET",status_class="2xx"\} 1/,
    );
  });

  it("classifies 5xx, 4xx, 3xx, 2xx separately", async () => {
    recordHttpRequest({ method: "GET", route: "/api/x", status: 200, durationSeconds: 0.001 });
    recordHttpRequest({ method: "GET", route: "/api/x", status: 304, durationSeconds: 0.001 });
    recordHttpRequest({ method: "GET", route: "/api/x", status: 404, durationSeconds: 0.001 });
    recordHttpRequest({ method: "GET", route: "/api/x", status: 500, durationSeconds: 0.001 });
    const body = await renderMetrics({
      poolStats: emptyPool,
      jobMetrics: emptyJobMetrics,
    });
    expect(body).toMatch(/status_class="2xx"\} 1/);
    expect(body).toMatch(/status_class="3xx"\} 1/);
    expect(body).toMatch(/status_class="4xx"\} 1/);
    expect(body).toMatch(/status_class="5xx"\} 1/);
  });

  it("aggregates repeat hits into one series with the correct sum/count", async () => {
    for (const d of [0.002, 0.05, 0.4, 1.2]) {
      recordHttpRequest({
        method: "POST",
        route: "/api/things",
        status: 201,
        durationSeconds: d,
      });
    }
    const body = await renderMetrics({
      poolStats: emptyPool,
      jobMetrics: emptyJobMetrics,
    });
    expect(body).toMatch(/http_requests_total\{route="\/api\/things",method="POST",status_class="2xx"\} 4/);
    expect(body).toMatch(/http_request_duration_seconds_count\{route="\/api\/things",method="POST",status_class="2xx"\} 4/);
    // sum = 0.002 + 0.05 + 0.4 + 1.2 = 1.652
    expect(body).toMatch(/http_request_duration_seconds_sum\{route="\/api\/things",method="POST",status_class="2xx"\} 1\.652/);
  });

  it("buckets new tuples beyond MAX_LABEL_TUPLES into __overflow__", async () => {
    // Push past the cap with synthetic distinct routes.
    for (let i = 0; i < 600; i++) {
      recordHttpRequest({
        method: "GET",
        route: `/api/route-${i}`,
        status: 200,
        durationSeconds: 0.001,
      });
    }
    // Cardinality stays bounded at MAX_LABEL_TUPLES (500) plus the single
    // `__overflow__` bucket — so the upper bound is 501, not 600.
    expect(__getMetricsCardinalityForTests()).toBeLessThanOrEqual(501);
    const body = await renderMetrics({
      poolStats: emptyPool,
      jobMetrics: emptyJobMetrics,
    });
    expect(body).toMatch(/route="__overflow__"/);
  });

  it("renders all eleven default histogram buckets plus +Inf", async () => {
    recordHttpRequest({
      method: "GET",
      route: "/api/bucket-test",
      status: 200,
      durationSeconds: 0.001,
    });
    const body = await renderMetrics({
      poolStats: emptyPool,
      jobMetrics: emptyJobMetrics,
    });
    for (const b of HTTP_DURATION_BUCKETS_SECONDS) {
      expect(body).toContain(`le="${b}"`);
    }
    expect(body).toContain('le="+Inf"');
  });
});

describe("renderMetrics", () => {
  beforeEach(() => __resetMetricsForTests());

  it("renders every required HELP/TYPE preamble even with zero traffic", async () => {
    const body = await renderMetrics({
      poolStats: emptyPool,
      jobMetrics: emptyJobMetrics,
    });
    expect(body).toContain("# HELP http_requests_total");
    expect(body).toContain("# TYPE http_requests_total counter");
    expect(body).toContain("# HELP http_request_duration_seconds");
    expect(body).toContain("# TYPE http_request_duration_seconds histogram");
    expect(body).toContain("# HELP db_pool_total");
    expect(body).toContain("# TYPE db_pool_total gauge");
    expect(body).toContain("# HELP db_pool_idle");
    expect(body).toContain("# HELP db_pool_in_use");
    expect(body).toContain("# HELP db_pool_waiting");
    expect(body).toContain("# HELP background_job_runs_total");
    expect(body).toContain("# TYPE background_job_runs_total counter");
    expect(body).toContain("# HELP background_job_last_duration_seconds");
    expect(body).toContain("# TYPE background_job_last_duration_seconds gauge");
    expect(body).toContain("# HELP background_job_last_success_age_seconds");
  });

  it("renders DB pool gauges from the supplied stats", async () => {
    const body = await renderMetrics({
      poolStats: () => ({ total: 10, idle: 3, waiting: 2, inUse: 7 }),
      jobMetrics: emptyJobMetrics,
    });
    expect(body).toMatch(/db_pool_total\{pool="primary"\} 10/);
    expect(body).toMatch(/db_pool_idle\{pool="primary"\} 3/);
    expect(body).toMatch(/db_pool_in_use\{pool="primary"\} 7/);
    expect(body).toMatch(/db_pool_waiting\{pool="primary"\} 2/);
  });

  it("renders background-job rows with success/error counts and last-duration", async () => {
    const body = await renderMetrics({
      poolStats: emptyPool,
      jobMetrics: async () => [
        {
          jobName: "fee-accruals",
          successCount: 12,
          errorCount: 1,
          lastDurationSeconds: 2.345,
          lastSuccessAgeSeconds: 3600,
        },
        {
          jobName: "wallet-ledger-reconciliation",
          successCount: 0,
          errorCount: 0,
          lastDurationSeconds: null,
          lastSuccessAgeSeconds: null,
        },
      ],
    });
    expect(body).toMatch(/background_job_runs_total\{job="fee-accruals",status="success"\} 12/);
    expect(body).toMatch(/background_job_runs_total\{job="fee-accruals",status="error"\} 1/);
    expect(body).toMatch(/background_job_last_duration_seconds\{job="fee-accruals"\} 2\.345/);
    expect(body).toMatch(/background_job_last_success_age_seconds\{job="fee-accruals"\} 3600/);
    // A never-ran job appears in the counts but NOT in the gauges (no
    // lastDuration / lastSuccessAge yet).
    expect(body).toMatch(/background_job_runs_total\{job="wallet-ledger-reconciliation",status="success"\} 0/);
    expect(body).not.toMatch(/background_job_last_duration_seconds\{job="wallet-ledger-reconciliation"\}/);
    expect(body).not.toMatch(/background_job_last_success_age_seconds\{job="wallet-ledger-reconciliation"\}/);
  });

  it("ends with a trailing newline so concatenation with another scrape works", async () => {
    const body = await renderMetrics({
      poolStats: emptyPool,
      jobMetrics: emptyJobMetrics,
    });
    expect(body.endsWith("\n")).toBe(true);
  });
});

describe("metricsMiddleware + GET /metrics route end-to-end", () => {
  let server: http.Server;
  let baseUrl: string;
  let renderShouldThrow = false;

  beforeAll(async () => {
    const app = express();
    // Register middleware first so it observes every subsequent handler.
    app.use(metricsMiddleware);
    // Sample app routes the middleware will instrument.
    app.get("/api/echo/:id", (req, res) => res.json({ id: req.params.id }));
    app.get("/api/error", (_req, res) => res.status(500).json({ error: "x" }));
    // Mount /metrics with a forced-fail option toggled by the test. Pass an
    // explicit open-mode authConfig so the existing assertions don't need
    // env vars and the open-mode startup warning isn't logged here (a
    // dedicated test below covers that warning path).
    registerMetricsRoute(app, {
      authConfig: { token: null, allowFrom: null },
      render: async () => {
        if (renderShouldThrow) throw new Error("boom");
        return renderMetrics({
          poolStats: () => ({ total: 5, idle: 4, waiting: 0, inUse: 1 }),
          jobMetrics: emptyJobMetrics,
        });
      },
    });
    // Mount stub /health and /ready so we can assert the middleware skips them.
    app.get("/health", (_req, res) => res.json({ ok: true }));
    app.get("/ready", (_req, res) => res.json({ ok: true }));

    server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    __resetMetricsForTests();
    renderShouldThrow = false;
  });

  it("serves /metrics with the Prometheus content type and a no-store cache header", async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain;.*version=0\.0\.4/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("# HELP http_requests_total");
    expect(body).toContain('db_pool_total{pool="primary"} 5');
  });

  it("instruments a real request with the matched route pattern (not the raw URL)", async () => {
    const r1 = await fetch(`${baseUrl}/api/echo/abc`);
    const r2 = await fetch(`${baseUrl}/api/echo/xyz`);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const body = await (await fetch(`${baseUrl}/metrics`)).text();
    // Two requests should fold into the same series via the :id pattern.
    expect(body).toMatch(/http_requests_total\{route="\/api\/echo\/:id",method="GET",status_class="2xx"\} 2/);
    expect(body).not.toContain("/api/echo/abc");
    expect(body).not.toContain("/api/echo/xyz");
  });

  it("records 5xx responses under status_class=5xx", async () => {
    await fetch(`${baseUrl}/api/error`);
    const body = await (await fetch(`${baseUrl}/metrics`)).text();
    expect(body).toMatch(/http_requests_total\{route="\/api\/error",method="GET",status_class="5xx"\} 1/);
  });

  it("does NOT instrument /metrics, /health, or /ready (monitor traffic)", async () => {
    // Hit each monitor endpoint a few times — none should appear as a
    // series in the metrics output, otherwise scraper traffic would
    // dominate the request-rate panel.
    await fetch(`${baseUrl}/health`);
    await fetch(`${baseUrl}/health`);
    await fetch(`${baseUrl}/ready`);
    await fetch(`${baseUrl}/metrics`);
    const body = await (await fetch(`${baseUrl}/metrics`)).text();
    expect(body).not.toMatch(/route="\/health"/);
    expect(body).not.toMatch(/route="\/ready"/);
    expect(body).not.toMatch(/route="\/metrics"/);
  });

  it("returns 500 with a Prometheus comment line when render throws", async () => {
    renderShouldThrow = true;
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toMatch(/^# metrics render failed: boom/);
  });

  it("buckets unmatched routes (404s) into <unmatched> rather than the raw URL", async () => {
    await fetch(`${baseUrl}/this-path-does-not-exist`);
    const body = await (await fetch(`${baseUrl}/metrics`)).text();
    expect(body).toMatch(/route="<unmatched>",method="GET",status_class="4xx"/);
    expect(body).not.toContain("/this-path-does-not-exist");
  });
});

// ===========================================================================
// Task #242 — /metrics access control tests
// ===========================================================================
// Locks in the auth contract a public-facing deployment relies on:
//   * Either env-var alone gates the endpoint; together they're OR'd.
//   * Open-mode (neither set) keeps working but logs a one-line warning.
//   * Denied responses don't leak route table / pool stats — just a single
//     Prometheus comment line so a scraper parser doesn't choke on HTML.
// ===========================================================================

function makeFakeRequest(opts: {
  authHeader?: string;
  ip?: string;
} = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.authHeader) headers["authorization"] = opts.authHeader;
  return {
    ip: opts.ip,
    socket: { remoteAddress: opts.ip } as Request["socket"],
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

describe("loadMetricsAuthConfigFromEnv", () => {
  it("returns nulls when neither env var is set", () => {
    expect(loadMetricsAuthConfigFromEnv({})).toEqual({
      token: null,
      allowFrom: null,
    });
  });

  it("trims whitespace and treats whitespace-only values as unset", () => {
    expect(
      loadMetricsAuthConfigFromEnv({
        METRICS_TOKEN: "   ",
        METRICS_ALLOW_FROM: "  loopback  ",
      } as NodeJS.ProcessEnv),
    ).toEqual({ token: null, allowFrom: "loopback" });
  });

  it("reads both vars when set", () => {
    expect(
      loadMetricsAuthConfigFromEnv({
        METRICS_TOKEN: "s3cr3t",
        METRICS_ALLOW_FROM: "10.0.0.0/8",
      } as NodeJS.ProcessEnv),
    ).toEqual({ token: "s3cr3t", allowFrom: "10.0.0.0/8" });
  });
});

describe("expandMetricsAllowList", () => {
  it("expands the loopback shortcut to v4 + v6", () => {
    expect(expandMetricsAllowList("loopback")).toEqual([
      "127.0.0.0/8",
      "::1/128",
    ]);
  });

  it("expands the private shortcut to RFC1918 + ULA + loopback", () => {
    expect(expandMetricsAllowList("private")).toEqual([
      "127.0.0.0/8",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "::1/128",
      "fc00::/7",
    ]);
  });

  it("trims and ignores empty entries in a CSV", () => {
    expect(expandMetricsAllowList("  10.0.0.0/8 , ,192.168.0.0/16 ")).toEqual([
      "10.0.0.0/8",
      "192.168.0.0/16",
    ]);
  });

  it("mixes shortcut + explicit CIDRs in one list", () => {
    expect(expandMetricsAllowList("loopback,10.0.0.0/8")).toEqual([
      "127.0.0.0/8",
      "::1/128",
      "10.0.0.0/8",
    ]);
  });
});

describe("authorizeMetricsRequest", () => {
  const open: MetricsAuthConfig = { token: null, allowFrom: null };
  const tokenOnly: MetricsAuthConfig = { token: "letmein", allowFrom: null };
  const ipOnly: MetricsAuthConfig = { token: null, allowFrom: "loopback" };
  const both: MetricsAuthConfig = { token: "letmein", allowFrom: "10.0.0.0/8" };

  it("allows everything in open mode", () => {
    expect(authorizeMetricsRequest(makeFakeRequest(), open)).toEqual({
      ok: true,
      reason: "open",
    });
  });

  it("rejects with 401 when token is configured and no Authorization header", () => {
    const decision = authorizeMetricsRequest(makeFakeRequest(), tokenOnly);
    expect(decision).toEqual({
      ok: false,
      status: 401,
      reason: "missing-or-bad-token",
    });
  });

  it("rejects with 401 when the presented Bearer token is wrong", () => {
    const decision = authorizeMetricsRequest(
      makeFakeRequest({ authHeader: "Bearer not-the-token" }),
      tokenOnly,
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.status).toBe(401);
  });

  it("accepts the correct Bearer token (case-insensitive scheme)", () => {
    expect(
      authorizeMetricsRequest(
        makeFakeRequest({ authHeader: "Bearer letmein" }),
        tokenOnly,
      ),
    ).toEqual({ ok: true, reason: "token" });
    expect(
      authorizeMetricsRequest(
        makeFakeRequest({ authHeader: "bearer letmein" }),
        tokenOnly,
      ),
    ).toEqual({ ok: true, reason: "token" });
  });

  it("rejects a near-miss token (one char different) — length-safe compare still says no", () => {
    const decision = authorizeMetricsRequest(
      makeFakeRequest({ authHeader: "Bearer letmeix" }),
      tokenOnly,
    );
    expect(decision.ok).toBe(false);
  });

  it("rejects with 403 when only an allow-list is configured and IP doesn't match", () => {
    const decision = authorizeMetricsRequest(
      makeFakeRequest({ ip: "8.8.8.8" }),
      ipOnly,
    );
    expect(decision).toEqual({
      ok: false,
      status: 403,
      reason: "ip-not-allowed",
    });
  });

  it("accepts loopback IPv4 and IPv6 against the loopback shortcut", () => {
    expect(
      authorizeMetricsRequest(makeFakeRequest({ ip: "127.0.0.1" }), ipOnly),
    ).toEqual({ ok: true, reason: "allow-list" });
    expect(
      authorizeMetricsRequest(makeFakeRequest({ ip: "::1" }), ipOnly),
    ).toEqual({ ok: true, reason: "allow-list" });
  });

  it("normalises an IPv4-mapped IPv6 source (::ffff:127.0.0.1) before matching", () => {
    expect(
      authorizeMetricsRequest(
        makeFakeRequest({ ip: "::ffff:127.0.0.1" }),
        ipOnly,
      ),
    ).toEqual({ ok: true, reason: "allow-list" });
  });

  it("matches an explicit IPv4 CIDR (10.0.0.0/8 covers 10.1.2.3, not 11.0.0.1)", () => {
    const cfg: MetricsAuthConfig = { token: null, allowFrom: "10.0.0.0/8" };
    expect(
      authorizeMetricsRequest(makeFakeRequest({ ip: "10.1.2.3" }), cfg).ok,
    ).toBe(true);
    expect(
      authorizeMetricsRequest(makeFakeRequest({ ip: "11.0.0.1" }), cfg).ok,
    ).toBe(false);
  });

  it("matches an explicit IPv6 CIDR (fc00::/7 covers fd12::1, not 2001::1)", () => {
    const cfg: MetricsAuthConfig = { token: null, allowFrom: "fc00::/7" };
    expect(
      authorizeMetricsRequest(makeFakeRequest({ ip: "fd12::1" }), cfg).ok,
    ).toBe(true);
    expect(
      authorizeMetricsRequest(makeFakeRequest({ ip: "2001::1" }), cfg).ok,
    ).toBe(false);
  });

  it("OR's the two paths when both are configured (token wins from any IP)", () => {
    expect(
      authorizeMetricsRequest(
        makeFakeRequest({ authHeader: "Bearer letmein", ip: "8.8.8.8" }),
        both,
      ),
    ).toEqual({ ok: true, reason: "token" });
  });

  it("OR's the two paths when both are configured (allow-list wins with no token)", () => {
    expect(
      authorizeMetricsRequest(makeFakeRequest({ ip: "10.5.6.7" }), both),
    ).toEqual({ ok: true, reason: "allow-list" });
  });

  it("returns 401 (not 403) when both are configured and neither path passes — token is the credential to retry with", () => {
    const decision = authorizeMetricsRequest(
      makeFakeRequest({ ip: "8.8.8.8", authHeader: "Bearer wrong" }),
      both,
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.status).toBe(401);
  });
});

describe("registerMetricsRoute — auth integration", () => {
  // Each test mounts a fresh Express app with a baked-in authConfig so we
  // exercise the real registerMetricsRoute closure (no per-request mutation
  // of module-level state and no router-stack surgery).
  async function bootMetricsApp(authConfig: MetricsAuthConfig): Promise<{
    baseUrl: string;
    close: () => Promise<void>;
  }> {
    const app = express();
    // Mirror production: trust the first proxy hop so req.ip works the same
    // way it does behind Replit's reverse proxy.
    app.set("trust proxy", 1);
    registerMetricsRoute(app, {
      authConfig,
      render: async () =>
        renderMetrics({
          poolStats: () => ({ total: 1, idle: 0, waiting: 0, inUse: 1 }),
          jobMetrics: emptyJobMetrics,
        }),
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as AddressInfo;
    return {
      baseUrl: `http://127.0.0.1:${addr.port}`,
      close: () =>
        new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        ),
    };
  }

  it("returns 401 with WWW-Authenticate when METRICS_TOKEN is set and no header is sent", async () => {
    const { baseUrl, close } = await bootMetricsApp({
      token: "supersecret",
      allowFrom: null,
    });
    try {
      const res = await fetch(`${baseUrl}/metrics`);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
      const body = await res.text();
      // No leakage — single comment line, none of the route / pool fields.
      expect(body).toBe("# metrics access denied\n");
      expect(body).not.toMatch(/db_pool_total/);
      expect(body).not.toMatch(/http_requests_total/);
    } finally {
      await close();
    }
  });

  it("returns 200 when METRICS_TOKEN matches the Authorization Bearer header", async () => {
    const { baseUrl, close } = await bootMetricsApp({
      token: "supersecret",
      allowFrom: null,
    });
    try {
      const res = await fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: "Bearer supersecret" },
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("# HELP http_requests_total");
      expect(body).toContain("db_pool_total");
    } finally {
      await close();
    }
  });

  it("returns 401 when the token is set but the wrong value is presented", async () => {
    const { baseUrl, close } = await bootMetricsApp({
      token: "supersecret",
      allowFrom: null,
    });
    try {
      const res = await fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: "Bearer wrong" },
      });
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it("allows a loopback caller when METRICS_ALLOW_FROM=loopback (no token configured)", async () => {
    const { baseUrl, close } = await bootMetricsApp({
      token: null,
      allowFrom: "loopback",
    });
    try {
      const res = await fetch(`${baseUrl}/metrics`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("# HELP http_requests_total");
    } finally {
      await close();
    }
  });

  it("returns 403 when allow-list is configured but the caller is non-loopback", async () => {
    // We can't fake a non-loopback peer over a real socket, but we CAN
    // configure an allow-list that DOESN'T include loopback and then make
    // the loopback test client get rejected.
    const { baseUrl, close } = await bootMetricsApp({
      token: null,
      allowFrom: "10.0.0.0/8",
    });
    try {
      const res = await fetch(`${baseUrl}/metrics`);
      expect(res.status).toBe(403);
      // Denied responses must NOT leak the route table or pool stats.
      const body = await res.text();
      expect(body).toBe("# metrics access denied\n");
      // 403 responses don't emit WWW-Authenticate (no credential will help).
      expect(res.headers.get("www-authenticate")).toBeNull();
    } finally {
      await close();
    }
  });

  it("returns 200 in open mode (neither var set) so existing scrapers keep working", async () => {
    const { baseUrl, close } = await bootMetricsApp({
      token: null,
      allowFrom: null,
    });
    try {
      const res = await fetch(`${baseUrl}/metrics`);
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });
});

describe("registerMetricsRoute — open-mode startup warning", () => {
  it("logs the one-line warning when neither env var is set", () => {
    const app = express();
    const warnings: string[] = [];
    // Suppress the env-load path with an explicit-undefined authConfig so
    // we only test the warning emission code path here.
    const originalToken = process.env.METRICS_TOKEN;
    const originalAllow = process.env.METRICS_ALLOW_FROM;
    delete process.env.METRICS_TOKEN;
    delete process.env.METRICS_ALLOW_FROM;
    try {
      registerMetricsRoute(app, { warn: (m) => warnings.push(m) });
    } finally {
      if (originalToken !== undefined) process.env.METRICS_TOKEN = originalToken;
      if (originalAllow !== undefined) process.env.METRICS_ALLOW_FROM = originalAllow;
    }
    expect(warnings).toContain(METRICS_OPEN_MODE_WARNING);
  });

  it("does NOT log the warning when METRICS_TOKEN is set", () => {
    const app = express();
    const warnings: string[] = [];
    const originalToken = process.env.METRICS_TOKEN;
    process.env.METRICS_TOKEN = "anything";
    try {
      registerMetricsRoute(app, { warn: (m) => warnings.push(m) });
    } finally {
      if (originalToken === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = originalToken;
    }
    expect(warnings).toHaveLength(0);
  });

  it("does NOT log the warning when METRICS_ALLOW_FROM is set", () => {
    const app = express();
    const warnings: string[] = [];
    const originalAllow = process.env.METRICS_ALLOW_FROM;
    process.env.METRICS_ALLOW_FROM = "loopback";
    try {
      registerMetricsRoute(app, { warn: (m) => warnings.push(m) });
    } finally {
      if (originalAllow === undefined) delete process.env.METRICS_ALLOW_FROM;
      else process.env.METRICS_ALLOW_FROM = originalAllow;
    }
    expect(warnings).toHaveLength(0);
  });

  it("does NOT log the warning when an explicit authConfig is injected", () => {
    const app = express();
    const warnings: string[] = [];
    registerMetricsRoute(app, {
      authConfig: { token: null, allowFrom: null },
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(0);
  });
});
