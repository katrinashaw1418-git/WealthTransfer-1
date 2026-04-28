import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { eq, desc, asc, and, or, lt, gte, isNull, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  reportRequests,
  users,
  userInvestments,
  investmentProducts,
  transactions,
  feeConsents,
  adviserClients,
  adviserProfiles,
  auditLogs,
  type ReportRequest,
} from "@shared/schema";
import { getUserCurrencyBalance } from "./ledger";
import {
  sendReportReadyEmail,
  sendReportFailedEmail,
  sendReportExpiringSoonEmail,
} from "../email";
// Task #318 — watermarking moved to the download surface (server/adviser-routes.ts
// report download). Generation now produces an unmarked PDF on disk; the route
// applies the per-download watermark just before streaming the response so
// every download is forensically distinguishable. We deliberately do NOT
// import applyDocumentWatermark here.

export const REPORTS_DIR = path.resolve(process.cwd(), ".local/reports");
const EXPIRY_DAYS = 30;
// Task #315 — 7-day download-link expiry. The data inside the PDF can stay
// "valid" for the longer 30-day window (`expiresAt`) but the signed link
// itself goes cold after a week so a forwarded URL cannot be replayed
// indefinitely.
export const DOWNLOAD_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TXN_LIMIT = 100;
// Task #315 — sweeper hard timeout. A row that has sat in `requested` or
// `generating` for longer than this is treated as an abandoned worker.
export const SWEEPER_STUCK_AFTER_MS = 10 * 60 * 1000;
// Task #315 — duplicate guard window. A second request for the same
// (clientUserId, reportType) within this window is rejected with 409.
export const DUPLICATE_GUARD_WINDOW_MS = 30 * 60 * 1000;
// Task #315 — placeholder AFSL number used in the PDF header until the
// licensee's authorised wording is wired in. Kept as a constant so the
// later "real wording" sweep is a single search-and-replace.
const PLATFORM_AFSL_NUMBER = "AFSL placeholder";
const PLATFORM_NAME = "AMAX Wealth";

// Task #298 — single named constant. A row stuck in `requested` or
// `generating` for longer than this is considered abandoned (the generator
// crashed mid-flight) and the next list-endpoint hit will flip it to
// `failed` with a clear reason. Configurable via env so ops can tune it
// without a redeploy if a real generator ever takes longer.
export const STALE_REPORT_JOB_TIMEOUT_MS = (() => {
  const raw = Number(process.env.ADVISER_REPORT_STALE_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 10 * 60 * 1000; // 10 minutes
})();
export const STALE_REPORT_JOB_FAILURE_REASON = "Generation timed out";

// -----------------------------------------------------------------------------
// Sweep stale jobs. Called from the top of every list endpoint so the UI
// never has to render an indefinitely-stuck "Requested" pill. Idempotent:
// safe to call from concurrent requests; the WHERE clause re-checks the
// timeout so two parallel sweeps converge on the same outcome.
// -----------------------------------------------------------------------------
export async function sweepStaleReportJobs(adviserUserId: number): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_REPORT_JOB_TIMEOUT_MS);
  const result = await db
    .update(reportRequests)
    .set({
      status: "failed",
      failureReason: STALE_REPORT_JOB_FAILURE_REASON,
    })
    .where(
      and(
        eq(reportRequests.adviserUserId, adviserUserId),
        inArray(reportRequests.status, ["requested", "generating"]),
        lt(reportRequests.requestedAt, cutoff),
      ),
    )
    .returning({ id: reportRequests.id });
  return result.length;
}

export type ReportResult =
  | { status: "ready"; downloadUrl: string; filePath: string }
  | { status: "failed"; failureReason: string };

function ensureDir(): void {
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }
}

function fmtMoney(amount: string | number | null | undefined, currency = "AUD"): string {
  if (amount === null || amount === undefined) return "—";
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-AU", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-AU", { year: "numeric", month: "short", day: "2-digit" });
}

function fmtDateTimeUtc(d: Date): string {
  // ISO-style UTC stamp for the PDF footer ("2026-04-27 03:14:00 UTC"). An
  // auditor reading a forwarded PDF needs the timezone explicit so they
  // can correlate it against ledger entries (which are also UTC).
  const iso = d.toISOString();
  return iso.replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

// ---------------------------------------------------------------------------
// Task #299 — Auto-expire. The download endpoint already enforces expiry
// inline (`expiresAt < now` returns 410), but a row that nobody clicks on
// will sit at status='ready' forever and the on-disk PDF will linger past
// its retention window. This sweeper, scheduled hourly from server/index.ts,
// flips every ready row whose expiresAt is past to 'expired', deletes the
// corresponding PDF on disk, and writes an audit row so the lifecycle is
// reviewable. The download endpoint's inline check stays in place as
// defence-in-depth (a row inserted right before the cron fires would still
// be caught at request time).
// ---------------------------------------------------------------------------
export interface ReportAutoExpireSummary {
  scanned: number;
  expired: number;
  expiredIds: number[];
  filesDeleted: number;
}

export async function runReportAutoExpire(opts?: {
  now?: Date;
}): Promise<ReportAutoExpireSummary> {
  const now = opts?.now ?? new Date();

  const due = await db
    .select({
      id: reportRequests.id,
      adviserUserId: reportRequests.adviserUserId,
      clientUserId: reportRequests.clientUserId,
      reportType: reportRequests.reportType,
      expiresAt: reportRequests.expiresAt,
    })
    .from(reportRequests)
    .where(
      and(
        eq(reportRequests.status, "ready"),
        lt(reportRequests.expiresAt, now),
      ),
    );

  let filesDeleted = 0;
  const expiredIds: number[] = [];
  for (const row of due) {
    // Per-row update so the audit row carries the precise ms-overdue figure.
    await db
      .update(reportRequests)
      .set({ status: "expired", downloadUrl: null })
      .where(eq(reportRequests.id, row.id));

    // Delete the on-disk PDF best-effort. A missing file is not an error —
    // the row may have been generated on a different host or already
    // cleaned up by a previous tick that crashed before writing the audit
    // row. We log unexpected unlink failures but never throw.
    const filePath = path.join(REPORTS_DIR, `${row.id}.pdf`);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        filesDeleted += 1;
      }
    } catch (err) {
      console.error(
        `[report-auto-expire] failed to delete ${filePath}:`,
        (err as Error)?.message ?? err,
      );
    }

    try {
      await db.insert(auditLogs).values({
        userId: null,
        action: "adviser_report_expired",
        entityType: "report_request",
        entityId: String(row.id),
        metadata: {
          adviserUserId: row.adviserUserId,
          clientUserId: row.clientUserId,
          reportType: row.reportType,
          expiresAt: row.expiresAt,
          msOverdue:
            row.expiresAt != null
              ? now.getTime() - new Date(row.expiresAt).getTime()
              : null,
          fileDeleted: fs.existsSync(filePath) === false,
        } as any,
        ipAddress: null,
      });
    } catch (err) {
      console.error(
        `[report-auto-expire] failed to write audit row for #${row.id}:`,
        (err as Error)?.message ?? err,
      );
    }

    expiredIds.push(row.id);
  }

  return {
    scanned: due.length,
    expired: expiredIds.length,
    expiredIds,
    filesDeleted,
  };
}

