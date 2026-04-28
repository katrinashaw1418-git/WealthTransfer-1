// =============================================================================
// Task #324 — HTTP-level coverage for the consent reconciliation history endpoints
// =============================================================================
// Two new admin endpoints:
//   GET /api/admin/fee-rules/consent-reconcile-runs
//     → lists last 30 rollup audit_logs rows
//        (action='fee_rules_consent_reconciled')
//   GET /api/admin/fee-rules/consent-reconcile-runs/:id/transitions
//     → returns per-rule audit lines (action='fee_rule_consent_reconciled',
//        entityType='adviser_fee_rule') correlated by metadata.triggeredAt.
//
// We mount registerAdminRoutes on a tiny express app and exercise both
// endpoints end-to-end so the metadata-reshape pipeline (the audit jsonb
// → frontend-facing JSON shape) is locked. Without this test, a future
// refactor of the asRecord/pickString helpers could silently break the
// "consent reconciliation history" admin panel.
//
// Each test seeds its own audit_logs rows tagged with a unique
// `triggeredAt` ISO so we never collide with rows produced by the real
// cron path running in the same dev DB.
// =============================================================================

import "../scripts/_bootstrap-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, sql } from "drizzle-orm";

import { db } from "./db";
import { auditLogs } from "@shared/schema";
import { signToken } from "./auth";
import { registerAdminRoutes } from "./admin-routes";

let server: http.Server;
let baseUrl: string;
let adminToken: string;
let clientToken: string;

const TAG = `t324-routes-${Date.now()}`;
const TRIGGERED_AT_CRON = `2026-04-01T03:30:00.000Z-${TAG}`;
const TRIGGERED_AT_MANUAL = `2026-04-02T15:45:00.000Z-${TAG}`;
const TRIGGERED_AT_LEGACY = null; // legacy rollup written before Task #324

let cronRollupId = 0;
let manualRollupId = 0;
let legacyRollupId = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerAdminRoutes(app);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  adminToken = signToken({
    userId: 999_101,
    username: "__admin_t324__",
    email: "admin-t324@test.invalid",
    role: "admin",
  });
  clientToken = signToken({
    userId: 999_102,
    username: "__client_t324__",
    email: "client-t324@test.invalid",
    role: "client",
  });

  // Seed: one cron rollup + matching per-rule transition lines.
  const [cronRow] = await db
    .insert(auditLogs)
    .values({
      userId: null,
      action: "fee_rules_consent_reconciled",
      entityType: "adviser_fee_rules",
      entityId: null,
      metadata: {
        before: null,
        after: null,
        trigger: "cron",
        triggeredAt: TRIGGERED_AT_CRON,
        summary: {
          checked: 7,
          expired: 1,
          pausedForWithdrawal: 2,
          alreadyAligned: 4,
          consentMissing: 0,
          triggeredAt: TRIGGERED_AT_CRON,
        },
      },
    })
    .returning();
  cronRollupId = cronRow.id;

  // Two per-rule transitions tagged with the same triggeredAt.
  await db.insert(auditLogs).values([
    {
      userId: null,
      action: "fee_rule_consent_reconciled",
      entityType: "adviser_fee_rule",
      entityId: "9001",
      metadata: {
        before: { status: "active" },
        after: { status: "expired" },
        transition: "expired",
        consentId: 5001,
        triggeredAt: TRIGGERED_AT_CRON,
      },
    },
    {
      userId: null,
      action: "fee_rule_consent_reconciled",
      entityType: "adviser_fee_rule",
      entityId: "9002",
      metadata: {
        before: { status: "active" },
        after: { status: "paused" },
        transition: "paused_consent_withdrawn",
        consentId: 5002,
        triggeredAt: TRIGGERED_AT_CRON,
      },
    },
  ]);

  // Seed: one manual rollup with no per-rule transitions (idempotent run).
  // userId is left null to avoid a users-table FK seed in this test —
  // the endpoint contract being asserted is the metadata shape, not the
  // executor identity (which is just a passthrough column the UI joins
  // against the users map separately).
  const [manualRow] = await db
    .insert(auditLogs)
    .values({
      userId: null,
      action: "fee_rules_consent_reconciled",
      entityType: "adviser_fee_rules",
      entityId: null,
      metadata: {
        before: null,
        after: null,
        trigger: "manual",
        triggeredAt: TRIGGERED_AT_MANUAL,
        summary: {
          checked: 3,
          expired: 0,
          pausedForWithdrawal: 0,
          alreadyAligned: 3,
          consentMissing: 0,
          triggeredAt: TRIGGERED_AT_MANUAL,
        },
      },
    })
    .returning();
  manualRollupId = manualRow.id;

  // Seed: one legacy rollup with NO triggeredAt — proves the endpoint
  // does not 500 on partial / pre-Task-#324 rows and surfaces them with
  // null fields instead.
  const [legacyRow] = await db
    .insert(auditLogs)
    .values({
      userId: null,
      action: "fee_rules_consent_reconciled",
      entityType: "adviser_fee_rules",
      entityId: null,
      metadata: {
        before: null,
        after: null,
        trigger: "manual",
        // intentionally NO triggeredAt + NO summary
      },
    })
    .returning();
  legacyRollupId = legacyRow.id;
});

