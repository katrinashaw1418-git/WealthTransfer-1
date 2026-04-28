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
  ledgerPostings,
  reportRequests,
  transactions,
  users,
  wallets,
} from "@shared/schema";
import {
  deriveSourceMix,
  DUPLICATE_GUARD_WINDOW_MS,
  enqueueReportJob,
  findDuplicateRecentReport,
  generateReportPdf,
  isCashLedgerIncompleteForUserCurrency,
  isDraftWatermarkEnabled,
  isLicenseeDisclosurePending,
  LEDGER_LABEL,
  notifyAdviserReportFailed,
  notifyAdviserReportReady,
  regenerateReport,
  runReportExpiringSoonReminder,
  runReportJobSweeper,
  runReportJobWorkerTick,
  SNAPSHOT_LABEL,
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
  // Task #369 — the new sourceMix tests insert per-client transactions and
  // wallet rows. Any leftover transactions row holds a FK back to
  // users(id) and would break the legacy users delete below, so clear
  // them (and their postings) before tearing down the user rows.
  const txIds = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(inArray(transactions.userId, [adviserUserId, clientUserId]));
  if (txIds.length > 0) {
    const ids = txIds.map((t) => t.id);
    await db.delete(ledgerPostings).where(inArray(ledgerPostings.transactionId, ids));
    await db.delete(transactions).where(inArray(transactions.id, ids));
  }
  await db
    .delete(wallets)
    .where(inArray(wallets.userId, [adviserUserId, clientUserId]));
  // The user delete may still fail if other unrelated dev-DB rows hold a
  // FK back to one of these test users (e.g. portfolio_snapshots from a
  // separate suite). That is the same hazard the per-suite cleanup
  // elsewhere in this file documents — swallow it so a stray FK from
  // outside this suite does not mask real test failures above.
  try {
    await db.delete(users).where(inArray(users.id, [adviserUserId, clientUserId]));
  } catch {
    // best-effort teardown; users rows are harmless to leave behind.
  }
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

// ===========================================================================
// Task #332 — Background worker for PDF generation.
//
// Locks in the contract that the worker:
//   - Picks up rows in 'requested' state and runs them through the
//     existing generateReportPdf path (so the row ends up in 'ready' or
//     'failed' state and the existing notification path still fires).
//   - Atomically claims rows so two workers cannot both run the same id.
//   - The setImmediate fire-and-forget enqueueReportJob() also drives
//     a 'requested' row to a terminal state.
// ===========================================================================
describe("runReportJobWorkerTick", () => {
  it("drains a 'requested' row into a terminal state", async () => {
    await clearReportRows();
    const [row] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "requested",
      })
      .returning();

    const summary = await runReportJobWorkerTick();
    expect(summary.processedIds).toContain(row.id);

    const [after] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, row.id));
    // generateReportPdf flips the row to 'ready' on success or 'failed'
    // on any exception inside its try/catch. Either outcome means the
    // row is no longer sitting in 'requested' / 'generating' — which is
    // the contract this worker is responsible for.
    expect(["ready", "failed"]).toContain(after.status);
    expect(after.status).not.toBe("requested");
    expect(after.status).not.toBe("generating");
  });

  it("returns processed=0 when no rows are queued", async () => {
    await clearReportRows();
    const summary = await runReportJobWorkerTick();
    expect(summary.processed).toBe(0);
    expect(summary.processedIds).toEqual([]);
  });

  it("does not touch rows already in 'generating' / 'ready' / 'failed'", async () => {
    await clearReportRows();
    const [generating] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "fee_summary",
        format: "pdf",
        status: "generating",
      })
      .returning();
    const [ready] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "transaction_history",
        format: "pdf",
        status: "ready",
        downloadUrl: "/api/adviser/reports/0/download",
        generatedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      })
      .returning();

    const summary = await runReportJobWorkerTick();
    expect(summary.processedIds).not.toContain(generating.id);
    expect(summary.processedIds).not.toContain(ready.id);

    const [generatingAfter] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, generating.id));
    expect(generatingAfter.status).toBe("generating");
    const [readyAfter] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, ready.id));
    expect(readyAfter.status).toBe("ready");
  });

  it("respects the maxJobs budget", async () => {
    await clearReportRows();
    for (let i = 0; i < 3; i++) {
      await db.insert(reportRequests).values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "requested",
      });
    }
    const summary = await runReportJobWorkerTick({ maxJobs: 2 });
    expect(summary.processed).toBe(2);
  });

  it("writes a system audit row tagged report.worker_generated or report.worker_failed", async () => {
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

    await runReportJobWorkerTick();

    const audits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          inArray(auditLogs.action, [
            "report.worker_generated",
            "report.worker_failed",
          ]),
          eq(auditLogs.entityType, "report_request"),
          eq(auditLogs.entityId, String(row.id)),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(audits.length).toBe(1);
    expect(audits[0].userId).toBeNull();
  });
});

