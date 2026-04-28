// =============================================================================
// Task #398 — adviser fee-rules + fee-accruals endpoints hide fixture clients
// -----------------------------------------------------------------------------
// Closes the gap left by Tasks #308 / #348: those tasks wired the
// fixture-client filter onto all four adviser fee endpoints and added
// route-level regression tests for /fee-consent-requests and
// /fee-deductions, but the remaining pair —
//   GET /api/adviser/fee-rules
//   GET /api/adviser/fee-accruals
// — still relied solely on the inlined route logic with no test that
// actually drove the HTTP surface. A future refactor of the fixture
// filter (or of the per-endpoint short-circuits at
// `server/adviser-routes.ts` ~lines 1484 / 1580) could quietly regress
// either endpoint without a single test failing. This file plugs that
// hole by mirroring the seed shape and assertion layout of
// `adviser-fee-deductions-fixture-filter.test.ts`:
//
//   1. unscoped list  (?clientUserId omitted) → only the real client's row
//   2. ?clientUserId=<real>                   → the real row
//   3. ?clientUserId=<fixture>                → empty success payload, NOT a 403
//      (the adviser_clients link IS active, so assertAdviserClientLink
//      passes; the fixture filter must short-circuit BEFORE the DB read)
//
// Same seed shape as the sibling tests: one real adviser (non-fixture
// email) linked to one real client and one @example.com fixture client.
// For fee-rules we insert the matching feeConsents row first because the
// route LEFT JOINs feeConsents to surface consent context; for
// fee-accruals each accrual row points at the corresponding fee rule.
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
import { eq, inArray } from "drizzle-orm";

import { signToken } from "./auth";
import { registerAdviserRoutes } from "./adviser-routes";
import { db } from "./db";
import {
  users,
  adviserClients,
  adviceRecords,
  feeConsents,
  adviserFeeRules,
  adviserFeeAccruals,
} from "@shared/schema";

let server: http.Server;
let baseUrl: string;
let seedKey: string;

let adviserUserId: number;
let realClientUserId: number;
let fixtureClientUserId: number;
let realRuleId: number;
let fixtureRuleId: number;
let realAccrualId: number;
let fixtureAccrualId: number;
let adviserToken: string;

