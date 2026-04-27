// =============================================================================
// Task #166 — integration coverage for GET /api/admin/metrics
// =============================================================================
// The metrics endpoint feeds the admin "key business failures" tile (Task
// #144). It joins three numbers from durable tables (failed transactions
// last 24h, fee-deduction failures last 24h, most recent failed transaction
// id) with two process-local counters from services/error-log.ts (audit-log
// write failures, http5xx). A regression here is silent — the tile just
// shows wrong numbers — so we lock the contract end-to-end:
//
//   1. Unauthenticated → HTTP 401. The endpoint MUST NOT leak metrics to
//      anonymous callers.
//   2. Non-admin role → HTTP 403. (Belt-and-braces; the route uses the
//      same adminRoute wrapper as every other /api/admin/* route.)
//   3. Admin → HTTP 200 with the full payload shape:
//        - windowMs                                = 24h (in ms)
//        - generatedAt                             = ISO timestamp
//        - failedTransactions.{ last24h, mostRecentId, mostRecentAt }
//        - feeDeductionFailures.{ last24h, inProcessLast24h }
//        - auditWriteFailures.last24hInProcess
//        - http5xx.last24hInProcess
//        - lastSuccessfulHealthProbe.{ at, ageMs }
//
// Implementation notes:
//   - We mount ONLY registerAdminRoutes on a tiny express app — the route
//     wrapper does its own JWT check via requireAuth, so no other middleware
//     is required for the auth assertions to be meaningful.
//   - We touch the in-process counters and the probe signal so the response
//     numbers are non-trivial and we can assert they round-trip end-to-end.
//   - JWT_SECRET is set inside vi.hoisted so it lands BEFORE the transitive
//     import of server/auth.ts (which throws at module-init when the secret
//     is missing outside local-dev).
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET ||= "admin-metrics-test-secret";
});

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { signToken } from "./auth";
import { registerAdminRoutes } from "./admin-routes";
import {
  bumpFeeDeductionFailures,
  recordServerError,
  recordSuccessfulHealthProbe,
} from "./services/error-log";

let server: http.Server;
let baseUrl: string;
let adminToken: string;
let clientToken: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerAdminRoutes(app);

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // The metrics route does not look up the user in the DB — it only inspects
  // the role claim on the JWT. That means we can sign synthetic tokens
  // without seeding `users` rows, keeping this test independent of the test
  // DB's user state.
  adminToken = signToken({
    userId: 999_001,
    username: "__admin_metrics_test__",
    email: "admin-metrics-test@test.invalid",
    role: "admin",
  });
  clientToken = signToken({
    userId: 999_002,
    username: "__client_metrics_test__",
    email: "client-metrics-test@test.invalid",
    role: "client",
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

async function getMetrics(token?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}/api/admin/metrics`, { headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

describe("GET /api/admin/metrics — auth gate", () => {
  it("returns 401 when no Authorization header is sent", async () => {
    const { status, body } = await getMetrics();
    expect(status).toBe(401);
    // The metrics payload SHAPE must not appear on a 401 — proves nothing
    // leaked through the failed auth path.
    expect(body.windowMs).toBeUndefined();
    expect(body.failedTransactions).toBeUndefined();
  });

  it("returns 403 when a non-admin (role='client') token is presented", async () => {
    const { status, body } = await getMetrics(clientToken);
    expect(status).toBe(403);
    expect(body.windowMs).toBeUndefined();
  });

  it("returns 401 on a syntactically-invalid token", async () => {
    const { status } = await getMetrics("not-a-real-jwt");
    expect(status).toBe(401);
  });
});

describe("GET /api/admin/metrics — admin shape", () => {
  it("returns 200 and the full payload shape for an admin caller", async () => {
    // Touch the in-process counters and the probe signal so the response
    // surfaces non-zero numbers — proves the endpoint is actually wired
    // through to the helpers in services/error-log.ts.
    bumpFeeDeductionFailures();
    bumpFeeDeductionFailures();
    recordServerError({
      tag: "http_5xx",
      method: "GET",
      path: "/admin-metrics-test",
      status: 500,
      error: new Error("synthetic 5xx for metrics test"),
    });
    recordSuccessfulHealthProbe();

    const { status, body } = await getMetrics(adminToken);
    expect(status).toBe(200);

    // Top-level shape
    expect(body.windowMs).toBe(24 * 60 * 60 * 1000);
    expect(typeof body.generatedAt).toBe("string");
    expect(() => new Date(body.generatedAt)).not.toThrow();

    // failedTransactions block — sourced from the durable transactions
    // table. We do not assert exact counts (the dev DB may legitimately
    // contain rows from other tests/runs); we only lock the SHAPE so a
    // future change that drops a field — or renames mostRecentId — fails
    // here loudly instead of silently in the admin UI.
    expect(body.failedTransactions).toBeDefined();
    expect(typeof body.failedTransactions.last24h).toBe("number");
    expect(body.failedTransactions.last24h).toBeGreaterThanOrEqual(0);
    expect("mostRecentId" in body.failedTransactions).toBe(true);
    expect("mostRecentAt" in body.failedTransactions).toBe(true);

    // feeDeductionFailures block — durable count + the in-process mirror
    // we bumped above. The mirror MUST reflect the bumps (>= 2) — that is
    // the end-to-end proof that getInProcessCounters is reaching the wire.
    expect(body.feeDeductionFailures).toBeDefined();
    expect(typeof body.feeDeductionFailures.last24h).toBe("number");
    expect(body.feeDeductionFailures.inProcessLast24h).toBeGreaterThanOrEqual(2);

    // Process-local-only counters. http5xx must reflect the recordServerError
    // call above (>= 1). audit write failures may legitimately be 0 here.
    expect(typeof body.auditWriteFailures.last24hInProcess).toBe("number");
    expect(body.http5xx.last24hInProcess).toBeGreaterThanOrEqual(1);

    // Health-probe signal — recordSuccessfulHealthProbe() was called above,
    // so `at` must be a fresh ISO timestamp and `ageMs` must be a small
    // non-negative number.
    expect(typeof body.lastSuccessfulHealthProbe.at).toBe("string");
    expect(() => new Date(body.lastSuccessfulHealthProbe.at)).not.toThrow();
    expect(body.lastSuccessfulHealthProbe.ageMs).toBeGreaterThanOrEqual(0);
    // 60s ceiling — we recorded the probe a few ms ago. A wildly larger
    // ageMs would mean the endpoint is reading a stale cached value, NOT
    // computing it fresh per request.
    expect(body.lastSuccessfulHealthProbe.ageMs).toBeLessThan(60_000);
  });
});
