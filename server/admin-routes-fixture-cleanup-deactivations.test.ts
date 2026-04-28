// =============================================================================
// Task #399 — integration coverage for
// GET /api/admin/background-jobs/fixture-cleanup-deactivations
// =============================================================================
// Locks the contract the admin Background Jobs page relies on:
//
//   1. Auth — unauthenticated → 401, non-admin → 403, admin → 200.
//   2. Returns ONLY rows with action='adviser_client.deactivated_fixture_cleanup'
//      AND entityType='adviser_client'. A row with the same action but a
//      different entityType (an unrelated audit category that happens to
//      reuse a verb) MUST NOT leak through.
//   3. Adviser + client emails are joined from `users` so the UI can render
//      human emails. linkId is parsed from `entityId` (text → int) so the
//      "View audit" deep-link can target one specific entry.
//   4. matchedPattern + trigger pass through verbatim from
//      metadata.extra so the operator can see WHY the cron flipped the row.
//   5. Ordering — most recent first (createdAt DESC, id DESC).
//   6. limit query param caps at 200 and floors at 1.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET ||= "fixture-cleanup-deact-test-secret";
});

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { inArray } from "drizzle-orm";

import { db } from "./db";
import { auditLogs, users } from "@shared/schema";
import { signToken } from "./auth";
import { registerAdminRoutes } from "./admin-routes";
import { writeAuditLog } from "./services/audit";

const TAG = "task399-cleanup-deact-test";
const REAL_ADVISER_EMAIL = `${TAG}-real-adviser@example.invalid`;
const FIXTURE_CLIENT_EMAIL_A = `${TAG}-okadv-fakeclientA@example.com`;
const FIXTURE_CLIENT_EMAIL_B = `${TAG}-okadv-fakeclientB@example.com`;

const SEEDED_EMAILS = [
  REAL_ADVISER_EMAIL,
  FIXTURE_CLIENT_EMAIL_A,
  FIXTURE_CLIENT_EMAIL_B,
];

let server: http.Server;
let baseUrl: string;
let adminToken: string;
let clientToken: string;

interface SeedIds {
  adviserUserId: number;
  clientAUserId: number;
  clientBUserId: number;
  auditIds: number[];
  // Synthetic "wrong action" row that MUST NOT show up in the endpoint.
  decoyAuditId: number;
  // A row with the right action + entityType but with a NON-INTEGER entityId,
  // which the endpoint must still surface (with linkId=null) rather than
  // dropping silently.
  nonNumericLinkAuditId: number;
}