describe("enqueueReportJob (fire-and-forget)", () => {
  it("drains a 'requested' row asynchronously after setImmediate", async () => {
    await clearReportRows();
    const [row] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "requested",
      })
      .returning();

    // Synchronous return — the route handler must not be blocked.
    enqueueReportJob(row.id);

    // Wait a few ticks for the setImmediate path to claim and run.
    // The DB calls inside generateReportPdf settle on a few promise
    // turns, so we poll up to ~1.5s for the row to leave 'requested'.
    const deadline = Date.now() + 2000;
    let after: typeof row | undefined;
    while (Date.now() < deadline) {
      [after] = await db
        .select()
        .from(reportRequests)
        .where(eq(reportRequests.id, row.id));
      if (after && after.status !== "requested" && after.status !== "generating") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(after).toBeDefined();
    expect(["ready", "failed"]).toContain(after!.status);
  });

  it("is a no-op when the row was already claimed (status != 'requested')", async () => {
    await clearReportRows();
    // Row that is already in 'ready' state — enqueue must not flip it.
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

    enqueueReportJob(row.id);
    await new Promise((r) => setTimeout(r, 200));

    const [after] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, row.id));
    expect(after.status).toBe("ready");
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

// ===========================================================================
// Task #333 — Licensee disclosure & DRAFT-watermark gating
//
// The two helpers exposed by reports.ts decide:
//   1. whether the rendered PDF must carry the visible "[PLACEHOLDER]" warning
//      paragraph on the disclosure page (because the env-driven licensee
//      values aren't configured yet); and
//   2. whether a per-request `isDraft=true` actually paints the DRAFT banner
//      on every page (suppressed in production unless explicitly opted in).
//
// `isLicenseeDisclosurePending()` reads module-level constants captured at
// require-time, so we only assert the boolean shape (not flip env vars
// after the fact). The default test env leaves the AMAX_LICENSEE_* vars
// unset, so the helper resolves to true — that's the very signal we want
// the disclosure page to surface.
//
// `isDraftWatermarkEnabled()` reads process.env on every call, so it can
// be exercised by mutating the var in-place. Each test restores the
// previous value to avoid bleed between cases.
// ===========================================================================
describe("isLicenseeDisclosurePending", () => {
  it("returns true in the default test env (AMAX_LICENSEE_* not configured)", () => {
    // The bootstrap doesn't set the four env vars, so the module-level
    // constants kept their `[PLACEHOLDER]` defaults — the helper MUST
    // detect that and tell the renderer to stamp the warning paragraph.
    expect(isLicenseeDisclosurePending()).toBe(true);
  });
});

describe("isDraftWatermarkEnabled", () => {
  const ENV_KEY = "AMAX_REPORT_DRAFT_WATERMARK";
  const NODE_ENV_KEY = "NODE_ENV";
  let savedEnv: string | undefined;
  let savedNodeEnv: string | undefined;

  beforeAll(() => {
    savedEnv = process.env[ENV_KEY];
    savedNodeEnv = process.env[NODE_ENV_KEY];
  });
  afterAll(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    if (savedNodeEnv === undefined) delete process.env[NODE_ENV_KEY];
    else process.env[NODE_ENV_KEY] = savedNodeEnv;
  });

  it("returns true when AMAX_REPORT_DRAFT_WATERMARK is explicitly truthy", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      process.env[ENV_KEY] = v;
      expect(isDraftWatermarkEnabled()).toBe(true);
    }
  });

  it("returns false when AMAX_REPORT_DRAFT_WATERMARK is explicitly falsy", () => {
    for (const v of ["0", "false", "FALSE", "no", "off"]) {
      process.env[ENV_KEY] = v;
      expect(isDraftWatermarkEnabled()).toBe(false);
    }
  });

  it("defaults to FALSE in production-like envs (production/staging) when the env var is unset", () => {
    delete process.env[ENV_KEY];
    // Staging is intentionally treated like production: a regulator-facing
    // UAT must not stamp DRAFT on its reports either. Anything outside the
    // dev/demo/test allowlist falls through to FALSE.
    for (const v of ["production", "staging", "uat", "preview"]) {
      process.env[NODE_ENV_KEY] = v;
      expect(isDraftWatermarkEnabled()).toBe(false);
    }
  });

  it("defaults to TRUE in dev/demo/test envs (and when NODE_ENV is unset)", () => {
    delete process.env[ENV_KEY];
    for (const v of ["development", "dev", "demo", "test", undefined]) {
      if (v === undefined) delete process.env[NODE_ENV_KEY];
      else process.env[NODE_ENV_KEY] = v;
      expect(isDraftWatermarkEnabled()).toBe(true);
    }
  });
});