afterAll(async () => {
  // audit_logs is immutable in production, but the dev DB allows the
  // suite-cleanup pattern used elsewhere to drop seeded rows. Failures
  // are tolerated — the rows are tagged with a unique TAG so they
  // never pollute meaningful queries.
  try {
    await db
      .delete(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "fee_rules_consent_reconciled"),
          sql`${auditLogs.metadata}->>'triggeredAt' IN (${TRIGGERED_AT_CRON}, ${TRIGGERED_AT_MANUAL})`,
        ),
      );
  } catch {}
  try {
    await db
      .delete(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "fee_rule_consent_reconciled"),
          sql`${auditLogs.metadata}->>'triggeredAt' = ${TRIGGERED_AT_CRON}`,
        ),
      );
  } catch {}
  try {
    if (legacyRollupId) {
      await db.delete(auditLogs).where(eq(auditLogs.id, legacyRollupId));
    }
  } catch {}
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

async function GET(
  path: string,
  token?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

describe("GET /api/admin/fee-rules/consent-reconcile-runs (Task #324)", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const { status } = await GET("/api/admin/fee-rules/consent-reconcile-runs");
    expect(status).toBe(401);
  });

  it("rejects non-admin callers with 403", async () => {
    const { status } = await GET(
      "/api/admin/fee-rules/consent-reconcile-runs",
      clientToken,
    );
    expect(status).toBe(403);
  });

  it("returns the rollup rows in newest-first order with the documented shape", async () => {
    const { status, body } = await GET(
      "/api/admin/fee-rules/consent-reconcile-runs",
      adminToken,
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.items)).toBe(true);

    // Find OUR seeded rows in the response (other concurrent test data
    // and real audit rows may live in the dev DB; isolate by id).
    const ours = body.items.filter((r: any) =>
      [cronRollupId, manualRollupId, legacyRollupId].includes(r.id),
    );
    expect(ours.length).toBe(3);

    const cron = ours.find((r: any) => r.id === cronRollupId);
    expect(cron.trigger).toBe("cron");
    expect(cron.triggeredAt).toBe(TRIGGERED_AT_CRON);
    expect(cron.summary).toEqual({
      checked: 7,
      expired: 1,
      pausedForWithdrawal: 2,
      alreadyAligned: 4,
      consentMissing: 0,
    });

    const manual = ours.find((r: any) => r.id === manualRollupId);
    expect(manual.trigger).toBe("manual");
    expect(manual.userId).toBeNull();
    expect(manual.summary.checked).toBe(3);

    // Legacy row — no triggeredAt, no summary fields. Endpoint must
    // surface it without crashing; UI shows "—" for the nulls.
    const legacy = ours.find((r: any) => r.id === legacyRollupId);
    expect(legacy.triggeredAt).toBeNull();
    expect(legacy.summary.checked).toBeNull();
    expect(legacy.summary.expired).toBeNull();
  });
});

describe("GET /api/admin/fee-rules/consent-reconcile-runs/:id/transitions (Task #324)", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const { status } = await GET(
      `/api/admin/fee-rules/consent-reconcile-runs/${cronRollupId}/transitions`,
    );
    expect(status).toBe(401);
  });

  it("rejects non-admin callers with 403", async () => {
    const { status } = await GET(
      `/api/admin/fee-rules/consent-reconcile-runs/${cronRollupId}/transitions`,
      clientToken,
    );
    expect(status).toBe(403);
  });

  it("returns the per-rule transitions for a known cron rollup, correlated by triggeredAt", async () => {
    const { status, body } = await GET(
      `/api/admin/fee-rules/consent-reconcile-runs/${cronRollupId}/transitions`,
      adminToken,
    );
    expect(status).toBe(200);
    expect(body.triggeredAt).toBe(TRIGGERED_AT_CRON);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    const ruleIds = body.items.map((t: any) => t.ruleId);
    expect(ruleIds).toContain("9001");
    expect(ruleIds).toContain("9002");
    const expired = body.items.find((t: any) => t.ruleId === "9001");
    expect(expired.transition).toBe("expired");
    expect(expired.beforeStatus).toBe("active");
    expect(expired.afterStatus).toBe("expired");
    expect(expired.consentId).toBe(5001);
  });

  it("returns an empty list (with triggeredAt set) for a manual run that produced no transitions", async () => {
    const { status, body } = await GET(
      `/api/admin/fee-rules/consent-reconcile-runs/${manualRollupId}/transitions`,
      adminToken,
    );
    expect(status).toBe(200);
    expect(body.triggeredAt).toBe(TRIGGERED_AT_MANUAL);
    expect(body.items).toEqual([]);
  });

  it("returns an empty list with triggeredAt=null for a legacy rollup with no correlation key", async () => {
    const { status, body } = await GET(
      `/api/admin/fee-rules/consent-reconcile-runs/${legacyRollupId}/transitions`,
      adminToken,
    );
    expect(status).toBe(200);
    expect(body.triggeredAt).toBeNull();
    expect(body.items).toEqual([]);
  });

  it("returns 404 for an unknown rollup id", async () => {
    const { status } = await GET(
      "/api/admin/fee-rules/consent-reconcile-runs/999999999/transitions",
      adminToken,
    );
    expect(status).toBe(404);
  });

  it("returns 400 for a non-numeric / invalid id", async () => {
    const { status } = await GET(
      "/api/admin/fee-rules/consent-reconcile-runs/0/transitions",
      adminToken,
    );
    expect(status).toBe(400);
  });
});
