// =============================================================================
// Task #157 — /health and /ready endpoint tests
// =============================================================================
// Locks in the contracts an external uptime monitor relies on:
//
//   * /health returns 200 + status='ok' + db.ok=true when the DB ping
//     succeeds, and 503 + status='degraded' + db.ok=false when it fails.
//
//   * /ready returns 200 only when the DB ping succeeds AND no background
//     job in the health snapshot is flagged isOverdue. Either condition
//     alone (DB down, or any overdue job) drops it to 503.
//
//   * Both endpoints include uptimeSeconds and a non-empty version string
//     so an incident-triage hit on /health can map a response to a build.
//
// The endpoints are exercised over a real loopback HTTP server so the
// status code, JSON body, and route registration are all proven end-to-end
// — exactly the surface a monitor sees. DB and background-jobs deps are
// injected so the tests don't depend on a working Postgres.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  registerHealthRoutes,
  type DbPingResult,
  type HealthRouteDeps,
} from "./health";
import {
  DEFAULT_OVERDUE_AFTER_MS,
  type BackgroundJobsHealth,
  type JobHealth,
} from "./services/background-jobs";

// ---------------------------------------------------------------------------
// Test harness — boots a tiny express server with the health routes wired
// to injected deps. Returned `setDeps` lets each test redefine the ping /
// snapshot behaviour without standing up a new server.
// ---------------------------------------------------------------------------
type DepState = {
  dbPing: () => Promise<DbPingResult>;
  jobsHealth: () => Promise<BackgroundJobsHealth>;
};

let server: http.Server;
let baseUrl: string;
const state: DepState = {
  dbPing: async () => ({ ok: true, latencyMs: 1 }),
  jobsHealth: async () => emptyHealthSnapshot(),
};

function emptyHealthSnapshot(): BackgroundJobsHealth {
  return {
    generatedAt: new Date().toISOString(),
    overdueAfterMs: DEFAULT_OVERDUE_AFTER_MS,
    jobs: [],
  };
}

function jobRow(name: string, isOverdue: boolean): JobHealth {
  return {
    name,
    label: name,
    description: "",
    lastRun: isOverdue
      ? null
      : {
          id: 1,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          status: "success",
          summary: "ok",
          errorMessage: null,
          durationMs: 5,
        },
    lastSuccessAt: isOverdue ? null : new Date().toISOString(),
    ageMs: isOverdue ? null : 1_000,
    neverRan: isOverdue,
    isOverdue,
  };
}

beforeAll(async () => {
  const app = express();
  const deps: HealthRouteDeps = {
    dbPing: () => state.dbPing(),
    jobsHealth: () => state.jobsHealth(),
    version: "test-version-abc123",
    uptimeSeconds: () => 42,
  };
  registerHealthRoutes(app, deps);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

describe("GET /health", () => {
  it("returns 200 + ok + db.ok=true when the DB ping succeeds", async () => {
    state.dbPing = async () => ({ ok: true, latencyMs: 7 });
    const { status, body } = await get("/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.db).toEqual({ ok: true, latencyMs: 7 });
    expect(body.uptimeSeconds).toBe(42);
    expect(body.version).toBe("test-version-abc123");
  });

  it("returns 503 + degraded + db.ok=false when the DB ping fails", async () => {
    state.dbPing = async () => ({
      ok: false,
      latencyMs: 1001,
      error: "db ping timed out after 1000ms",
    });
    const { status, body } = await get("/health");
    expect(status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.db.ok).toBe(false);
    expect(body.db.error).toMatch(/timed out/);
  });

  it("does not require auth (no Authorization header sent)", async () => {
    state.dbPing = async () => ({ ok: true, latencyMs: 1 });
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });
});

describe("GET /ready", () => {
  it("returns 200 when DB is reachable and no background job is overdue", async () => {
    state.dbPing = async () => ({ ok: true, latencyMs: 2 });
    state.jobsHealth = async () => ({
      generatedAt: new Date().toISOString(),
      overdueAfterMs: DEFAULT_OVERDUE_AFTER_MS,
      jobs: [jobRow("fee-accruals", false), jobRow("ledger-reconciliation", false)],
    });
    const { status, body } = await get("/ready");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.db.ok).toBe(true);
    expect(body.jobs.ok).toBe(true);
    expect(body.jobs.overdueJobs).toEqual([]);
  });

  it("returns 503 when any background job is flagged overdue", async () => {
    state.dbPing = async () => ({ ok: true, latencyMs: 2 });
    state.jobsHealth = async () => ({
      generatedAt: new Date().toISOString(),
      overdueAfterMs: DEFAULT_OVERDUE_AFTER_MS,
      jobs: [
        jobRow("fee-accruals", false),
        jobRow("ledger-reconciliation", true),
      ],
    });
    const { status, body } = await get("/ready");
    expect(status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.jobs.ok).toBe(false);
    expect(body.jobs.overdueJobs).toContain("ledger-reconciliation");
  });

  it("returns 503 when the DB ping fails even if all jobs are healthy", async () => {
    state.dbPing = async () => ({ ok: false, latencyMs: 1001, error: "down" });
    state.jobsHealth = async () => ({
      generatedAt: new Date().toISOString(),
      overdueAfterMs: DEFAULT_OVERDUE_AFTER_MS,
      jobs: [jobRow("fee-accruals", false)],
    });
    const { status, body } = await get("/ready");
    expect(status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.db.ok).toBe(false);
  });

  it("returns 503 when the background-jobs snapshot itself throws", async () => {
    state.dbPing = async () => ({ ok: true, latencyMs: 2 });
    state.jobsHealth = async () => {
      throw new Error("snapshot exploded");
    };
    const { status, body } = await get("/ready");
    expect(status).toBe(503);
    expect(body.jobs.ok).toBe(false);
    expect(body.jobs.error).toMatch(/snapshot exploded/);
  });
});