// ===========================================================================
// Task #344 — Adviser report notifications.
// ---------------------------------------------------------------------------
// Three close-the-loop notifications:
//   1. Ready          — sent inline when generateReportPdf flips a row to ready
//   2. Failed         — sent inline when generation OR the sweeper flips a
//                       row to failed
//   3. Expiring soon  — sent by an hourly cron ~24h before expiresAt for any
//                       still-undownloaded ready row
//
// All three:
//   - debounce off a per-status `*NotifiedAt` column on report_requests so
//     re-running the cron / re-flipping a row never re-emails the adviser.
//   - stamp the column even on SMTP failure so a transient bounce can't
//     turn into a re-page loop on every tick.
//   - never throw — a notification outage must not break PDF generation
//     or the sweeper's status-flip work, which are the canonical signals
//     for the UI.
// ===========================================================================

const EXPIRING_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;

interface AdviserAndClientForNotify {
  adviserEmail: string | null;
  adviserFirstName: string | null;
  clientName: string;
}

async function loadAdviserAndClientForNotify(
  adviserUserId: number,
  clientUserId: number,
): Promise<AdviserAndClientForNotify | null> {
  const [adviser] = await db
    .select({
      email: users.email,
      firstName: users.firstName,
    })
    .from(users)
    .where(eq(users.id, adviserUserId))
    .limit(1);
  if (!adviser) return null;

  const [client] = await db
    .select({
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, clientUserId))
    .limit(1);

  const clientName =
    (client?.firstName || client?.lastName)
      ? `${client?.firstName ?? ""} ${client?.lastName ?? ""}`.trim()
      : (client?.email ?? `client #${clientUserId}`);

  return {
    adviserEmail: adviser.email ?? null,
    adviserFirstName: adviser.firstName ?? null,
    clientName,
  };
}

/**
 * Notify the adviser their report is ready. Idempotent on
 * `readyNotifiedAt` — a second call for the same row is a no-op.
 * Never throws; logs and returns on any error.
 */
export async function notifyAdviserReportReady(reportId: number): Promise<{
  attempted: boolean;
  sent: boolean;
  error?: string;
}> {
  try {
    const [row] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, reportId))
      .limit(1);
    if (!row) return { attempted: false, sent: false, error: "report not found" };
    if (row.status !== "ready") {
      return { attempted: false, sent: false, error: `status=${row.status}` };
    }
    if (row.readyNotifiedAt) {
      return { attempted: false, sent: false, error: "already notified" };
    }
    const ctx = await loadAdviserAndClientForNotify(row.adviserUserId, row.clientUserId);
    if (!ctx?.adviserEmail) {
      // Stamp anyway so we don't loop trying to notify an adviser without
      // an email — but log the gap so an operator can fix the user record.
      await db
        .update(reportRequests)
        .set({ readyNotifiedAt: new Date() })
        .where(eq(reportRequests.id, reportId));
      console.warn(
        `[reports/notify] adviser #${row.adviserUserId} has no email; ready notify skipped for report #${reportId}`,
      );
      return { attempted: true, sent: false, error: "no adviser email" };
    }
    const dispatch = await sendReportReadyEmail({
      to: ctx.adviserEmail,
      firstName: ctx.adviserFirstName || "there",
      reportId: row.id,
      reportType: row.reportType,
      clientName: ctx.clientName,
      expiresAt: row.expiresAt,
    });
    await db
      .update(reportRequests)
      .set({ readyNotifiedAt: new Date() })
      .where(eq(reportRequests.id, reportId));
    return { attempted: true, sent: dispatch.sent, error: dispatch.error };
  } catch (err) {
    console.error(
      `[reports/notify] notifyAdviserReportReady failed for #${reportId}:`,
      (err as Error)?.message ?? err,
    );
    return { attempted: false, sent: false, error: (err as Error)?.message };
  }
}

/**
 * Notify the adviser their report failed. Idempotent on
 * `failedNotifiedAt`.
 */
export async function notifyAdviserReportFailed(reportId: number): Promise<{
  attempted: boolean;
  sent: boolean;
  error?: string;
}> {
  try {
    const [row] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, reportId))
      .limit(1);
    if (!row) return { attempted: false, sent: false, error: "report not found" };
    if (row.status !== "failed") {
      return { attempted: false, sent: false, error: `status=${row.status}` };
    }
    if (row.failedNotifiedAt) {
      return { attempted: false, sent: false, error: "already notified" };
    }
    const ctx = await loadAdviserAndClientForNotify(row.adviserUserId, row.clientUserId);
    if (!ctx?.adviserEmail) {
      await db
        .update(reportRequests)
        .set({ failedNotifiedAt: new Date() })
        .where(eq(reportRequests.id, reportId));
      console.warn(
        `[reports/notify] adviser #${row.adviserUserId} has no email; failed notify skipped for report #${reportId}`,
      );
      return { attempted: true, sent: false, error: "no adviser email" };
    }
    const dispatch = await sendReportFailedEmail({
      to: ctx.adviserEmail,
      firstName: ctx.adviserFirstName || "there",
      reportId: row.id,
      reportType: row.reportType,
      clientName: ctx.clientName,
      failureReason: row.failureReason ?? "unknown error",
    });
    await db
      .update(reportRequests)
      .set({ failedNotifiedAt: new Date() })
      .where(eq(reportRequests.id, reportId));
    return { attempted: true, sent: dispatch.sent, error: dispatch.error };
  } catch (err) {
    console.error(
      `[reports/notify] notifyAdviserReportFailed failed for #${reportId}:`,
      (err as Error)?.message ?? err,
    );
    return { attempted: false, sent: false, error: (err as Error)?.message };
  }
}

// ---------------------------------------------------------------------------
// Task #344 — Expiring-soon reminder cron. Hourly. Selects ready rows that:
//   - have not been downloaded yet (firstDownloadedAt IS NULL)
//   - have not already received this reminder (expiringSoonNotifiedAt IS NULL)
//   - have an expiresAt in the future, within EXPIRING_SOON_WINDOW_MS
// ---------------------------------------------------------------------------
export interface ReportExpiringSoonReminderSummary {
  scanned: number;
  notified: number;
  skipped: number;
  notifiedIds: number[];
}