async function seed(): Promise<SeedIds> {
  // 1. Create the three users we need.
  const [adviser] = await db
    .insert(users)
    .values({
      username: `${TAG}-adviser`,
      email: REAL_ADVISER_EMAIL,
      password: "hash",
      firstName: "Real",
      lastName: "Adviser",
      role: "adviser",
    })
    .returning({ id: users.id });
  const [clientA] = await db
    .insert(users)
    .values({
      username: `${TAG}-clientA`,
      email: FIXTURE_CLIENT_EMAIL_A,
      password: "hash",
      firstName: "Fixture",
      lastName: "ClientA",
      role: "client",
    })
    .returning({ id: users.id });
  const [clientB] = await db
    .insert(users)
    .values({
      username: `${TAG}-clientB`,
      email: FIXTURE_CLIENT_EMAIL_B,
      password: "hash",
      firstName: "Fixture",
      lastName: "ClientB",
      role: "client",
    })
    .returning({ id: users.id });

  // 2. Two real fixture-cleanup audit rows, sequenced so the endpoint's
  //    DESC order is observable. We sleep 5ms between them so createdAt is
  //    distinct on databases without sub-millisecond clock resolution.
  const olderAudit = await writeAuditLog({
    userId: null,
    action: "adviser_client.deactivated_fixture_cleanup",
    entityType: "adviser_client",
    entityId: "9000001",
    before: { isActive: true, unlinkedAt: null },
    after: { isActive: false, unlinkedAt: new Date().toISOString() },
    extra: {
      adviserUserId: adviser.id,
      clientUserId: clientA.id,
      matchedPattern: "okadv-*",
      trigger: TAG,
    },
    ipAddress: null,
  });
  await new Promise((r) => setTimeout(r, 10));
  const newerAudit = await writeAuditLog({
    userId: null,
    action: "adviser_client.deactivated_fixture_cleanup",
    entityType: "adviser_client",
    entityId: "9000002",
    before: { isActive: true, unlinkedAt: null },
    after: { isActive: false, unlinkedAt: new Date().toISOString() },
    extra: {
      adviserUserId: adviser.id,
      clientUserId: clientB.id,
      matchedPattern: "okadv-*",
      trigger: TAG,
    },
    ipAddress: null,
  });

  // 3. A decoy row with the right action but wrong entityType. The
  //    endpoint must scope to entityType='adviser_client' so this never
  //    shows up.
  const decoyRow = await writeAuditLog({
    userId: null,
    action: "adviser_client.deactivated_fixture_cleanup",
    entityType: "wrong_type",
    entityId: "9999",
    extra: { trigger: TAG },
    ipAddress: null,
  });

  // 4. A non-numeric entityId. This is defensive — if a future caller
  //    ever writes a non-integer entityId, the endpoint should still
  //    surface the row (with linkId=null) instead of crashing or dropping
  //    it. Important so ops can spot bad data rather than have it hide.
  const nonNumericRow = await writeAuditLog({
    userId: null,
    action: "adviser_client.deactivated_fixture_cleanup",
    entityType: "adviser_client",
    entityId: `not-a-number-${TAG}`,
    extra: {
      adviserUserId: adviser.id,
      clientUserId: clientA.id,
      matchedPattern: "okadv-*",
      trigger: TAG,
    },
    ipAddress: null,
  });

  return {
    adviserUserId: adviser.id,
    clientAUserId: clientA.id,
    clientBUserId: clientB.id,
    auditIds: [olderAudit.id, newerAudit.id],
    decoyAuditId: decoyRow.id,
    nonNumericLinkAuditId: nonNumericRow.id,
  };
}

let seeded: SeedIds;

beforeAll(async () => {
  seeded = await seed();

  const app = express();
  app.use(express.json());
  registerAdminRoutes(app);

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  adminToken = signToken({
    userId: 999_001,
    username: "__admin_task399_test__",
    email: "admin-task399-test@test.invalid",
    role: "admin",
  });
  clientToken = signToken({
    userId: 999_002,
    username: "__client_task399_test__",
    email: "client-task399-test@test.invalid",
    role: "client",
  });
});