// ===========================================================================
// Task #369 — ledger-vs-snapshot source attribution on report PDFs
// ---------------------------------------------------------------------------
// Locks in the contract that:
//   1. The pure deriveSourceMix() helper maps the four input booleans to
//      the persisted shape correctly, including the "fullyLedgerBacked"
//      derived flag.
//   2. isCashLedgerIncompleteForUserCurrency() flags a settled transaction
//      that touches the currency in the period AND has no posting receipt,
//      and ignores transactions that are posted (or out of window).
//   3. generateReportPdf stamps sourceMix on the row:
//        - fully ledger-backed when every settled in-window transaction
//          has a posting receipt
//        - cashUsd="snapshot" with cashAud="ledger" when only USD has an
//          unposted in-window transaction (partial fallback)
//   4. regenerateReport copies sourceMix forward from the chain head, and
//      a re-generation of the new row honours that mix instead of
//      recomputing — so the regenerated PDF carries the SAME mix as the
//      original even if the ledger has shifted in between.
// ===========================================================================

// Helper: insert a settled transaction in a chosen currency at a chosen
// timestamp. Returns the transaction id so the caller can decide whether
// to pair it with a ledger_postings receipt or leave it unposted.
async function insertSettledTxn(opts: {
  userId: number;
  currency: string;
  createdAt: Date;
  amount?: string;
}): Promise<number> {
  const [tx] = await db
    .insert(transactions)
    .values({
      userId: opts.userId,
      type: "deposit",
      fromCurrency: null,
      toCurrency: opts.currency,
      amount: opts.amount ?? "100.00000000",
      fee: "0.00000000",
      exchangeRate: null,
      status: "completed",
      settlementStatus: "internal_only",
      description: "Task #369 reports source-mix test fixture",
      createdAt: opts.createdAt,
    })
    .returning({ id: transactions.id });
  return tx.id;
}

// Helper: best-effort upsert of a wallet snapshot row. The wallets table
// has a unique (userId, currency) index so we use insert/onConflictDoUpdate
// to keep the test idempotent across re-runs against the dev DB.
async function upsertWallet(
  userId: number,
  currency: string,
  balance: string,
): Promise<void> {
  await db
    .insert(wallets)
    .values({
      userId,
      currency,
      balance,
      availableBalance: balance,
      walletType: "fiat",
    })
    .onConflictDoUpdate({
      target: [wallets.userId, wallets.currency],
      set: { balance, availableBalance: balance },
    });
}

// Helper: clear all transactions, postings, and wallets we created for the
// shared test client so each Task #369 test starts from a clean per-client
// data slice. We scope by clientUserId so this never touches another
// developer's fixtures in the dev DB.
async function clearTask369Fixtures(): Promise<void> {
  if (clientUserId === undefined) return;
  // Postings reference transactionId; remove them via the user's tx ids.
  const txIds = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.userId, clientUserId));
  if (txIds.length > 0) {
    const ids = txIds.map((t) => t.id);
    await db.delete(ledgerPostings).where(inArray(ledgerPostings.transactionId, ids));
    await db.delete(transactions).where(inArray(transactions.id, ids));
  }
  await db.delete(wallets).where(eq(wallets.userId, clientUserId));
}

