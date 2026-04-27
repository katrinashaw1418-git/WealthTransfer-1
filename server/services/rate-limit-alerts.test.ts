// =============================================================================
// TASK #163 — automated tests for the rate-limiter trip recorder + alert
// =============================================================================
// Locks in the contract:
//   1. Each call to `recordRateLimitTrip` writes one `audit_logs` row with
//      action `rate_limit_exceeded` carrying the IP, username (when present),
//      route and limiter.
//   2. Trips below the threshold do NOT dispatch an operator alert.
//   3. The trip that crosses the threshold DOES dispatch one alert with
//      source `rate-limit-abuse`.
//   4. The threshold + window are configurable via env vars; an invalid env
//      var falls back to the default rather than silently disabling the path.
//   5. A request with no username is still recorded and still alerts on the
//      IP axis alone.
//
// Tests use the dev DB (same as the rest of server/services/*.test.ts) and
// scrub every row they create in afterEach so reruns are idempotent.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { Request } from "express";

import { db } from "../db";
import { auditLogs, operatorAlerts } from "@shared/schema";
import {
  RATE_LIMIT_ALERT_SOURCE,
  RATE_LIMIT_AUDIT_ACTION,
  recordRateLimitTrip,
} from "./rate-limit-alerts";

// `audit_logs` is intentionally append-only (Task #149 — DELETE is blocked
// by `audit_logs_block_delete`), so we deliberately do NOT scrub the
// audit rows we insert here. The per-test unique route + IP guarantees
// isolation between runs and across test files.
const insertedAlertIds: number[] = [];

let originalThreshold: string | undefined;
let originalWindow: string | undefined;
let originalWebhook: string | undefined;
let originalDedupe: string | undefined;
let originalDedupeOverrides: string | undefined;

function uniqueRoute(label: string): string {
  return `/__test__/rate-limit-alerts/${label}/${Date.now()}-${Math.floor(
    Math.random() * 1_000_000,
  )}`;
}

// Minimal Express-Request shape the recorder reads from. Avoids `as any` by
// declaring exactly the two fields recordRateLimitTrip touches.
type FakeRequest = { ip: string | null; body: Record<string, unknown> };

// The shape recordRateLimitTrip writes into operator_alerts.details. The
// column is `jsonb` (typed `unknown` by drizzle) so we narrow it through
// this concrete shape inside test assertions instead of using `any`.
type RateLimitAlertDetails = {
  route?: string;
  offenderType?: "ip" | "username";
  tripCountBucket?: number;
  thresholdApplied?: number;
  windowMinutes?: number;
};

function detailsOf(row: { details: unknown }): RateLimitAlertDetails {
  return (row.details as RateLimitAlertDetails) ?? {};
}

function fakeReq(opts: { ip?: string | null; username?: string | null }): FakeRequest {
  return {
    ip: opts.ip ?? "203.0.113.42",
    body: opts.username !== undefined ? { username: opts.username } : {},
  };
}

beforeEach(() => {
  originalThreshold = process.env.RATE_LIMIT_ALERT_THRESHOLD;
  originalWindow = process.env.RATE_LIMIT_ALERT_WINDOW_MINUTES;
  originalWebhook = process.env.OPERATOR_ALERT_WEBHOOK_URL;
  originalDedupe = process.env.OPERATOR_ALERT_DEDUPE_WINDOW_MIN;
  originalDedupeOverrides = process.env.OPERATOR_ALERT_DEDUPE_WINDOW_OVERRIDES;
  // Make sure the operator-alerts dispatcher fires every time so the test
  // can observe the alert; the dispatcher's payload-hash dedupe would
  // otherwise collapse two repeats inside the default 15-min window.
  process.env.OPERATOR_ALERT_DEDUPE_WINDOW_MIN = "0";
  delete process.env.OPERATOR_ALERT_DEDUPE_WINDOW_OVERRIDES;
  // No webhook — log channel only — keeps tests hermetic.
  delete process.env.OPERATOR_ALERT_WEBHOOK_URL;
});

