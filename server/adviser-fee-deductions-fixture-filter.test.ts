// =============================================================================
// Task #348 — adviser fee-deductions endpoint hides fixture-pattern clients
// -----------------------------------------------------------------------------
// Locks in the regression on GET /api/adviser/fee-deductions, the second
// of the four fee endpoints whose fixture-client filter was wired up by
// Task #308. Mirrors `adviser-fee-consent-requests-fixture-filter.test.ts`
// (which covers the simpler /fee-consent-requests surface) so every fee
// endpoint that real advisers can hit has at least one route-level
// regression test exercising:
//
//   1. unscoped list  (?clientUserId omitted) → only the real client's row
//   2. ?clientUserId=<real>                   → the real deduction
//   3. ?clientUserId=<fixture>                → empty list, NOT a 403
//      (the adviser_clients link IS active, so assertAdviserClientLink
//      passes; the fixture filter must short-circuit BEFORE the DB read)
//
// Same seed shape as the fee-consent-requests test: one real adviser
// (non-fixture email) linked to one real client and one @example.com
// fixture client, each with a single pending_approval deduction row.
// =============================================================================

import "../scripts/_bootstrap-test-env";

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";

import { signToken } from "./auth";
import { registerAdviserRoutes } from "./adviser-routes";
import { db } from "./db";
import {
  users,
  adviserClients,
  adviserFeeDeductions,
} from "@shared/schema";

let server: http.Server;
let baseUrl: string;
let seedKey: string;

let adviserUserId: number;
let realClientUserId: number;
let fixtureClientUserId: number;
let realDeductionId: number;
let fixtureDeductionId: number;
let adviserToken: string;

beforeAll(async () => {
  seedKey = `t348_${randomBytes(4).toString("hex")}`;

  const app = express();
  app.use(express.json());
  registerAdviserRoutes(app);
  server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const [adviser] = await db
    .insert(users)
    .values({
      username: `${seedKey}_adv`,
      // Adviser email is on a non-fixture domain so the fixture filter
      // doesn't no-op via the "adviser is themselves a fixture" branch.
      email: `${seedKey}_adv@test.invalid`,
      password: "x",
      firstName: "Real",
      lastName: "Adviser",
      role: "adviser",
    })
    .returning();
  adviserUserId = adviser.id;

  const [realClient] = await db
    .insert(users)
    .values({
      username: `${seedKey}_real`,
      email: `${seedKey}_real@test.invalid`,
      password: "x",
      firstName: "Real",
      lastName: "Client",
      role: "client",
    })
    .returning();
  realClientUserId = realClient.id;

  const [fixtureClient] = await db
    .insert(users)
    .values({
      username: `${seedKey}_fix`,
      // @example.com is a known fixture domain in
      // server/services/test-fixture-emails.ts → must be excluded.
      email: `${seedKey}_fix@example.com`,
      password: "x",
      firstName: "Fixture",
      lastName: "Client",
      role: "client",
    })
    .returning();
  fixtureClientUserId = fixtureClient.id;

  await db.insert(adviserClients).values([
    {
      adviserUserId,
      clientUserId: realClientUserId,
      relationshipType: "servicing",
      isActive: true,
    },
    {
      adviserUserId,
      clientUserId: fixtureClientUserId,
      relationshipType: "servicing",
      isActive: true,
    },
  ]);

  // One pending_approval deduction per client. Both rows are otherwise
  // identical so any difference in the response is purely the result of
  // the fixture-client filter.
  const periodStart = new Date("2026-01-01T00:00:00Z");
  const periodEnd = new Date("2026-01-31T23:59:59Z");
  for (const clientUserId of [realClientUserId, fixtureClientUserId]) {
    const [deduction] = await db
      .insert(adviserFeeDeductions)
      .values({
        adviserUserId,
        clientUserId,
        periodStart,
        periodEnd,
        totalAccrued: "10.0000",
        adviserShareAmount: "8.0000",
        platformShareAmount: "2.0000",
        currency: "AUD",
        accrualIds: [],
      })
      .returning();
    if (clientUserId === realClientUserId) realDeductionId = deduction.id;
    else fixtureDeductionId = deduction.id;
  }

  adviserToken = signToken({
    userId: adviserUserId,
    username: adviser.username,
    email: adviser.email,
    role: "adviser",
  });
});

afterAll(async () => {
  await db
    .delete(adviserFeeDeductions)
    .where(eq(adviserFeeDeductions.adviserUserId, adviserUserId));
  await db
    .delete(adviserClients)
    .where(eq(adviserClients.adviserUserId, adviserUserId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${adviserToken}` },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

describe("GET /api/adviser/fee-deductions — Task #348 fixture-client filter", () => {
  it("omits deductions belonging to fixture-pattern clients in the unscoped list", async () => {
    const { status, body } = await getJson("/api/adviser/fee-deductions");
    expect(status).toBe(200);
    const ids = (body.items as any[]).map((r) => r.id);
    expect(ids).toContain(realDeductionId);
    expect(ids).not.toContain(fixtureDeductionId);
    const fixtureRows = (body.items as any[]).filter(
      (r) => r.clientUserId === fixtureClientUserId,
    );
    expect(fixtureRows).toHaveLength(0);
  });

  it("returns the deduction for an explicitly scoped real client", async () => {
    const { status, body } = await getJson(
      `/api/adviser/fee-deductions?clientUserId=${realClientUserId}`,
    );
    expect(status).toBe(200);
    expect((body.items as any[]).map((r) => r.id)).toEqual([realDeductionId]);
  });

  it("short-circuits to an empty payload when the explicit client is fixture-filtered", async () => {
    // The adviser_clients link IS active, so assertAdviserClientLink would
    // succeed; the fixture filter must take precedence and return empty
    // (NOT 403, NOT the fixture-client's deduction).
    const { status, body } = await getJson(
      `/api/adviser/fee-deductions?clientUserId=${fixtureClientUserId}`,
    );
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    // Response shape stays consistent with the non-empty success path
    // (`items` + `users`) so callers don't have to special-case this branch.
    expect(body).toMatchObject({ items: [], users: {} });
  });
});