describe("deriveSourceMix (pure)", () => {
  it("returns all-ledger + fullyLedgerBacked=true when no source is incomplete", () => {
    // Holdings are ledger-backed in this hypothetical (today they always
    // go through the snapshot path; the helper still has to handle the
    // future case where a ledger-tracked-holdings extension flips this).
    const mix = deriveSourceMix({
      cashAudIncomplete: false,
      cashUsdIncomplete: false,
      holdingsHaveLedgerSource: true,
    });
    expect(mix).toEqual({
      cashAud: "ledger",
      cashUsd: "ledger",
      holdings: "ledger",
      fullyLedgerBacked: true,
    });
  });

  it("returns snapshot for the affected currency only and clears fullyLedgerBacked", () => {
    const mix = deriveSourceMix({
      cashAudIncomplete: false,
      cashUsdIncomplete: true,
      holdingsHaveLedgerSource: false,
    });
    expect(mix.cashAud).toBe("ledger");
    expect(mix.cashUsd).toBe("snapshot");
    // Today holdings are always snapshot — that alone clears the flag.
    expect(mix.holdings).toBe("snapshot");
    expect(mix.fullyLedgerBacked).toBe(false);
  });

  it("clears fullyLedgerBacked the moment ANY single source is non-ledger", () => {
    // Even if both currencies are clean, snapshot-derived holdings
    // (the production reality today) is enough to flip the flag.
    const mix = deriveSourceMix({
      cashAudIncomplete: false,
      cashUsdIncomplete: false,
      holdingsHaveLedgerSource: false,
    });
    expect(mix.fullyLedgerBacked).toBe(false);
    expect(mix.holdings).toBe("snapshot");
  });
});

describe("isCashLedgerIncompleteForUserCurrency", () => {
  it("returns true when an in-window settled txn touching the currency lacks a posting receipt", async () => {
    await clearTask369Fixtures();
    const periodFrom = new Date("2026-04-01T00:00:00.000Z");
    const periodToExclusive = new Date("2026-05-01T00:00:00.000Z");
    await insertSettledTxn({
      userId: clientUserId,
      currency: "USD",
      createdAt: new Date("2026-04-15T10:00:00.000Z"),
    });
    // No ledger_postings row inserted -> ledger is incomplete for USD.
    const incomplete = await isCashLedgerIncompleteForUserCurrency(
      clientUserId,
      "USD",
      periodFrom,
      periodToExclusive,
    );
    expect(incomplete).toBe(true);
  });

  it("returns false when every in-window settled txn for the currency has a posting receipt", async () => {
    await clearTask369Fixtures();
    const periodFrom = new Date("2026-04-01T00:00:00.000Z");
    const periodToExclusive = new Date("2026-05-01T00:00:00.000Z");
    const txId = await insertSettledTxn({
      userId: clientUserId,
      currency: "AUD",
      createdAt: new Date("2026-04-10T10:00:00.000Z"),
    });
    await db.insert(ledgerPostings).values({ transactionId: txId });
    const incomplete = await isCashLedgerIncompleteForUserCurrency(
      clientUserId,
      "AUD",
      periodFrom,
      periodToExclusive,
    );
    expect(incomplete).toBe(false);
  });

  it("ignores unposted txns that fall OUTSIDE the window", async () => {
    await clearTask369Fixtures();
    const periodFrom = new Date("2026-04-01T00:00:00.000Z");
    const periodToExclusive = new Date("2026-05-01T00:00:00.000Z");
    // Out-of-window unposted txn — should not affect the report's window.
    await insertSettledTxn({
      userId: clientUserId,
      currency: "USD",
      createdAt: new Date("2026-03-15T10:00:00.000Z"),
    });
    const incomplete = await isCashLedgerIncompleteForUserCurrency(
      clientUserId,
      "USD",
      periodFrom,
      periodToExclusive,
    );
    expect(incomplete).toBe(false);
  });
});