export async function runReportExpiringSoonReminder(opts?: {
  now?: Date;
  windowMs?: number;
}): Promise<ReportExpiringSoonReminderSummary> {
  const now = opts?.now ?? new Date();
  const windowMs = opts?.windowMs ?? EXPIRING_SOON_WINDOW_MS;
  const windowEnd = new Date(now.getTime() + windowMs);

  const due = await db
    .select({
      id: reportRequests.id,
      adviserUserId: reportRequests.adviserUserId,
      clientUserId: reportRequests.clientUserId,
      reportType: reportRequests.reportType,
      expiresAt: reportRequests.expiresAt,
    })
    .from(reportRequests)
    .where(
      and(
        eq(reportRequests.status, "ready"),
        isNull(reportRequests.firstDownloadedAt),
        isNull(reportRequests.expiringSoonNotifiedAt),
        gte(reportRequests.expiresAt, now),
        lt(reportRequests.expiresAt, windowEnd),
      ),
    );

  const notifiedIds: number[] = [];
  let skipped = 0;
  for (const row of due) {
    if (!row.expiresAt) {
      skipped += 1;
      continue;
    }
    try {
      const ctx = await loadAdviserAndClientForNotify(row.adviserUserId, row.clientUserId);
      if (!ctx?.adviserEmail) {
        // Stamp so we don't keep retrying for an adviser without an email.
        await db
          .update(reportRequests)
          .set({ expiringSoonNotifiedAt: new Date() })
          .where(eq(reportRequests.id, row.id));
        console.warn(
          `[report-expiring-soon] adviser #${row.adviserUserId} has no email; reminder skipped for report #${row.id}`,
        );
        skipped += 1;
        continue;
      }
      await sendReportExpiringSoonEmail({
        to: ctx.adviserEmail,
        firstName: ctx.adviserFirstName || "there",
        reportId: row.id,
        reportType: row.reportType,
        clientName: ctx.clientName,
        expiresAt: row.expiresAt,
      });
      await db
        .update(reportRequests)
        .set({ expiringSoonNotifiedAt: new Date() })
        .where(eq(reportRequests.id, row.id));
      notifiedIds.push(row.id);
    } catch (err) {
      // Same debounce-on-failure stance as the inline notifiers: stamp so
      // a transient bounce doesn't re-page on every hourly tick. The
      // failure has already been logged inside the email helper.
      try {
        await db
          .update(reportRequests)
          .set({ expiringSoonNotifiedAt: new Date() })
          .where(eq(reportRequests.id, row.id));
      } catch {
        // best-effort
      }
      console.error(
        `[report-expiring-soon] failed to notify for #${row.id}:`,
        (err as Error)?.message ?? err,
      );
      skipped += 1;
    }
  }

  return {
    scanned: due.length,
    notified: notifiedIds.length,
    skipped,
    notifiedIds,
  };
}

// ---------------------------------------------------------------------------
// Task #315 — Sweeper. Forces stuck rows into a terminal `failed` state so
// the UI can surface a Retry button instead of the row sitting at
// `requested` forever, and emits an audit row + one summary line for the
// background-jobs dashboard.
//
// Returns a tagged structure the cron wrapper turns into a one-line summary.
// Pure observation otherwise — never mutates rows that aren't actually stuck.
// ---------------------------------------------------------------------------
export interface ReportSweeperSummary {
  scanned: number;
  flipped: number;
  flippedIds: number[];
}

export async function runReportJobSweeper(opts?: {
  now?: Date;
  stuckAfterMs?: number;
}): Promise<ReportSweeperSummary> {
  const now = opts?.now ?? new Date();
  const stuckAfterMs = opts?.stuckAfterMs ?? SWEEPER_STUCK_AFTER_MS;
  const cutoff = new Date(now.getTime() - stuckAfterMs);

  // Use requestedAt rather than createdAt because the schema uses
  // `requested_at` as the row-creation timestamp (defaultNow on insert).
  // A NULL requestedAt is impossible in practice but defensive: rows
  // missing the timestamp are skipped rather than incorrectly flipped.
  const stuck = await db
    .select({
      id: reportRequests.id,
      status: reportRequests.status,
      adviserUserId: reportRequests.adviserUserId,
      clientUserId: reportRequests.clientUserId,
      reportType: reportRequests.reportType,
      requestedAt: reportRequests.requestedAt,
    })
    .from(reportRequests)
    .where(
      and(
        inArray(reportRequests.status, ["requested", "generating"]),
        lt(reportRequests.requestedAt, cutoff),
      ),
    );

  const flippedIds: number[] = [];
  for (const row of stuck) {
    // Per-row update (not bulk) so we can also write a per-row audit entry.
    // The volume here is bounded — a healthy system rarely produces stuck
    // rows, and even an outage tail would be tens of rows, not thousands.
    await db
      .update(reportRequests)
      .set({
        status: "failed",
        failureReason: "sweeper_timeout",
      })
      .where(eq(reportRequests.id, row.id));

    try {
      // System-actor audit row. userId=null because the sweeper is
      // unattended — the action was not performed by a logged-in admin.
      await db.insert(auditLogs).values({
        userId: null,
        action: "report.sweeper_timeout",
        entityType: "report_request",
        entityId: String(row.id),
        metadata: {
          previousStatus: row.status,
          stuckSinceMs: now.getTime() - new Date(row.requestedAt!).getTime(),
          stuckAfterMsConfig: stuckAfterMs,
          adviserUserId: row.adviserUserId,
          clientUserId: row.clientUserId,
          reportType: row.reportType,
        } as any,
        ipAddress: null,
      });
    } catch (err) {
      // Sweeper bookkeeping must not crash the cron; the status flip is
      // already committed and that is the more important effect.
      console.error(
        `[report-sweeper] failed to write audit row for #${row.id}:`,
        (err as Error)?.message ?? err,
      );
    }
    flippedIds.push(row.id);

    // Task #344 — close the loop on the adviser. Best-effort, never throws,
    // idempotent on failedNotifiedAt. Awaited so the sweeper summary
    // reflects the real outbound side-effects of this tick.
    try {
      await notifyAdviserReportFailed(row.id);
    } catch (err) {
      console.error(
        `[report-sweeper] notify-failed crashed for #${row.id}:`,
        (err as Error)?.message ?? err,
      );
    }
  }

  return {
    scanned: stuck.length,
    flipped: flippedIds.length,
    flippedIds,
  };
}

// ---------------------------------------------------------------------------
// Task #315 — Duplicate guard probe. Returns the existing pending/recent row
// id if one exists for the same (clientUserId, reportType) within the
// guard window. Used by createReportRequest in adviser-access to short-
// circuit a second click-burst.
// ---------------------------------------------------------------------------
export async function findDuplicateRecentReport(opts: {
  adviserUserId: number;
  clientUserId: number;
  reportType: string;
  now?: Date;
  windowMs?: number;
}): Promise<{ id: number; status: string; requestedAt: Date | null } | null> {
  const now = opts.now ?? new Date();
  const windowMs = opts.windowMs ?? DUPLICATE_GUARD_WINDOW_MS;
  const since = new Date(now.getTime() - windowMs);
  const [existing] = await db
    .select({
      id: reportRequests.id,
      status: reportRequests.status,
      requestedAt: reportRequests.requestedAt,
    })
    .from(reportRequests)
    .where(
      and(
        eq(reportRequests.adviserUserId, opts.adviserUserId),
        eq(reportRequests.clientUserId, opts.clientUserId),
        eq(reportRequests.reportType, opts.reportType),
        gte(reportRequests.requestedAt, since),
      ),
    )
    .orderBy(desc(reportRequests.requestedAt))
    .limit(1);
  return existing ?? null;
}

