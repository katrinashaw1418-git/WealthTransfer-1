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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import type { WriteKillSwitchState } from "./services/write-kill-switch";

// ---------------------------------------------------------------------------
// Test harness — boots a tiny express server with the health routes wired
// to injected deps. Returned `setDeps` lets each test redefine the ping /
// snapshot behaviour without standing up a new server.
// ---------------------------------------------------------------------------
type DepState = {
  dbPing: () => Promise<DbPingResult>;
  jobsHealth: () => Promise<BackgroundJobsHealth>;
  killSwitchState: () => Promise<WriteKillSwitchState>;
};

let server: http.Server;
let baseUrl: string;
const state: DepState = {
  dbPing: async () => ({ ok: true, latencyMs: 1 }),
  jobsHealth: async () => emptyHealthSnapshot(),
  killSwitchState: async () => killSwitchOff(),
};

function killSwitchOff(): WriteKillSwitchState {
  return {
    enabled: false,
    envOverride: false,
    reason: null,
    enabledByUserId: null,
    enabledAt: null,
    updatedAt: null,
  };
}

function killSwitchOn(reason: string | null): WriteKillSwitchState {
  return {
    enabled: true,
    envOverride: false,
    reason,
    enabledByUserId: 7,
    enabledAt: new Date(),
    updatedAt: new Date(),
  };
}

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
    killSwitchState: () => state.killSwitchState(),
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

// Reset the kill-switch dep before every test so an "on" state set by one
// case can't bleed into the next. dbPing / jobsHealth are explicitly set
// per-test so they don't need a reset here.
beforeEach(() => {
  state.killSwitchState = async () => killSwitchOff();
});

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

// ---------------------------------------------------------------------------
// Task #172 — writeKillSwitch field on /health and /ready.
//
// The kill-switch is exposed as INFORMATIONAL on both endpoints. It must:
//   * appear in both response bodies in every state (off, on, on+reason),
//   * never flip /health off 200 by itself (DB ping is the sole 503 trigger),
//   * never flip /ready off 200 by itself (DB + overdue jobs are the only
//     readiness gates).
// ---------------------------------------------------------------------------
describe("writeKillSwitch field", () => {
  it("includes writeKillSwitch={enabled:false, reason:null} on /health when off", async () => {
    state.dbPing = async () => ({ ok: true, latencyMs: 1 });
    const { status, body } = await get("/health");
    expect(status).toBe(200);
    expect(body.writeKillSwitch).toEqual({ enabled: false, reason: null });
  });

  it("includes writeKillSwitch={enabled:false, reason:null} on /ready when off", async () => {
    state.dbPing = async () => ({ ok: true, latencyMs: 1 });
    state.jobsHealth = async () => emptyHealthSnapshot();
    const { status, body } = await get("/ready");
    expect(status).toBe(200);
    expect(body.writeKillSwitch).toEqual({ enabled: false, reason: null });
  });

  it("surfaces enabled=true + reason on /health WITHOUT flipping status to 503", async () => {
    state.dbPing = async () => ({ ok: true, latencyMs: 1 });
    state.killSwitchState = async () =>
      killSwitchOn("planned database maintenance");
    const { status, body } = await get("/health");
    // DB is healthy, so /health stays 200 even though writes are paused.
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.writeKillSwitch).toEqual({
      enabled: true,
      reason: "planned database maintenance",
    });
  });

  it("surfaces enabled=true + reason on /ready WITHOUT flipping status to 503", async () => {
    state.dbPing = async () => ({ ok: true, latencyMs: 1 });
    state.jobsHealth = async () => emptyHealthSnapshot();
    state.killSwitchState = async () =>
      killSwitchOn("incident response");
    const { status, body } = await get("/ready");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.writeKillSwitch).toEqual({
      enabled: true,
      reason: "incident response",
    });
    expect(body.jobs.ok).toBe(true);
  });

  it("still includes writeKillSwitch when /health degrades on a DB failure", async () => {
    state.dbPing = async () => ({
      ok: false,
      latencyMs: 1001,
      error: "db ping timed out after 1000ms",
    });
    state.killSwitchState = async () => killSwitchOn(null);
    const { status, body } = await get("/health");
    // 503 is driven by the DB ping, not by the kill-switch.
    expect(status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.writeKillSwitch).toEqual({ enabled: true, reason: null });
  });

  it("falls back to enabled=false when the kill-switch lookup itself throws", async () => {
    // A broken admin row must not look like an active write block to
    // responders, and must not take /health down.
    state.dbPing = async () => ({ ok: true, latencyMs: 1 });
    state.killSwitchState = async () => {
      throw new Error("settings row missing");
    };
    const { status, body } = await get("/health");
    expect(status).toBe(200);
    expect(body.writeKillSwitch).toEqual({ enabled: false, reason: null });
  });
});