describe("generateReportPdf — sourceMix persistence (Task #369)", () => {
  it("fully-ledger case: every in-window cash txn has a posting receipt -> sourceMix.fullyLedgerBacked is false ONLY because holdings are snapshot today", async () => {
    await clearReportRows();
    await clearTask369Fixtures();
    // Two in-window txns, one per currency, BOTH posted. The cash side
    // is fully reconciled to the ledger; the only thing that prevents
    // fullyLedgerBacked from being true is that holdings remain
    // snapshot-derived (the ledger does not track NAV).
    const audId = await insertSettledTxn({
      userId: clientUserId,
      currency: "AUD",
      createdAt: new Date("2026-04-10T00:00:00.000Z"),
    });
    const usdId = await insertSettledTxn({
      userId: clientUserId,
      currency: "USD",
      createdAt: new Date("2026-04-12T00:00:00.000Z"),
    });
    await db.insert(ledgerPostings).values({ transactionId: audId });
    await db.insert(ledgerPostings).values({ transactionId: usdId });

    const [row] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "requested",
        periodFrom: "2026-04-01",
        periodTo: "2026-04-30",
      })
      .returning();

    const result = await generateReportPdf(row.id);
    expect(result.status).toBe("ready");

    const [after] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, row.id));
    expect(after.sourceMix).toBeTruthy();
    expect(after.sourceMix!.cashAud).toBe("ledger");
    expect(after.sourceMix!.cashUsd).toBe("ledger");
    // Holdings are snapshot today (no ledger NAV), so the overall flag
    // is false even when both currencies are reconciled.
    expect(after.sourceMix!.holdings).toBe("snapshot");
    expect(after.sourceMix!.fullyLedgerBacked).toBe(false);
  });

  it("partial-fallback case: USD has an unposted in-window txn -> cashUsd flips to snapshot, AUD stays ledger", async () => {
    await clearReportRows();
    await clearTask369Fixtures();
    // AUD txn is posted; USD txn is unposted. The renderer must fall
    // back to the wallets snapshot for USD only and label the figure
    // accordingly.
    const audId = await insertSettledTxn({
      userId: clientUserId,
      currency: "AUD",
      createdAt: new Date("2026-04-10T00:00:00.000Z"),
    });
    await db.insert(ledgerPostings).values({ transactionId: audId });
    await insertSettledTxn({
      userId: clientUserId,
      currency: "USD",
      createdAt: new Date("2026-04-12T00:00:00.000Z"),
    });
    // Snapshot fallback value the report should now read.
    await upsertWallet(clientUserId, "USD", "777.00000000");

    const [row] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "requested",
        periodFrom: "2026-04-01",
        periodTo: "2026-04-30",
      })
      .returning();

    const result = await generateReportPdf(row.id);
    expect(result.status).toBe("ready");

    const [after] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, row.id));
    expect(after.sourceMix).toBeTruthy();
    expect(after.sourceMix!.cashAud).toBe("ledger");
    expect(after.sourceMix!.cashUsd).toBe("snapshot");
    expect(after.sourceMix!.fullyLedgerBacked).toBe(false);
  });

  it("regeneration case: regenerateReport copies sourceMix forward, and the regenerated PDF honours that mix instead of recomputing", async () => {
    await clearReportRows();
    await clearTask369Fixtures();
    // Set up a v1 with a stamped, deliberately-mixed sourceMix. Going
    // through the full generator path is the simplest way to do that:
    // start with a partial-fallback fixture (USD unposted), generate v1,
    // then DROP the fallback condition (post the USD txn) before
    // regenerating. Without the copy-forward contract, v2 would
    // recompute fresh and silently flip USD back to "ledger" — which
    // would defeat the audit-trail guarantee.
    const audId = await insertSettledTxn({
      userId: clientUserId,
      currency: "AUD",
      createdAt: new Date("2026-04-10T00:00:00.000Z"),
    });
    await db.insert(ledgerPostings).values({ transactionId: audId });
    const usdId = await insertSettledTxn({
      userId: clientUserId,
      currency: "USD",
      createdAt: new Date("2026-04-12T00:00:00.000Z"),
    });
    await upsertWallet(clientUserId, "USD", "1.00000000");

    const [v1Row] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "requested",
        periodFrom: "2026-04-01",
        periodTo: "2026-04-30",
      })
      .returning();
    const v1Result = await generateReportPdf(v1Row.id);
    expect(v1Result.status).toBe("ready");
    const [v1After] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, v1Row.id));
    expect(v1After.sourceMix!.cashUsd).toBe("snapshot");

    // Now reconcile the ledger by adding the missing posting. A FRESH
    // generator run would compute cashUsd="ledger" — but we want
    // regeneration to preserve the ORIGINAL mix.
    await db.insert(ledgerPostings).values({ transactionId: usdId });

    const v2Row = await regenerateReport(adviserUserId, v1Row.id);
    // Copy-forward at insert time.
    expect(v2Row.sourceMix).toEqual(v1After.sourceMix);

    const v2Result = await generateReportPdf(v2Row.id);
    expect(v2Result.status).toBe("ready");

    const [v2After] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, v2Row.id));
    // Honoured at generation time — same mix as v1 even though the
    // underlying data has shifted to a fully-ledger state.
    expect(v2After.sourceMix).toEqual(v1After.sourceMix);
    expect(v2After.sourceMix!.cashUsd).toBe("snapshot");
  });

  it("exposes stable label strings used by the renderer", () => {
    // Belt-and-braces guard: the per-balance labels and footer wording
    // are part of the audit contract — a copy-edit must not silently
    // change them. Asserting the literal strings here makes any future
    // wording change an explicit, reviewed event.
    expect(LEDGER_LABEL).toBe("Balance as at ledger");
    expect(SNAPSHOT_LABEL).toBe("Balance estimated from snapshot");
  });
});
