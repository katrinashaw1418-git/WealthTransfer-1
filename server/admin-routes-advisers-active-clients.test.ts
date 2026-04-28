// =============================================================================
// Task #379 — pin the admin /advisers `activeClients` count
// -----------------------------------------------------------------------------
// `GET /api/admin/advisers` projects an `activeClients` value through a
// correlated subquery against `adviser_clients`. Drizzle renders an inline
// `${users.id}` outer reference as the bare column name `"id"`, which inside
// the subquery PostgreSQL resolves to `adviser_clients.id` (the only table
// in scope) rather than the outer `users.id`. The WHERE clause then silently
// degrades to `adviser_clients.adviser_user_id = adviser_clients.id` and the
// count is essentially always 0 — admins were shown wrong client counts.
//
// Same Drizzle-bare-column-name footgun previously fixed for the
// fee-consents back-pointers (Tasks #342 and #372). This test seeds an
// adviser with a known set of active and inactive client links, hits the
// endpoint, and asserts the value-level `activeClients` count so the fix
// (qualifying the outer reference as `"users"."id"`) cannot regress
// unnoticed.
// =============================================================================

import "../scripts/_bootstrap-test-env";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { inArray } from "drizzle-orm";

import { signToken } from "./auth";
import { registerAdminRoutes } from "./admin-routes";
import { db } from "./db";
import { adviserClients, users } from "@shared/schema";

let server: http.Server;
let baseUrl: string;
let seedKey: string;

let adminUserId: number;
let adminToken: string;

// The adviser whose `activeClients` count we assert against.
let adviserUserId: number;
let adviserUsername: string;

// A second adviser with NO links — proves the count is per-adviser, not a
// global tally that would also pass the bug accidentally.
let lonelyAdviserUserId: number;
let lonelyAdviserUsername: string;

const seededUserIds: number[] = [];
const seededLinkIds: number[] = [];

const ACTIVE_CLIENT_COUNT = 3;
const INACTIVE_CLIENT_COUNT = 2;

beforeAll(async () => {
  seedKey = `t379_${randomBytes(4).toString("hex")}`;

  const app = express();
  app.use(express.json());
  registerAdminRoutes(app);
  server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const [adminRow] = await db
    .insert(users)
    .values({
      username: `${seedKey}_admin`,
      email: `${seedKey}_admin@test.invalid`,
      password: "x",
      firstName: "Test",
      lastName: "Admin",
      role: "admin",
    })
    .returning();
  adminUserId = adminRow.id;
  seededUserIds.push(adminUserId);
  adminToken = signToken({
    userId: adminUserId,
    username: adminRow.username,
    email: adminRow.email,
    role: "admin",
  });

  adviserUsername = `${seedKey}_adv`;
  const [adviserRow] = await db
    .insert(users)
    .values({
      username: adviserUsername,
      email: `${seedKey}_adv@test.invalid`,
      password: "x",
      firstName: "Active",
      lastName: "Adviser",
      role: "adviser",
    })
    .returning();
  adviserUserId = adviserRow.id;
  seededUserIds.push(adviserUserId);

  lonelyAdviserUsername = `${seedKey}_lonely`;
  const [lonelyAdviserRow] = await db
    .insert(users)
    .values({
      username: lonelyAdviserUsername,
      email: `${seedKey}_lonely@test.invalid`,
      password: "x",
      firstName: "Lonely",
      lastName: "Adviser",
      role: "adviser",
    })
    .returning();
  lonelyAdviserUserId = lonelyAdviserRow.id;
  seededUserIds.push(lonelyAdviserUserId);

  // Seed N active client links to the first adviser, plus M inactive ones.
  // The inactive rows pin that the WHERE-clause `is_active = true` filter
  // is also being applied correctly — without that, a fix that simply
  // joined adviser_clients without the predicate would silently inflate
  // the count to N + M.
  for (let i = 0; i < ACTIVE_CLIENT_COUNT; i += 1) {
    const [client] = await db
      .insert(users)
      .values({
        username: `${seedKey}_active_client_${i}`,
        email: `${seedKey}_active_client_${i}@test.invalid`,
        password: "x",
        firstName: "Active",
        lastName: `Client${i}`,
        role: "client",
      })
      .returning();
    seededUserIds.push(client.id);

    const [link] = await db
      .insert(adviserClients)
      .values({
        adviserUserId,
        clientUserId: client.id,
        relationshipType: "servicing",
        isActive: true,
      })
      .returning();
    seededLinkIds.push(link.id);
  }

  for (let i = 0; i < INACTIVE_CLIENT_COUNT; i += 1) {
    const [client] = await db
      .insert(users)
      .values({
        username: `${seedKey}_inactive_client_${i}`,
        email: `${seedKey}_inactive_client_${i}@test.invalid`,
        password: "x",
        firstName: "Inactive",
        lastName: `Client${i}`,
        role: "client",
      })
      .returning();
    seededUserIds.push(client.id);

    const [link] = await db
      .insert(adviserClients)
      .values({
        adviserUserId,
        clientUserId: client.id,
        relationshipType: "servicing",
        isActive: false,
      })
      .returning();
    seededLinkIds.push(link.id);
  }
});

afterAll(async () => {
  if (seededLinkIds.length > 0) {
    await db
      .delete(adviserClients)
      .where(inArray(adviserClients.id, seededLinkIds));
  }
  if (seededUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("GET /api/admin/advisers — activeClients count (Task #379)", () => {
  it("returns the correct count of ACTIVE adviser_clients links per adviser", async () => {
    const res = await fetch(`${baseUrl}/api/admin/advisers`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const rows: Array<{
      id: number;
      username: string;
      activeClients: number | string;
    }> = await res.json();

    // The endpoint returns ALL advisers in the system. We pluck the two
    // we seeded by id so the assertion is robust to other advisers being
    // present (e.g. the seeded demo adviser, or fixtures from earlier
    // suites that may not have been cleaned up).
    const seededAdviser = rows.find((r) => r.id === adviserUserId);
    const lonelyAdviser = rows.find((r) => r.id === lonelyAdviserUserId);
    expect(seededAdviser, "seeded adviser must appear in /admin/advisers").toBeDefined();
    expect(lonelyAdviser, "lonely adviser must appear in /admin/advisers").toBeDefined();

    // The bug rendered `${users.id}` as the bare `"id"` column and
    // PostgreSQL bound it to `adviser_clients.id` — making the WHERE
    // `adviser_clients.adviser_user_id = adviser_clients.id`, which is
    // essentially never true. Without the fix this assertion would see
    // 0 (or, on the off-chance an id and adviser_user_id happen to
    // collide, a coincidental small number) instead of
    // ACTIVE_CLIENT_COUNT.
    expect(Number(seededAdviser!.activeClients)).toBe(ACTIVE_CLIENT_COUNT);

    // Inactive links are excluded by the `is_active = true` predicate;
    // the lonely adviser has no links at all, so the count must be 0.
    // This pins both halves of the WHERE clause at once: a fix that
    // dropped the `is_active = true` predicate would inflate the
    // seeded-adviser count to ACTIVE_CLIENT_COUNT + INACTIVE_CLIENT_COUNT
    // and would still report 0 for the lonely adviser, so the active
    // adviser assertion above is what catches that regression.
    expect(Number(lonelyAdviser!.activeClients)).toBe(0);
  });
});