// ---------------------------------------------------------------------------
// Task #315 — Regenerate. Writes a fresh row with versionNumber++ and a
// supersedesReportId pointer back at the original. Original row is left
// untouched (immutable history); the worker generates the new PDF and
// flips THIS row to ready/failed.
//
// Note we resolve the chain head every time: regenerating from any
// version in the chain produces the next version above the current head.
// ---------------------------------------------------------------------------
export async function regenerateReport(
  adviserUserId: number,
  originalId: number,
): Promise<ReportRequest> {
  const [original] = await db
    .select()
    .from(reportRequests)
    .where(eq(reportRequests.id, originalId))
    .limit(1);
  if (!original) {
    throw Object.assign(new Error("Report not found"), { status: 404 });
  }
  if (original.adviserUserId !== adviserUserId) {
    throw Object.assign(new Error("Forbidden — this report does not belong to you"), { status: 403 });
  }

  // Walk the chain to find the current head so the new row stays at
  // versionNumber = head.versionNumber + 1 even if the caller passed an
  // older mid-chain id.
  const head = await getChainHead(originalId);

  const [next] = await db
    .insert(reportRequests)
    .values({
      adviserUserId: original.adviserUserId,
      clientUserId: original.clientUserId,
      reportType: original.reportType,
      format: original.format,
      notes: original.notes,
      // The new row supersedes the CURRENT head, not the row whose id was
      // passed in — that way the chain stays a clean linked list ordered
      // by versionNumber.
      supersedesReportId: head.id,
      versionNumber: head.versionNumber + 1,
    })
    .returning();
  return next;
}

// Walk supersedesReportId chain forward to the most recent version. Bounded
// by `maxHops` so a (theoretical) cycle can't wedge the request.
async function getChainHead(startId: number, maxHops = 50): Promise<ReportRequest> {
  let cursorId = startId;
  let current: ReportRequest | undefined;
  for (let i = 0; i < maxHops; i++) {
    const [row] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, cursorId))
      .limit(1);
    if (!row) break;
    current = row;
    const [child] = await db
      .select({ id: reportRequests.id })
      .from(reportRequests)
      .where(eq(reportRequests.supersedesReportId, cursorId))
      .orderBy(desc(reportRequests.versionNumber))
      .limit(1);
    if (!child) break;
    cursorId = child.id;
  }
  if (!current) {
    throw new Error(`Report chain head not resolvable for id ${startId}`);
  }
  return current;
}

// Public: list the prior versions of a given report (excluding itself), in
// ascending versionNumber order. Used by the list endpoint to build the
// `versions` array each chain head ships down to the UI.
export async function listPriorVersions(reportId: number): Promise<
  Array<{ id: number; versionNumber: number; generatedAt: Date | null; status: string }>
> {
  // Walk backwards via supersedesReportId. The chain is short (rarely > 5)
  // so a per-hop SELECT is the simplest correct implementation.
  const out: Array<{ id: number; versionNumber: number; generatedAt: Date | null; status: string }> = [];
  let cursorId: number | null = reportId;
  for (let i = 0; i < 50 && cursorId !== null; i++) {
    const [row]: Array<{
      id: number;
      versionNumber: number;
      generatedAt: Date | null;
      status: string;
      supersedesReportId: number | null;
    }> = await db
      .select({
        id: reportRequests.id,
        versionNumber: reportRequests.versionNumber,
        generatedAt: reportRequests.generatedAt,
        status: reportRequests.status,
        supersedesReportId: reportRequests.supersedesReportId,
      })
      .from(reportRequests)
      .where(eq(reportRequests.id, cursorId))
      .limit(1);
    if (!row) break;
    if (row.id !== reportId) {
      out.push({
        id: row.id,
        versionNumber: row.versionNumber,
        generatedAt: row.generatedAt,
        status: row.status,
      });
    }
    cursorId = row.supersedesReportId ?? null;
  }
  return out.sort((a, b) => a.versionNumber - b.versionNumber);
}

