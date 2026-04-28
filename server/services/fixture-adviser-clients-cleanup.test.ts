// Integration test: exercise the fixture adviser_clients cleanup against
// the real dev DB. Seeds three adviser↔client pairs (one fixture-on-real,
// one fixture-on-fixture, one real-on-real) and asserts the sweep flips
// only the first, writes one audit row per flip, and is idempotent.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, desc } from "drizzle-orm";

import { db } from "../db";
import { adviserClients, auditLogs, users } from "@shared/schema";
import {
  deactivateFixtureAdviserClientLinks,
  findFixtureAdviserClientLinks,
  formatDeactivateSummary,
} from "./fixture-adviser-clients-cleanup";

const TAG = "task347-cleanup-test";
const REAL_ADVISER_EMAIL = `${TAG}-real-adviser@example.invalid`;
const FIXTURE_ADVISER_EMAIL = `${TAG}-adviser-race-fakeadv@example.com`;
const FIXTURE_CLIENT_EMAIL = `${TAG}-okadv-fakeclient@example.com`;
const REAL_CLIENT_EMAIL = `${TAG}-real-client@example.invalid`;

const SEEDED_EMAILS = [
  REAL_ADVISER_EMAIL,
  FIXTURE_ADVISER_EMAIL,
  FIXTURE_CLIENT_EMAIL,
  REAL_CLIENT_EMAIL,
];

interface Ids {
  realAdviserId: number;
  fixtureAdviserId: number;
  fixtureClientId: number;
  realClientId: number;
  fixtureOnRealLinkId: number;
  fixtureOnFixtureLinkId: number;
  realOnRealLinkId: number;
}

let ids: Ids;

async function cleanup() {
  // `audit_logs` is immutable (per Task #98), so we leave any prior-run
  // audit rows in place. They reference now-deleted entityIds and do
  // not interfere with assertions because every run seeds fresh users
  // and the SERIAL adviser_clients.id sequence never reuses ids.
  const adviserUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, SEEDED_EMAILS));
  const userIds = adviserUsers.map((u) => u.id);
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

