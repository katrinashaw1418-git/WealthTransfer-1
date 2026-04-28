// =============================================================================
// Task #308 — adviser fee endpoint hides fixture-pattern clients
// -----------------------------------------------------------------------------
// Reviewer follow-up: prove via the actual HTTP route (not just the helper)
// that the fixture-client filter wired into the fee endpoints actually
// short-circuits a real adviser's responses.
//
// Targets GET /api/adviser/fee-consent-requests (the simplest of the four
// new fee surfaces — no JOIN against the drifting adviser_fee_rules table)
// and seeds:
//   - one real adviser (non-fixture email)
//   - one real client                    + one pending fee-consent request
//   - one fixture client (@example.com)  + one pending fee-consent request
//   - both clients linked active in adviser_clients
//
// Then exercises three modes of the route:
//   1. unscoped list  (?clientId omitted) → only the real client's request
//   2. ?clientId=<real>                   → the real request
//   3. ?clientId=<fixture>                → empty list, NOT a 403
//      (the adviser_clients link IS active, so assertAdviserClientLink
//      passes; the fixture filter must short-circuit BEFORE the DB read)
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
  adviceRecords,
  feeConsentRequests,
} from "@shared/schema";

let server: http.Server;
let baseUrl: string;
let seedKey: string;

let adviserUserId: number;
let realClientUserId: number;
let fixtureClientUserId: number;
let realRequestId: number;
let fixtureRequestId: number;
let adviserToken: string;

beforeAll(async () => {
  seedKey = `t308_${randomBytes(4).toString("hex")}`;

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
      // Adviser email is on a non-fixture domain so the route doesn't
      // short-circuit via the "adviser is themselves a fixture" branch.
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

  // One advice record + one pending fee-consent request per client. Both
  // requests are otherwise identical so any difference in the response is
  // purely the result of the fixture-client filter.
  for (const clientUserId of [realClientUserId, fixtureClientUserId]) {
    const [advice] = await db
      .insert(adviceRecords)
      .values({
        clientId: clientUserId,
        adviserId: adviserUserId,
        adviceType: "personal",
        adviceSource: "hybrid",
        status: "issued",
      })
      .returning();
    const [request] = await db
      .insert(feeConsentRequests)
      .values({
        adviserUserId,
        clientUserId,
        adviceRecordId: advice.id,
        feeType: "ongoing_service_fee",
        amountType: "percentage",
        amount: "1.0000",
        accountNumber: `${seedKey}-${clientUserId}-ACC`,
        accountName: `${seedKey} acct`,
        deductionFrequency: "monthly",
        proposedReferenceDay: new Date(),
        proposedRenewalWindowStart: new Date(),
        proposedRenewalWindowEnd: new Date(Date.now() + 365 * 24 * 3600 * 1000),
        proposedConsentExpiryDate: new Date(Date.now() + 365 * 24 * 3600 * 1000),
        status: "pending",
      })
      .returning();
    if (clientUserId === realClientUserId) realRequestId = request.id;
    else fixtureRequestId = request.id;
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
    .delete(feeConsentRequests)
    .where(eq(feeConsentRequests.adviserUserId, adviserUserId));
  await db.delete(adviceRecords).where(eq(adviceRecords.adviserId, adviserUserId));
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

describe("GET /api/adviser/fee-consent-requests — Task #308 fixture-client filter", () => {
  it("omits requests belonging to fixture-pattern clients in the unscoped list", async () => {
    const { status, body } = await getJson("/api/adviser/fee-consent-requests");
    expect(status).toBe(200);
    const requestIds = body.items.map((r: any) => r.id);
    expect(requestIds).toContain(realRequestId);
    expect(requestIds).not.toContain(fixtureRequestId);
    const fixtureRows = (body.items as any[]).filter(
      (r) => r.clientUserId === fixtureClientUserId,
    );
    expect(fixtureRows).toHaveLength(0);
  });

  it("returns the request for an explicitly scoped real client", async () => {
    const { status, body } = await getJson(
      `/api/adviser/fee-consent-requests?clientId=${realClientUserId}`,
    );
    expect(status).toBe(200);
    expect(body.items.map((r: any) => r.id)).toEqual([realRequestId]);
  });

  it("short-circuits to an empty paginated payload when the explicit client is fixture-filtered", async () => {
    // The adviser_clients link IS active, so assertAdviserClientLink would
    // succeed; the fixture filter must take precedence and return empty
    // (NOT 403, NOT the fixture-client's request).
    const { status, body } = await getJson(
      `/api/adviser/fee-consent-requests?clientId=${fixtureClientUserId}`,
    );
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    // Response shape stays consistent with the non-empty success path so
    // the UI's `total ?? 0` etc. don't have to special-case this branch.
    expect(body).toMatchObject({ items: [], total: 0 });
    expect(body.page).toBeGreaterThan(0);
    expect(body.limit).toBeGreaterThan(0);
  });
});