// ---------------------------------------------------------------------------
// Main entry. Loads the row, regenerates link enforcement (defense in depth),
// gathers data, streams a PDF to disk, and updates the row to ready/failed.
// Throws nothing; returns a tagged union the caller can audit.
// ---------------------------------------------------------------------------
export async function generateReportPdf(reportId: number): Promise<ReportResult> {
  ensureDir();

  // Load the request row
  const [row] = await db
    .select()
    .from(reportRequests)
    .where(eq(reportRequests.id, reportId))
    .limit(1);

  if (!row) {
    return { status: "failed", failureReason: "Report request not found" };
  }

  // Defense in depth: re-verify the adviser-client link still exists & is active.
  // This protects against a link being deactivated between request and generation.
  const [link] = await db
    .select()
    .from(adviserClients)
    .where(
      and(
        eq(adviserClients.adviserUserId, row.adviserUserId),
        eq(adviserClients.clientUserId, row.clientUserId),
        eq(adviserClients.isActive, true),
      ),
    )
    .limit(1);

  if (!link) {
    const failureReason = "Adviser-client link is not active";
    await db
      .update(reportRequests)
      .set({ status: "failed", failureReason })
      .where(eq(reportRequests.id, reportId));
    // Task #344 — close the loop on the adviser even when the failure
    // is the entitlement check (most likely cause: link deactivated
    // between request and generation). Best-effort.
    void notifyAdviserReportFailed(reportId);
    return { status: "failed", failureReason };
  }

  try {
    // Mark generating so the bell-icon notification can show progress
    await db
      .update(reportRequests)
      .set({ status: "generating" })
      .where(eq(reportRequests.id, reportId));

    // ---- Load client + data slices -------------------------------------------
    const [client] = await db
      .select()
      .from(users)
      .where(eq(users.id, row.clientUserId))
      .limit(1);

    if (!client) {
      throw new Error("Client user not found");
    }

    // Task #298 — load adviser identity for the PDF header. Both the user
    // row (for the human-readable name) and the adviser_profiles row (for
    // AFSL #) — the join is two cheap point reads, not a large analytic
    // query. Required by the per-page header drawn in renderPdf.
    const [adviserUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, row.adviserUserId))
      .limit(1);
    const [adviserProfile] = await db
      .select()
      .from(adviserProfiles)
      .where(eq(adviserProfiles.userId, row.adviserUserId))
      .limit(1);


    const wantsHoldings = row.reportType === "portfolio_summary" || row.reportType === "full_statement";
    const wantsTxns = row.reportType === "transaction_history" || row.reportType === "full_statement";
    const wantsFees = row.reportType === "fee_summary" || row.reportType === "full_statement";

    // Task #298 — resolve the optional reporting window. Both columns are
    // nullable: when both are null the generator preserves its prior
    // behaviour (everything-on-record) so older queued rows that predate
    // the column still render. When set, slices below filter by:
    //   - transactions.createdAt within [periodFrom, periodTo + 1 day)
    //   - fee consents by consentedAt within the same window
    //   - holdings by overlap with [investmentDate, maturityDate ?? +∞]
    const periodFrom = row.periodFrom ? new Date(`${row.periodFrom}T00:00:00.000Z`) : null;
    const periodTo = row.periodTo ? new Date(`${row.periodTo}T00:00:00.000Z`) : null;
    // Inclusive upper bound: shift by one day so a To = 2026-04-30 captures
    // anything stamped on that date.
    const periodToExclusive = periodTo ? new Date(periodTo.getTime() + 86_400_000) : null;
    const hasWindow = periodFrom !== null && periodTo !== null;

    const holdings = wantsHoldings
      ? await (() => {
          const conds = [eq(userInvestments.userId, row.clientUserId)];
          if (hasWindow) {
            // Holdings overlap the window if they were opened strictly
            // before periodTo + 1 day (so a holding stamped at 15:00 on the
            // periodTo calendar date is still in scope) AND have either no
            // maturity or mature on/after periodFrom.
            conds.push(lt(userInvestments.investmentDate, periodToExclusive!));
            conds.push(
              or(
                isNull(userInvestments.maturityDate),
                gte(userInvestments.maturityDate, periodFrom!),
              )!,
            );
          }
          return db
            .select({
              productName: investmentProducts.name,
              productCategory: investmentProducts.category,
              investedAmount: userInvestments.investedAmount,
              currentValue: userInvestments.currentValue,
              totalReturn: userInvestments.totalReturn,
              returnPercent: userInvestments.returnPercent,
              status: userInvestments.status,
              investmentDate: userInvestments.investmentDate,
              maturityDate: userInvestments.maturityDate,
            })
            .from(userInvestments)
            .innerJoin(investmentProducts, eq(investmentProducts.id, userInvestments.productId))
            .where(and(...conds))
            .orderBy(desc(userInvestments.investmentDate));
        })()
      : [];

    // Cash balances are LEDGER-DERIVED (per Session 12 requirement). The
    // ledger is the single source of truth for cash; product current value
    // continues to come from `userInvestments` (product NAV is its own truth).
    // Cash totals are point-in-time and not window-scoped — the brief calls
    // for window-filtered transactions/holdings/fees only.
    const cashAud = wantsHoldings ? await getUserCurrencyBalance(row.clientUserId, "AUD") : "0";
    const cashUsd = wantsHoldings ? await getUserCurrencyBalance(row.clientUserId, "USD") : "0";

    const txns = wantsTxns
      ? await (() => {
          const conds = [eq(transactions.userId, row.clientUserId)];
          if (hasWindow) {
            conds.push(gte(transactions.createdAt, periodFrom!));
            conds.push(lt(transactions.createdAt, periodToExclusive!));
          }
          return db
            .select()
            .from(transactions)
            .where(and(...conds))
            .orderBy(desc(transactions.createdAt))
            .limit(TXN_LIMIT);
        })()
      : [];

    const fees = wantsFees
      ? await (() => {
          const conds = [eq(feeConsents.clientId, row.clientUserId)];
          if (hasWindow) {
            conds.push(gte(feeConsents.consentedAt, periodFrom!));
            conds.push(lt(feeConsents.consentedAt, periodToExclusive!));
          }
          return db
            .select({
              id: feeConsents.id,
              feeType: feeConsents.feeType,
              amountType: feeConsents.amountType,
              amount: feeConsents.amount,
              deductionFrequency: feeConsents.deductionFrequency,
              consentedAt: feeConsents.consentedAt,
              consentExpiryDate: feeConsents.consentExpiryDate,
              renewalStatus: feeConsents.renewalStatus,
            })
            .from(feeConsents)
            .where(and(...conds))
            .orderBy(desc(feeConsents.consentedAt));
        })()
      : [];

    // ---- Render PDF ----------------------------------------------------------
    const generatedAt = new Date();
    // Task #318 (rework) — the PDF is generated WITHOUT the confidential
    // watermark. The watermark (with its forensic per-download timestamp +
    // purpose) is applied by each download route on every request via
    // `applyDocumentWatermark()`. See server/adviser-routes.ts,
    // server/client-routes.ts, server/admin-routes.ts download handlers.
    const filePath = path.join(REPORTS_DIR, `${reportId}.pdf`);
    await renderPdf(filePath, {
      reportId,
      reportType: row.reportType,
      notes: row.notes,
      versionNumber: row.versionNumber ?? 1,
      generatedAt,
      // Task #298 — pass the resolved window through verbatim so the rendered
      // header explicitly states the data slice. Both ISO date strings or
      // null (older queued rows that predate the column).
      periodFrom: row.periodFrom,
      periodTo: row.periodTo,
      client: {
        userId: row.clientUserId,
        firstName: client.firstName,
        lastName: client.lastName,
        email: client.email,
        kycStatus: client.kycStatus,
      },
      adviser: {
        firstName: adviserUser?.firstName ?? "—",
        lastName: adviserUser?.lastName ?? "",
        afslNumber: adviserProfile?.afslNumber ?? PLATFORM_AFSL_NUMBER,
      },
      holdings,
      cashAud,
      cashUsd,
      txns,
      fees,
    });

    const expiresAt = new Date(generatedAt.getTime() + EXPIRY_DAYS * 86_400_000);
    const downloadLinkExpiresAt = new Date(generatedAt.getTime() + DOWNLOAD_LINK_TTL_MS);
    const downloadUrl = `/api/adviser/reports/${reportId}/download`;

    await db
      .update(reportRequests)
      .set({
        status: "ready",
        downloadUrl,
        generatedAt,
        expiresAt,
        downloadLinkExpiresAt,
        failureReason: null,
      })
      .where(eq(reportRequests.id, reportId));

    // Task #344 — fire the "report ready" email. Idempotent on
    // readyNotifiedAt and never throws, so a notification outage cannot
    // mask the canonical status flip just committed above.
    void notifyAdviserReportReady(reportId);

    return { status: "ready", downloadUrl, filePath };
  } catch (err) {
    const failureReason = err instanceof Error ? err.message : "Unknown generation error";
    console.error(`[reports] generation failed for #${reportId}:`, err);
    await db
      .update(reportRequests)
      .set({ status: "failed", failureReason })
      .where(eq(reportRequests.id, reportId));
    // Task #344 — close the loop on a generation failure. Best-effort.
    void notifyAdviserReportFailed(reportId);
    return { status: "failed", failureReason };
  }
}

