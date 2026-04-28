// =============================================================================
// Task #315 — automated tests for reports lifecycle hardening
// =============================================================================
// Locks in the behaviour of:
//   1. runReportJobSweeper() — flips an 11-minute-old `requested` row to
//      `failed` with failureReason='sweeper_timeout' and writes the
//      `report.sweeper_timeout` audit row, while leaving fresh rows alone.
//   2. regenerateReport() — inserts a new row pointing back at the original
//      via supersedesReportId and increments versionNumber. Re-regenerating
//      from the original id still walks the chain to v3.
//   3. createReportRequest duplicate guard — a second request for the same
//      (clientUserId, reportType) within 30 minutes throws a 409 carrying
//      a structured `body.code = 'duplicate_report_request'` envelope.
//   4. findDuplicateRecentReport — outside the 30-minute window the guard
//      returns null (so a daily request cadence is fine).
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  adviserClients,
  auditLogs,
  reportRequests,
  users,
} from "@shared/schema";
import {
  DUPLICATE_GUARD_WINDOW_MS,
  findDuplicateRecentReport,
  notifyAdviserReportFailed,
  notifyAdviserReportReady,
  regenerateReport,
  runReportExpiringSoonReminder,
  runReportJobSweeper,
  STALE_REPORT_JOB_FAILURE_REASON,
  STALE_REPORT_JOB_TIMEOUT_MS,
  SWEEPER_STUCK_AFTER_MS,
  sweepStaleReportJobs,
} from "./reports";
import { createReportRequest } from "./adviser-access";

const ADVISER_USERNAME = "__reports_test_adviser__";
const CLIENT_USERNAME = "__reports_test_client__";

let adviserUserId: number;
let clientUserId: number;

async function ensureUser(
  username: string,
  email: string,
  role: "client" | "adviser",
): Promise<number> {
  const [existing] = await db.select().from(users).where(eq(users.username, username));
  if (existing) {
    await db
      .update(users)
      .set({ email, firstName: "Reports", lastName: "Test", role })
      .where(eq(users.id, existing.id));
    return existing.id;
  }
  const [created] = await db
    .insert(users)
    .values({
      username,
      email,
      password: "not-a-real-password",
      firstName: "Reports",
      lastName: "Test",
      kycStatus: "verified",
      emailVerified: true,
      role,
    })
    .returning();
  return created.id;
}

async function clearReportRows(): Promise<void> {
  if (adviserUserId !== undefined) {
    // audit_logs is immutable (DELETE blocked at the DB level), so we leave
    // its rows alone. Each new reportRequests insert produces a fresh
    // serial id, so the sweeper-audit assertion below scopes its lookup
    // to that specific id and never collides with prior runs.
    await db
      .delete(reportRequests)
      .where(eq(reportRequests.adviserUserId, adviserUserId));
  }
}

beforeAll(async () => {
  adviserUserId = await ensureUser(
    ADVISER_USERNAME,
    "reports-test-adviser@example.com",
    "adviser",
  );
  clientUserId = await ensureUser(
    CLIENT_USERNAME,
    "reports-test-client@example.com",
    "client",
  );
  // Idempotent active link — required by createReportRequest.
  const [existingLink] = await db
    .select()
    .from(adviserClients)
    .where(
      and(
        eq(adviserClients.adviserUserId, adviserUserId),
        eq(adviserClients.clientUserId, clientUserId),
      ),
    );
  if (!existingLink) {
    await db.insert(adviserClients).values({
      adviserUserId,
      clientUserId,
      isActive: true,
    });
  } else if (!existingLink.isActive) {
    await db
      .update(adviserClients)
      .set({ isActive: true })
      .where(eq(adviserClients.id, existingLink.id));
  }
  await clearReportRows();
});

afterAll(async () => {
  await clearReportRows();
  await db
    .delete(adviserClients)
    .where(
      and(
        eq(adviserClients.adviserUserId, adviserUserId),
        eq(adviserClients.clientUserId, clientUserId),
      ),
    );
  await db.delete(users).where(inArray(users.id, [adviserUserId, clientUserId]));
});