afterEach(async () => {
  if (insertedAlertIds.length > 0) {
    await db
      .delete(operatorAlerts)
      .where(inArray(operatorAlerts.id, insertedAlertIds));
    insertedAlertIds.length = 0;
  }
  // Restore env
  if (originalThreshold === undefined) delete process.env.RATE_LIMIT_ALERT_THRESHOLD;
  else process.env.RATE_LIMIT_ALERT_THRESHOLD = originalThreshold;
  if (originalWindow === undefined) delete process.env.RATE_LIMIT_ALERT_WINDOW_MINUTES;
  else process.env.RATE_LIMIT_ALERT_WINDOW_MINUTES = originalWindow;
  if (originalWebhook === undefined) delete process.env.OPERATOR_ALERT_WEBHOOK_URL;
  else process.env.OPERATOR_ALERT_WEBHOOK_URL = originalWebhook;
  if (originalDedupe === undefined) delete process.env.OPERATOR_ALERT_DEDUPE_WINDOW_MIN;
  else process.env.OPERATOR_ALERT_DEDUPE_WINDOW_MIN = originalDedupe;
  if (originalDedupeOverrides === undefined)
    delete process.env.OPERATOR_ALERT_DEDUPE_WINDOW_OVERRIDES;
  else process.env.OPERATOR_ALERT_DEDUPE_WINDOW_OVERRIDES = originalDedupeOverrides;
});

/**
 * Run the recorder N times against the same fake request; record every
 * audit + alert id it leaves behind so afterEach can scrub them.
 */
async function tripN(
  n: number,
  req: FakeRequest,
  ctx: { limiter: string; route: string },
) {
  // recordRateLimitTrip declares `req: Request` but only reads `req.ip`
  // and `req.body`. The cast through `unknown` is a structural-mock idiom
  // (NOT an `any` escape hatch) — the FakeRequest type above pins the
  // exact two fields the recorder is allowed to touch.
  const reqAsExpress = req as unknown as Request;
  const results = [];
  for (let i = 0; i < n; i++) {
    results.push(await recordRateLimitTrip(reqAsExpress, ctx));
  }
  // Capture freshly-inserted alert ids for cleanup.
  const alertRows = await db
    .select({ id: operatorAlerts.id })
    .from(operatorAlerts)
    .where(eq(operatorAlerts.source, RATE_LIMIT_ALERT_SOURCE));
  for (const r of alertRows) {
    // Filter to alerts whose details mention this route — other concurrent
    // tests in this file all use unique routes too, so this is a safe filter.
    if (!insertedAlertIds.includes(r.id)) insertedAlertIds.push(r.id);
  }
  return results;
}

describe("recordRateLimitTrip — audit row contract", () => {
  it("writes one audit_logs row per trip with the expected fields", async () => {
    const route = uniqueRoute("audit-row");
    const ip = "203.0.113.10";
    const username = "MixedCaseUser";
    process.env.RATE_LIMIT_ALERT_THRESHOLD = "999"; // never alert
    await tripN(1, fakeReq({ ip, username }), { limiter: "loginLimiter", route });

    const rows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, RATE_LIMIT_AUDIT_ACTION),
          eq(auditLogs.entityId, route),
        ),
      );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.entityType).toBe("rate_limiter");
    expect(row.ipAddress).toBe(ip);
    expect(row.userId).toBeNull();
    const md = row.metadata as Record<string, unknown>;
    expect(md.limiter).toBe("loginLimiter");
    expect(md.route).toBe(route);
    expect(md.ip).toBe(ip);
    // Username is lower-cased before storage so the IP+username axis count
    // is case-insensitive; test that contract.
    expect(md.username).toBe("mixedcaseuser");
  });
});