// ---------------------------------------------------------------------------
// PDF rendering. Streamed so memory is bounded.
// ---------------------------------------------------------------------------
interface RenderInput {
  reportId: number;
  reportType: string;
  notes: string | null;
  versionNumber: number;
  generatedAt: Date;
  // Task #298 — when both are set, the rendered header explicitly states
  // the window the data was scoped to. When null, the existing
  // "everything-on-record" rendering is preserved.
  periodFrom: string | null;
  periodTo: string | null;
  client: { userId: number; firstName: string; lastName: string; email: string; kycStatus: string };
  adviser: { firstName: string; lastName: string; afslNumber: string };
  holdings: Array<{
    productName: string;
    productCategory: string;
    investedAmount: string;
    currentValue: string;
    totalReturn: string | null;
    returnPercent: string | null;
    status: string;
    investmentDate: Date | null;
    maturityDate: Date | null;
  }>;
  cashAud: string;
  cashUsd: string;
  txns: Array<{
    id: number;
    type: string;
    fromCurrency: string | null;
    toCurrency: string | null;
    amount: string;
    fee: string;
    status: string;
    description: string;
    createdAt: Date | null;
  }>;
  fees: Array<{
    id: number;
    feeType: string;
    amountType: string;
    amount: string | null;
    deductionFrequency: string;
    consentedAt: Date | null;
    consentExpiryDate: Date | null;
    renewalStatus: string;
  }>;
}

const REPORT_TYPE_LABEL: Record<string, string> = {
  portfolio_summary: "Portfolio Summary",
  fee_summary: "Fee Summary",
  transaction_history: "Transaction History",
  full_statement: "Full Statement",
};

// Account number format: zero-padded internal user id. Stable across
// regenerations and easy to cross-reference against ledger entries.
function formatAccountNumber(userId: number): string {
  return `AMW-${String(userId).padStart(8, "0")}`;
}

async function renderPdf(filePath: string, data: RenderInput): Promise<void> {
  return new Promise((resolve, reject) => {
    // Top margin is bumped to 96px to make room for the fixed
    // header band drawn on every page in the bufferedPages pass.
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 96, bottom: 80, left: 56, right: 56 },
      bufferPages: true,
      info: {
        Title: `${REPORT_TYPE_LABEL[data.reportType] ?? data.reportType} — ${data.client.firstName} ${data.client.lastName}`,
        Author: `${PLATFORM_NAME} (Authorised Representative under ${data.adviser.afslNumber})`,
        Subject: `Report request #${data.reportId} (v${data.versionNumber})`,
      },
    });

    const stream = fs.createWriteStream(filePath);
    stream.on("finish", () => resolve());
    stream.on("error", reject);
    doc.on("error", reject);
    doc.pipe(stream);

    // Cover content. The fixed per-page header/footer is added later via
    // bufferedPages, so on the first page we just render the report-level
    // intro band beneath the (yet-to-be-painted) header.
    doc.fillColor("#0f172a").fontSize(18).font("Helvetica-Bold").text(REPORT_TYPE_LABEL[data.reportType] ?? data.reportType);
    doc.moveDown(0.2);
    doc.fillColor("#64748b").fontSize(10).font("Helvetica")
      .text(`For ${data.client.firstName} ${data.client.lastName} · ${data.client.email}`);
    doc.text(
      `Generated ${fmtDate(data.generatedAt)} · Report #${data.reportId} · Version ${data.versionNumber}`,
    );
    // Task #298 — explicit reporting window so the recipient never has to
    // guess what data was sliced into this PDF. When the request had no
    // window set (older queued rows) we mark it as such rather than
    // silently rendering "everything".
    if (data.periodFrom && data.periodTo) {
      doc.text(`Period: ${fmtDate(data.periodFrom)} – ${fmtDate(data.periodTo)}`);
    } else {
      doc.text(`Period: All data on record`);
    }
    if (data.notes) {
      doc.moveDown(0.3);
      doc.fillColor("#475569").fontSize(9).font("Helvetica-Oblique").text(`Note: ${data.notes}`);
    }
    doc.moveDown(0.6);

    // Sections
    if (data.holdings.length > 0 || data.cashAud !== "0" || data.cashUsd !== "0") {
      drawHoldingsSection(doc, data);
    }
    if (data.fees.length > 0 || data.reportType === "fee_summary" || data.reportType === "full_statement") {
      drawFeesSection(doc, data);
    }
    if (data.txns.length > 0 || data.reportType === "transaction_history" || data.reportType === "full_statement") {
      drawTxnsSection(doc, data);
    }

    drawDisclosurePage(doc);

    // Per-page header + footer + watermark. Drawn AFTER content so the
    // bufferedPageRange is final — adding a page from inside this loop
    // would invalidate the count we use for "page X of Y". The watermark
    // is drawn BEFORE the header/footer so the licensee strip and footer
    // line stay readable on top of it.
    const range = doc.bufferedPageRange();
    const totalPages = range.count;
    for (let i = range.start; i < range.start + totalPages; i++) {
      doc.switchToPage(i);
      drawAmaxWatermark(doc);
      drawPageHeader(doc, data);
      drawPageFooter(doc, data, i - range.start + 1, totalPages);
    }

    doc.end();
  });
}

// Per-page fixed header band. Carries the licensee identity (so a forwarded
// page is unambiguously ours) plus the four pieces of provenance an auditor
// needs: client name, account number, adviser name, AFSL number.
function drawPageHeader(doc: PDFKit.PDFDocument, data: RenderInput): void {
  const left = 56;
  const right = doc.page.width - 56;
  const yTop = 32;
  doc.save();
  // Licensee strip
  doc.fillColor("#0f172a").fontSize(11).font("Helvetica-Bold")
    .text(PLATFORM_NAME.toUpperCase(), left, yTop, { lineBreak: false });
  doc.fillColor("#64748b").fontSize(8).font("Helvetica")
    .text(`AFSL ${data.adviser.afslNumber}`, left + 110, yTop + 2, { lineBreak: false });
  // Right-aligned client + account identity
  const accountNo = formatAccountNumber(data.client.userId);
  const clientLine = `${data.client.firstName} ${data.client.lastName} · ${accountNo}`;
  const adviserLine = `Adviser: ${data.adviser.firstName} ${data.adviser.lastName}`.trim();
  doc.fillColor("#0f172a").fontSize(9).font("Helvetica-Bold")
    .text(clientLine, left, yTop, { width: right - left, align: "right", lineBreak: false });
  doc.fillColor("#64748b").fontSize(8).font("Helvetica")
    .text(adviserLine, left, yTop + 12, { width: right - left, align: "right", lineBreak: false });
  // Hairline underneath the header band
  doc.moveTo(left, yTop + 28)
    .lineTo(right, yTop + 28)
    .strokeColor("#e2e8f0").lineWidth(0.5).stroke();
  doc.restore();
  // Reset Y so subsequent text() calls land below the header. Without this
  // the next paragraph would overlap the header strip on freshly added
  // pages (PDFKit advances doc.y when text is written, and we just wrote
  // at yTop). Margin top is 96, so we sit at 96.
  doc.y = 96;
}