describe("runReportJobSweeper", () => {
  it("flips a row stuck in 'requested' for >10 minutes to 'failed' with sweeper_timeout reason and writes audit", async () => {
    await clearReportRows();
    const now = new Date();
    const eleven = new Date(now.getTime() - 11 * 60 * 1000);
    const five = new Date(now.getTime() - 5 * 60 * 1000);

    // Insert two rows: one stuck (11m old), one fresh (5m old).
    const [stuckRow] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "requested",
        requestedAt: eleven,
      })
      .returning();
    const [freshRow] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "fee_summary",
        format: "pdf",
        status: "generating",
        requestedAt: five,
      })
      .returning();

    const summary = await runReportJobSweeper({ now });

    expect(summary.scanned).toBeGreaterThanOrEqual(1);
    expect(summary.flippedIds).toContain(stuckRow.id);
    expect(summary.flippedIds).not.toContain(freshRow.id);

    const [stuckAfter] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, stuckRow.id));
    expect(stuckAfter.status).toBe("failed");
    expect(stuckAfter.failureReason).toBe("sweeper_timeout");

    const [freshAfter] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, freshRow.id));
    expect(freshAfter.status).toBe("generating");
    expect(freshAfter.failureReason).toBeNull();

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "report.sweeper_timeout"),
          eq(auditLogs.entityType, "report_request"),
          eq(auditLogs.entityId, String(stuckRow.id)),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(audit).toBeDefined();
    expect(audit.userId).toBeNull();
    const meta = audit.metadata as any;
    expect(meta.previousStatus).toBe("requested");
    expect(meta.stuckAfterMsConfig).toBe(SWEEPER_STUCK_AFTER_MS);
  });

  it("returns scanned=0 when no rows are stuck", async () => {
    await clearReportRows();
    const summary = await runReportJobSweeper();
    expect(summary.flipped).toBe(0);
  });
});

