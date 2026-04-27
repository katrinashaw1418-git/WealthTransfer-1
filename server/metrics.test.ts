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
  __getMetricsCardinalityForTests,
  __resetMetricsForTests,
  metricsMiddleware,
  recordHttpRequest,
  registerMetricsRoute,
  renderMetrics,
  type BackgroundJobMetricRow,
  type DbPoolStats,
} from "./metrics";

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
    // Mount /metrics with a forced-fail option toggled by the test.
    registerMetricsRoute(app, {
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