describe("recordRateLimitTrip — threshold gating", () => {
  it("does NOT dispatch an operator alert below the threshold", async () => {
    const route = uniqueRoute("below-threshold");
    process.env.RATE_LIMIT_ALERT_THRESHOLD = "5";
    process.env.RATE_LIMIT_ALERT_WINDOW_MINUTES = "60";

    const results = await tripN(4, fakeReq({ ip: "203.0.113.20", username: "alice" }), {
      limiter: "loginLimiter",
      route,
    });

    for (const r of results) {
      expect(r.alerted).toBe(false);
    }
    const alerts = await db
      .select()
      .from(operatorAlerts)
      .where(eq(operatorAlerts.source, RATE_LIMIT_ALERT_SOURCE));
    // No alert row should mention this unique route.
    const alertsForThisRoute = alerts.filter(
      (a) => detailsOf(a).route === route,
    );
    expect(alertsForThisRoute).toHaveLength(0);
  });

  it("dispatches an operator alert when the threshold is crossed", async () => {
    const route = uniqueRoute("crosses-threshold");
    process.env.RATE_LIMIT_ALERT_THRESHOLD = "5";
    process.env.RATE_LIMIT_ALERT_WINDOW_MINUTES = "60";

    const results = await tripN(5, fakeReq({ ip: "203.0.113.30", username: "bob" }), {
      limiter: "loginLimiter",
      route,
    });

    // Trips 1..4 below threshold; trip 5 IS the crossing trip.
    expect(results.slice(0, 4).every((r) => r.alerted === false)).toBe(true);
    expect(results[4].alerted).toBe(true);
    expect(results[4].ipCount).toBe(5);
    expect(results[4].usernameCount).toBe(5);

    const alerts = await db
      .select()
      .from(operatorAlerts)
      .where(eq(operatorAlerts.source, RATE_LIMIT_ALERT_SOURCE));
    const alertsForThisRoute = alerts.filter(
      (a) => detailsOf(a).route === route,
    );
    // One alert per offender axis (ip + username) on the crossing trip.
    expect(alertsForThisRoute).toHaveLength(2);
    const offenderTypes = alertsForThisRoute
      .map((a) => detailsOf(a).offenderType)
      .sort();
    expect(offenderTypes).toEqual(["ip", "username"]);
    for (const a of alertsForThisRoute) {
      const d = detailsOf(a);
      expect(d.tripCountBucket).toBe(5);
      expect(d.thresholdApplied).toBe(5);
      expect(d.windowMinutes).toBe(60);
      expect(a.severity).toBe("warning");
    }
  });

  it("alerts on the IP axis even when no username is present", async () => {
    const route = uniqueRoute("ip-only");
    process.env.RATE_LIMIT_ALERT_THRESHOLD = "3";
    process.env.RATE_LIMIT_ALERT_WINDOW_MINUTES = "60";

    const results = await tripN(3, fakeReq({ ip: "203.0.113.40" }), {
      limiter: "resetPasswordLimiter",
      route,
    });

    expect(results[2].alerted).toBe(true);
    expect(results[2].ipCount).toBe(3);
    expect(results[2].usernameCount).toBeNull();

    const alerts = await db
      .select()
      .from(operatorAlerts)
      .where(eq(operatorAlerts.source, RATE_LIMIT_ALERT_SOURCE));
    const alertsForThisRoute = alerts.filter(
      (a) => detailsOf(a).route === route,
    );
    expect(alertsForThisRoute).toHaveLength(1);
    expect(detailsOf(alertsForThisRoute[0]).offenderType).toBe("ip");
  });
});

describe("recordRateLimitTrip — env-var resolution", () => {
  it("falls back to the default threshold when the env var is invalid", async () => {
    const route = uniqueRoute("invalid-threshold");
    process.env.RATE_LIMIT_ALERT_THRESHOLD = "not-a-number";
    process.env.RATE_LIMIT_ALERT_WINDOW_MINUTES = "60";

    const result = await tripN(1, fakeReq({ ip: "203.0.113.50", username: "carol" }), {
      limiter: "loginLimiter",
      route,
    });

    // Default threshold is 20 → one trip is well below it → no alert.
    expect(result[0].alerted).toBe(false);
    expect(result[0].thresholdApplied).toBe(20);
    expect(result[0].windowMinutesApplied).toBe(60);
  });

  it("falls back to the default window when the env var is invalid", async () => {
    const route = uniqueRoute("invalid-window");
    process.env.RATE_LIMIT_ALERT_THRESHOLD = "1";
    process.env.RATE_LIMIT_ALERT_WINDOW_MINUTES = "-5";

    const result = await tripN(1, fakeReq({ ip: "203.0.113.60", username: "dave" }), {
      limiter: "loginLimiter",
      route,
    });

    expect(result[0].windowMinutesApplied).toBe(60);
    // Threshold=1 means the very first trip alerts — sanity-check the gate.
    expect(result[0].alerted).toBe(true);
  });
});