// ===========================================================================
// Task #298 — sweepStaleReportJobs (per-adviser scoped on-demand sweep).
// ---------------------------------------------------------------------------
// Locks the contract for the per-adviser scoped helper invoked by the
// reports list endpoint (server/adviser-routes.ts) before it returns rows.
// The cron-based runReportJobSweeper above is global; this one is the
// "render-time safety net" path and uses a different failure reason
// (STALE_REPORT_JOB_FAILURE_REASON) so the two surfaces are
// distinguishable in the audit trail.
// ===========================================================================
describe("sweepStaleReportJobs", () => {
  it("flips a 'requested' row older than the timeout to 'failed' with the documented reason", async () => {
    await clearReportRows();
    const stuckRequestedAt = new Date(
      Date.now() - STALE_REPORT_JOB_TIMEOUT_MS - 60_000,
    );
    const [stuck] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "requested",
        requestedAt: stuckRequestedAt,
      })
      .returning();

    const flipped = await sweepStaleReportJobs(adviserUserId);
    expect(flipped).toBeGreaterThanOrEqual(1);

    const [after] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, stuck.id));
    expect(after.status).toBe("failed");
    expect(after.failureReason).toBe(STALE_REPORT_JOB_FAILURE_REASON);
  });

  it("also flips a 'generating' row older than the timeout", async () => {
    await clearReportRows();
    const stuckRequestedAt = new Date(
      Date.now() - STALE_REPORT_JOB_TIMEOUT_MS - 60_000,
    );
    const [stuck] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "fee_summary",
        format: "pdf",
        status: "generating",
        requestedAt: stuckRequestedAt,
      })
      .returning();

    await sweepStaleReportJobs(adviserUserId);

    const [after] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, stuck.id));
    expect(after.status).toBe("failed");
    expect(after.failureReason).toBe(STALE_REPORT_JOB_FAILURE_REASON);
  });

  it("leaves rows inside the timeout window untouched", async () => {
    await clearReportRows();
    // Half the timeout — well within the safe window.
    const freshRequestedAt = new Date(
      Date.now() - Math.floor(STALE_REPORT_JOB_TIMEOUT_MS / 2),
    );
    const [fresh] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "transaction_history",
        format: "pdf",
        status: "requested",
        requestedAt: freshRequestedAt,
      })
      .returning();

    const flipped = await sweepStaleReportJobs(adviserUserId);
    expect(flipped).toBe(0);

    const [after] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, fresh.id));
    expect(after.status).toBe("requested");
    expect(after.failureReason).toBeNull();
  });

  it("never touches terminal rows (ready, failed, expired) even if old", async () => {
    await clearReportRows();
    const ancient = new Date(Date.now() - 10 * STALE_REPORT_JOB_TIMEOUT_MS);

    const [readyRow] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "ready",
        requestedAt: ancient,
        downloadUrl: "/api/adviser/reports/0/download",
      })
      .returning();
    const [failedRow] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "fee_summary",
        format: "pdf",
        status: "failed",
        failureReason: "prior reason",
        requestedAt: ancient,
      })
      .returning();
    const [expiredRow] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "transaction_history",
        format: "pdf",
        status: "expired",
        requestedAt: ancient,
      })
      .returning();

    const flipped = await sweepStaleReportJobs(adviserUserId);
    expect(flipped).toBe(0);

    const [readyAfter] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, readyRow.id));
    expect(readyAfter.status).toBe("ready");
    // Documented reason must NOT have been overwritten on a terminal row.
    expect(readyAfter.failureReason).toBeNull();

    const [failedAfter] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, failedRow.id));
    expect(failedAfter.status).toBe("failed");
    // The original failureReason is preserved — the sweep did not rewrite it.
    expect(failedAfter.failureReason).toBe("prior reason");

    const [expiredAfter] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, expiredRow.id));
    expect(expiredAfter.status).toBe("expired");
  });

  it("is scoped to the calling adviser — does not flip another adviser's stuck rows", async () => {
    await clearReportRows();
    const stuckRequestedAt = new Date(
      Date.now() - STALE_REPORT_JOB_TIMEOUT_MS - 60_000,
    );
    // Use a stable username + onConflictDoUpdate so re-runs of this file
    // don't accumulate adviser rows. We deliberately do NOT delete this
    // user in cleanup: other tables in the dev DB carry FKs back to
    // users(id) (e.g. portfolio_snapshots) that make a teardown DELETE
    // fragile across schema evolutions. The report row is cleaned by
    // the explicit delete below; the adviser row is harmless to leave.
    const [otherAdviser] = await db
      .insert(users)
      .values({
        username: `__reports_test_other_adviser__`,
        email: "reports-test-other-adviser@example.com",
        password: "not-a-real-password",
        firstName: "Other",
        lastName: "Adviser",
        role: "adviser",
      })
      .onConflictDoUpdate({
        target: users.username,
        set: { role: "adviser" },
      })
      .returning();

    const [otherStuck] = await db
      .insert(reportRequests)
      .values({
        adviserUserId: otherAdviser.id,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "requested",
        requestedAt: stuckRequestedAt,
      })
      .returning();

    const flipped = await sweepStaleReportJobs(adviserUserId);
    expect(flipped).toBe(0);

    const [otherAfter] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, otherStuck.id));
    expect(otherAfter.status).toBe("requested");

    // Cleanup just the report row owned by the other adviser — the user
    // row is intentionally left in place (see comment above on FKs).
    await db.delete(reportRequests).where(eq(reportRequests.id, otherStuck.id));
  });
});

