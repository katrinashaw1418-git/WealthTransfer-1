// =============================================================================
// Task #334 — route-level coverage for the adviser report download endpoint's
// two expiry envelopes.
// =============================================================================
// The Task #315 service-layer suite (server/services/reports.test.ts) covers
// the sweeper, regenerate chain, duplicate-guard, and findDuplicateRecentReport
// boundary check, but the actual GET /api/adviser/reports/:id/download
// behaviour is currently only verified by manual reasoning. The download
// endpoint emits TWO distinct 410 envelopes that the adviser UI relies on:
//
//   1. `code: 'link_expired'`  — the 7-day downloadLinkExpiresAt cutoff has
//      passed. Side effect: the row is flipped to status='expired_link' so
//      a follow-up Regenerate (which walks the version chain and emits v2)
//      can recover from it.
//
//   2. `code: 'report_expired'` — the 30-day data-validity expiresAt has
//      passed. Side effect: the row is flipped to status='expired'. This
//      is the *older* legacy envelope; the link-expired check fires first
//      in the route, so any test of the data-expiry path must leave
//      downloadLinkExpiresAt unset (or in the future) to reach it.
//
// Both side effects matter: the UI distinguishes "regenerate now" (link
// expired, recoverable) from "request a fresh report" (data expired). A
// future refactor of the download endpoint that quietly drops one of the
// envelopes — or stops flipping the row — would break the UI without any
// test signalling the regression. This file pins both contracts via
// supertest against an in-process express app wired up by registerRoutes.
//
// Implementation notes:
//   * Auth: signed JWT with role='adviser' from server/auth.signToken, set
//     via Authorization: Bearer header. JWT_SECRET is hoisted into the
//     environment before any module that reads it loads.
//   * Live entitlement: assertAdviserClientLink demands an ACTIVE
//     adviser_clients row at download time, even for a report this adviser
//     owns. We seed one in beforeAll and tear it down in afterAll.
//   * The 410 paths short-circuit before the disk read, so we do not need
//     a real PDF on disk or any watermark fixtures — the route returns
//     the structured envelope before reaching the filesystem.
//   * Cleanup: report_requests rows are scoped to the test adviser id and
//     deleted between cases; the adviser_clients link and the seeded users
//     are left until afterAll. Like the parity test, we leave the user
//     rows in place to avoid the FK-vs-DELETE problem from leftover
//     audit_logs (audit_logs is immutable at the DB level).
// =============================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// JWT_SECRET must be set BEFORE any transitive import of server/auth.ts.
// vi.hoisted runs before ESM-hoisted imports below.
vi.hoisted(() => {
  process.env.JWT_SECRET ||= "task-334-report-download-expiry-test-secret";
});

import express from "express";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Server } from "http";

import { db } from "./db";
import {
  adviserClients,
  reportRequests,
  users,
} from "@shared/schema";
import { signToken } from "./auth";
import { registerRoutes } from "./routes";

let testApp: express.Express;
let httpServer: Server;
let adviserUserId: number;
let clientUserId: number;
let adviserToken: string;
let seedKey: string;

beforeAll(async () => {
  seedKey = `t334_${randomBytes(4).toString("hex")}`;

  const [adviser] = await db
    .insert(users)
    .values({
      username: `${seedKey}_adviser`,
      email: `${seedKey}-adviser@test.invalid`,
      password: "not-a-real-password",
      firstName: "Download",
      lastName: "Adviser",
      role: "adviser",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  adviserUserId = adviser.id;

  const [client] = await db
    .insert(users)
    .values({
      username: `${seedKey}_client`,
      email: `${seedKey}-client@test.invalid`,
      password: "not-a-real-password",
      firstName: "Download",
      lastName: "Client",
      role: "client",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  clientUserId = client.id;

  await db.insert(adviserClients).values({
    adviserUserId,
    clientUserId,
    isActive: true,
  });

  adviserToken = signToken({
    userId: adviserUserId,
    username: adviser.username,
    email: adviser.email,
    role: "adviser",
  });

  testApp = express();
  testApp.use(express.json());
  httpServer = await registerRoutes(testApp);
}, 60_000);

afterAll(async () => {
  if (adviserUserId !== undefined) {
    await db
      .delete(reportRequests)
      .where(eq(reportRequests.adviserUserId, adviserUserId));
    await db
      .delete(adviserClients)
      .where(
        and(
          eq(adviserClients.adviserUserId, adviserUserId),
          eq(adviserClients.clientUserId, clientUserId),
        ),
      );
    // Best-effort user cleanup. If audit_logs (immutable) or other FK
    // referrers hold these ids, the delete will throw and we swallow it
    // — the seedKey-scoped usernames keep future runs collision-free.
    try {
      await db
        .delete(users)
        .where(inArray(users.id, [adviserUserId, clientUserId]));
    } catch {
      // intentional: leftover FK referrers are fine, seedKey isolates us.
    }
  }
  if (httpServer && typeof httpServer.close === "function") {
    httpServer.close();
  }
});

beforeEach(async () => {
  // Each case seeds its own report_requests row; clear any prior runs so
  // the `expired_link` / `expired` flip assertions cannot read a stale
  // row from a previous test.
  await db
    .delete(reportRequests)
    .where(eq(reportRequests.adviserUserId, adviserUserId));
});

describe("GET /api/adviser/reports/:id/download — expiry envelopes (Task #334)", () => {
  it("returns 410 with code='link_expired' and flips the row to status='expired_link' when downloadLinkExpiresAt is in the past", async () => {
    // 7-day download-link cutoff in the past. The 30-day data-validity
    // expiresAt is left in the future so the route definitely takes the
    // link-expired branch (which is checked FIRST) rather than the
    // data-expired branch.
    const past = new Date(Date.now() - 60 * 1000);
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const [row] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "ready",
        downloadUrl: "/api/adviser/reports/0/download",
        generatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        expiresAt: future,
        downloadLinkExpiresAt: past,
      })
      .returning();

    const res = await request(testApp)
      .get(`/api/adviser/reports/${row.id}/download`)
      .set("Authorization", `Bearer ${adviserToken}`);

    expect(res.status).toBe(410);
    expect(res.body.code).toBe("link_expired");
    expect(res.body.reportId).toBe(row.id);
    expect(typeof res.body.error).toBe("string");

    const [after] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, row.id));
    expect(after.status).toBe("expired_link");
  });

  it("returns 410 with code='report_expired' and flips the row to status='expired' when expiresAt is in the past (and the link is still valid)", async () => {
    // 30-day data-validity cutoff in the past. The 7-day link cutoff is
    // left in the future so the route falls through the link-expired
    // branch into the data-expired branch — this is the only way to
    // reach the `report_expired` envelope, since link-expired is
    // checked first.
    const past = new Date(Date.now() - 60 * 1000);
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const [row] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "fee_summary",
        format: "pdf",
        status: "ready",
        downloadUrl: "/api/adviser/reports/0/download",
        generatedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        expiresAt: past,
        downloadLinkExpiresAt: future,
      })
      .returning();

    const res = await request(testApp)
      .get(`/api/adviser/reports/${row.id}/download`)
      .set("Authorization", `Bearer ${adviserToken}`);

    expect(res.status).toBe(410);
    expect(res.body.code).toBe("report_expired");
    expect(res.body.reportId).toBe(row.id);
    expect(typeof res.body.error).toBe("string");

    const [after] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, row.id));
    expect(after.status).toBe("expired");
  });
});