beforeAll(async () => {
  seedKey = `t398_${randomBytes(4).toString("hex")}`;

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

  // One advice record + one fee consent + one fee rule + one fee accrual
  // per client. Both rows are otherwise identical so any difference in
  // either endpoint's response is purely the result of the fixture-client
  // filter — not, e.g., a status, date, or split mismatch.
  const refDay = new Date("2026-01-15T00:00:00Z");
  const yearFromNow = new Date(Date.now() + 365 * 24 * 3600 * 1000);
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
    const [consent] = await db
      .insert(feeConsents)
      .values({
        adviceRecordId: advice.id,
        clientId: clientUserId,
        adviserId: adviserUserId,
        feeType: "ongoing_service_fee",
        amountType: "percentage",
        amount: "1.0000",
        accountNumber: `${seedKey}-${clientUserId}-ACC`,
        accountName: `${seedKey} acct`,
        deductionFrequency: "monthly",
        referenceDay: refDay,
        renewalWindowStart: refDay,
        renewalWindowEnd: yearFromNow,
        consentExpiryDate: yearFromNow,
        clientSignatureName: "Test Signer",
      })
      .returning();
    const [rule] = await db
      .insert(adviserFeeRules)
      .values({
        feeConsentId: consent.id,
        clientUserId,
        adviserUserId,
        feeType: "ongoing_service_fee",
        amountType: "percentage",
        rateBps: 100,
        currency: "AUD",
        adviserSplitBps: 8000,
        platformSplitBps: 2000,
      })
      .returning();
    const [accrual] = await db
      .insert(adviserFeeAccruals)
      .values({
        feeRuleId: rule.id,
        clientUserId,
        adviserUserId,
        accrualDate: refDay,
        accrualAmount: "1.0000",
        adviserShareAmount: "0.8000",
        platformShareAmount: "0.2000",
        currency: "AUD",
      })
      .returning();
    if (clientUserId === realClientUserId) {
      realRuleId = rule.id;
      realAccrualId = accrual.id;
    } else {
      fixtureRuleId = rule.id;
      fixtureAccrualId = accrual.id;
    }
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
    .delete(adviserFeeAccruals)
    .where(eq(adviserFeeAccruals.adviserUserId, adviserUserId));
  await db
    .delete(adviserFeeRules)
    .where(eq(adviserFeeRules.adviserUserId, adviserUserId));
  await db
    .delete(feeConsents)
    .where(inArray(feeConsents.clientId, [realClientUserId, fixtureClientUserId]));
  await db
    .delete(adviceRecords)
    .where(eq(adviceRecords.adviserId, adviserUserId));
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

describe("GET /api/adviser/fee-rules — Task #398 fixture-client filter", () => {
  it("omits rules belonging to fixture-pattern clients in the unscoped list", async () => {
    const { status, body } = await getJson("/api/adviser/fee-rules");
    expect(status).toBe(200);
    const ids = (body.items as any[]).map((r) => r.id);
    expect(ids).toContain(realRuleId);
    expect(ids).not.toContain(fixtureRuleId);
    const fixtureRows = (body.items as any[]).filter(
      (r) => r.clientUserId === fixtureClientUserId,
    );
    expect(fixtureRows).toHaveLength(0);
  });

  it("returns the rule for an explicitly scoped real client", async () => {
    const { status, body } = await getJson(
      `/api/adviser/fee-rules?clientUserId=${realClientUserId}`,
    );
    expect(status).toBe(200);
    expect((body.items as any[]).map((r) => r.id)).toEqual([realRuleId]);
  });

  it("short-circuits to an empty paginated payload when the explicit client is fixture-filtered", async () => {
    // The adviser_clients link IS active, so assertAdviserClientLink would
    // succeed; the fixture filter must take precedence and return empty
    // (NOT 403, NOT the fixture-client's rule).
    const { status, body } = await getJson(
      `/api/adviser/fee-rules?clientUserId=${fixtureClientUserId}`,
    );
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    // Response shape stays consistent with the non-empty success path so
    // the UI's pagination + name-map lookups don't have to special-case
    // this branch.
    expect(body).toMatchObject({ items: [], total: 0, users: {} });
    expect(body.page).toBeGreaterThan(0);
    expect(body.limit).toBeGreaterThan(0);
  });
});

describe("GET /api/adviser/fee-accruals — Task #398 fixture-client filter", () => {
  it("omits accruals belonging to fixture-pattern clients in the unscoped list", async () => {
    const { status, body } = await getJson("/api/adviser/fee-accruals");
    expect(status).toBe(200);
    const ids = (body.items as any[]).map((r) => r.id);
    expect(ids).toContain(realAccrualId);
    expect(ids).not.toContain(fixtureAccrualId);
    const fixtureRows = (body.items as any[]).filter(
      (r) => r.clientUserId === fixtureClientUserId,
    );
    expect(fixtureRows).toHaveLength(0);
  });

  it("returns the accrual for an explicitly scoped real client", async () => {
    const { status, body } = await getJson(
      `/api/adviser/fee-accruals?clientUserId=${realClientUserId}`,
    );
    expect(status).toBe(200);
    expect((body.items as any[]).map((r) => r.id)).toEqual([realAccrualId]);
  });

  it("short-circuits to an empty payload when the explicit client is fixture-filtered", async () => {
    // The adviser_clients link IS active, so assertAdviserClientLink would
    // succeed; the fixture filter must take precedence and return empty
    // (NOT 403, NOT the fixture-client's accrual).
    const { status, body } = await getJson(
      `/api/adviser/fee-accruals?clientUserId=${fixtureClientUserId}`,
    );
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    // Response shape stays consistent with the non-empty success path
    // (`items` + `users`) so callers don't have to special-case this branch.
    expect(body).toMatchObject({ items: [], users: {} });
  });
});
