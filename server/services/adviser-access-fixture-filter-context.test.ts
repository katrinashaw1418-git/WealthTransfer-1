// =============================================================================
// Task #420 — direct unit test for loadAdviserFixtureFilterContext
// -----------------------------------------------------------------------------
// Every adviser fee endpoint regression test (Tasks #308 / #348 / #398) drives
// the shared fixture-client filter via a full HTTP round trip because the
// helper itself — `loadAdviserFixtureFilterContext` in `server/services/
// adviser-access.ts` — has no direct cover. The helper now backs four fee
// endpoints plus the adviser tasks / dashboard / notifications surfaces, so
// this file pins its contract once and lets the route-level tests stay narrow.
//
// Two scenarios are covered:
//
//   1. Real adviser linked to a mix of real and fixture-pattern clients
//      (an `@example.com` fixture and a real-domain client). Helper must
//      partition the link set: visibleClientIds = [real],
//      excludedClientIds = [fixture], adviserIsFixture = false.
//
//   2. Adviser whose own email is on a fixture domain. The helper currently
//      no-ops in this branch — fixture-on-fixture test scripts depend on it
//      keeping working — so visibleClientIds must include the fixture client
//      and excludedClientIds must be empty, with adviserIsFixture = true.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { db } from "../db";
import { adviserClients, users } from "@shared/schema";
import { loadAdviserFixtureFilterContext } from "./adviser-access";

const TAG = `t420_${randomBytes(4).toString("hex")}`;

// Real adviser scenario emails. The adviser uses a non-fixture domain so
// the filter does NOT short-circuit via the "adviser is themselves a
// fixture" branch — that branch is exercised by the second scenario.
const REAL_ADVISER_EMAIL = `${TAG}_real_adv@test.invalid`;
const REAL_CLIENT_EMAIL = `${TAG}_real_client@test.invalid`;
// `@example.com` is a known fixture domain in test-fixture-emails.ts.
const FIXTURE_CLIENT_EMAIL = `${TAG}_fixture_client@example.com`;

// Fixture-adviser scenario emails. The adviser-on-fixture branch must
// no-op the filter and surface ALL linked clients, including the
// `@example.com` one, so fixture-on-fixture test scripts keep working.
const FIXTURE_ADVISER_EMAIL = `${TAG}_adviser-race-fakeadv@example.com`;
const FIXTURE_ADVISER_REAL_CLIENT_EMAIL = `${TAG}_fa_real_client@test.invalid`;
const FIXTURE_ADVISER_FIXTURE_CLIENT_EMAIL = `${TAG}_fa_fixture_client@example.com`;

const SEEDED_EMAILS = [
  REAL_ADVISER_EMAIL,
  REAL_CLIENT_EMAIL,
  FIXTURE_CLIENT_EMAIL,
  FIXTURE_ADVISER_EMAIL,
  FIXTURE_ADVISER_REAL_CLIENT_EMAIL,
  FIXTURE_ADVISER_FIXTURE_CLIENT_EMAIL,
];

interface SeedIds {
  realAdviserId: number;
  realClientId: number;
  fixtureClientId: number;
  fixtureAdviserId: number;
  fixtureAdviserRealClientId: number;
  fixtureAdviserFixtureClientId: number;
}

let ids: SeedIds;

async function cleanup() {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, SEEDED_EMAILS));
  const userIds = rows.map((r) => r.id);
  if (userIds.length > 0) {
    await db
      .delete(adviserClients)
      .where(inArray(adviserClients.adviserUserId, userIds));
    await db
      .delete(adviserClients)
      .where(inArray(adviserClients.clientUserId, userIds));
  }
  await db.delete(users).where(inArray(users.email, SEEDED_EMAILS));
}