describe("regenerateReport (versioning chain)", () => {
  it("inserts v2 with supersedesReportId pointing at v1", async () => {
    await clearReportRows();
    const [v1] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "transaction_history",
        format: "pdf",
        status: "ready",
      })
      .returning();
    expect(v1.versionNumber).toBe(1);
    expect(v1.supersedesReportId).toBeNull();

    const v2 = await regenerateReport(adviserUserId, v1.id);
    expect(v2.versionNumber).toBe(2);
    expect(v2.supersedesReportId).toBe(v1.id);
    expect(v2.adviserUserId).toBe(adviserUserId);
    expect(v2.clientUserId).toBe(clientUserId);
    expect(v2.reportType).toBe("transaction_history");
    // The new row is in the initial 'requested' state — the cron / route
    // wrapper is responsible for actually generating the PDF.
    expect(v2.status).toBe("requested");
  });

  it("regenerating from the ORIGINAL id again walks the chain head and produces v3", async () => {
    await clearReportRows();
    const [v1] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "full_statement",
        format: "pdf",
        status: "failed",
        failureReason: "test",
      })
      .returning();
    const v2 = await regenerateReport(adviserUserId, v1.id);
    // Pass v1.id again — the service must walk forward to v2 and produce v3.
    const v3 = await regenerateReport(adviserUserId, v1.id);
    expect(v2.versionNumber).toBe(2);
    expect(v3.versionNumber).toBe(3);
    expect(v3.supersedesReportId).toBe(v2.id);
  });

  it("rejects regenerate when the caller does not own the original", async () => {
    await clearReportRows();
    const [v1] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "ready",
      })
      .returning();
    await expect(regenerateReport(adviserUserId + 99999, v1.id)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("createReportRequest duplicate guard", () => {
  it("rejects a second request for the same (client, type) within 30 minutes with a 409", async () => {
    await clearReportRows();
    const first = await createReportRequest(adviserUserId, {
      clientUserId,
      reportType: "portfolio_summary",
      format: "pdf",
    });
    expect(first.id).toBeGreaterThan(0);

    let captured: any = null;
    try {
      await createReportRequest(adviserUserId, {
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeTruthy();
    expect(captured.status).toBe(409);
    expect(captured.body?.code).toBe("duplicate_report_request");
    expect(captured.body?.existingReportId).toBe(first.id);
  });

  it("does NOT block when the report type differs", async () => {
    await clearReportRows();
    await createReportRequest(adviserUserId, {
      clientUserId,
      reportType: "portfolio_summary",
      format: "pdf",
    });
    const second = await createReportRequest(adviserUserId, {
      clientUserId,
      reportType: "fee_summary",
      format: "pdf",
    });
    expect(second.id).toBeGreaterThan(0);
    expect(second.reportType).toBe("fee_summary");
  });

  it("does NOT block once the guard window has passed", async () => {
    await clearReportRows();
    // Insert a synthetic "old" row directly so we can place its requestedAt
    // outside the guard window without time travel.
    const oldRequestedAt = new Date(Date.now() - DUPLICATE_GUARD_WINDOW_MS - 60 * 1000);
    await db.insert(reportRequests).values({
      adviserUserId,
      clientUserId,
      reportType: "portfolio_summary",
      format: "pdf",
      status: "ready",
      requestedAt: oldRequestedAt,
    });

    const fresh = await createReportRequest(adviserUserId, {
      clientUserId,
      reportType: "portfolio_summary",
      format: "pdf",
    });
    expect(fresh.id).toBeGreaterThan(0);
  });
});

describe("findDuplicateRecentReport (boundary check)", () => {
  it("returns null when no row exists for that combination at all", async () => {
    await clearReportRows();
    const r = await findDuplicateRecentReport({
      adviserUserId,
      clientUserId,
      reportType: "fee_summary",
    });
    expect(r).toBeNull();
  });
});

// ===========================================================================
// Task #344 — Adviser report notifications
//
// The test environment has SMTP unconfigured, so the email helpers return
// `{ sent: false, error: 'SMTP not configured ...' }`. These tests assert
// the *bookkeeping* contract that holds regardless of SMTP outcome:
//   - the corresponding `*NotifiedAt` column is stamped, even on SMTP miss,
//     so a transient failure can't turn into a re-page loop on every cron tick
//   - re-running the notifier is a no-op (idempotency)
//   - the expiring-soon cron's row selection only catches still-undownloaded
//     `ready` rows whose expiresAt is inside the next 24h
// ===========================================================================
describe("notifyAdviserReportReady", () => {
  it("stamps readyNotifiedAt the first time and is a no-op the second time", async () => {
    await clearReportRows();
    const [row] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "ready",
        downloadUrl: "/api/adviser/reports/0/download",
        generatedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      })
      .returning();

    const first = await notifyAdviserReportReady(row.id);
    expect(first.attempted).toBe(true);

    const [after1] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, row.id));
    expect(after1.readyNotifiedAt).not.toBeNull();
    const stampedAt = after1.readyNotifiedAt as Date;

    const second = await notifyAdviserReportReady(row.id);
    expect(second.attempted).toBe(false);
    expect(second.error).toBe("already notified");

    const [after2] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, row.id));
    expect((after2.readyNotifiedAt as Date).getTime()).toBe(stampedAt.getTime());
  });

  it("refuses to notify when the row is not in ready status", async () => {
    await clearReportRows();
    const [row] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "fee_summary",
        format: "pdf",
        status: "requested",
      })
      .returning();
    const r = await notifyAdviserReportReady(row.id);
    expect(r.attempted).toBe(false);
    expect(r.error).toContain("status=");
    const [after] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, row.id));
    expect(after.readyNotifiedAt).toBeNull();
  });
});

