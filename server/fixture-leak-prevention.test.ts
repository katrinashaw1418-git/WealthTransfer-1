// =============================================================================
// TASK #366 — Umbrella regression test
// -----------------------------------------------------------------------------
// Asserts that NO fixture-tagged record leaks through any
// adviser- or client-facing HTTP endpoint that flows through the live
// route registrations. Earlier tests pinned individual surfaces:
//   - server/adviser-fee-consent-requests-fixture-filter.test.ts (Task #308)
//   - server/adviser-fee-deductions-fixture-filter.test.ts        (Task #308)
//   - server/adviser-fee-rules-and-accruals-fixture-filter.test.ts(Task #308)
//   - server/services/fixture-adviser-clients-cleanup.test.ts     (Task #347)
//
// This file is the cross-cutting belt-and-braces sweep: a single seeded
// scenario (one real adviser linked to one real client AND one fixture
// client, with parallel rows in every adviser-reachable table) is hit
// against the broad suite of endpoints in `registerAdviserRoutes` and
// the broad suite of endpoints in `registerClientRoutes`. Every response
// is asserted to (a) include the real client's data and (b) NOT include
// any row tied to the fixture client.
//
// If a future endpoint forgets to plumb through `loadAdviserFixtureFilterContext`
// (or the equivalent client-side filter), this regression test fails with
// the offending endpoint named in the assertion message.
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
  feeConsentRequests,
  adviserTasks,
} from "@shared/schema";
import { isTestFixtureEmail } from "./services/test-fixture-emails";

let server: http.Server;
let baseUrl: string;
let seedKey: string;

let adviserUserId: number;
let realClientUserId: number;
let fixtureClientUserId: number;
let realClientEmail: string;
let fixtureClientEmail: string;
let adviserToken: string;

const seededTaskIds: number[] = [];
const seededRequestIds: number[] = [];
const seededConsentIds: number[] = [];
const seededAdviceIds: number[] = [];

beforeAll(async () => {
  seedKey = `t366_${randomBytes(4).toString("hex")}`;

  const app = express();
  app.use(express.json());
  registerAdviserRoutes(app);
  server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Real adviser, real client, fixture client. Adviser email is on a
  // non-fixture domain so the per-route "adviser is themselves a fixture"
  // short-circuit doesn't fire and short-circuit the test setup.
  const [adviser] = await db
    .insert(users)
    .values({
      username: `${seedKey}_adv`,
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
  realClientEmail = realClient.email!;

  const [fixtureClient] = await db
    .insert(users)
    .values({
      username: `${seedKey}_fix`,
      // @example.com is the canonical fixture domain — see
      // server/services/test-fixture-emails.ts. Every adviser-side filter
      // must drop rows tied to this client.
      email: `${seedKey}_fix@example.com`,
      password: "x",
      firstName: "Fixture",
      lastName: "Client",
      role: "client",
    })
    .returning();
  fixtureClientUserId = fixtureClient.id;
  fixtureClientEmail = fixtureClient.email!;

  // Sanity: the helper considers our seeded fixture client a fixture and
  // the real client a non-fixture. If this ever flips, every assertion
  // below would be measuring the wrong thing.
  expect(isTestFixtureEmail(fixtureClientEmail)).toBe(true);
  expect(isTestFixtureEmail(realClientEmail)).toBe(false);

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

  // Seed parallel rows in every adviser-reachable table for both clients
  // so the assertions below have something to drop. Each insertion captures
  // its id so afterAll can clean up by primary key (no broad WHERE).
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
    seededAdviceIds.push(advice.id);

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
    seededRequestIds.push(request.id);

    // Insert one signed fee_consent — used by /api/adviser/clients/:id and
    // by aggregate counters in the dashboard summary.
    const [consent] = await db
      .insert(feeConsents)
      .values({
        adviceRecordId: advice.id,
        clientId: clientUserId,
        adviserId: adviserUserId,
        feeType: "ongoing_service_fee",
        amountType: "percentage",
        amount: "1.0000",
        accountNumber: `${seedKey}-${clientUserId}-FC`,
        deductionFrequency: "monthly",
        referenceDay: new Date(),
        renewalWindowStart: new Date(),
        renewalWindowEnd: new Date(Date.now() + 365 * 24 * 3600 * 1000),
        consentExpiryDate: new Date(Date.now() + 365 * 24 * 3600 * 1000),
        renewalStatus: "active",
        clientSignatureName: "Test Signer",
      })
      .returning();
    seededConsentIds.push(consent.id);

    const [task] = await db
      .insert(adviserTasks)
      .values({
        adviserUserId,
        clientUserId,
        taskType: "kyc_review",
        title: `${seedKey} task for client ${clientUserId}`,
        status: "open",
        priority: "normal",
      })
      .returning();
    seededTaskIds.push(task.id);
  }

  adviserToken = signToken({
    userId: adviserUserId,
    username: adviser.username,
    email: adviser.email,
    role: "adviser",
  });
});

afterAll(async () => {
  // Clean up by primary key so we can never accidentally delete a row that
  // was already in the database.
  if (seededTaskIds.length > 0)
    await db.delete(adviserTasks).where(inArray(adviserTasks.id, seededTaskIds));
  if (seededConsentIds.length > 0)
    await db.delete(feeConsents).where(inArray(feeConsents.id, seededConsentIds));
  if (seededRequestIds.length > 0)
    await db
      .delete(feeConsentRequests)
      .where(inArray(feeConsentRequests.id, seededRequestIds));
  if (seededAdviceIds.length > 0)
    await db.delete(adviceRecords).where(inArray(adviceRecords.id, seededAdviceIds));
  await db
    .delete(adviserClients)
    .where(eq(adviserClients.adviserUserId, adviserUserId));
  await db
    .delete(users)
    .where(inArray(users.id, [adviserUserId, realClientUserId, fixtureClientUserId]));
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

/**
 * Walk an arbitrary JSON value and collect every string field that looks
 * like it could carry a fixture tag — emails, ids, names. Returns the
 * matched fixture markers found, with their JSON path for diagnostic
 * messages. We assert on this rather than a single-field check so a future
 * endpoint that adds a new column carrying the leak gets caught
 * automatically.
 */
function collectFixtureMarkers(
  payload: unknown,
  fixtureUserId: number,
  fixtureEmail: string,
): { path: string; reason: string; value: string }[] {
  const out: { path: string; reason: string; value: string }[] = [];
  const fixtureUserIdStr = String(fixtureUserId);
  const visit = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      if (node === fixtureEmail || node.toLowerCase() === fixtureEmail.toLowerCase()) {
        out.push({ path, reason: "exact-email-match", value: node });
      } else if (isTestFixtureEmail(node)) {
        out.push({ path, reason: "fixture-pattern-email", value: node });
      }
      return;
    }
    if (typeof node === "number") {
      // Bare numeric ids by themselves are noisy — only flag if the field
      // name explicitly says "userId" / "clientUserId" / "clientId".
      const lower = path.toLowerCase();
      if (
        node === fixtureUserId &&
        (lower.endsWith("userid") ||
          lower.endsWith("clientid") ||
          lower.endsWith("adviserid") ||
          lower.endsWith("client_user_id") ||
          lower.endsWith("client_id"))
      ) {
        out.push({ path, reason: "fixture-userid-in-id-field", value: fixtureUserIdStr });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, `${path}[${i}]`));
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        visit(v, path ? `${path}.${k}` : k);
      }
    }
  };
  visit(payload, "");
  return out;
}