function drawPageFooter(
  doc: PDFKit.PDFDocument,
  data: RenderInput,
  pageNum: number,
  pageCount: number,
): void {
  const left = 56;
  const right = doc.page.width - 56;
  // Two stacked footer rows: the new Task #299 provenance line on top
  // (period · client · adviser/licensee · "Generated by AMAX platform")
  // and the existing pagination + confidentiality line beneath. Page
  // bottom margin is 80px, so the two 10px rows starting at -56 fit
  // comfortably.
  const yProvenance = doc.page.height - 56;
  const yMeta = doc.page.height - 38;
  doc.save();
  // Hairline above the footer
  doc
    .moveTo(left, yProvenance - 6)
    .lineTo(right, yProvenance - 6)
    .strokeColor("#e2e8f0")
    .lineWidth(0.5)
    .stroke();

  // Top footer row — Task #299 provenance line. We render it as four
  // dot-separated segments so a forwarded single-page printout still
  // tells the reader the date range, the client, the adviser/licensee,
  // and that the document came from the AMAX platform.
  const periodSegment =
    data.periodFrom && data.periodTo
      ? `${fmtDate(data.periodFrom)} – ${fmtDate(data.periodTo)}`
      : "All data on record";
  const clientSegment =
    `${data.client.firstName} ${data.client.lastName}`.trim() || data.client.email;
  const adviserSegment =
    `${data.adviser.firstName} ${data.adviser.lastName}`.trim() || PLATFORM_NAME;
  const licenseeSegment = `${adviserSegment} · ${PLATFORM_NAME}`;
  const provenance = [
    periodSegment,
    clientSegment,
    licenseeSegment,
    "Generated by AMAX platform",
  ].join(" · ");
  doc
    .fillColor("#475569")
    .fontSize(7.5)
    .font("Helvetica")
    .text(provenance, left, yProvenance, {
      width: right - left,
      align: "center",
      lineBreak: false,
      ellipsis: true,
    });

  // Bottom footer row — pagination + generation timestamp + confidentiality.
  doc.fillColor("#94a3b8").fontSize(8).font("Helvetica");
  doc.text(`Generated ${fmtDateTimeUtc(data.generatedAt)}`, left, yMeta, {
    width: (right - left) / 2,
    align: "left",
    lineBreak: false,
  });
  doc.text(`Page ${pageNum} of ${pageCount}`, left, yMeta, {
    width: right - left,
    align: "center",
    lineBreak: false,
  });
  doc.text("Confidential — not for distribution", left, yMeta, {
    width: right - left,
    align: "right",
    lineBreak: false,
  });
  doc.restore();
}

// Task #318 (rework) — the legacy `drawDraftWatermark` was removed; the
// per-recipient forensic watermark (downloaded-at + purpose) is now applied
// at download time via `applyDocumentWatermark()` on each download surface
// (adviser/client/admin), so generation no longer produces a DRAFT overlay.
//
// Task #299 — in addition to that download-time watermark, generation bakes
// a faint diagonal "AMAX" *brand* watermark behind the body content of every
// page. The two layers serve different purposes and intentionally coexist:
//   - drawAmaxWatermark (this function): brand-only, no PII; ensures any
//     forwarded screenshot or printout is unambiguously branded as AMAX
//     regardless of who later downloaded it.
//   - applyDocumentWatermark (download-time): forensic per-recipient
//     attribution; only added to the response stream, never persisted.
function drawAmaxWatermark(doc: PDFKit.PDFDocument): void {
  doc.save();
  // Light slate that prints near-invisible but is clearly visible on
  // screen and on a colour print. Opacity is set explicitly so the
  // watermark sits BEHIND the body text without bleeding into it.
  doc.opacity(0.08);
  doc.fillColor("#0f172a").fontSize(120).font("Helvetica-Bold");
  doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
  doc.text("AMAX", 0, doc.page.height / 2 - 60, {
    width: doc.page.width,
    align: "center",
    lineBreak: false,
  });
  doc.restore();
}

function sectionHeading(doc: PDFKit.PDFDocument, title: string): void {
  if (doc.y > doc.page.height - 180) doc.addPage();
  doc.moveDown(0.5);
  doc.fillColor("#0f172a").fontSize(13).font("Helvetica-Bold").text(title);
  doc.moveTo(56, doc.y + 2).lineTo(doc.page.width - 56, doc.y + 2).strokeColor("#cbd5e1").lineWidth(0.5).stroke();
  doc.moveDown(0.5);
}

function drawHoldingsSection(doc: PDFKit.PDFDocument, data: RenderInput): void {
  sectionHeading(doc, "Holdings & Cash");

  // Table header
  const startX = 56;
  const colWidths = [180, 90, 90, 70, 60];
  const headers = ["Product", "Invested", "Current value", "Return", "Status"];
  let y = doc.y;

  doc.fillColor("#475569").fontSize(9).font("Helvetica-Bold");
  let x = startX;
  headers.forEach((h, i) => {
    doc.text(h, x, y, { width: colWidths[i], align: i === 0 ? "left" : "right" });
    x += colWidths[i];
  });
  doc.moveTo(startX, y + 14).lineTo(doc.page.width - 56, y + 14).strokeColor("#e2e8f0").stroke();
  y += 18;

  doc.fillColor("#0f172a").fontSize(9).font("Helvetica");
  let totalInvested = 0;
  let totalCurrent = 0;
  data.holdings.forEach((h) => {
    if (y > doc.page.height - 100) {
      doc.addPage();
      y = 96;
    }
    x = startX;
    doc.text(h.productName, x, y, { width: colWidths[0], align: "left" });
    x += colWidths[0];
    doc.text(fmtMoney(h.investedAmount), x, y, { width: colWidths[1], align: "right" });
    x += colWidths[1];
    doc.text(fmtMoney(h.currentValue), x, y, { width: colWidths[2], align: "right" });
    x += colWidths[2];
    doc.text(`${h.returnPercent ?? "—"}%`, x, y, { width: colWidths[3], align: "right" });
    x += colWidths[3];
    doc.text(h.status, x, y, { width: colWidths[4], align: "right" });
    totalInvested += Number(h.investedAmount) || 0;
    totalCurrent += Number(h.currentValue) || 0;
    y += 14;
  });

  // Totals row
  if (data.holdings.length > 0) {
    doc.moveTo(startX, y).lineTo(doc.page.width - 56, y).strokeColor("#cbd5e1").stroke();
    y += 4;
    doc.fillColor("#0f172a").font("Helvetica-Bold");
    x = startX;
    doc.text("Totals", x, y, { width: colWidths[0], align: "left" });
    x += colWidths[0];
    doc.text(fmtMoney(totalInvested), x, y, { width: colWidths[1], align: "right" });
    x += colWidths[1];
    doc.text(fmtMoney(totalCurrent), x, y, { width: colWidths[2], align: "right" });
    y += 18;
  } else {
    doc.fillColor("#64748b").fontSize(9).font("Helvetica-Oblique").text("No invested products on record.", startX, y);
    y += 14;
  }
  doc.y = y;

  // Cash subsection (LEDGER-DERIVED)
  doc.moveDown(0.6);
  doc.fillColor("#0f172a").fontSize(11).font("Helvetica-Bold").text("Cash balances");
  doc.fillColor("#64748b").fontSize(8).font("Helvetica-Oblique")
    .text("Source: derived from ledger entries (sum of credits − debits).");
  doc.moveDown(0.3);
  doc.fillColor("#0f172a").fontSize(10).font("Helvetica");
  doc.text(`AUD: ${fmtMoney(data.cashAud, "AUD")}`);
  doc.text(`USD: ${fmtMoney(data.cashUsd, "USD")}`);
  doc.moveDown(0.5);
}