describe("notifyAdviserReportFailed", () => {
  it("stamps failedNotifiedAt and is idempotent", async () => {
    await clearReportRows();
    const [row] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "failed",
        failureReason: "sweeper_timeout",
      })
      .returning();

    const first = await notifyAdviserReportFailed(row.id);
    expect(first.attempted).toBe(true);

    const [after1] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, row.id));
    expect(after1.failedNotifiedAt).not.toBeNull();

    const second = await notifyAdviserReportFailed(row.id);
    expect(second.attempted).toBe(false);
    expect(second.error).toBe("already notified");
  });
});

describe("runReportExpiringSoonReminder", () => {
  it("only notifies undownloaded ready rows whose expiresAt lands inside the 24h window", async () => {
    await clearReportRows();
    const now = new Date();
    const inside = new Date(now.getTime() + 6 * 60 * 60 * 1000); // +6h: due
    const outside = new Date(now.getTime() + 48 * 60 * 60 * 1000); // +48h: too far away
    const past = new Date(now.getTime() - 60 * 1000); // already expired
    const generatedAt = new Date(now.getTime() - 60_000);

    // Row #1 — eligible (ready, undownloaded, within 24h)
    const [eligible] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "ready",
        downloadUrl: "/api/adviser/reports/0/download",
        generatedAt,
        expiresAt: inside,
      })
      .returning();

    // Row #2 — already downloaded, must be skipped
    const [downloaded] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "fee_summary",
        format: "pdf",
        status: "ready",
        downloadUrl: "/api/adviser/reports/0/download",
        generatedAt,
        expiresAt: inside,
        firstDownloadedAt: now,
      })
      .returning();

    // Row #3 — outside 24h window, must be skipped
    const [farAway] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "annual_statement",
        format: "pdf",
        status: "ready",
        downloadUrl: "/api/adviser/reports/0/download",
        generatedAt,
        expiresAt: outside,
      })
      .returning();

    // Row #4 — already expired, must be skipped
    const [expiredRow] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "kyc_summary",
        format: "pdf",
        status: "ready",
        downloadUrl: "/api/adviser/reports/0/download",
        generatedAt,
        expiresAt: past,
      })
      .returning();

    // Row #5 — already received the reminder, must be skipped
    const [alreadyNotified] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "tax_summary",
        format: "pdf",
        status: "ready",
        downloadUrl: "/api/adviser/reports/0/download",
        generatedAt,
        expiresAt: inside,
        expiringSoonNotifiedAt: now,
      })
      .returning();

    const r = await runReportExpiringSoonReminder({ now });
    expect(r.notifiedIds).toContain(eligible.id);
    expect(r.notifiedIds).not.toContain(downloaded.id);
    expect(r.notifiedIds).not.toContain(farAway.id);
    expect(r.notifiedIds).not.toContain(expiredRow.id);
    expect(r.notifiedIds).not.toContain(alreadyNotified.id);

    const [stamped] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, eligible.id));
    expect(stamped.expiringSoonNotifiedAt).not.toBeNull();

    // Re-running is a zero-row no-op for the already-notified row.
    const second = await runReportExpiringSoonReminder({ now });
    expect(second.notifiedIds).not.toContain(eligible.id);
  });
});