describe("deactivateFixtureAdviserClientLinks — integration", () => {
  beforeAll(async () => {
    await cleanup();

    // Use a unique tag per row to keep usernames distinct from any prior
    // test run that might still be lingering despite the cleanup() above.
    const inserted = await db
      .insert(users)
      .values([
        {
          username: `${TAG}-real-adviser`,
          email: REAL_ADVISER_EMAIL,
          password: "x",
          firstName: "Real",
          lastName: "Adviser",
          role: "adviser",
        },
        {
          username: `${TAG}-fixture-adviser`,
          email: FIXTURE_ADVISER_EMAIL,
          password: "x",
          firstName: "Fixture",
          lastName: "Adviser",
          role: "adviser",
        },
        {
          username: `${TAG}-fixture-client`,
          email: FIXTURE_CLIENT_EMAIL,
          password: "x",
          firstName: "Fixture",
          lastName: "Client",
          role: "client",
        },
        {
          username: `${TAG}-real-client`,
          email: REAL_CLIENT_EMAIL,
          password: "x",
          firstName: "Real",
          lastName: "Client",
          role: "client",
        },
      ])
      .returning({ id: users.id, email: users.email });

    const idByEmail = new Map(inserted.map((u) => [u.email!, u.id]));
    const realAdviserId = idByEmail.get(REAL_ADVISER_EMAIL)!;
    const fixtureAdviserId = idByEmail.get(FIXTURE_ADVISER_EMAIL)!;
    const fixtureClientId = idByEmail.get(FIXTURE_CLIENT_EMAIL)!;
    const realClientId = idByEmail.get(REAL_CLIENT_EMAIL)!;

    const seededLinks = await db
      .insert(adviserClients)
      .values([
        {
          adviserUserId: realAdviserId,
          clientUserId: fixtureClientId,
          relationshipType: "servicing",
          isActive: true,
        },
        {
          adviserUserId: fixtureAdviserId,
          clientUserId: fixtureClientId,
          relationshipType: "servicing",
          isActive: true,
        },
        {
          adviserUserId: realAdviserId,
          clientUserId: realClientId,
          relationshipType: "servicing",
          isActive: true,
        },
      ])
      .returning({
        id: adviserClients.id,
        adviserUserId: adviserClients.adviserUserId,
        clientUserId: adviserClients.clientUserId,
      });

    const findLink = (a: number, c: number) =>
      seededLinks.find((l) => l.adviserUserId === a && l.clientUserId === c)!.id;

    ids = {
      realAdviserId,
      fixtureAdviserId,
      fixtureClientId,
      realClientId,
      fixtureOnRealLinkId: findLink(realAdviserId, fixtureClientId),
      fixtureOnFixtureLinkId: findLink(fixtureAdviserId, fixtureClientId),
      realOnRealLinkId: findLink(realAdviserId, realClientId),
    };
  });

  afterAll(cleanup);

  it("findFixtureAdviserClientLinks returns ONLY the fixture-on-real link", async () => {
    const offending = await findFixtureAdviserClientLinks();
    const ours = offending.filter((o) =>
      [
        ids.fixtureOnRealLinkId,
        ids.fixtureOnFixtureLinkId,
        ids.realOnRealLinkId,
      ].includes(o.linkId),
    );
    expect(ours.map((o) => o.linkId)).toEqual([ids.fixtureOnRealLinkId]);
    expect(ours[0].adviserEmail).toBe(REAL_ADVISER_EMAIL);
    expect(ours[0].clientEmail).toBe(FIXTURE_CLIENT_EMAIL);
    expect(ours[0].matchedPattern).toContain("@example.com");
  });

  it("dryRun reports the offending link without flipping it", async () => {
    const summary = await deactivateFixtureAdviserClientLinks({ dryRun: true });
    const ourLink = summary.offending.find(
      (o) => o.linkId === ids.fixtureOnRealLinkId,
    );
    expect(ourLink).toBeDefined();
    expect(summary.deactivated).toBe(0);
    expect(summary.dryRun).toBe(true);

    const [row] = await db
      .select({ isActive: adviserClients.isActive })
      .from(adviserClients)
      .where(eq(adviserClients.id, ids.fixtureOnRealLinkId));
    expect(row.isActive).toBe(true);
    expect(formatDeactivateSummary(summary)).toContain("DRY RUN");
  });

  it("apply flips the fixture-on-real link, leaves the others, writes one audit row, and is idempotent", async () => {
    const summary = await deactivateFixtureAdviserClientLinks({
      dryRun: false,
      trigger: "test:task-347",
    });
    expect(summary.errors).toBe(0);
    // The dev DB may carry other fixture-on-real rows from earlier runs;
    // assert OUR link was deactivated and the totals are at least 1.
    expect(summary.scanned).toBeGreaterThanOrEqual(1);
    expect(summary.deactivated).toBeGreaterThanOrEqual(1);
    expect(
      summary.offending.find((o) => o.linkId === ids.fixtureOnRealLinkId),
    ).toBeDefined();

    const rows = await db
      .select({
        id: adviserClients.id,
        isActive: adviserClients.isActive,
        unlinkedAt: adviserClients.unlinkedAt,
      })
      .from(adviserClients)
      .where(
        inArray(adviserClients.id, [
          ids.fixtureOnRealLinkId,
          ids.fixtureOnFixtureLinkId,
          ids.realOnRealLinkId,
        ]),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(ids.fixtureOnRealLinkId)?.isActive).toBe(false);
    expect(byId.get(ids.fixtureOnRealLinkId)?.unlinkedAt).not.toBeNull();
    expect(byId.get(ids.fixtureOnFixtureLinkId)?.isActive).toBe(true);
    expect(byId.get(ids.realOnRealLinkId)?.isActive).toBe(true);

    const audits = await db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        userId: auditLogs.userId,
        metadata: auditLogs.metadata,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "adviser_client"),
          eq(auditLogs.entityId, String(ids.fixtureOnRealLinkId)),
        ),
      )
      .orderBy(desc(auditLogs.id));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const latest = audits[0];
    expect(latest.action).toBe("adviser_client.deactivated_fixture_cleanup");
    expect(latest.userId).toBeNull();
    const meta = latest.metadata as Record<string, unknown>;
    expect(meta.before).toMatchObject({ isActive: true });
    expect(meta.after).toMatchObject({ isActive: false });
    expect(meta.adviserUserId).toBe(ids.realAdviserId);
    expect(meta.clientUserId).toBe(ids.fixtureClientId);
    expect(meta.trigger).toBe("test:task-347");
    expect(typeof meta.matchedPattern).toBe("string");

    // Re-run is a no-op for OUR link (already inactive).
    const second = await deactivateFixtureAdviserClientLinks({
      dryRun: false,
      trigger: "test:task-347-rerun",
    });
    expect(
      second.offending.find((o) => o.linkId === ids.fixtureOnRealLinkId),
    ).toBeUndefined();

    const auditsAfterRerun = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "adviser_client"),
          eq(auditLogs.entityId, String(ids.fixtureOnRealLinkId)),
        ),
      );
    expect(auditsAfterRerun.length).toBe(audits.length);
  });
});