function drawFeesSection(doc: PDFKit.PDFDocument, data: RenderInput): void {
  sectionHeading(doc, "Fee Consents");

  if (data.fees.length === 0) {
    doc.fillColor("#64748b").fontSize(9).font("Helvetica-Oblique")
      .text("No fee consents on record. (No fee deductions are recorded — the fee engine is not yet operative.)");
    doc.moveDown(0.5);
    return;
  }

  const startX = 56;
  const colWidths = [110, 70, 80, 80, 80, 60];
  const headers = ["Fee type", "Amount", "Type", "Frequency", "Consented", "Status"];
  let y = doc.y;

  doc.fillColor("#475569").fontSize(9).font("Helvetica-Bold");
  let x = startX;
  headers.forEach((h, i) => {
    doc.text(h, x, y, { width: colWidths[i], align: i === 0 ? "left" : "right" });
    x += colWidths[i];
  });
  doc.moveTo(startX, y + 14).lineTo(doc.page.width - 56, y + 14).strokeColor("#e2e8f0").stroke();
  y += 18;

  doc.fillColor("#0f172a").fontSize(9).font("Helvetica");
  data.fees.forEach((f) => {
    if (y > doc.page.height - 100) { doc.addPage(); y = 96; }
    x = startX;
    doc.text(f.feeType, x, y, { width: colWidths[0], align: "left" });
    x += colWidths[0];
    const amountText = f.amount
      ? f.amountType === "percentage"
        ? `${f.amount}%`
        : fmtMoney(f.amount)
      : "—";
    doc.text(amountText, x, y, { width: colWidths[1], align: "right" });
    x += colWidths[1];
    doc.text(f.amountType, x, y, { width: colWidths[2], align: "right" });
    x += colWidths[2];
    doc.text(f.deductionFrequency, x, y, { width: colWidths[3], align: "right" });
    x += colWidths[3];
    doc.text(fmtDate(f.consentedAt), x, y, { width: colWidths[4], align: "right" });
    x += colWidths[4];
    doc.text(f.renewalStatus, x, y, { width: colWidths[5], align: "right" });
    y += 14;
  });
  doc.y = y;
  doc.moveDown(0.4);
  doc.fillColor("#64748b").fontSize(8).font("Helvetica-Oblique")
    .text("Fee deductions are not yet operative; the fee engine is gated.");
  doc.moveDown(0.5);
}

function drawTxnsSection(doc: PDFKit.PDFDocument, data: RenderInput): void {
  sectionHeading(doc, `Transactions (last ${data.txns.length})`);

  if (data.txns.length === 0) {
    doc.fillColor("#64748b").fontSize(9).font("Helvetica-Oblique")
      .text("No transactions on record.");
    doc.moveDown(0.5);
    return;
  }

  const startX = 56;
  const colWidths = [80, 90, 90, 60, 170];
  const headers = ["Date", "Type", "Amount", "Status", "Description"];
  let y = doc.y;

  doc.fillColor("#475569").fontSize(9).font("Helvetica-Bold");
  let x = startX;
  headers.forEach((h, i) => {
    doc.text(h, x, y, { width: colWidths[i], align: i === 4 ? "left" : i === 0 || i === 1 ? "left" : "right" });
    x += colWidths[i];
  });
  doc.moveTo(startX, y + 14).lineTo(doc.page.width - 56, y + 14).strokeColor("#e2e8f0").stroke();
  y += 18;

  doc.fillColor("#0f172a").fontSize(9).font("Helvetica");
  data.txns.forEach((t) => {
    if (y > doc.page.height - 100) { doc.addPage(); y = 96; }
    x = startX;
    doc.text(fmtDate(t.createdAt), x, y, { width: colWidths[0], align: "left" });
    x += colWidths[0];
    doc.text(t.type, x, y, { width: colWidths[1], align: "left" });
    x += colWidths[1];
    const cur = t.toCurrency || t.fromCurrency || "AUD";
    doc.text(fmtMoney(t.amount, cur), x, y, { width: colWidths[2], align: "right" });
    x += colWidths[2];
    doc.text(t.status, x, y, { width: colWidths[3], align: "right" });
    x += colWidths[3];
    doc.text((t.description || "").slice(0, 60), x, y, { width: colWidths[4], align: "left" });
    y += 14;
  });
  doc.y = y;
  doc.moveDown(0.5);
}

function drawDisclosurePage(doc: PDFKit.PDFDocument): void {
  doc.addPage();
  doc.fillColor("#0f172a").fontSize(13).font("Helvetica-Bold").text("Important disclosures");
  doc.moveDown(0.4);
  doc.fillColor("#334155").fontSize(9).font("Helvetica");
  const lines = [
    "This document is a draft generated by the AMAX Wealth platform. Regulatory details on this page are placeholder content and must be replaced with the licensee's final wording before client delivery.",
    "",
    "AMAX Wealth operates as an Authorised Representative under an Australian Financial Services Licence (AFSL). This report is general information only and does not constitute personal advice. It does not consider your objectives, financial situation or needs.",
    "",
    "Cash balances shown in this report are derived directly from the platform's ledger (sum of credits minus debits per currency). Invested-product current values reflect the latest unit price recorded against each product and may not match real-time custodian valuations.",
    "",
    "No fee deductions have been executed by this platform. Fee consents shown record the client's authorisation only; the fee engine itself remains gated.",
    "",
    "For questions, contact your adviser or write to compliance@amaxwealth.com.au.",
  ];
  lines.forEach((l) => {
    if (l === "") doc.moveDown(0.4);
    else doc.text(l, { align: "justify" });
  });
}