describe("loadAdviserFixtureFilterContext — Task #420 unit cover", () => {
  beforeAll(async () => {
    await cleanup();

    const inserted = await db
      .insert(users)
      .values([
        {
          username: `${TAG}_real_adv`,
          email: REAL_ADVISER_EMAIL,
          password: "x",
          firstName: "Real",
          lastName: "Adviser",
          role: "adviser",
        },
        {
          username: `${TAG}_real_client`,
          email: REAL_CLIENT_EMAIL,
          password: "x",
          firstName: "Real",
          lastName: "Client",
          role: "client",
        },
        {
          username: `${TAG}_fixture_client`,
          email: FIXTURE_CLIENT_EMAIL,
          password: "x",
          firstName: "Fixture",
          lastName: "Client",
          role: "client",
        },
        {
          username: `${TAG}_fixture_adv`,
          email: FIXTURE_ADVISER_EMAIL,
          password: "x",
          firstName: "Fixture",
          lastName: "Adviser",
          role: "adviser",
        },
        {
          username: `${TAG}_fa_real_client`,
          email: FIXTURE_ADVISER_REAL_CLIENT_EMAIL,
          password: "x",
          firstName: "FixtureAdv",
          lastName: "RealClient",
          role: "client",
        },
        {
          username: `${TAG}_fa_fixture_client`,
          email: FIXTURE_ADVISER_FIXTURE_CLIENT_EMAIL,
          password: "x",
          firstName: "FixtureAdv",
          lastName: "FixtureClient",
          role: "client",
        },
      ])
      .returning({ id: users.id, email: users.email });

    const idByEmail = new Map(inserted.map((u) => [u.email!, u.id]));
    ids = {
      realAdviserId: idByEmail.get(REAL_ADVISER_EMAIL)!,
      realClientId: idByEmail.get(REAL_CLIENT_EMAIL)!,
      fixtureClientId: idByEmail.get(FIXTURE_CLIENT_EMAIL)!,
      fixtureAdviserId: idByEmail.get(FIXTURE_ADVISER_EMAIL)!,
      fixtureAdviserRealClientId: idByEmail.get(
        FIXTURE_ADVISER_REAL_CLIENT_EMAIL,
      )!,
      fixtureAdviserFixtureClientId: idByEmail.get(
        FIXTURE_ADVISER_FIXTURE_CLIENT_EMAIL,
      )!,
    };

    await db.insert(adviserClients).values([
      {
        adviserUserId: ids.realAdviserId,
        clientUserId: ids.realClientId,
        relationshipType: "servicing",
        isActive: true,
      },
      {
        adviserUserId: ids.realAdviserId,
        clientUserId: ids.fixtureClientId,
        relationshipType: "servicing",
        isActive: true,
      },
      {
        adviserUserId: ids.fixtureAdviserId,
        clientUserId: ids.fixtureAdviserRealClientId,
        relationshipType: "servicing",
        isActive: true,
      },
      {
        adviserUserId: ids.fixtureAdviserId,
        clientUserId: ids.fixtureAdviserFixtureClientId,
        relationshipType: "servicing",
        isActive: true,
      },
    ]);
  });

  afterAll(cleanup);

  it("partitions a real adviser's links into visible (real) and excluded (fixture-pattern) ids", async () => {
    const ctx = await loadAdviserFixtureFilterContext(ids.realAdviserId);

    expect(ctx.adviserIsFixture).toBe(false);
    expect(ctx.visibleClientIds).toEqual([ids.realClientId]);
    expect(ctx.excludedClientIds).toEqual([ids.fixtureClientId]);
    // Defence in depth: the fixture client must NEVER appear in the visible
    // set even if some future refactor reorders the link rows.
    expect(ctx.visibleClientIds).not.toContain(ids.fixtureClientId);
  });

  it("no-ops when the adviser themselves is a fixture (preserves fixture-on-fixture test scripts)", async () => {
    const ctx = await loadAdviserFixtureFilterContext(ids.fixtureAdviserId);

    expect(ctx.adviserIsFixture).toBe(true);
    expect(ctx.excludedClientIds).toEqual([]);
    // The fixture-adviser's link set is BOTH the real and fixture client,
    // exposed verbatim — no filtering, no diagnostic warnings.
    const visible = [...ctx.visibleClientIds].sort((a, b) => a - b);
    const expected = [
      ids.fixtureAdviserRealClientId,
      ids.fixtureAdviserFixtureClientId,
    ].sort((a, b) => a - b);
    expect(visible).toEqual(expected);
  });
});