afterAll(async () => {
  // audit_logs is append-only (Task #149's audit_logs_block_delete trigger),
  // so we cannot scrub the seeded rows. The unique TAG namespace + per-run
  // unique entityId values guarantee isolation across test reruns and across
  // other test files. We DO clean up the users rows we created.
  try {
    await db.delete(users).where(inArray(users.email, SEEDED_EMAILS));
  } catch {
    // best-effort
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

async function call(
  token?: string,
  query = "",
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(
    `${baseUrl}/api/admin/background-jobs/fixture-cleanup-deactivations${query}`,
    { headers },
  );
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

describe("GET /api/admin/background-jobs/fixture-cleanup-deactivations", () => {
  it("returns 401 when no Authorization header is sent", async () => {
    const { status, body } = await call();
    expect(status).toBe(401);
    expect(body.items).toBeUndefined();
  });

  it("returns 403 when a non-admin token is presented", async () => {
    const { status, body } = await call(clientToken);
    expect(status).toBe(403);
    expect(body.items).toBeUndefined();
  });

  it("returns the seeded fixture-cleanup deactivations to an admin, joined with user emails, most recent first", async () => {
    const { status, body } = await call(adminToken);
    expect(status).toBe(200);
    expect(Array.isArray(body.items)).toBe(true);

    const ours = (body.items as any[]).filter((it) =>
      seeded.auditIds.includes(it.auditLogId),
    );
    expect(ours).toHaveLength(2);

    // Most recent first (newer audit row before older one).
    expect(ours[0].auditLogId).toBe(seeded.auditIds[1]);
    expect(ours[1].auditLogId).toBe(seeded.auditIds[0]);

    // The newer row points at clientB; the older at clientA.
    expect(ours[0].clientUserId).toBe(seeded.clientBUserId);
    expect(ours[0].clientEmail).toBe(FIXTURE_CLIENT_EMAIL_B);
    expect(ours[0].adviserUserId).toBe(seeded.adviserUserId);
    expect(ours[0].adviserEmail).toBe(REAL_ADVISER_EMAIL);
    expect(ours[0].matchedPattern).toBe("okadv-*");
    expect(ours[0].trigger).toBe(TAG);
    expect(ours[0].linkId).toBe(9000002);

    expect(ours[1].clientUserId).toBe(seeded.clientAUserId);
    expect(ours[1].clientEmail).toBe(FIXTURE_CLIENT_EMAIL_A);
    expect(ours[1].linkId).toBe(9000001);
  });

  it("excludes rows with the same action but a different entityType", async () => {
    const { body } = await call(adminToken);
    const ids = (body.items as any[]).map((it) => it.auditLogId);
    expect(ids).not.toContain(seeded.decoyAuditId);
  });

  it("includes rows with a non-integer entityId, surfaced with linkId=null", async () => {
    const { body } = await call(adminToken);
    const nonNumeric = (body.items as any[]).find(
      (it) => it.auditLogId === seeded.nonNumericLinkAuditId,
    );
    expect(nonNumeric).toBeDefined();
    expect(nonNumeric.linkId).toBeNull();
  });

  it("respects the limit query param (clamped to [1, 200])", async () => {
    const { status, body } = await call(adminToken, "?limit=1");
    expect(status).toBe(200);
    expect(body.items.length).toBe(1);

    const { status: tooBigStatus, body: tooBig } = await call(
      adminToken,
      "?limit=99999",
    );
    expect(tooBigStatus).toBe(200);
    expect(tooBig.items.length).toBeLessThanOrEqual(200);
  });
});

// =============================================================================
// Companion coverage for the deep-link target:
// GET /api/admin/audit-logs?id=<auditLogId> must return EXACTLY one row,
// even if the same (action, entityType, entityId) tuple has been written
// multiple times. This is what makes the Background Jobs page's
// "View audit" link land on the specific row the operator clicked.
// =============================================================================
describe("GET /api/admin/audit-logs?id=<auditLogId>", () => {
  it("returns exactly the one audit row when filtering by id", async () => {
    const targetId = seeded.auditIds[1];
    const res = await fetch(
      `${baseUrl}/api/admin/audit-logs?id=${targetId}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(targetId);
    expect(body.items[0].action).toBe(
      "adviser_client.deactivated_fixture_cleanup",
    );
  });

  it("returns no rows when id does not match (and ignores zero/negative ids)", async () => {
    const headers = { Authorization: `Bearer ${adminToken}` };

    // A real but absent id (max+1 of our seeded ids) — must return zero rows.
    const ghostId = Math.max(...seeded.auditIds) + 9_999_999;
    const ghostRes = await fetch(
      `${baseUrl}/api/admin/audit-logs?id=${ghostId}`,
      { headers },
    );
    expect(ghostRes.status).toBe(200);
    const ghostBody = await ghostRes.json();
    expect(ghostBody.items).toHaveLength(0);

    // id=0 must be treated as "no exact-id filter" (not an error, not a
    // match), so combining with an action filter still narrows correctly.
    const zeroRes = await fetch(
      `${baseUrl}/api/admin/audit-logs?id=0&action=adviser_client.deactivated_fixture_cleanup`,
      { headers },
    );
    expect(zeroRes.status).toBe(200);
    const zeroBody = await zeroRes.json();
    const ourIds = (zeroBody.items as any[])
      .map((it) => it.id)
      .filter((id) => seeded.auditIds.includes(id));
    expect(ourIds.length).toBeGreaterThanOrEqual(2);
  });
});
