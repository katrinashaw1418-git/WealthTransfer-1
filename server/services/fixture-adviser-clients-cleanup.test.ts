// Integration test: exercise the fixture adviser_clients cleanup against
// the real dev DB. Seeds three adviser↔client pairs (one fixture-on-real,
// one fixture-on-fixture, one real-on-real) and asserts the sweep flips
// only the first, writes one audit row per flip, and is idempotent.
//
// Task #400 additions: also exercises the burst-alert threshold check —
// a pure unit test for `evaluateFixtureCleanupBurstAlert` plus an
// integration test that injects a stub `notifyOperator` to assert the
// cron pages on-call when the count threshold trips.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, desc } from "drizzle-orm";

import { db } from "../db";
import { adviserClients, auditLogs, users } from "@shared/schema";
import {
  FIXTURE_ADVISER_CLIENTS_CLEANUP_ALERT_SOURCE,
  deactivateFixtureAdviserClientLinks,
  evaluateFixtureCleanupBurstAlert,
  findFixtureAdviserClientLinks,
  formatDeactivateSummary,
  scanFixtureAdviserClientLinks,
} from "./fixture-adviser-clients-cleanup";
import type {
  OperatorAlert,
  OperatorAlertResult,
} from "./operator-alerts";

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

  // ===========================================================================
  // Task #400 — burst-alert behaviour
  // ===========================================================================

  it("scanFixtureAdviserClientLinks reports total active links alongside the offending subset", async () => {
    const scan = await scanFixtureAdviserClientLinks();
    // The dev DB carries other links from prior runs; just assert sanity:
    // total >= offending count, and total >= our seeded real-on-real link
    // (which is active and should always be counted).
    expect(scan.totalActiveLinks).toBeGreaterThanOrEqual(scan.offending.length);
    expect(scan.totalActiveLinks).toBeGreaterThanOrEqual(1);
  });

  it("evaluateFixtureCleanupBurstAlert trips on the count threshold", () => {
    const decision = evaluateFixtureCleanupBurstAlert(50, 10_000, {
      minCount: 25,
      minPercent: 100, // disable percent rule
    });
    expect(decision.shouldAlert).toBe(true);
    expect(decision.reason).toContain("deactivated=50 >= minCount=25");
    expect(decision.percent).toBeCloseTo(0.5, 5);
  });

  it("evaluateFixtureCleanupBurstAlert trips on the percent threshold", () => {
    const decision = evaluateFixtureCleanupBurstAlert(6, 100, {
      minCount: 1_000_000, // disable count rule
      minPercent: 5,
    });
    expect(decision.shouldAlert).toBe(true);
    expect(decision.reason).toContain("percent=6.00% >= minPercent=5%");
  });

  it("evaluateFixtureCleanupBurstAlert stays quiet when neither threshold is breached", () => {
    const decision = evaluateFixtureCleanupBurstAlert(2, 1_000, {
      minCount: 25,
      minPercent: 5,
    });
    expect(decision.shouldAlert).toBe(false);
    expect(decision.reason).toBeNull();
  });

  it("evaluateFixtureCleanupBurstAlert never alerts on a no-op sweep", () => {
    const decision = evaluateFixtureCleanupBurstAlert(0, 0, {
      minCount: 0,
      minPercent: 0,
    });
    expect(decision.shouldAlert).toBe(false);
    expect(decision.percent).toBe(0);
  });

  it("evaluateFixtureCleanupBurstAlert avoids percent false-positive when total is 0", () => {
    // total=0 happens on a fresh DB or when every active link is itself
    // about to be deactivated. The percent rule is intentionally skipped
    // so we don't page on a 100% sweep of an empty universe.
    const decision = evaluateFixtureCleanupBurstAlert(3, 0, {
      minCount: 100, // disable count rule
      minPercent: 1,
    });
    expect(decision.shouldAlert).toBe(false);
  });

  it("deactivateFixtureAdviserClientLinks dispatches a burst alert when the count threshold trips, with a UTC-date subjectId", async () => {
    // Re-seed: the previous "apply flips" test left our fixture-on-real
    // link inactive, so re-flip it before this test exercises the alert.
    await db
      .update(adviserClients)
      .set({ isActive: true, unlinkedAt: null })
      .where(eq(adviserClients.id, ids.fixtureOnRealLinkId));

    const calls: OperatorAlert[] = [];
    const stubNotify = async (
      alert: OperatorAlert,
    ): Promise<OperatorAlertResult> => {
      calls.push(alert);
      return {
        channelsAttempted: ["log"],
        outcomes: [{ channel: "log", status: "success", durationMs: 0 }],
        channels: ["log"],
        alertId: 1,
        deliveryStatus: "delivered",
        occurrences: 1,
        dedupeKey: "stub",
      };
    };

    // minCount=1 forces the alert to trip on our single seeded link
    // regardless of whatever else the dev DB has lying around.
    const summary = await deactivateFixtureAdviserClientLinks({
      dryRun: false,
      trigger: "test:task-400-burst",
      alertThresholds: { minCount: 1, minPercent: 100 },
      notifyOperator: stubNotify,
    });

    expect(summary.deactivated).toBeGreaterThanOrEqual(1);
    expect(summary.burstAlert.shouldAlert).toBe(true);
    expect(summary.burstAlertDispatched).toBe(true);
    expect(calls.length).toBe(1);
    const alert = calls[0]!;
    expect(alert.source).toBe(FIXTURE_ADVISER_CLIENTS_CLEANUP_ALERT_SOURCE);
    expect(alert.severity).toBe("alert");
    expect(alert.kind).toBe(FIXTURE_ADVISER_CLIENTS_CLEANUP_ALERT_SOURCE);
    expect(alert.subjectType).toBe("cron-tick-utc-date");
    expect(typeof alert.subjectId).toBe("string");
    expect((alert.subjectId as string)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const details = alert.details as Record<string, unknown>;
    expect(details.deactivated).toBe(summary.deactivated);
    expect(details.totalActiveLinks).toBe(summary.totalActiveLinks);
    expect(details.minCountThreshold).toBe(1);
    expect(Array.isArray(details.sampleLinkIds)).toBe(true);
    expect(typeof details.remediation).toBe("string");
    expect(typeof details.reason).toBe("string");
    expect(formatDeactivateSummary(summary)).toContain(
      "BURST_ALERT_DISPATCHED",
    );
  });

  it("deactivateFixtureAdviserClientLinks does NOT page when both thresholds are loose enough to absorb the sweep", async () => {
    // Re-seed again: the previous test's apply step left our link
    // inactive. Flip it back so this assertion covers both "alert below
    // count threshold" AND "alert below percent threshold" in one go.
    await db
      .update(adviserClients)
      .set({ isActive: true, unlinkedAt: null })
      .where(eq(adviserClients.id, ids.fixtureOnRealLinkId));

    const calls: OperatorAlert[] = [];
    const stubNotify = async (
      alert: OperatorAlert,
    ): Promise<OperatorAlertResult> => {
      calls.push(alert);
      return {
        channelsAttempted: ["log"],
        outcomes: [{ channel: "log", status: "success", durationMs: 0 }],
        channels: ["log"],
        alertId: 1,
        deliveryStatus: "delivered",
        occurrences: 1,
        dedupeKey: "stub",
      };
    };

    const summary = await deactivateFixtureAdviserClientLinks({
      dryRun: false,
      trigger: "test:task-400-quiet",
      // 1_000_000 absolute + 100% relative = guaranteed quiet.
      alertThresholds: { minCount: 1_000_000, minPercent: 100 },
      notifyOperator: stubNotify,
    });

    expect(summary.burstAlert.shouldAlert).toBe(false);
    expect(summary.burstAlertDispatched).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("deactivateFixtureAdviserClientLinks records the would-fire decision in dry-run without paging", async () => {
    // Same re-seed dance.
    await db
      .update(adviserClients)
      .set({ isActive: true, unlinkedAt: null })
      .where(eq(adviserClients.id, ids.fixtureOnRealLinkId));

    const calls: OperatorAlert[] = [];
    const stubNotify = async (
      alert: OperatorAlert,
    ): Promise<OperatorAlertResult> => {
      calls.push(alert);
      return {
        channelsAttempted: ["log"],
        outcomes: [{ channel: "log", status: "success", durationMs: 0 }],
        channels: ["log"],
        alertId: 1,
        deliveryStatus: "delivered",
        occurrences: 1,
        dedupeKey: "stub",
      };
    };

    const summary = await deactivateFixtureAdviserClientLinks({
      dryRun: true,
      trigger: "test:task-400-dryrun",
      alertThresholds: { minCount: 1, minPercent: 100 },
      notifyOperator: stubNotify,
    });

    expect(summary.dryRun).toBe(true);
    expect(summary.deactivated).toBe(0);
    // Pre-sweep decision was based on offending count, which IS >= 1.
    expect(summary.burstAlert.shouldAlert).toBe(true);
    // But we're in dry-run, so the dispatcher must NOT have been called.
    expect(summary.burstAlertDispatched).toBe(false);
    expect(calls.length).toBe(0);
    expect(formatDeactivateSummary(summary)).toContain(
      "BURST_ALERT_WOULD_FIRE",
    );
  });
});