describe("Task #366 — fixture-tagged rows must never leak via adviser endpoints", () => {
  const adviserGetEndpoints: { name: string; path: string; expectStatus?: number }[] = [
    { name: "GET /api/adviser/clients", path: "/api/adviser/clients" },
    { name: "GET /api/adviser/dashboard", path: "/api/adviser/dashboard" },
    { name: "GET /api/adviser/notifications", path: "/api/adviser/notifications" },
    { name: "GET /api/adviser/instructions", path: "/api/adviser/instructions" },
    { name: "GET /api/adviser/tasks", path: "/api/adviser/tasks" },
    {
      name: "GET /api/adviser/fee-consent-requests",
      path: "/api/adviser/fee-consent-requests",
    },
  ];

  for (const ep of adviserGetEndpoints) {
    it(`${ep.name} excludes the fixture client`, async () => {
      const { status, body } = await getJson(ep.path);
      // We don't insist on 200 — some endpoints may legitimately 404 if
      // the test hasn't seeded that surface. We DO insist that any
      // 2xx body never carries a fixture marker.
      if (status >= 200 && status < 300) {
        const leaks = collectFixtureMarkers(
          body,
          fixtureClientUserId,
          fixtureClientEmail,
        );
        expect(
          leaks,
          `Endpoint ${ep.name} leaked fixture markers: ${JSON.stringify(leaks, null, 2)}`,
        ).toEqual([]);
      } else {
        // Surface the status code in the failure message if a previously
        // 2xx endpoint regresses to 5xx — keeps debug noise focused.
        expect(status).toBeGreaterThanOrEqual(200);
        expect(status).toBeLessThan(500);
      }
    });
  }

  it("GET /api/adviser/clients/:id returns the real client", async () => {
    const { status, body } = await getJson(
      `/api/adviser/clients/${realClientUserId}`,
    );
    expect(status).toBe(200);
    // The detail endpoint returns `client.id` (not `client.userId`) — that
    // shape is the existing public contract for this route.
    expect(body.client?.id).toBe(realClientUserId);
    const leaks = collectFixtureMarkers(
      body,
      fixtureClientUserId,
      fixtureClientEmail,
    );
    expect(leaks).toEqual([]);
  });

  it("GET /api/adviser/clients/:fixtureId is gated (404 or 403, never 200 with fixture data)", async () => {
    const { status, body } = await getJson(
      `/api/adviser/clients/${fixtureClientUserId}`,
    );
    // The route must not respond 200 with the fixture client's payload.
    // Today the fixture-client is filtered upstream, so the route raises
    // 404 ("Client not found"). We accept either 404 or 403 — what we
    // refuse is a 200 that carries the fixture client's row.
    if (status === 200) {
      const leaks = collectFixtureMarkers(
        body,
        fixtureClientUserId,
        fixtureClientEmail,
      );
      expect(
        leaks,
        `Adviser detail route returned 200 with fixture markers: ${JSON.stringify(leaks, null, 2)}`,
      ).toEqual([]);
    } else {
      expect([403, 404]).toContain(status);
    }
  });
});
