// =============================================================================
// SESSION 13 — ADMIN ROUTES (mounted at /api/admin/*)
// -----------------------------------------------------------------------------
// All endpoints in this file:
//   1. require a valid JWT (requireAuth)
//   2. require role === 'admin' (requireRole)
//   3. write an audit_logs entry on every state change
//
// Admins manage:
//   - applications (approve/reject)
//   - adviser users (create + read)
//   - adviser_clients links (assign + activate/deactivate)
//   - audit log (read with filters)
//
// What admins do NOT do here:
//   - move money / execute trades / touch the gated 10C fee engine
//   - bypass KYC (KYC remains the user's responsibility on signup; admin only
//     approves the *application* — i.e. permission to register an account)
//   - alter feeConsents / adviceRecords / instructions (those belong to the
//     adviser layer with full traceability)
// =============================================================================

import type { Express, Request } from "express";
import { z } from "zod";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { createHash, randomBytes } from "crypto";
import { db } from "./db";
import {
  auditLogs,
  applications,
  users,
  adviserClients,
  registrationInvites,
  normalizeEmail,
  // Session 19 — admin shell expansion
  investmentProducts,
  investmentInstructions,
  reportRequests,
  adminReviewNotes,
  feeConsents,
  // Task #302 — AMAX-branded consent PDF needs the adviser AFSL line on the
  // letterhead (read-only join from the adviser user → adviser_profiles).
  adviserProfiles,
  // Session 23A — fee engine Gate A / Session 23B — Gate B settlement
  adviserFeeRules,
  adviserFeeAccruals,
  adviserFeeDeductions,
  insertAdviserFeeRuleSchema,
  feeConsentRequests,
  adviceRecords,
  adviceAcknowledgements,
  insertInvestmentProductSchema,
  // Session 25 (Task #17) — wallet-vs-ledger drift visibility
  walletLedgerReconciliations,
  // Task #93 — drift attribution by fee-deduction transaction id
  ledgerEntries,
  // Session 28 (Task #35) — drift acknowledgements (alert suppression)
  walletLedgerDriftAcknowledgements,
  // Session 27 (Task #23) — fee accrual run log
  feeAccrualRuns,
  // Task #36 — operator alert audit log
  operatorAlerts,
  // Task #59 — operator alert retention prune run history
  operatorAlertPruneRuns,
  // Task #79 — generic background-job run history
  backgroundJobRuns,
  // Task #144 — admin metrics tile reads transaction failures
  transactions,
  // Task #359 — confirm-before-unpublish needs the active holdings count
  // for a product when the visibility toggle is flipped true → false.
  userInvestments,
} from "@shared/schema";
// Task #341 — canonical investment-product category enum used to validate
// admin create/update payloads (see adminCreateProductSchema /
// adminUpdateProductSchema below).
import { PRODUCT_CATEGORY_VALUES } from "@shared/product-categories";
import {
  acknowledgeWalletLedgerDrift,
  clearWalletLedgerDriftAcknowledgement,
  computeDriftAckExpiresAt,
  getDriftAckTtlDays,
  DriftAckConflictError,
  DriftAckNoMismatchError,
  DriftAckNotFoundError,
  // Task #93 — share the SAME drift tolerance the recon cron uses so the
  // reporting page can never disagree with the reconciliation page about
  // whether a wallet is "clean".
  MATCH_EPSILON,
} from "./services/reconciliation";
import { findUserIdsByQuery, getUserNameMap } from "./services/user-name-map";
// Task #95 — standardised audit-log writer (before/after snapshots) for the
// advice + fee-engine surfaces. Other admin paths still use auditTx; only the
// fee-deduction settle/reverse routes below have been migrated.
import { writeAuditLog } from "./services/audit";
import {
  buildFeeConsentPdf,
  buildFeeConsentRequestPdf,
} from "./services/fee-consent-pdf";
// Task #204 — manual insufficient-funds sweep button calls the same service
// the daily cron uses, so there is exactly one settlement code path to audit.
import {
  runInsufficientFundsSweep,
  type InsufficientFundsSweepSummary,
} from "./services/insufficient-funds-sweep";
// Task #204 — centralised "show as IF?" projection. Strips IF-only bookkeeping
// columns from non-IF rows before they ship over the wire so settled-formerly-
// IF rows can never leak stale notification metadata into the admin table.
import {
  projectDeductionForApiContract,
  projectFeeExceptionRow,
} from "../shared/fee-deduction-status";
// Task #339 — admin product create/update validates `riskProfile` against
// the canonical lowercase enum so legacy sentence-case values can no longer
// drift into the database via the admin UI / API.
import {
  RISK_PROFILE_KEYS,
  type KnownRiskProfile,
} from "@shared/risk-profiles";
import {
  getInProcessCounters,
  getLastSuccessfulHealthProbeAt,
  getErrorLogPathByIndex,
  listErrorLogFiles,
  tailErrorLogEntries,
  MAX_ROTATIONS as ERROR_LOG_MAX_ROTATIONS,
} from "./services/error-log";
import {
  getAllKillSwitchStates,
  getKillSwitchBlockedStats,
  getKillSwitchHistory,
  isKillSwitchActive,
  isKillSwitchKey,
  KillSwitchActiveError,
  killSwitchEnvVarName,
  killSwitchKeyValues,
  killSwitchLabel,
  setKillSwitchState,
  type KillSwitchKey,
} from "./services/kill-switch";
// Task #155 — global write kill switch (admin toggle + read-only state).
import {
  getWriteKillSwitchState,
  setWriteKillSwitch,
} from "./services/write-kill-switch";
import { requireAuth, requireRole, hashPassword } from "./auth";
import { sendInviteEmail, type InviteRole } from "./email";
// Task #301 — best-effort client notification when an admin Supersedes a
// live consent and a fresh pending request is created. Same helper as the
// adviser POST handler so the audit-log shape is identical regardless of
// trigger source.
import { notifyClientOfFeeConsentRequest } from "./services/fee-consent-notifications";
import { storage } from "./storage";

// ---------------------------------------------------------------------------
// Registration-invite helpers (Session 14)
// Invite security model:
//   - 32 random bytes hex (256-bit entropy)
//   - SHA-256(invite) is what we store in the DB; raw invite returned ONCE on creation
//   - 48h expiry, single-use (usedAt enforced)
//   - Email + role are FROZEN at issue time and cannot be overridden by activation form
// ---------------------------------------------------------------------------
const INVITE_EXPIRY_HOURS = 48;

function mintRegistrationInvite(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

function buildInviteLink(req: Request, rawInvite: string): string {
  // Best-effort: assemble a relative path; the client can prepend its own origin
  // when sharing externally. This avoids hard-coding a hostname.
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.get("host") || "";
  return host ? `${proto}://${host}/register/invite?invite=${rawInvite}` : `/register/invite?invite=${rawInvite}`;
}

// ---------------------------------------------------------------------------
// Audit + error helpers
//
// Hard rule: every admin state change must produce an audit_logs row. We
// therefore (a) accept a transaction handle so the audit insert lives in the
// same transaction as the underlying write, and (b) DO NOT swallow errors —
// if the audit insert fails, the surrounding transaction rolls back and the
// caller gets a 500. Fail-closed is the only correct behaviour for an
// AFSL-grade audit trail.
// ---------------------------------------------------------------------------
type DbHandle = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

async function auditTx(
  handle: DbHandle,
  userId: number,
  action: string,
  entityType: string | null,
  entityId: string | null,
  metadata: unknown,
  ipAddress: string | null,
): Promise<void> {
  await (handle as any).insert(auditLogs).values({
    userId,
    action,
    entityType,
    entityId,
    metadata: metadata as any,
    ipAddress,
  });
}

function handleError(res: any, error: any, fallbackMessage: string) {
  // Task #146 — every admin route surface (including the fee-deduction
  // settle/reverse paths that throw via the fee-engine) MUST emit the
  // canonical 503 envelope when a kill switch is engaged. Centralising
  // here means a future admin route that reuses settleApprovedDeduction
  // (or any other guarded call) gets the right shape automatically.
  if (error instanceof KillSwitchActiveError) {
    return res
      .status(503)
      .json({ error: "operation_disabled", switch: error.switchKey });
  }
  if (error?.status) {
    const payload: Record<string, unknown> = { error: error.message };
    // Errors may attach extra fields (e.g. inviteLink for the email-delivery
    // failure path) so the admin still has a manual fallback even on 5xx.
    if (error.body && typeof error.body === "object") {
      Object.assign(payload, error.body);
    }
    return res.status(error.status).json(payload);
  }
  console.error(`[admin-routes] ${fallbackMessage}:`, error);
  res.status(500).json({ error: fallbackMessage });
}

// ---------------------------------------------------------------------------
// Invite email delivery + audit
//
// Runs AFTER the invite-creation transaction has committed: the invite row
// already exists, so failure here must not roll it back. Instead we:
//   - audit the email attempt (success or failure) on its own row, and
//   - on failure, throw a 502 carrying the inviteLink/expiry so the admin can
//     deliver the link out-of-band as a manual fallback.
// ---------------------------------------------------------------------------
async function deliverInviteEmail(opts: {
  to: string;
  role: InviteRole;
  inviteLink: string;
  expiresAt: Date;
  source: "application_approved" | "direct_invite";
  actorUserId: number;
  ipAddress: string | null;
  relatedEntityType: string | null;
  relatedEntityId: number | null;
}): Promise<{ sent: boolean; error?: string }> {
  const result = await sendInviteEmail(opts.to, opts.role, opts.inviteLink, opts.expiresAt);

  await db.insert(auditLogs).values({
    userId: opts.actorUserId,
    action: result.sent
      ? "registration_invite_email_sent"
      : "registration_invite_email_failed",
    entityType: "registration_invite",
    entityId: opts.to,
    metadata: {
      role: opts.role,
      source: opts.source,
      relatedEntityType: opts.relatedEntityType,
      relatedEntityId: opts.relatedEntityId,
      expiresAt: opts.expiresAt.toISOString(),
      sent: result.sent,
      error: result.error ?? null,
    } as any,
    ipAddress: opts.ipAddress,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
const applicationStatusValues = [
  "email_unverified",
  "submitted",
  "under_review",
  "approved",
  "rejected",
] as const;

const approveApplicationSchema = z.object({
  reviewNote: z.string().max(2000).optional().nullable(),
});

const rejectApplicationSchema = z.object({
  reviewNote: z.string().min(1, "A reason is required for rejection").max(2000),
});

const inviteUserSchema = z.object({
  email: z.string().email().max(255),
  role: z.enum(["client", "adviser", "admin"]),
  // Optional context for the invite. `relatedEntityType` examples:
  // 'adviser_application', 'client_application', 'adviser_firm'. `relatedEntityId`
  // is the FK into that entity. Both nullable.
  relatedEntityType: z.string().min(1).max(64).optional().nullable(),
  relatedEntityId: z.number().int().positive().optional().nullable(),
  // Optional adviser to auto-link this client to on activation. Server validates
  // that the id refers to a real adviser, and that role === 'client'.
  adviserUserId: z.number().int().positive().optional(),
});

const createAdviserSchema = z.object({
  username: z
    .string()
    .min(3, "username must be at least 3 chars")
    .max(50)
    .regex(/^[a-zA-Z0-9_.-]+$/, "username may only contain letters, numbers, _, ., -"),
  email: z.string().email(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  password: z.string().min(8, "password must be at least 8 chars").max(128),
});

const RELATIONSHIP_TYPES = ["servicing", "introducing", "review_only"] as const;

const createLinkSchema = z.object({
  adviserUserId: z.number().int().positive(),
  clientUserId: z.number().int().positive(),
  relationshipType: z.enum(RELATIONSHIP_TYPES).optional(),
});

const updateLinkSchema = z.object({
  isActive: z.boolean(),
});

// ---------------------------------------------------------------------------
// Walk the supersede chain for a given consent OR request and return all
// artefacts touched, sorted oldest → newest by their authoritative timestamp
// (request.createdAt, consent.consentedAt). DFS-with-memo over every link
// type rather than two stitched-together linear walks: that means the same
// algorithm handles deep multi-supersede chains and future link types
// without per-direction edge cases. Bounded transitively by the per-id Set
// so cycles are impossible.
//
// Lifted to module scope (Task #353) so the consent-PDF test can unit-test
// the chain shape directly without reaching through an HTTP route. The
// behaviour is unchanged from the original closure inside
// registerAdminRoutes; the consent-PDF endpoints below still call it.
// ---------------------------------------------------------------------------
export async function buildConsentSupersedeChain(opts: {
  kind: "consent" | "request";
  id: number;
}): Promise<{
  chain: Array<{ ref: string; label: string; status: string; when: Date | null }>;
  requestIds: number[];
  consentIds: number[];
}> {
  const requestIds = new Set<number>();
  const consentIds = new Set<number>();

  async function visitRequest(id: number): Promise<void> {
    if (requestIds.has(id)) return;
    requestIds.add(id);
    const [row] = await db.select().from(feeConsentRequests)
      .where(eq(feeConsentRequests.id, id)).limit(1);
    if (!row) return;
    if (row.supersedesRequestId) await visitRequest(row.supersedesRequestId);
    if (row.signedFeeConsentId) await visitConsent(row.signedFeeConsentId);
  }

  async function visitConsent(id: number): Promise<void> {
    if (consentIds.has(id)) return;
    consentIds.add(id);
    const [row] = await db.select().from(feeConsents)
      .where(eq(feeConsents.id, id)).limit(1);
    if (!row) return;
    const [signingReq] = await db.select({ id: feeConsentRequests.id })
      .from(feeConsentRequests)
      .where(eq(feeConsentRequests.signedFeeConsentId, id)).limit(1);
    if (signingReq) await visitRequest(signingReq.id);
    if (row.supersededByRequestId) await visitRequest(row.supersededByRequestId);
  }

  if (opts.kind === "request") await visitRequest(opts.id);
  else await visitConsent(opts.id);

  const requestIdList = Array.from(requestIds);
  const consentIdList = Array.from(consentIds);
  const reqRows = requestIdList.length > 0
    ? await db.select().from(feeConsentRequests)
        .where(inArray(feeConsentRequests.id, requestIdList))
    : [];
  const conRows = consentIdList.length > 0
    ? await db.select().from(feeConsents)
        .where(inArray(feeConsents.id, consentIdList))
    : [];

  type Entry = {
    ref: string;
    label: string;
    status: string;
    when: Date | null;
    sortKey: number;
  };
  const entries: Entry[] = [];
  for (const r of reqRows) {
    const isAudit = opts.kind === "request" && r.id === opts.id;
    entries.push({
      ref: `FCR-${r.id}`,
      status: r.status,
      when: r.createdAt,
      label: isAudit
        ? "Fee consent request (THIS DOCUMENT)"
        : `Fee consent request · ${r.feeType}`,
      sortKey: r.createdAt?.getTime() ?? 0,
    });
  }
  for (const c of conRows) {
    const isAudit = opts.kind === "consent" && c.id === opts.id;
    entries.push({
      ref: `FC-${c.id}`,
      status: c.renewalStatus,
      when: c.consentedAt,
      label: isAudit
        ? "Signed consent (THIS DOCUMENT)"
        : `Signed consent · ${c.feeType}`,
      sortKey: c.consentedAt?.getTime() ?? 0,
    });
  }
  // Stable sort by timestamp; ties broken by ref (FCR-N ordering before
  // FC-N for the same instant — a request always precedes the consent it
  // produced, even when the seeded test fixture stamps them on the same
  // millisecond).
  entries.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
    return a.ref.startsWith("FCR-") && b.ref.startsWith("FC-") ? -1
      : a.ref.startsWith("FC-") && b.ref.startsWith("FCR-") ? 1 : 0;
  });

  return {
    chain: entries.map(({ sortKey, ...rest }) => rest),
    requestIds: requestIdList,
    consentIds: consentIdList,
  };
}

// Task #324 — narrow helpers for safely reading the free-form `metadata`
// jsonb from audit_logs without spraying `Record<string, any>` through the
// route handlers. The metadata column is typed as `unknown` at the DB
// layer; the writers across the codebase produce a known shape, but a
// regulator-facing read endpoint must defend against legacy / partial /
// hand-written rows. These helpers narrow each access exactly once and
// return a typed value or null, which the route then forwards to the
// frontend (where "—" is rendered for null). No `any` casts.
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function pickString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function pickNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------
export function registerAdminRoutes(app: Express): void {
  // Convenience wrapper: auth + role + try/catch envelope.
  function adminRoute(
    handler: (req: Request, auth: { userId: number; username: string; email: string; role: string }) => Promise<unknown>,
  ) {
    return async (req: Request, res: any) => {
      try {
        const auth = requireAuth(req);
        requireRole(auth, "admin");
        const result = await handler(req, auth);
        res.json(result);
      } catch (error: any) {
        handleError(res, error, "Admin request failed");
      }
    };
  }

  // Streaming variant of `adminRoute` for endpoints that must write the
  // response body themselves (e.g. text/markdown, file downloads). Same
  // auth + role + handleError envelope, but the handler owns the response
  // and is expected to call res.send / res.pipe / etc. We deliberately do
  // NOT call res.json afterwards — handlers that forget to write a body
  // will hang their request, which is a clearer signal than silently
  // returning an empty JSON object.
  //
  // Listed alongside adminRoute / feeReportingRoute in the static
  // coverage check (server/admin-routes-coverage.test.ts) so future
  // contributors can't drop the auth+role guard on streaming endpoints
  // either.
  function adminStreamRoute(
    handler: (
      req: Request,
      res: any,
      auth: { userId: number; username: string; email: string; role: string },
    ) => Promise<void>,
  ) {
    return async (req: Request, res: any) => {
      try {
        const auth = requireAuth(req);
        requireRole(auth, "admin");
        await handler(req, res, auth);
      } catch (error: any) {
        handleError(res, error, "Admin request failed");
      }
    };
  }

  // -------------------------------------------------------------------------
  // GET /api/admin/dashboard — single call for the landing page
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/dashboard",
    adminRoute(async () => {
      const [appsByStatus, advisersCount, clientsCount, linksCount, recentAudit] =
        await Promise.all([
          db
            .select({ status: applications.status, count: sql<number>`count(*)::int` })
            .from(applications)
            .groupBy(applications.status),
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(users)
            .where(eq(users.role, "adviser")),
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(users)
            .where(eq(users.role, "client")),
          db
            .select({
              total: sql<number>`count(*)::int`,
              active: sql<number>`count(*) filter (where ${adviserClients.isActive} = true)::int`,
            })
            .from(adviserClients),
          db
            .select({
              id: auditLogs.id,
              userId: auditLogs.userId,
              action: auditLogs.action,
              entityType: auditLogs.entityType,
              entityId: auditLogs.entityId,
              createdAt: auditLogs.createdAt,
            })
            .from(auditLogs)
            .orderBy(desc(auditLogs.createdAt))
            .limit(15),
        ]);

      const appCounts: Record<string, number> = {
        email_unverified: 0,
        submitted: 0,
        under_review: 0,
        approved: 0,
        rejected: 0,
      };
      for (const row of appsByStatus) {
        appCounts[row.status] = Number(row.count);
      }

      // Task #147 — surface "last successful backup / drill" timestamps on
      // the landing page so the admin sees whether the rollback safety net
      // is healthy without having to navigate away. Wrapped in a try/catch
      // so a failing backup-status query never breaks the whole dashboard.
      const { getBackupStatus } = await import("./services/database-backups");
      type BackupStatusPayload = Awaited<ReturnType<typeof getBackupStatus>>;
      let backups: BackupStatusPayload | null = null;
      try {
        backups = await getBackupStatus();
      } catch (err) {
        console.error("[admin/dashboard] failed to load backup status", err);
      }

      return {
        applications: {
          ...appCounts,
          pending: (appCounts.submitted ?? 0) + (appCounts.under_review ?? 0),
          total: Object.values(appCounts).reduce((a, b) => a + b, 0),
        },
        advisers: { total: Number(advisersCount[0]?.count ?? 0) },
        clients: { total: Number(clientsCount[0]?.count ?? 0) },
        adviserClients: {
          total: Number(linksCount[0]?.total ?? 0),
          active: Number(linksCount[0]?.active ?? 0),
        },
        recentAudit,
        backups,
      };
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/metrics — Task #144 key business metrics tile
  // -------------------------------------------------------------------------
  // Three of the four numbers come straight from the durable tables (the
  // source of truth survives restarts and is per-cluster); the fourth
  // (audit-log write failures) is necessarily process-local because by
  // definition a successful audit-failure DB write is impossible. The
  // response includes the units + window explicitly so the frontend doesn't
  // have to guess: `windowMs` makes "in last 24h" rendering trivial and
  // future-proofs against ever changing the window without a coordinated
  // FE/BE deploy.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/metrics",
    adminRoute(async () => {
      const windowMs = 24 * 60 * 60 * 1000;
      const cutoff = new Date(Date.now() - windowMs);

      // Three independent COUNT(*) queries, run in parallel. Each one hits
      // an existing index (`createdAt`/`status`) so the total cost is
      // bounded even on a busy day.
      const [failedTxRows, feeFailureRows, lastTxFailureRows] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(transactions)
          .where(
            and(
              eq(transactions.status, "failed"),
              gte(transactions.createdAt, cutoff),
            ),
          ),
        // A fee deduction is "failed" in the user-visible sense if it has
        // landed in `insufficient_funds` (the explicit business failure mode)
        // OR has a `failureReason` set in the recorded window (a posting
        // attempt blew up and rolled back). We OR them so a deduction that
        // recovered to settled but failed earlier IS still counted on the
        // tile — operators care about "things that needed attention", not
        // just "things still broken right now".
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(adviserFeeDeductions)
          .where(
            and(
              gte(adviserFeeDeductions.createdAt, cutoff),
              or(
                eq(adviserFeeDeductions.status, "insufficient_funds"),
                sql`${adviserFeeDeductions.failureReason} IS NOT NULL`,
              )!,
            ),
          ),
        // Surface the most recent failed transaction's id so an admin can
        // jump straight to it. Cheapest possible probe — index seek + LIMIT 1.
        db
          .select({ id: transactions.id, createdAt: transactions.createdAt })
          .from(transactions)
          .where(eq(transactions.status, "failed"))
          .orderBy(desc(transactions.createdAt))
          .limit(1),
      ]);

      const counters = getInProcessCounters();
      const lastProbeMs = getLastSuccessfulHealthProbeAt();

      return {
        windowMs,
        generatedAt: new Date().toISOString(),
        failedTransactions: {
          last24h: Number(failedTxRows[0]?.count ?? 0),
          mostRecentId: lastTxFailureRows[0]?.id ?? null,
          mostRecentAt: lastTxFailureRows[0]?.createdAt
            ? new Date(lastTxFailureRows[0].createdAt as Date).toISOString()
            : null,
        },
        feeDeductionFailures: {
          last24h: Number(feeFailureRows[0]?.count ?? 0),
          // Process-local mirror — useful when the DB column is set on a
          // tx-rollback path (failureReason cleared after retry success) and
          // the durable count is artificially low.
          inProcessLast24h: counters.feeDeductionFailuresLast24h,
        },
        // Audit-log write failures are intentionally process-local only —
        // see comment block at the top of `server/services/error-log.ts`.
        // We also expose the in-process 5xx tally so the operator can see
        // whether the persistent error log is being fed at all.
        auditWriteFailures: {
          last24hInProcess: counters.auditWriteFailuresLast24h,
        },
        http5xx: {
          last24hInProcess: counters.http5xxLast24h,
        },
        lastSuccessfulHealthProbe: {
          // ISO timestamp of the last /health 200, or null if no monitor
          // has hit /health since this process started. The FE renders this
          // as "X minutes ago" and shows a warning when null.
          at: lastProbeMs ? new Date(lastProbeMs).toISOString() : null,
          ageMs: lastProbeMs ? Date.now() - lastProbeMs : null,
        },
      };
    }),
  );

  // -------------------------------------------------------------------------
  // Task #155 — Global write kill switch
  //
  // GET  /api/admin/system-status        — full snapshot for the admin UI.
  // POST /api/admin/write-kill-switch    — flip the switch (enabled+reason).
  //
  // Toggle endpoint always writes one audit_logs row with a before/after
  // snapshot of the effective state, so an auditor can reconstruct who
  // paused writes, when, why, and when they resumed.
  //
  // The middleware that enforces 503 for non-admin writes lives in
  // server/middleware/write-kill-switch.ts and runs BEFORE this route, so
  // an admin can always reach the toggle even after enabling it.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/system-status",
    adminRoute(async () => {
      const state = await getWriteKillSwitchState();
      return {
        writeKillSwitch: {
          enabled: state.enabled,
          envOverride: state.envOverride,
          reason: state.reason,
          enabledByUserId: state.enabledByUserId,
          enabledAt: state.enabledAt,
          updatedAt: state.updatedAt,
        },
      };
    }),
  );

  // -------------------------------------------------------------------------
  // Task #155 — POST /api/admin/write-kill-switch (toggle endpoint).
  // Validates body, requires a reason on enable, persists the change, and
  // writes one audit_logs row per call with a before/after snapshot.
  // -------------------------------------------------------------------------
  const writeKillSwitchToggleSchema = z.object({
    enabled: z.boolean(),
    // Reason is required when turning ON (so the audit trail is useful);
    // ignored / nulled when turning OFF.
    reason: z.string().max(500).optional().nullable(),
  });

  app.post(
    "/api/admin/write-kill-switch",
    adminRoute(async (req, auth) => {
      const parsed = writeKillSwitchToggleSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw Object.assign(new Error(parsed.error.errors[0]?.message ?? "Invalid payload"), {
          status: 400,
        });
      }
      const { enabled, reason } = parsed.data;
      if (enabled && (!reason || reason.trim().length === 0)) {
        throw Object.assign(
          new Error("A reason is required when enabling the write kill switch."),
          { status: 400 },
        );
      }

      const result = await setWriteKillSwitch({
        enabled,
        reason: reason ?? null,
        actorUserId: auth.userId,
      });

      // Always write the audit row — even no-op toggles. An admin clicking
      // a "confirm" button is itself a recordable action; the before/after
      // pair makes no-op vs real changes easy to filter.
      try {
        await writeAuditLog({
          userId: auth.userId,
          action: "write_kill_switch.toggled",
          entityType: "system_settings",
          entityId: "1",
          before: {
            enabled: result.before.enabled,
            envOverride: result.before.envOverride,
            reason: result.before.reason,
          },
          after: {
            enabled: result.after.enabled,
            envOverride: result.after.envOverride,
            reason: result.after.reason,
          },
          extra: {
            requestedEnabled: enabled,
            changed: result.changed,
          },
          ipAddress: (req.ip ?? null) as string | null,
        });
      } catch (e) {
        // Audit failure must NOT mask the toggle from the caller — but it
        // also must not be silent. Log loudly and continue; a regulator
        // reading the log stream still sees the gap.
        console.error("[write-kill-switch] audit log insert failed", e);
      }

      return {
        ok: true,
        changed: result.changed,
        writeKillSwitch: {
          enabled: result.after.enabled,
          envOverride: result.after.envOverride,
          reason: result.after.reason,
          enabledByUserId: result.after.enabledByUserId,
          enabledAt: result.after.enabledAt,
          updatedAt: result.after.updatedAt,
        },
      };
    }),
  );

  // -------------------------------------------------------------------------
  // Task #147 — Backup health endpoint. Standalone version of the same
  // payload embedded in /api/admin/dashboard so the dashboard can re-fetch
  // (or a future "Backups" page can fetch only this) without re-running the
  // expensive aggregate queries.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/backups/status",
    adminRoute(async () => {
      const { getBackupStatus } = await import("./services/database-backups");
      return await getBackupStatus();
    }),
  );

  // Task #147 — serve the rollback runbook as the admin help-area link.
  // Returned as text/markdown so an operator clicking through from the
  // dashboard can read it inline in a new tab without needing repo access.
  // Slug-restricted to known runbooks so this route cannot be coaxed into
  // serving arbitrary repo files.
  app.get(
    "/api/admin/runbooks/:slug",
    adminStreamRoute(async (req, res) => {
      const slug = String(req.params.slug ?? "");
      const KNOWN_RUNBOOKS: Record<string, string> = {
        rollback: "docs/runbooks/rollback.md",
      };
      const relPath = KNOWN_RUNBOOKS[slug];
      if (!relPath) {
        res.status(404).json({ error: "Unknown runbook" });
        return;
      }
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const abs = path.resolve(process.cwd(), relPath);
      const body = await fs.readFile(abs, "utf8");
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.send(body);
    }),
  );

  // -------------------------------------------------------------------------
  // Task #165 — admin error log viewer
  // -------------------------------------------------------------------------
  // The persistent 5xx log lives on disk at logs/errors.log (with rotated
  // copies errors.log.1 … errors.log.<MAX_ROTATIONS>). Operators previously
  // had to SSH into the box to read it. These two endpoints expose the same
  // data over the admin API:
  //
  //   GET /api/admin/error-log
  //     Returns the latest N parsed entries (newest first) across all rotated
  //     files, with optional tag / free-text / date filters. Stream-reads the
  //     files line-by-line so a multi-megabyte log never lands on the heap.
  //
  //   GET /api/admin/error-log/download[?file=N]
  //     Streams the raw log file as text/plain so an operator can grab the
  //     full file for offline analysis. `file` defaults to 0 (active log);
  //     1..MAX_ROTATIONS pick a rotated copy.
  //
  // Both are admin-only (the wrapper enforces requireAuth + requireRole) and
  // never write anywhere — no audit log entry is needed for read-only
  // observability tooling.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/error-log",
    adminRoute(async (req) => {
      const limitRaw = req.query.limit;
      const parsedLimit =
        typeof limitRaw === "string" && limitRaw.trim().length > 0
          ? Number(limitRaw)
          : NaN;
      const limit = Number.isInteger(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 1000)
        : 200;

      const tag = typeof req.query.tag === "string" ? req.query.tag : null;
      const q = typeof req.query.q === "string" ? req.query.q : null;
      const fromIso = typeof req.query.from === "string" ? req.query.from : null;
      const toIso = typeof req.query.to === "string" ? req.query.to : null;

      const result = await tailErrorLogEntries({
        limit,
        tag: tag && tag.trim().length > 0 ? tag : null,
        q: q && q.trim().length > 0 ? q : null,
        fromIso: fromIso && fromIso.trim().length > 0 ? fromIso : null,
        toIso: toIso && toIso.trim().length > 0 ? toIso : null,
      });

      return {
        entries: result.entries,
        scannedLines: result.scannedLines,
        matchedLines: result.matchedLines,
        truncated: result.truncated,
        tagsSeen: result.tagsSeen,
        // Strip absolute paths from the file listing — the UI only needs the
        // logical name + size + modified time, and leaking the box's
        // filesystem layout serves no purpose.
        files: result.files.map((f) => ({
          index: f.index,
          name: f.name,
          bytes: f.bytes,
          modifiedAt: f.modifiedAt,
        })),
        limit,
        maxRotations: ERROR_LOG_MAX_ROTATIONS,
      };
    }),
  );

  app.get(
    "/api/admin/error-log/download",
    adminStreamRoute(async (req, res) => {
      const fileRaw = req.query.file;
      const fileIndex = (() => {
        if (typeof fileRaw !== "string" || fileRaw.trim().length === 0) return 0;
        const n = Number(fileRaw);
        if (!Number.isInteger(n) || n < 0 || n > ERROR_LOG_MAX_ROTATIONS) {
          throw Object.assign(new Error("Invalid file index"), { status: 400 });
        }
        return n;
      })();

      const filePath = getErrorLogPathByIndex(fileIndex);
      const files = listErrorLogFiles();
      const meta = files.find((f) => f.index === fileIndex);
      if (!meta) {
        res.status(404).json({ error: "Log file not found" });
        return;
      }

      const fs = await import("node:fs");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${meta.name}"`,
      );
      res.setHeader("Cache-Control", "no-store");
      const stream = fs.createReadStream(filePath, { encoding: "utf8" });
      stream.on("error", (err) => {
        console.error("[admin/error-log/download] stream error", err);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to read log file" });
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    }),
  );


  // -------------------------------------------------------------------------
  // Applications
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/applications",
    adminRoute(async (req) => {
      const status = typeof req.query.status === "string" ? req.query.status : null;
      const validStatus =
        status && (applicationStatusValues as readonly string[]).includes(status)
          ? status
          : null;

      const rows = await db
        .select()
        .from(applications)
        .where(validStatus ? eq(applications.status, validStatus) : sql`true`)
        .orderBy(desc(applications.createdAt))
        .limit(200);

      return rows;
    }),
  );

  app.post(
    "/api/admin/applications/:id/approve",
    adminRoute(async (req, auth) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw Object.assign(new Error("Invalid application id"), { status: 400 });
      }
      const parsed = approveApplicationSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw Object.assign(new Error("Invalid payload"), { status: 400 });
      }

      const [existing] = await db
        .select()
        .from(applications)
        .where(eq(applications.id, id))
        .limit(1);
      if (!existing) {
        throw Object.assign(new Error("Application not found"), { status: 404 });
      }
      if (existing.status === "approved") {
        throw Object.assign(new Error("Application is already approved"), { status: 409 });
      }
      if (existing.status === "rejected") {
        throw Object.assign(new Error("Cannot approve a rejected application"), { status: 409 });
      }
      if (!existing.emailVerified) {
        throw Object.assign(
          new Error("Cannot approve: applicant has not verified their email"),
          { status: 409 },
        );
      }

      // Mirror the activation-time username/email pair check from
      // /api/auth/registration-invites/complete: that endpoint sets
      // username = email on the new user row, so a pre-existing user whose
      // username happens to equal the applicant's email will trigger a 409
      // at /complete via the username UNIQUE constraint. Catching it here
      // avoids the confusing "approved but the invitee still can't activate"
      // dead-end. Residual races where a username==email user is created
      // AFTER this check are caught at /complete.
      const usernameTaken = await storage.getUserByUsername(existing.email);
      if (usernameTaken) {
        throw Object.assign(
          new Error("A user with this email already exists"),
          { status: 409 },
        );
      }

      // Mint registration invite in the same tx as the approval + audit. This
      // closes the loop from "approved application" → "user can actually activate"
      // (Session 14). Without an invite, an approved applicant has no path forward.
      const { raw: rawInvite, hash: inviteHash } = mintRegistrationInvite();
      const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

      let result;
      try {
        result = await db.transaction(async (tx) => {
        // Atomic status gate: only flip to 'approved' if the row is still in a
        // pre-decision state. If two operators race, the loser sees [] back and
        // we throw 409 — preventing duplicate approve+token-mint pairs.
        const [row] = await (tx as any)
          .update(applications)
          .set({
            status: "approved",
            reviewNote: parsed.data.reviewNote ?? existing.reviewNote ?? null,
            reviewedAt: new Date(),
          })
          .where(
            and(
              eq(applications.id, id),
              sql`${applications.status} NOT IN ('approved', 'rejected')`,
            ),
          )
          .returning();
        if (!row) {
          throw Object.assign(
            new Error("Application status changed concurrently — please refresh and try again."),
            { status: 409 },
          );
        }
        await auditTx(
          tx,
          auth.userId,
          "admin_application_approved",
          "application",
          String(id),
          {
            email: existing.email,
            previousStatus: existing.status,
            reviewNote: parsed.data.reviewNote ?? null,
          },
          req.ip || null,
        );

        // Revoke any prior unused invites for this email so only the freshest is live.
        await (tx as any)
          .update(registrationInvites)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(registrationInvites.email, existing.email),
              isNull(registrationInvites.usedAt),
            ),
          );

        await (tx as any).insert(registrationInvites).values({
          email: existing.email,
          role: "client",
          relatedEntityType: "client_application",
          relatedEntityId: id,
          adviserUserId: null,
          inviteHash,
          expiresAt,
          createdBy: auth.userId,
        });

        await auditTx(
          tx,
          auth.userId,
          "registration_invite_created",
          "registration_invite",
          existing.email,
          {
            role: "client",
            source: "application_approved",
            applicationId: id,
            expiresAt: expiresAt.toISOString(),
          },
          req.ip || null,
        );
        return row;
        });
      } catch (err: any) {
        // Partial unique index `registration_invites_email_active_unique` enforces
        // "at most one live invite per email". A concurrent issuer racing us hits
        // 23505; translate to a deterministic 409 instead of a 500.
        if (err?.code === "23505" && String(err?.constraint || "").includes("registration_invites_email_active")) {
          throw Object.assign(
            new Error("Another invitation is already in flight for this email — please refresh and retry."),
            { status: 409 },
          );
        }
        throw err;
      }

      const inviteLink = buildInviteLink(req, rawInvite);

      // Deliver the link by email. The invite already exists in the DB; if SMTP
      // fails we surface a 502 so the admin sees an explicit failure, while
      // keeping the link in the response body as a manual fallback.
      const emailResult = await deliverInviteEmail({
        to: existing.email,
        role: "client",
        inviteLink,
        expiresAt,
        source: "application_approved",
        actorUserId: auth.userId,
        ipAddress: req.ip || null,
        relatedEntityType: "client_application",
        relatedEntityId: id,
      });

      if (!emailResult.sent) {
        throw Object.assign(
          new Error(
            `Application approved but the invitation email could not be sent: ${emailResult.error ?? "unknown error"}. Share the link below manually.`,
          ),
          {
            status: 502,
            body: {
              application: result,
              inviteLink,
              expiresAt: expiresAt.toISOString(),
              emailSent: false,
              emailError: emailResult.error ?? null,
            },
          },
        );
      }

      return {
        application: result,
        inviteLink,
        expiresAt: expiresAt.toISOString(),
        emailSent: true,
      };
    }),
  );

  app.post(
    "/api/admin/applications/:id/reject",
    adminRoute(async (req, auth) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw Object.assign(new Error("Invalid application id"), { status: 400 });
      }
      const parsed = rejectApplicationSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw Object.assign(
          new Error("Invalid payload: " + parsed.error.issues.map((i) => i.message).join("; ")),
          { status: 400 },
        );
      }

      const [existing] = await db
        .select()
        .from(applications)
        .where(eq(applications.id, id))
        .limit(1);
      if (!existing) {
        throw Object.assign(new Error("Application not found"), { status: 404 });
      }
      if (existing.status === "rejected") {
        throw Object.assign(new Error("Application is already rejected"), { status: 409 });
      }
      if (existing.status === "approved") {
        throw Object.assign(new Error("Cannot reject an approved application"), { status: 409 });
      }

      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(applications)
          .set({
            status: "rejected",
            reviewNote: parsed.data.reviewNote,
            reviewedAt: new Date(),
          })
          .where(eq(applications.id, id))
          .returning();
        await auditTx(
          tx,
          auth.userId,
          "admin_application_rejected",
          "application",
          String(id),
          {
            email: existing.email,
            previousStatus: existing.status,
            reviewNote: parsed.data.reviewNote,
          },
          req.ip || null,
        );
        return row;
      });

      return updated;
    }),
  );

  // -------------------------------------------------------------------------
  // Direct invites (Session 14) — admin issues a registration invite without
  // going through the full /apply flow. Used to onboard advisers, or to
  // pre-link a client to a specific adviser at issue time.
  //
  // Security:
  //   - Admin-only (requireRole enforced by adminRoute wrapper).
  //   - Email is frozen on the token; registration form cannot override it.
  //   - Role is frozen on the token; cannot self-promote to adviser.
  //   - If role=client + adviserUserId set, the new client is auto-linked to that
  //     adviser via adviser_clients on registration (in the same registration tx).
  //   - Existing live tokens for the same email are revoked (only newest is valid).
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/registration-invites",
    adminRoute(async (req, auth) => {
      const parsed = inviteUserSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw Object.assign(
          new Error("Invalid payload: " + parsed.error.issues.map((i) => i.message).join("; ")),
          { status: 400 },
        );
      }
      const { email, role, relatedEntityType, relatedEntityId, adviserUserId } = parsed.data;
      const normalisedEmail = normalizeEmail(email);

      // Adviser-link guard: cheap, race-free, can stay outside the tx.
      // (If the adviser is somehow deleted between this check and the insert,
      //  the FK on registration_invites.adviser_user_id would reject it anyway.)
      if (adviserUserId !== undefined) {
        if (role !== "client") {
          throw Object.assign(
            new Error("adviserUserId can only be set when role is 'client'"),
            { status: 400 },
          );
        }
        const [adv] = await db
          .select({ id: users.id, role: users.role })
          .from(users)
          .where(eq(users.id, adviserUserId))
          .limit(1);
        if (!adv || adv.role !== "adviser") {
          throw Object.assign(
            new Error("adviserUserId does not refer to an adviser"),
            { status: 400 },
          );
        }
      }

      // Mirror the activation-time username/email pair check from
      // /api/auth/registration-invites/complete: that endpoint sets
      // username = email on the new user row, so a pre-existing user whose
      // username happens to equal the invitee's email will trigger a 409 at
      // /complete via the username UNIQUE constraint. Without this guard,
      // admins would see "invitation issued" only for the invitee to hit a
      // dead-end 409 after typing a password. The atomicity guarantee for
      // the rare race where a username==email user is created AFTER this
      // check but BEFORE /complete is still owed to the activation tx,
      // exactly as for the email check below.
      const usernameTaken = await storage.getUserByUsername(normalisedEmail);
      if (usernameTaken) {
        throw Object.assign(
          new Error("A user with this email already exists"),
          { status: 409 },
        );
      }

      const { raw: rawInvite, hash: inviteHash } = mintRegistrationInvite();
      const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

      try {
        await db.transaction(async (tx) => {
          // Re-check for an existing user INSIDE the tx so the SELECT and the
          // invite INSERT happen in the same atomic unit. This collapses the
          // create-invite race window from ~ms-of-network down to a single
          // tx — practically eliminating the "issue invite for an email that
          // is being registered right now" UX hazard.
          //
          // Final atomicity (against a user committing AFTER this SELECT but
          // BEFORE our INSERT) is still owed to the activation tx, which
          // re-checks via the users.email UNIQUE constraint and maps 23505
          // to a clean 409. We deliberately don't escalate to SERIALIZABLE
          // here — the cost (retry loops in admin code) outweighs the
          // sub-millisecond residual race window.
          // Case-insensitive lookup so User@x.com and user@x.com collapse to
          // the same identity. Belt-and-braces: the users_email_lower_unique
          // index is the DB-level safety net.
          const [existingUser] = await (tx as any)
            .select({ id: users.id })
            .from(users)
            .where(sql`lower(${users.email}) = ${normalisedEmail}`)
            .limit(1);
          if (existingUser) {
            // Tag the rejection so the surrounding catch can emit a clean,
            // post-rollback audit row (audit inside the tx would roll back
            // with the rejection itself).
            throw Object.assign(
              new Error("A user with this email already exists"),
              { status: 409, code: "DUP_USER_EMAIL", existingUserId: existingUser.id },
            );
          }

          // Revoke any prior live invites for this email so only the freshest is valid.
          await (tx as any)
            .update(registrationInvites)
            .set({ usedAt: new Date() })
            .where(
              and(
                eq(registrationInvites.email, normalisedEmail),
                isNull(registrationInvites.usedAt),
              ),
            );

          await (tx as any).insert(registrationInvites).values({
            email: normalisedEmail,
            role,
            relatedEntityType: relatedEntityType ?? "invite",
            relatedEntityId: relatedEntityId ?? null,
            adviserUserId: adviserUserId ?? null,
            inviteHash,
            expiresAt,
            createdBy: auth.userId,
          });

          await auditTx(
            tx,
            auth.userId,
            "registration_invite_created",
            "registration_invite",
            normalisedEmail,
            {
              role,
              source: "direct_invite",
              relatedEntityType: relatedEntityType ?? "invite",
              relatedEntityId: relatedEntityId ?? null,
              adviserUserId: adviserUserId ?? null,
              expiresAt: expiresAt.toISOString(),
            },
            req.ip || null,
          );
        });
      } catch (err: any) {
        // Audit the existing-user rejection on the way out. The audit row lives
        // OUTSIDE the rolled-back transaction so the rejection is still
        // discoverable in the audit trail. Mirrors the validate/complete-time
        // emission of `registration_invite_rejected_duplicate_email` so admin
        // and self-serve rejection paths show up under one action name.
        if (err?.code === "DUP_USER_EMAIL") {
          await db.insert(auditLogs).values({
            userId: auth.userId,
            action: "registration_invite_rejected_duplicate_email",
            entityType: "registration_invite",
            entityId: null,
            metadata: {
              email: normalisedEmail,
              role,
              stage: "create_invite",
              existingUserId: err.existingUserId ?? null,
            } as any,
            ipAddress: req.ip || null,
          }).catch(() => { /* never let audit failure mask the 409 */ });
          throw Object.assign(
            new Error("A user with this email already exists."),
            { status: 409 },
          );
        }
        // Partial unique index ensures only one live invite per email; concurrent
        // issuers race here. Translate the unique-violation to a clean 409.
        // We check both the case-sensitive and case-insensitive partial unique
        // indexes — either one firing means another invite is already in flight.
        if (
          err?.code === "23505" &&
          (String(err?.constraint || "").includes("registration_invites_email_active") ||
            String(err?.constraint || "").includes("registration_invites_email_lower_active"))
        ) {
          throw Object.assign(
            new Error("Another invitation is already in flight for this email — please refresh and retry."),
            { status: 409 },
          );
        }
        throw err;
      }

      const inviteLink = buildInviteLink(req, rawInvite);

      // Deliver the link by email. The invite already exists in the DB; if SMTP
      // fails we surface a 502 so the admin sees an explicit failure, while
      // keeping the link in the response body as a manual fallback.
      const emailResult = await deliverInviteEmail({
        to: normalisedEmail,
        role,
        inviteLink,
        expiresAt,
        source: "direct_invite",
        actorUserId: auth.userId,
        ipAddress: req.ip || null,
        relatedEntityType: relatedEntityType ?? "invite",
        relatedEntityId: relatedEntityId ?? null,
      });

      if (!emailResult.sent) {
        throw Object.assign(
          new Error(
            `Invitation created but the email could not be sent: ${emailResult.error ?? "unknown error"}. Share the link below manually.`,
          ),
          {
            status: 502,
            body: {
              email: normalisedEmail,
              role,
              inviteLink,
              expiresAt: expiresAt.toISOString(),
              emailSent: false,
              emailError: emailResult.error ?? null,
            },
          },
        );
      }

      return {
        email: normalisedEmail,
        role,
        inviteLink,
        expiresAt: expiresAt.toISOString(),
        emailSent: true,
      };
    }),
  );

  // -------------------------------------------------------------------------
  // Advisers
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/advisers",
    adminRoute(async () => {
      // Count active client links per adviser in a single round trip.
      const rows = await db
        .select({
          id: users.id,
          username: users.username,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          createdAt: users.createdAt,
          // Drizzle renders `${users.id}` as the bare column name `"id"`,
          // which inside this correlated subquery resolves to
          // `adviser_clients.id` (the only table in scope) rather than the
          // outer `users.id`. The WHERE clause then silently degrades to
          // `adviser_clients.adviser_user_id = adviser_clients.id` and the
          // count is essentially always 0. Pin the outer reference
          // explicitly — same fix as Tasks #342 and #372 on the fee-consents
          // subqueries.
          activeClients: sql<number>`(
            SELECT COUNT(*)::int FROM ${adviserClients}
            WHERE ${adviserClients.adviserUserId} = ${sql.raw('"users"."id"')}
              AND ${adviserClients.isActive} = true
          )`,
        })
        .from(users)
        .where(eq(users.role, "adviser"))
        .orderBy(asc(users.username));

      return rows;
    }),
  );

  app.post(
    "/api/admin/advisers",
    adminRoute(async (req, auth) => {
      const parsed = createAdviserSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(
          new Error("Invalid payload: " + parsed.error.issues.map((i) => i.message).join("; ")),
          { status: 400 },
        );
      }
      const data = parsed.data;

      // Canonicalise email at the boundary so the existence check and the
      // insert use the same form. Combined with the lower(email) UNIQUE index
      // this means User@x.com and user@x.com cannot both be created as
      // advisers, even via this admin path.
      const normalisedEmail = normalizeEmail(data.email);

      // Uniqueness checks (race-tolerated by the unique indexes too)
      const [byName] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, data.username))
        .limit(1);
      if (byName) {
        throw Object.assign(new Error("Username is already taken"), { status: 409 });
      }
      const [byEmail] = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${normalisedEmail}`)
        .limit(1);
      if (byEmail) {
        throw Object.assign(new Error("Email is already in use"), { status: 409 });
      }

      const hashed = await hashPassword(data.password);
      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(users)
          .values({
            username: data.username,
            email: normalisedEmail,
            firstName: data.firstName,
            lastName: data.lastName,
            password: hashed,
            role: "adviser",
            // KYC is for retail clients; adviser staff don't go through the
            // same onboarding path. Mark verified so the new adviser can sign in.
            kycStatus: "verified",
            emailVerified: true,
          })
          .returning({
            id: users.id,
            username: users.username,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            createdAt: users.createdAt,
          });
        await auditTx(
          tx,
          auth.userId,
          "admin_adviser_created",
          "user",
          String(row.id),
          { username: row.username, email: row.email },
          req.ip || null,
        );
        return row;
      });

      return { ...created, activeClients: 0 };
    }),
  );

  // -------------------------------------------------------------------------
  // Clients (read-only — used by the "assign client" picker)
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/clients",
    adminRoute(async (req) => {
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const where = q
        ? sql`${users.role} = 'client' AND (
            ${users.username} ILIKE ${"%" + q + "%"} OR
            ${users.email} ILIKE ${"%" + q + "%"} OR
            ${users.firstName} ILIKE ${"%" + q + "%"} OR
            ${users.lastName} ILIKE ${"%" + q + "%"}
          )`
        : eq(users.role, "client");

      const rows = await db
        .select({
          id: users.id,
          username: users.username,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          kycStatus: users.kycStatus,
        })
        .from(users)
        .where(where)
        .orderBy(asc(users.username))
        .limit(100);

      return rows;
    }),
  );

  // -------------------------------------------------------------------------
  // Adviser-client links
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/adviser-clients",
    adminRoute(async () => {
      // We join twice on `users` (once for adviser, once for client) by aliasing
      // on the SQL side. Drizzle's typed select handles this cleanly with sql<T>.
      const rows = await db
        .select({
          id: adviserClients.id,
          adviserUserId: adviserClients.adviserUserId,
          clientUserId: adviserClients.clientUserId,
          relationshipType: adviserClients.relationshipType,
          isActive: adviserClients.isActive,
          linkedAt: adviserClients.linkedAt,
          unlinkedAt: adviserClients.unlinkedAt,
          adviserUsername: sql<string>`(SELECT username FROM ${users} u WHERE u.id = ${adviserClients.adviserUserId})`,
          adviserEmail: sql<string>`(SELECT email FROM ${users} u WHERE u.id = ${adviserClients.adviserUserId})`,
          clientUsername: sql<string>`(SELECT username FROM ${users} u WHERE u.id = ${adviserClients.clientUserId})`,
          clientEmail: sql<string>`(SELECT email FROM ${users} u WHERE u.id = ${adviserClients.clientUserId})`,
          clientFirstName: sql<string>`(SELECT first_name FROM ${users} u WHERE u.id = ${adviserClients.clientUserId})`,
          clientLastName: sql<string>`(SELECT last_name FROM ${users} u WHERE u.id = ${adviserClients.clientUserId})`,
        })
        .from(adviserClients)
        .orderBy(desc(adviserClients.linkedAt))
        .limit(500);

      return rows;
    }),
  );

  app.post(
    "/api/admin/adviser-clients",
    adminRoute(async (req, auth) => {
      const parsed = createLinkSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(
          new Error("Invalid payload: " + parsed.error.issues.map((i) => i.message).join("; ")),
          { status: 400 },
        );
      }
      const data = parsed.data;

      // Validate both ends actually exist with the right roles.
      const [adviser] = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.id, data.adviserUserId))
        .limit(1);
      if (!adviser) {
        throw Object.assign(new Error("Adviser not found"), { status: 404 });
      }
      if (adviser.role !== "adviser") {
        throw Object.assign(new Error("Target user is not an adviser"), { status: 400 });
      }
      const [client] = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.id, data.clientUserId))
        .limit(1);
      if (!client) {
        throw Object.assign(new Error("Client not found"), { status: 404 });
      }
      if (client.role !== "client") {
        throw Object.assign(new Error("Target user is not a client"), { status: 400 });
      }

      // If a link already exists for this pair, don't create a duplicate —
      // re-activate the existing row instead. The unique index would block
      // double-inserts anyway, but this gives a friendly response.
      const [existing] = await db
        .select()
        .from(adviserClients)
        .where(
          and(
            eq(adviserClients.adviserUserId, data.adviserUserId),
            eq(adviserClients.clientUserId, data.clientUserId),
          ),
        )
        .limit(1);

      const result = await db.transaction(async (tx) => {
        let row;
        let action: string;
        if (existing) {
          const [updated] = await tx
            .update(adviserClients)
            .set({
              isActive: true,
              unlinkedAt: null,
              relationshipType: data.relationshipType ?? existing.relationshipType,
            })
            .where(eq(adviserClients.id, existing.id))
            .returning();
          row = updated;
          action = "admin_adviser_client_reactivated";
        } else {
          const [inserted] = await tx
            .insert(adviserClients)
            .values({
              adviserUserId: data.adviserUserId,
              clientUserId: data.clientUserId,
              relationshipType: data.relationshipType ?? "servicing",
              isActive: true,
            })
            .returning();
          row = inserted;
          action = "admin_adviser_client_linked";
        }
        await auditTx(
          tx,
          auth.userId,
          action,
          "adviser_client",
          String(row.id),
          {
            adviserUserId: data.adviserUserId,
            clientUserId: data.clientUserId,
            relationshipType: row.relationshipType,
          },
          req.ip || null,
        );
        return row;
      });

      return result;
    }),
  );

  app.patch(
    "/api/admin/adviser-clients/:id",
    adminRoute(async (req, auth) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw Object.assign(new Error("Invalid link id"), { status: 400 });
      }
      const parsed = updateLinkSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(new Error("Invalid payload"), { status: 400 });
      }

      const [existing] = await db
        .select()
        .from(adviserClients)
        .where(eq(adviserClients.id, id))
        .limit(1);
      if (!existing) {
        throw Object.assign(new Error("Link not found"), { status: 404 });
      }

      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(adviserClients)
          .set({
            isActive: parsed.data.isActive,
            unlinkedAt: parsed.data.isActive ? null : new Date(),
          })
          .where(eq(adviserClients.id, id))
          .returning();
        await auditTx(
          tx,
          auth.userId,
          parsed.data.isActive ? "admin_adviser_client_reactivated" : "admin_adviser_client_deactivated",
          "adviser_client",
          String(id),
          {
            adviserUserId: existing.adviserUserId,
            clientUserId: existing.clientUserId,
            previousIsActive: existing.isActive,
          },
          req.ip || null,
        );
        return row;
      });

      return updated;
    }),
  );

  // -------------------------------------------------------------------------
  // Audit log viewer (paginated, filterable)
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/audit-logs",
    adminRoute(async (req) => {
      const action = typeof req.query.action === "string" ? req.query.action.trim() : "";
      const entityType = typeof req.query.entityType === "string" ? req.query.entityType.trim() : "";
      // Task #293 — added entityId filter so the admin fee-consents drawer
      // can pull a focused audit timeline for one request or one consent.
      const entityId = typeof req.query.entityId === "string" ? req.query.entityId.trim() : "";
      const userIdRaw = typeof req.query.userId === "string" ? Number(req.query.userId) : null;
      const userId = userIdRaw && Number.isInteger(userIdRaw) && userIdRaw > 0 ? userIdRaw : null;
      // Task #399 — exact-row targeting via auditLogId. Used by the
      // Background Jobs page's "View audit" deep-link so a click lands on
      // exactly ONE row instead of every audit entry that ever touched
      // the same (action, entityType, entityId) tuple.
      const idRaw = typeof req.query.id === "string" ? Number(req.query.id) : null;
      const exactId = idRaw && Number.isInteger(idRaw) && idRaw > 0 ? idRaw : null;

      const limit = Math.min(
        Math.max(Number(req.query.limit) || 50, 1),
        200,
      );
      const page = Math.max(Number(req.query.page) || 1, 1);
      const offset = (page - 1) * limit;

      const conditions = [] as any[];
      if (action) conditions.push(ilike(auditLogs.action, `%${action}%`));
      if (entityType) conditions.push(eq(auditLogs.entityType, entityType));
      if (entityId) conditions.push(eq(auditLogs.entityId, entityId));
      if (userId) conditions.push(eq(auditLogs.userId, userId));
      if (exactId) conditions.push(eq(auditLogs.id, exactId));
      const where = conditions.length ? and(...conditions) : undefined;

      const [rows, totalRow] = await Promise.all([
        db
          .select({
            id: auditLogs.id,
            userId: auditLogs.userId,
            action: auditLogs.action,
            entityType: auditLogs.entityType,
            entityId: auditLogs.entityId,
            metadata: auditLogs.metadata,
            ipAddress: auditLogs.ipAddress,
            createdAt: auditLogs.createdAt,
          })
          .from(auditLogs)
          .where(where as any)
          .orderBy(desc(auditLogs.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(auditLogs)
          .where(where as any),
      ]);

      return {
        items: rows,
        page,
        limit,
        total: Number(totalRow[0]?.count ?? 0),
      };
    }),
  );

  // -------------------------------------------------------------------------
  // SESSION 25 (Task #17) — Wallet ↔ ledger reconciliation viewer
  // -------------------------------------------------------------------------
  // LEDGER IS THE SOURCE OF TRUTH — wallet cache is derived only.
  //
  // Returns the MOST RECENT reconciliation row per (userId, currency),
  // joined with the user's username for display, with optional `status`
  // (`match` / `mismatch`) and `currency` filters and pagination.
  //
  // Strictly read-only. Cannot mutate ledger entries, wallets, or
  // reconciliation rows.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/wallet-ledger-reconciliations",
    adminRoute(async (req) => {
      const statusRaw = typeof req.query.status === "string" ? req.query.status.trim() : "";
      const currencyRaw = typeof req.query.currency === "string" ? req.query.currency.trim().toUpperCase() : "";
      const validStatus = statusRaw === "match" || statusRaw === "mismatch" ? statusRaw : null;
      const validCurrency = /^[A-Z]{3,10}$/.test(currencyRaw) ? currencyRaw : null;

      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const offset = (page - 1) * limit;

      // Optional drill-down filter: a comma-separated list of `userId:CCY`
      // pairs. Used by the fees-tab drift card so a click lands on exactly
      // the same source rows the card counted. Pairs are validated and
      // bound parametrically — never interpolated as raw SQL.
      //
      // We deliberately do NOT cap the number of pairs here: the card's
      // contract is "the count never disagrees with what the recon page
      // shows", so silently truncating the filter would break parity.
      // Volume is bounded by the number of distinct (user, currency) pairs
      // touched by fee deductions in the period — small in practice, and
      // the surrounding URL/HTTP layer will reject inputs that exceed
      // their own limits before we get here.
      const pairsRaw = typeof req.query.pairs === "string" ? req.query.pairs.trim() : "";
      const pairFilters: { userId: number; currency: string }[] = [];
      const seenPairKeys = new Set<string>();
      if (pairsRaw) {
        for (const part of pairsRaw.split(",")) {
          const [uidStr, ccyStr] = part.split(":");
          const uid = Number(uidStr);
          const ccy = (ccyStr ?? "").trim().toUpperCase();
          if (
            Number.isInteger(uid) &&
            uid > 0 &&
            /^[A-Z]{3,10}$/.test(ccy)
          ) {
            const key = `${uid}|${ccy}`;
            if (!seenPairKeys.has(key)) {
              seenPairKeys.add(key);
              pairFilters.push({ userId: uid, currency: ccy });
            }
          }
        }
      }

      // Build the filter chunk used in both the items query and the count
      // query. Parameters are bound via the `sql` template tag so user input
      // can never be concatenated into the SQL text.
      const statusFilter = validStatus
        ? sql`AND r.status = ${validStatus}`
        : sql``;
      const currencyFilter = validCurrency
        ? sql`AND r.currency = ${validCurrency}`
        : sql``;
      // When `pairs` is provided but parses to zero valid pairs, force an
      // empty result rather than silently returning everything.
      const pairsFilter = pairsRaw
        ? pairFilters.length === 0
          ? sql`AND FALSE`
          : sql`AND (r.user_id, r.currency) IN (${sql.join(
              pairFilters.map((p) => sql`(${p.userId}, ${p.currency})`),
              sql`, `,
            )})`
        : sql``;

      // Pull the latest row per (userId, currency) using ROW_NUMBER. Volume
      // is bounded by the number of distinct (user, currency) pairs, so this
      // stays cheap even at 10k+ users. Mismatches are bubbled to the top
      // so admins can triage drift first.
      //
      // Task #143 — exclude rows that belong to demo users (`users.is_demo`).
      // The reconciliation service no longer writes new rows for demo users
      // (see `runWalletLedgerReconciliation`), but historical rows from
      // before the fix are still in the table; we filter them out here so
      // the admin Reconciliation page is not dominated by demo-data noise.
      const itemsResult = await db.execute(sql`
        WITH ranked AS (
          SELECT
            id, user_id, currency, wallet_cached_balance, ledger_sum_balance,
            drift_amount, status, severity, notes, created_at,
            ROW_NUMBER() OVER (PARTITION BY user_id, currency ORDER BY created_at DESC, id DESC) AS rn
          FROM wallet_ledger_reconciliations
        )
        SELECT r.id,
               r.user_id        AS "userId",
               r.currency,
               r.wallet_cached_balance AS "walletCachedBalance",
               r.ledger_sum_balance    AS "ledgerSumBalance",
               r.drift_amount   AS "driftAmount",
               r.status, r.severity, r.notes,
               r.created_at     AS "createdAt",
               u.username       AS "username"
          FROM ranked r
          LEFT JOIN users u ON u.id = r.user_id
         WHERE r.rn = 1
           AND COALESCE(u.is_demo, FALSE) = FALSE
         ${statusFilter}
         ${currencyFilter}
         ${pairsFilter}
         ORDER BY (CASE WHEN r.status = 'mismatch' THEN 0 ELSE 1 END),
                  r.created_at DESC
         LIMIT ${limit}
        OFFSET ${offset}
      `);

      const totalResult = await db.execute(sql`
        WITH ranked AS (
          SELECT user_id, currency, status,
                 ROW_NUMBER() OVER (PARTITION BY user_id, currency ORDER BY created_at DESC, id DESC) AS rn
          FROM wallet_ledger_reconciliations
        )
        SELECT COUNT(*)::int AS count
          FROM ranked r
          LEFT JOIN users u ON u.id = r.user_id
         WHERE r.rn = 1
           AND COALESCE(u.is_demo, FALSE) = FALSE
         ${statusFilter}
         ${currencyFilter}
         ${pairsFilter}
      `);

      const items = (itemsResult as any).rows ?? [];
      const total = Number(((totalResult as any).rows ?? [{ count: 0 }])[0]?.count ?? 0);

      // Task #35 — enrich each item with the active acknowledgement (if any)
      // so the admin UI can show "alert suppressed because acknowledged on
      // YYYY-MM-DD by Z" without a second round-trip per row.
      let acks: any[] = [];
      if (items.length > 0) {
        const pairs = items.map((r: any) => sql`(${Number(r.userId)}, ${String(r.currency)})`);
        const inList = sql.join(pairs, sql`, `);
        const ackResult = await db.execute(sql`
          SELECT a.id,
                 a.user_id              AS "userId",
                 a.currency,
                 a.acknowledged_drift_amount AS "acknowledgedDriftAmount",
                 a.note,
                 a.kind,
                 a.acknowledged_by_user_id   AS "acknowledgedByUserId",
                 a.acknowledged_at      AS "acknowledgedAt",
                 u.username             AS "acknowledgedByUsername"
            FROM wallet_ledger_drift_acknowledgements a
            LEFT JOIN users u ON u.id = a.acknowledged_by_user_id
           WHERE a.cleared_at IS NULL
             AND (a.user_id, a.currency) IN (${inList})
        `);
        acks = (ackResult as any).rows ?? [];
      }
      // Task #203 — compute the per-ack expiry on the way out so the client
      // can render "expired" without needing to know the TTL config. We also
      // include the boolean `isExpired` so the UI doesn't have to re-derive
      // it (and so a future change in clock skew handling is centralised).
      const ackByPair = new Map<string, any>();
      const ttlDays = getDriftAckTtlDays();
      const nowMs = Date.now();
      for (const a of acks) {
        const ackAtMs = new Date(a.acknowledgedAt).getTime();
        const expiresAt = new Date(ackAtMs + ttlDays * 86_400_000);
        const enrichedAck = {
          ...a,
          kind: a.kind ?? "acknowledge",
          expiresAt,
          isExpired: expiresAt.getTime() <= nowMs,
        };
        ackByPair.set(
          `${Number(a.userId)}|${String(a.currency)}`,
          enrichedAck,
        );
      }
      const enriched = items.map((r: any) => ({
        ...r,
        activeAcknowledgement:
          ackByPair.get(`${Number(r.userId)}|${String(r.currency)}`) ?? null,
      }));

      return { items: enriched, page, limit, total, ttlDays };
    }),
  );

  // -------------------------------------------------------------------------
  // SESSION 28 (Task #35) — DRIFT ACKNOWLEDGEMENTS
  // -------------------------------------------------------------------------
  // Suppress repeat operator pages on a known drift case. The next
  // reconciliation pass will see the active acknowledgement and skip the
  // notifyOperator call as long as the drift hasn't moved by more than
  // MATCH_EPSILON since the snapshot was taken. The reconciliation row
  // itself is still written every day — the audit trail must show drift
  // continued to exist.
  //
  // These endpoints exist as the minimum needed to drive suppression; a
  // sibling task ("Let admins resolve and annotate ledger drift from the
  // reconciliation page") layers a richer UI on top of the same data model.
  // -------------------------------------------------------------------------
  // Task #203 — `kind` distinguishes "we're investigating" (acknowledge) from
  // "we believe this is fixed" (resolve). Both suppress operator notifications
  // identically — the difference is admin intent and is rendered differently
  // in the UI. Resolve REQUIRES a free-text note ("what corrective entry was
  // posted / why we believe this is closed"); acknowledge accepts an empty
  // note. Validation is enforced server-side so the UI cannot bypass it.
  const ackDriftSchema = z
    .object({
      userId: z.number().int().positive(),
      currency: z
        .string()
        .trim()
        .min(2)
        .max(10)
        .transform((s) => s.toUpperCase()),
      note: z.string().trim().max(2000).optional().nullable(),
      kind: z
        .enum(["acknowledge", "resolve"])
        .optional()
        .default("acknowledge"),
    })
    .superRefine((val, ctx) => {
      if (val.kind === "resolve") {
        const noteText = (val.note ?? "").trim();
        if (noteText.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["note"],
            message: "A note is required when resolving a drift case.",
          });
        }
      }
    });

  const clearAckDriftSchema = z.object({
    userId: z.number().int().positive(),
    currency: z
      .string()
      .trim()
      .min(2)
      .max(10)
      .transform((s) => s.toUpperCase()),
    reason: z.string().trim().max(2000).optional().nullable(),
  });

  app.post(
    "/api/admin/wallet-ledger-reconciliations/acknowledge",
    adminRoute(async (req, auth) => {
      const parsed = ackDriftSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(new Error(parsed.error.issues.map((i) => i.message).join("; ")), {
          status: 400,
        });
      }
      const { userId, currency, note, kind } = parsed.data;

      try {
        const ack = await acknowledgeWalletLedgerDrift({
          userId,
          currency,
          note: note ?? null,
          actorUserId: auth.userId,
          kind,
        });
        await db.insert(auditLogs).values({
          userId: auth.userId,
          // Task #203 — distinct action verb so audit-log readers can tell
          // "we marked this fixed" apart from "we are aware, investigating".
          action:
            kind === "resolve"
              ? "wallet_ledger_drift_resolved"
              : "wallet_ledger_drift_acknowledged",
          entityType: "wallet_ledger_drift_acknowledgement",
          entityId: String(ack.id),
          metadata: {
            targetUserId: userId,
            currency,
            kind,
            acknowledgedDriftAmount: ack.acknowledgedDriftAmount,
            note: note ?? null,
            ttlDays: getDriftAckTtlDays(),
            note_to_ops:
              "Operator notifications for this drift case will be suppressed until the drift moves > MATCH_EPSILON, this acknowledgement is cleared, or the TTL window lapses.",
          } as any,
          ipAddress: req.ip ?? null,
        });
        return {
          acknowledgement: {
            ...ack,
            expiresAt: computeDriftAckExpiresAt(ack.acknowledgedAt),
          },
        };
      } catch (err: any) {
        if (err instanceof DriftAckConflictError) {
          throw Object.assign(new Error(err.message), { status: 409 });
        }
        if (err instanceof DriftAckNoMismatchError) {
          throw Object.assign(new Error(err.message), { status: 400 });
        }
        throw err;
      }
    }),
  );

  app.post(
    "/api/admin/wallet-ledger-reconciliations/clear-acknowledgement",
    adminRoute(async (req, auth) => {
      const parsed = clearAckDriftSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(new Error(parsed.error.issues.map((i) => i.message).join("; ")), {
          status: 400,
        });
      }
      const { userId, currency, reason } = parsed.data;

      try {
        const cleared = await clearWalletLedgerDriftAcknowledgement({
          userId,
          currency,
          actorUserId: auth.userId,
          reason: reason ?? null,
        });
        await db.insert(auditLogs).values({
          userId: auth.userId,
          action: "wallet_ledger_drift_acknowledgement_cleared",
          entityType: "wallet_ledger_drift_acknowledgement",
          entityId: String(cleared.id),
          metadata: {
            targetUserId: userId,
            currency,
            reason: reason ?? null,
            note_to_ops:
              "Operator notifications resume on the next mismatch for this drift case.",
          } as any,
          ipAddress: req.ip ?? null,
        });
        return { acknowledgement: cleared };
      } catch (err: any) {
        if (err instanceof DriftAckNotFoundError) {
          throw Object.assign(new Error(err.message), { status: 404 });
        }
        throw err;
      }
    }),
  );

  app.get(
    "/api/admin/wallet-ledger-drift-acknowledgements",
    adminRoute(async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const offset = (page - 1) * limit;
      const activeOnly = String(req.query.activeOnly ?? "").toLowerCase() === "true";

      // Task #203 — optional per-pair filter so the reconciliation page can
      // hydrate the "ack history for this drift case" collapsible without
      // scanning the whole table. Both must be supplied together; passing
      // only one is treated as no filter so a stray `?userId=` query
      // doesn't accidentally leak unrelated currencies.
      const userIdRaw =
        typeof req.query.userId === "string" ? req.query.userId.trim() : "";
      const currencyRaw =
        typeof req.query.currency === "string"
          ? req.query.currency.trim().toUpperCase()
          : "";
      const userIdNum = Number(userIdRaw);
      const validPairFilter =
        userIdRaw &&
        currencyRaw &&
        Number.isInteger(userIdNum) &&
        userIdNum > 0 &&
        /^[A-Z]{3,10}$/.test(currencyRaw);
      const pairFilter = validPairFilter
        ? sql`AND a.user_id = ${userIdNum} AND a.currency = ${currencyRaw}`
        : sql``;
      const pairFilterCount = validPairFilter
        ? sql`AND user_id = ${userIdNum} AND currency = ${currencyRaw}`
        : sql``;

      const result = await db.execute(sql`
        SELECT a.id,
               a.user_id                  AS "userId",
               a.currency,
               a.acknowledged_drift_amount AS "acknowledgedDriftAmount",
               a.note,
               a.kind,
               a.acknowledged_by_user_id  AS "acknowledgedByUserId",
               a.acknowledged_at          AS "acknowledgedAt",
               a.cleared_at               AS "clearedAt",
               a.cleared_by_user_id       AS "clearedByUserId",
               a.clear_reason             AS "clearReason",
               u.username                 AS "username",
               ua.username                AS "acknowledgedByUsername",
               uc.username                AS "clearedByUsername"
          FROM wallet_ledger_drift_acknowledgements a
          LEFT JOIN users u  ON u.id  = a.user_id
          LEFT JOIN users ua ON ua.id = a.acknowledged_by_user_id
          LEFT JOIN users uc ON uc.id = a.cleared_by_user_id
         WHERE 1 = 1
           ${activeOnly ? sql`AND a.cleared_at IS NULL` : sql``}
           ${pairFilter}
         ORDER BY a.acknowledged_at DESC, a.id DESC
         LIMIT ${limit}
        OFFSET ${offset}
      `);
      const totalResult = await db.execute(sql`
        SELECT COUNT(*)::int AS count
          FROM wallet_ledger_drift_acknowledgements
         WHERE 1 = 1
           ${activeOnly ? sql`AND cleared_at IS NULL` : sql``}
           ${pairFilterCount}
      `);
      const itemsRaw = (result as any).rows ?? [];
      // Task #203 — surface kind + per-row expiresAt + isExpired so the UI
      // can render "expired" without re-deriving the TTL window.
      const ttlDays = getDriftAckTtlDays();
      const nowMs = Date.now();
      const items = itemsRaw.map((a: any) => {
        const ackAtMs = new Date(a.acknowledgedAt).getTime();
        const expiresAt = new Date(ackAtMs + ttlDays * 86_400_000);
        return {
          ...a,
          kind: a.kind ?? "acknowledge",
          expiresAt,
          isExpired:
            a.clearedAt === null && expiresAt.getTime() <= nowMs,
        };
      });
      const total = Number(((totalResult as any).rows ?? [{ count: 0 }])[0]?.count ?? 0);
      return { items, page, limit, total, ttlDays };
    }),
  );

  // -------------------------------------------------------------------------
  // TASK #145 — Generic operator-alert acknowledgement endpoints
  // -------------------------------------------------------------------------
  // Mirror the wallet-drift ack endpoints above but generic over
  // (alertSource, suppressionKey). The new alert types added in this task
  // — audit-log-write-failure, stuck-pending-transactions, db-connection-failure
  // — all suppress through this table.
  //
  // Allow-list of alert sources that this surface can acknowledge. The
  // wallet-drift case has its own dedicated table and does NOT belong here.
  // Restricting the allow-list at the route layer means a typo in the UI
  // can't silently park acks against an unknown source that no dispatcher
  // ever consults.
  // -------------------------------------------------------------------------
  const ACKABLE_OPERATOR_ALERT_SOURCES = [
    "audit-log-write-failure",
    "stuck-pending-transactions",
    "db-connection-failure",
  ] as const;

  const operatorAckCreateSchema = z.object({
    alertSource: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .refine(
        (s) =>
          (ACKABLE_OPERATOR_ALERT_SOURCES as readonly string[]).includes(s),
        {
          message: `alertSource must be one of: ${ACKABLE_OPERATOR_ALERT_SOURCES.join(", ")}`,
        },
      ),
    suppressionKey: z.string().trim().min(1).max(256),
    note: z.string().trim().max(2000).optional().nullable(),
  });

  const operatorAckClearSchema = z.object({
    id: z.number().int().positive(),
    reason: z.string().trim().max(2000).optional().nullable(),
  });

  app.get(
    "/api/admin/operator-alert-acknowledgements",
    adminRoute(async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const offset = (page - 1) * limit;
      const activeOnly =
        String(req.query.activeOnly ?? "").toLowerCase() === "true";
      const sourceRaw =
        typeof req.query.source === "string" ? req.query.source.trim() : "";
      const validSource =
        sourceRaw.length > 0 && sourceRaw.length <= 128 ? sourceRaw : null;

      const result = await db.execute(sql`
        SELECT a.id,
               a.alert_source            AS "alertSource",
               a.suppression_key         AS "suppressionKey",
               a.note,
               a.acknowledged_by_user_id AS "acknowledgedByUserId",
               a.acknowledged_at         AS "acknowledgedAt",
               a.cleared_at              AS "clearedAt",
               a.cleared_by_user_id      AS "clearedByUserId",
               a.clear_reason            AS "clearReason",
               ua.username               AS "acknowledgedByUsername",
               uc.username               AS "clearedByUsername"
          FROM operator_alert_acknowledgements a
          LEFT JOIN users ua ON ua.id = a.acknowledged_by_user_id
          LEFT JOIN users uc ON uc.id = a.cleared_by_user_id
         WHERE 1 = 1
           ${activeOnly ? sql`AND a.cleared_at IS NULL` : sql``}
           ${validSource ? sql`AND a.alert_source = ${validSource}` : sql``}
         ORDER BY a.acknowledged_at DESC, a.id DESC
         LIMIT ${limit}
        OFFSET ${offset}
      `);
      const totalResult = await db.execute(sql`
        SELECT COUNT(*)::int AS count
          FROM operator_alert_acknowledgements
         WHERE 1 = 1
           ${activeOnly ? sql`AND cleared_at IS NULL` : sql``}
           ${validSource ? sql`AND alert_source = ${validSource}` : sql``}
      `);
      const items = (result as any).rows ?? [];
      const total = Number(
        ((totalResult as any).rows ?? [{ count: 0 }])[0]?.count ?? 0,
      );
      return { items, page, limit, total };
    }),
  );

  app.post(
    "/api/admin/operator-alert-acknowledgements",
    adminRoute(async (req, auth) => {
      const parsed = operatorAckCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(
          new Error(parsed.error.issues.map((i) => i.message).join("; ")),
          { status: 400 },
        );
      }
      const { alertSource, suppressionKey, note } = parsed.data;

      // Enforce one-active-row at the route layer too, even though the
      // partial unique index would also reject it. Cleaner 409 than the
      // raw "duplicate key value" error from Postgres.
      const existing = await db.execute(sql`
        SELECT id
          FROM operator_alert_acknowledgements
         WHERE alert_source    = ${alertSource}
           AND suppression_key = ${suppressionKey}
           AND cleared_at IS NULL
         LIMIT 1
      `);
      const existingRow = ((existing as any).rows ?? [])[0];
      if (existingRow?.id) {
        throw Object.assign(
          new Error(
            `An active acknowledgement already exists for this alert (id=${existingRow.id}). ` +
              `Clear it before creating a new one.`,
          ),
          { status: 409 },
        );
      }

      const inserted = await db.execute(sql`
        INSERT INTO operator_alert_acknowledgements
          (alert_source, suppression_key, note, acknowledged_by_user_id)
        VALUES
          (${alertSource}, ${suppressionKey}, ${note ?? null}, ${auth.userId})
        RETURNING id, alert_source AS "alertSource", suppression_key AS "suppressionKey",
                  note, acknowledged_by_user_id AS "acknowledgedByUserId",
                  acknowledged_at AS "acknowledgedAt"
      `);
      const ack = ((inserted as any).rows ?? [])[0];

      await db.insert(auditLogs).values({
        userId: auth.userId,
        action: "operator_alert_acknowledged",
        entityType: "operator_alert_acknowledgement",
        entityId: String(ack?.id ?? ""),
        metadata: {
          alertSource,
          suppressionKey,
          note: note ?? null,
          note_to_ops:
            "Operator notifications for this (source, suppressionKey) pair will be suppressed until cleared.",
        } as any,
        ipAddress: req.ip ?? null,
      });

      return { acknowledgement: ack };
    }),
  );

  app.post(
    "/api/admin/operator-alert-acknowledgements/clear",
    adminRoute(async (req, auth) => {
      const parsed = operatorAckClearSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(
          new Error(parsed.error.issues.map((i) => i.message).join("; ")),
          { status: 400 },
        );
      }
      const { id, reason } = parsed.data;

      const cleared = await db.execute(sql`
        UPDATE operator_alert_acknowledgements
           SET cleared_at         = now(),
               cleared_by_user_id = ${auth.userId},
               clear_reason       = ${reason ?? null}
         WHERE id = ${id}
           AND cleared_at IS NULL
        RETURNING id, alert_source AS "alertSource", suppression_key AS "suppressionKey",
                  cleared_at AS "clearedAt", cleared_by_user_id AS "clearedByUserId",
                  clear_reason AS "clearReason"
      `);
      const row = ((cleared as any).rows ?? [])[0];
      if (!row) {
        throw Object.assign(
          new Error(
            `No active acknowledgement with id=${id} (already cleared, or never existed).`,
          ),
          { status: 404 },
        );
      }

      await db.insert(auditLogs).values({
        userId: auth.userId,
        action: "operator_alert_acknowledgement_cleared",
        entityType: "operator_alert_acknowledgement",
        entityId: String(row.id),
        metadata: {
          alertSource: row.alertSource,
          suppressionKey: row.suppressionKey,
          reason: reason ?? null,
          note_to_ops:
            "Operator notifications resume on the next dispatch attempt for this alert.",
        } as any,
        ipAddress: req.ip ?? null,
      });

      return { acknowledgement: row };
    }),
  );

  // -------------------------------------------------------------------------
  // TASK #36 — Operator alert audit log viewer
  // -------------------------------------------------------------------------
  // Read-only history of every alert dispatched by `notifyOperator`. One row
  // per dispatch attempt, including which channels were tried and the
  // per-channel outcome.
  //
  // Filters (all optional, all narrowed against an allow-list before being
  // bound as parameters — never concatenated into SQL):
  //   - source   : exact match on the originating job id
  //               (e.g. "wallet-ledger-reconciliation")
  //   - severity : one of info | warning | alert | critical
  //   - q        : free-text substring match against title and the JSON
  //                payload (details cast to text). Bound length-capped so a
  //                very long query string can't blow up the index scan.
  //
  // Pagination matches the audit-logs endpoint (page + limit, capped at 200)
  // so the admin shell can reuse the same paging controls.
  //
  // Strictly read-only — this endpoint cannot mutate the alert log; rows are
  // only ever inserted by `notifyOperator` itself.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/operator-alerts",
    adminRoute(async (req) => {
      const sourceRaw = typeof req.query.source === "string" ? req.query.source.trim() : "";
      const severityRaw = typeof req.query.severity === "string" ? req.query.severity.trim() : "";
      const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const fromRaw = typeof req.query.from === "string" ? req.query.from.trim() : "";
      const toRaw = typeof req.query.to === "string" ? req.query.to.trim() : "";
      const deliveryStatusRaw =
        typeof req.query.deliveryStatus === "string"
          ? req.query.deliveryStatus.trim()
          : "";
      // Allow-list severity to the four supported values so a typo can never
      // reach the DB and a malicious client can never inject an arbitrary
      // value past the filter.
      const validSeverity =
        severityRaw === "info" ||
        severityRaw === "warning" ||
        severityRaw === "alert" ||
        severityRaw === "critical"
          ? severityRaw
          : null;
      // Task #175 — deliveryStatus filter mirrors the dashboard "delivery
      // health" tile. Only the three rollup values defined on operator_alerts
      // are accepted; anything else is silently dropped so a stale link or
      // malformed querystring degrades to "no filter" instead of erroring.
      const validDeliveryStatus =
        deliveryStatusRaw === "delivered" ||
        deliveryStatusRaw === "failed" ||
        deliveryStatusRaw === "suppressed_duplicate"
          ? deliveryStatusRaw
          : null;
      // Bound source length so we don't index a 1MB query string.
      const validSource = sourceRaw.length > 0 && sourceRaw.length <= 128 ? sourceRaw : null;
      // Bound search length similarly; ILIKE %…% can't use the existing
      // indexes so we keep the input small to keep the seq scan cheap.
      const validQ = qRaw.length > 0 && qRaw.length <= 200 ? qRaw : null;
      // Date range — Task #69. Bound to 64 chars so a malformed querystring
      // can never reach the Date constructor with megabytes of input. Use
      // the parsed Date directly in the WHERE so the existing
      // operator_alerts_created_at_idx index supports the range scan.
      // A non-empty but unparseable value is a 400 — we don't silently
      // ignore it, otherwise an admin who mistypes the year still sees
      // the full unfiltered list and thinks the filter worked.
      const parseBound = (raw: string, label: string): Date | null => {
        if (raw.length === 0) return null;
        if (raw.length > 64) {
          throw Object.assign(new Error(`${label} is too long`), { status: 400 });
        }
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) {
          throw Object.assign(new Error(`${label} is not a valid ISO timestamp`), {
            status: 400,
          });
        }
        return d;
      };
      const fromDate = parseBound(fromRaw, "from");
      const toDate = parseBound(toRaw, "to");
      if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
        throw Object.assign(new Error("from must be earlier than or equal to to"), {
          status: 400,
        });
      }

      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const offset = (page - 1) * limit;

      const conditions: SQL[] = [];
      if (validSource) conditions.push(eq(operatorAlerts.source, validSource));
      if (validSeverity) conditions.push(eq(operatorAlerts.severity, validSeverity));
      if (validDeliveryStatus) {
        conditions.push(eq(operatorAlerts.deliveryStatus, validDeliveryStatus));
      }
      if (fromDate) conditions.push(gte(operatorAlerts.createdAt, fromDate));
      if (toDate) conditions.push(lte(operatorAlerts.createdAt, toDate));
      // Task #143 — exclude alerts attributable to demo users so the admin
      // operator-alert feed isn't dominated by demo-data noise. Most
      // reconciliation alerts carry the originating user id in
      // `details.userId`; we filter on it via a NOT EXISTS subquery against
      // `users.is_demo`. Alerts with no `userId` in their details (e.g.
      // process-level alerts) are always shown — the predicate only
      // suppresses an alert when its referenced user is explicitly flagged
      // as demo.
      conditions.push(
        sql`NOT EXISTS (
          SELECT 1 FROM ${users} u
          WHERE u.is_demo = TRUE
            AND (${operatorAlerts.details} ->> 'userId') = u.id::text
        )`,
      );
      if (validQ) {
        // Escape LIKE meta-characters (\, %, _) so a literal "100%" is
        // matched literally rather than as a wildcard. The pattern is then
        // bound as a parameter — never interpolated into SQL.
        const escaped = validQ.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
        const pattern = `%${escaped}%`;
        const titleMatch = ilike(operatorAlerts.title, pattern);
        // details is jsonb; cast to text so ILIKE can scan the serialised
        // payload (matches user ids, job names, drift bucket strings, etc.).
        const detailsMatch = sql`${operatorAlerts.details}::text ILIKE ${pattern}`;
        const combined = or(titleMatch, detailsMatch);
        if (combined) conditions.push(combined);
      }
      const where: SQL | undefined =
        conditions.length === 0
          ? undefined
          : conditions.length === 1
            ? conditions[0]
            : and(...conditions);

      const [rows, totalRow] = await Promise.all([
        db
          .select({
            id: operatorAlerts.id,
            source: operatorAlerts.source,
            severity: operatorAlerts.severity,
            title: operatorAlerts.title,
            details: operatorAlerts.details,
            channelsAttempted: operatorAlerts.channelsAttempted,
            channelOutcomes: operatorAlerts.channelOutcomes,
            createdAt: operatorAlerts.createdAt,
            // Task #156 — surface delivery rollup, occurrence counter and
            // last-seen so the admin viewer can show "delivered/failed/
            // suppressed-as-duplicate" + an occurrence badge per row.
            deliveryStatus: operatorAlerts.deliveryStatus,
            occurrences: operatorAlerts.occurrences,
            lastSeenAt: operatorAlerts.lastSeenAt,
          })
          .from(operatorAlerts)
          .where(where)
          .orderBy(desc(operatorAlerts.lastSeenAt), desc(operatorAlerts.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(operatorAlerts)
          .where(where),
      ]);

      return {
        items: rows,
        page,
        limit,
        total: Number(totalRow[0]?.count ?? 0),
      };
    }),
  );

  // -------------------------------------------------------------------------
  // TASK #57 — Operator alert dashboard summary
  // -------------------------------------------------------------------------
  // Tiny aggregate endpoint feeding the admin dashboard tile. Returns counts
  // bucketed by severity for two rolling windows (last 24h and last 7d) so
  // operators logging in can see at-a-glance whether anything new has fired
  // without having to open the full audit log page.
  //
  // Always returns every severity (info|warning|alert|critical) even when the
  // count is zero so the UI tile can render a fixed-shape grid instead of
  // conditionally hiding cells. Generated server-side via a single grouped
  // query with FILTER aggregates so we don't do two round-trips.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/operator-alerts/summary",
    adminRoute(async () => {
      // Run the severity breakdown and the delivery-health breakdown in
      // parallel against a 7-day window. Both queries are tiny aggregates
      // backed by `operator_alerts_created_at_idx`, so doing them as two
      // round-trips is still cheaper than building one fragile UNION here.
      const [severityRows, deliveryRows] = await Promise.all([
        db
          .select({
            severity: operatorAlerts.severity,
            last24h: sql<number>`count(*) filter (where ${operatorAlerts.createdAt} >= now() - interval '24 hours')::int`,
            last7d: sql<number>`count(*) filter (where ${operatorAlerts.createdAt} >= now() - interval '7 days')::int`,
          })
          .from(operatorAlerts)
          .where(sql`${operatorAlerts.createdAt} >= now() - interval '7 days'`)
          .groupBy(operatorAlerts.severity),
        // Task #175 — delivery rollup feeds the dashboard health card. We
        // only need last hour + last 24h here; older rows are irrelevant
        // for spotting an in-progress webhook outage.
        db
          .select({
            deliveryStatus: operatorAlerts.deliveryStatus,
            lastHour: sql<number>`count(*) filter (where ${operatorAlerts.createdAt} >= now() - interval '1 hour')::int`,
            last24h: sql<number>`count(*) filter (where ${operatorAlerts.createdAt} >= now() - interval '24 hours')::int`,
          })
          .from(operatorAlerts)
          .where(sql`${operatorAlerts.createdAt} >= now() - interval '24 hours'`)
          .groupBy(operatorAlerts.deliveryStatus),
      ]);

      const empty = { info: 0, warning: 0, alert: 0, critical: 0 };
      const last24h = { ...empty };
      const last7d = { ...empty };
      for (const row of severityRows) {
        const sev = row.severity as keyof typeof empty;
        if (sev in empty) {
          last24h[sev] = Number(row.last24h ?? 0);
          last7d[sev] = Number(row.last7d ?? 0);
        }
      }

      // Task #175 — keep the shape stable: every known delivery status is
      // always present even when its count is zero so the UI can render a
      // fixed-shape grid (and the red "delivery failures" banner can rely
      // on `failed` being a number, not undefined).
      const emptyDelivery = { delivered: 0, failed: 0, suppressed_duplicate: 0 };
      const deliveryLastHour = { ...emptyDelivery };
      const deliveryLast24h = { ...emptyDelivery };
      for (const row of deliveryRows) {
        const status = row.deliveryStatus as keyof typeof emptyDelivery;
        if (status in emptyDelivery) {
          deliveryLastHour[status] = Number(row.lastHour ?? 0);
          deliveryLast24h[status] = Number(row.last24h ?? 0);
        }
      }

      return {
        last24h,
        last7d,
        deliveryHealth: {
          lastHour: deliveryLastHour,
          last24h: deliveryLast24h,
        },
        generatedAt: new Date().toISOString(),
      };
    }),
  );

  // -------------------------------------------------------------------------
  // TASK #59 — Operator-alert prune run history
  // -------------------------------------------------------------------------
  // Surfaces the recent runs of the daily `pruneOperatorAlerts` job (Task #44)
  // so operators can confirm from the admin UI that the retention job is
  // healthy without grepping server logs.
  //
  // Read-only and capped at 30 entries — the prune writes one row per day, so
  // 30 covers the last month at a glance, which is what operators need for an
  // "is it running?" sanity check. If we ever want longer history we can add
  // pagination, but the table itself is the source of truth.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/operator-alerts/prune-runs",
    adminRoute(async () => {
      const rows = await db
        .select({
          id: operatorAlertPruneRuns.id,
          startedAt: operatorAlertPruneRuns.startedAt,
          retentionDays: operatorAlertPruneRuns.retentionDays,
          cutoff: operatorAlertPruneRuns.cutoff,
          deleted: operatorAlertPruneRuns.deleted,
          durationMs: operatorAlertPruneRuns.durationMs,
        })
        .from(operatorAlertPruneRuns)
        .orderBy(desc(operatorAlertPruneRuns.startedAt), desc(operatorAlertPruneRuns.id))
        .limit(30);

      return { items: rows };
    }),
  );

  // -------------------------------------------------------------------------
  // TASK #156 — "Send test alert" admin trigger
  // -------------------------------------------------------------------------
  // Lets an operator confirm the OPERATOR_ALERT_WEBHOOK_URL pipe is reachable
  // without having to wait for a real failure (or to manufacture wallet
  // drift). Fires a single, clearly-marked synthetic alert through the
  // dispatcher and returns the structured result so the UI can show
  // "delivered to <channel>" or surface the per-channel error inline.
  //
  // The synthetic alert has:
  //   * source   = "admin-test"  (so the audit trail is filterable)
  //   * severity = "info"
  //   * subjectId = `admin:<userId>:<msTimestamp>`  (per-call dedupe key —
  //                  back-to-back clicks must NOT collapse onto a prior
  //                  test alert; the operator wants visible feedback)
  //
  // Admin role is enforced by `adminRoute`; the action is captured in the
  // standard audit log so we have a record of which admin tested when.
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/operator-alerts/test",
    adminRoute(async (req, auth) => {
      const {
        notifyOperator,
        getEnvPrimaryWebhookUrl,
        getEnvBackupWebhookUrl,
      } = await import("./services/operator-alerts");
      const { isOperatorAlertFailoverActive } = await import(
        "./services/operator-alert-failover"
      );
      const triggeredAt = new Date();
      const result = await notifyOperator({
        source: "admin-test",
        severity: "info",
        title: "Operator alert pipeline test",
        details: {
          triggeredByUserId: auth.userId,
          triggeredByUsername: auth.username,
          triggeredAt: triggeredAt.toISOString(),
          message:
            "This is a synthetic alert fired from the admin UI to verify the operator-alerts pipeline. No action required.",
        },
        kind: "admin-test",
        subjectType: "admin",
        // Per-call subject id so two consecutive clicks each produce a
        // visible result rather than the second one being suppressed.
        subjectId: `admin:${auth.userId}:${triggeredAt.getTime()}`,
      });

      // Task #174 — surface BOTH host names (never the URL) in the test
      // response so the admin UI can render which receiver the dispatcher
      // actually targeted on each channel. Hosts are derived locally so
      // we never log/transmit the credential portion of the URL.
      const envPrimaryUrl = getEnvPrimaryWebhookUrl();
      const envBackupUrl = getEnvBackupWebhookUrl();
      const hostOf = (u: string | null): string | null => {
        if (!u) return null;
        try {
          return new URL(u).host;
        } catch {
          return "(unparseable URL)";
        }
      };
      const failoverActive = await isOperatorAlertFailoverActive();

      await writeAuditLog({
        userId: auth.userId,
        action: "admin_operator_alert_test",
        entityType: "operator_alert",
        entityId: result.alertId !== null ? String(result.alertId) : null,
        before: null,
        after: {
          deliveryStatus: result.deliveryStatus,
          channelsAttempted: result.channelsAttempted,
          alertId: result.alertId,
        },
        extra: {
          webhookConfigured: Boolean(envPrimaryUrl),
          backupWebhookConfigured: Boolean(envBackupUrl),
          failoverActive,
        },
        ipAddress: req.ip ?? null,
      });
      return {
        alertId: result.alertId,
        deliveryStatus: result.deliveryStatus,
        channelsAttempted: result.channelsAttempted,
        outcomes: result.outcomes,
        occurrences: result.occurrences,
        webhookConfigured: Boolean(envPrimaryUrl),
        backupWebhookConfigured: Boolean(envBackupUrl),
        failoverActive,
        // Hosts are reported as they map to the dispatch channels AFTER
        // applying the failover swap, matching what the dispatcher just
        // did. The "env" hosts below let the UI also show the underlying
        // env-var configuration unaffected by the toggle.
        webhookHosts: {
          primaryChannelHost: hostOf(
            failoverActive ? envBackupUrl : envPrimaryUrl,
          ),
          backupChannelHost: hostOf(
            failoverActive ? envPrimaryUrl : envBackupUrl,
          ),
          envPrimaryHost: hostOf(envPrimaryUrl),
          envBackupHost: hostOf(envBackupUrl),
        },
      };
    }),
  );

  // -------------------------------------------------------------------------
  // Task #174 — Operator alert webhook failover toggle
  //
  // GET  /api/admin/operator-alerts/failover   — current toggle state plus
  //                                              env webhook hosts so the
  //                                              admin page can render the
  //                                              card without two round
  //                                              trips.
  // POST /api/admin/operator-alerts/failover   — engage / disengage the
  //                                              toggle. Writes one
  //                                              audit_logs row per call.
  //
  // Engaging failover swaps which env URL the dispatcher uses for the
  // historical "webhook" channel (primary slot) without restart. The
  // backup URL is then promoted to primary; the original primary moves
  // into the backup slot so the parallel-dispatch path still pages it
  // (in case an ops mistake left the toggle on after recovery).
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/operator-alerts/failover",
    adminRoute(async () => {
      const {
        getOperatorAlertFailoverState,
      } = await import("./services/operator-alert-failover");
      const {
        getEnvPrimaryWebhookUrl,
        getEnvBackupWebhookUrl,
      } = await import("./services/operator-alerts");
      const state = await getOperatorAlertFailoverState();
      const envPrimaryUrl = getEnvPrimaryWebhookUrl();
      const envBackupUrl = getEnvBackupWebhookUrl();
      const hostOf = (u: string | null): string | null => {
        if (!u) return null;
        try {
          return new URL(u).host;
        } catch {
          return "(unparseable URL)";
        }
      };
      return {
        failover: {
          active: state.active,
          reason: state.reason,
          engagedByUserId: state.engagedByUserId,
          engagedAt: state.engagedAt,
        },
        webhookHosts: {
          envPrimaryHost: hostOf(envPrimaryUrl),
          envBackupHost: hostOf(envBackupUrl),
          // Effective hosts after applying the toggle, so the UI doesn't
          // have to recompute the swap rule on the client.
          primaryChannelHost: hostOf(
            state.active ? envBackupUrl : envPrimaryUrl,
          ),
          backupChannelHost: hostOf(
            state.active ? envPrimaryUrl : envBackupUrl,
          ),
        },
        // Surface to the UI whether failover is even meaningful. With no
        // backup URL configured, the toggle is rendered disabled with a
        // hint to set OPERATOR_ALERT_WEBHOOK_URL_BACKUP.
        backupConfigured: Boolean(envBackupUrl),
        primaryConfigured: Boolean(envPrimaryUrl),
      };
    }),
  );

  const operatorAlertFailoverToggleSchema = z.object({
    active: z.boolean(),
    // Reason required when engaging (audit usefulness); ignored on disengage.
    reason: z.string().max(500).optional().nullable(),
  });

  app.post(
    "/api/admin/operator-alerts/failover",
    adminRoute(async (req, auth) => {
      const parsed = operatorAlertFailoverToggleSchema.safeParse(
        req.body ?? {},
      );
      if (!parsed.success) {
        throw Object.assign(
          new Error(parsed.error.errors[0]?.message ?? "Invalid payload"),
          { status: 400 },
        );
      }
      const { active, reason } = parsed.data;
      if (active && (!reason || reason.trim().length === 0)) {
        throw Object.assign(
          new Error(
            "A reason is required when engaging operator-alert webhook failover.",
          ),
          { status: 400 },
        );
      }

      const {
        setOperatorAlertFailover,
      } = await import("./services/operator-alert-failover");
      const {
        getEnvPrimaryWebhookUrl,
        getEnvBackupWebhookUrl,
      } = await import("./services/operator-alerts");

      // Guard: refuse to engage if no backup URL is configured. With no
      // backup the swap would point the primary slot at null and leave
      // the dispatcher with the log channel only — almost certainly the
      // opposite of what the admin intended.
      if (active && !getEnvBackupWebhookUrl()) {
        throw Object.assign(
          new Error(
            "Cannot engage failover: OPERATOR_ALERT_WEBHOOK_URL_BACKUP is not configured.",
          ),
          { status: 400 },
        );
      }

      const result = await setOperatorAlertFailover({
        active,
        reason: reason ?? null,
        actorUserId: auth.userId,
      });

      try {
        await writeAuditLog({
          userId: auth.userId,
          action: "operator_alert_failover.toggled",
          entityType: "system_settings",
          entityId: "1",
          before: {
            active: result.before.active,
            reason: result.before.reason,
          },
          after: {
            active: result.after.active,
            reason: result.after.reason,
          },
          extra: {
            requestedActive: active,
            changed: result.changed,
            primaryConfigured: Boolean(getEnvPrimaryWebhookUrl()),
            backupConfigured: Boolean(getEnvBackupWebhookUrl()),
          },
          ipAddress: (req.ip ?? null) as string | null,
        });
      } catch (e) {
        console.error(
          "[operator-alert-failover] audit log insert failed",
          e,
        );
      }

      return {
        ok: true,
        changed: result.changed,
        failover: {
          active: result.after.active,
          reason: result.after.reason,
          engagedByUserId: result.after.engagedByUserId,
          engagedAt: result.after.engagedAt,
        },
      };
    }),
  );

  // -------------------------------------------------------------------------
  // TASK #79 — Background job health snapshot
  // -------------------------------------------------------------------------
  // One-stop health view for every scheduled background job: last run, last
  // successful run, outcome, and whether the job is overdue (default
  // threshold: > 36h since last start). Backed by `background_job_runs`
  // (one row per cron tick) plus the static catalogue in
  // server/services/background-jobs.ts so a job that has NEVER run still
  // shows up in the dashboard as "never ran" instead of being silently absent.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/background-jobs",
    adminRoute(async () => {
      const { getBackgroundJobsHealth } = await import(
        "./services/background-jobs"
      );
      return await getBackgroundJobsHealth();
    }),
  );

  // -------------------------------------------------------------------------
  // TASK #399 — Recent fixture-cleanup deactivations panel
  // -------------------------------------------------------------------------
  // The `fixture-adviser-clients-cleanup` cron writes one
  // `adviser_client.deactivated_fixture_cleanup` audit row per link it flips
  // to is_active=false. The Background Jobs page already shows the cron's
  // one-line summary (`scanned=…, deactivated=…`), but ops had no way to see
  // WHICH adviser↔client pairs were unlinked without dropping into SQL
  // against `audit_logs`. This endpoint surfaces the most recent N
  // deactivations (default 50), joined with `users` so the UI can render
  // human emails instead of raw user ids. Read-only.
  //
  // We deliberately filter on the canonical action name and entity type
  // so a future audit row for the same pair (e.g. a manual deactivation
  // by an admin) can never accidentally show up here.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/background-jobs/fixture-cleanup-deactivations",
    adminRoute(async (req) => {
      const limit = Math.min(
        Math.max(Number(req.query.limit) || 50, 1),
        200,
      );
      const rows = await db
        .select({
          id: auditLogs.id,
          createdAt: auditLogs.createdAt,
          entityId: auditLogs.entityId,
          metadata: auditLogs.metadata,
        })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "adviser_client.deactivated_fixture_cleanup"),
            eq(auditLogs.entityType, "adviser_client"),
          ),
        )
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(limit);

      // Pull adviser + client emails for the user ids referenced in the
      // metadata.extra payload. One round-trip via getUserNameMap.
      const userIds: number[] = [];
      for (const r of rows) {
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        const a = meta["adviserUserId"];
        const c = meta["clientUserId"];
        if (typeof a === "number" && Number.isFinite(a)) userIds.push(a);
        if (typeof c === "number" && Number.isFinite(c)) userIds.push(c);
      }
      const nameMap = await getUserNameMap(userIds);

      const items = rows.map((r) => {
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        const adviserUserId =
          typeof meta["adviserUserId"] === "number"
            ? (meta["adviserUserId"] as number)
            : null;
        const clientUserId =
          typeof meta["clientUserId"] === "number"
            ? (meta["clientUserId"] as number)
            : null;
        const matchedPattern =
          typeof meta["matchedPattern"] === "string"
            ? (meta["matchedPattern"] as string)
            : null;
        const trigger =
          typeof meta["trigger"] === "string"
            ? (meta["trigger"] as string)
            : null;
        const linkIdNum = Number(r.entityId);
        return {
          auditLogId: r.id,
          createdAt: r.createdAt,
          linkId:
            Number.isInteger(linkIdNum) && linkIdNum > 0 ? linkIdNum : null,
          adviserUserId,
          adviserEmail:
            adviserUserId !== null ? (nameMap[adviserUserId]?.email ?? null) : null,
          clientUserId,
          clientEmail:
            clientUserId !== null ? (nameMap[clientUserId]?.email ?? null) : null,
          matchedPattern,
          trigger,
        };
      });
      return { items };
    }),
  );

  // Recent run history for one specific job. Used by the Background Jobs
  // page to expand a job into its last N invocations. Capped at 50.
  app.get(
    "/api/admin/background-jobs/:jobName/runs",
    adminRoute(async (req) => {
      const jobName = String(req.params.jobName ?? "").trim();
      if (!jobName) {
        const err: any = new Error("jobName is required");
        err.status = 400;
        throw err;
      }
      const rows = await db
        .select({
          id: backgroundJobRuns.id,
          jobName: backgroundJobRuns.jobName,
          startedAt: backgroundJobRuns.startedAt,
          finishedAt: backgroundJobRuns.finishedAt,
          status: backgroundJobRuns.status,
          summary: backgroundJobRuns.summary,
          errorMessage: backgroundJobRuns.errorMessage,
          durationMs: backgroundJobRuns.durationMs,
        })
        .from(backgroundJobRuns)
        .where(eq(backgroundJobRuns.jobName, jobName))
        .orderBy(desc(backgroundJobRuns.startedAt), desc(backgroundJobRuns.id))
        .limit(50);
      return { items: rows };
    }),
  );

  // =========================================================================
  // SESSION 19 — admin shell expansion
  // -------------------------------------------------------------------------
  // Investment products (CRUD) | Investment instructions (read-only review,
  // with admin annotations) | Report requests (read-only) | Compliance overview.
  // None of these touch money or feeConsents/adviceRecords/instructions data —
  // they are read paths plus product catalogue and admin annotation writes.
  // =========================================================================

  // ----- shared schemas (Session 19) -------------------------------------
  // Reuse the global insertInvestmentProductSchema; allow numeric or string
  // for the decimal columns since drizzle-zod accepts string by default.
  //
  // Operational invariant: an ACTIVE product (isActive=true) must have a
  // populated annualReturn in [0, 1] — downstream portfolio valuation is
  // fail-closed when annualReturn is null, so allowing an active-but-
  // unvaluable product would surface as silent "unknown valuation"
  // everywhere it is selected. Inactive (draft) products can omit
  // annualReturn entirely. When annualReturn IS supplied (active or not),
  // it must be a parseable decimal in [0, 1].
  function isValidAnnualReturn(v: unknown): boolean {
    if (v === null || v === undefined || v === "") return false;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1;
  }
  const adminCreateProductSchema = insertInvestmentProductSchema
    .extend({
      minimumInvestment: z.union([z.string(), z.number()]).transform(String),
      annualReturn: z
        .union([z.string(), z.number()])
        .transform(String)
        .optional()
        .nullable(),
      isActive: z.boolean().optional(),
      // Investor-visibility flag (Task #336/#350). Defaults to true at the
      // DB level so omitting it keeps the existing "visible" behaviour;
      // admins can pass `false` to stage a product as a draft.
      isPublished: z.boolean().optional(),
      // Task #339 — same canonical-key constraint as the update path; see
      // adminUpdateProductSchema below for context.
      riskProfile: z.enum(RISK_PROFILE_KEYS as [KnownRiskProfile, ...KnownRiskProfile[]]),
    })
    .superRefine((val, ctx) => {
      const active = val.isActive !== false; // default true
      const supplied =
        val.annualReturn !== null &&
        val.annualReturn !== undefined &&
        val.annualReturn !== "";
      if (active && !supplied) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["annualReturn"],
          message: "annualReturn is required for an active product (else valuation is unknown)",
        });
      } else if (supplied && !isValidAnnualReturn(val.annualReturn)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["annualReturn"],
          message: "annualReturn must be a decimal in [0, 1] (e.g. 0.11 for 11% p.a.)",
        });
      }
    });
  const adminUpdateProductSchema = z
    .object({
      name: z.string().min(1).optional(),
      // Same canonical-enum guard as the create path: a PATCH cannot move a
      // product onto a non-canonical category like the historical `"x"`,
      // which would otherwise be silently filtered out everywhere downstream.
      category: z
        .enum(PRODUCT_CATEGORY_VALUES, {
          errorMap: () => ({
            message: `category must be one of: ${PRODUCT_CATEGORY_VALUES.join(", ")}`,
          }),
        })
        .optional(),
      subCategory: z.string().min(1).optional(),
      investmentStrategy: z.string().min(1).optional(),
      targetNetIrr: z.string().min(1).optional(),
      grossIrr: z.string().nullable().optional(),
      moic: z.string().nullable().optional(),
      term: z.string().min(1).optional(),
      structure: z.string().min(1).optional(),
      distributions: z.string().min(1).optional(),
      liquidity: z.string().min(1).optional(),
      minimumInvestment: z.union([z.string(), z.number()]).transform(String).optional(),
      // Task #339 — only canonical lowercase keys from shared/risk-profiles.ts
      // are accepted. Sentence-case values like "High" / "Very High" used to
      // sneak in via legacy callers and silently broke the investments-page
      // filter and the adviser suitability check (both compare against the
      // lowercase keys with strict equality).
      riskProfile: z.enum(RISK_PROFILE_KEYS as [KnownRiskProfile, ...KnownRiskProfile[]]).optional(),
      returnType: z.string().min(1).optional(),
      lvr: z.string().nullable().optional(),
      annualReturn: z.union([z.string(), z.number()]).transform(String).nullable().optional(),
      returnMethod: z.string().min(1).optional(),
      isActive: z.boolean().optional(),
      // Task #350 — investor-visibility toggle. Independent of isActive:
      // a product can be active (referenced, valued) yet hidden as a draft.
      isPublished: z.boolean().optional(),
    })
    // Same numeric bound as create: if a non-empty annualReturn is supplied
    // on PATCH, it must be a decimal in [0, 1]. (Activation invariant —
    // active row must have non-empty annualReturn — is enforced inline in
    // the PATCH handler against the post-update view.)
    .superRefine((val, ctx) => {
      if (
        Object.prototype.hasOwnProperty.call(val, "annualReturn") &&
        val.annualReturn !== null &&
        val.annualReturn !== undefined &&
        val.annualReturn !== "" &&
        !isValidAnnualReturn(val.annualReturn)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["annualReturn"],
          message: "annualReturn must be a decimal in [0, 1] (e.g. 0.11 for 11% p.a.)",
        });
      }
    });
  const adminCreateReviewNoteSchema = z.object({
    entityType: z.enum(["investment_instruction"]),
    entityId: z.string().min(1),
    note: z.string().min(1).max(4000),
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/products — full product catalogue (incl. inactive)
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/products",
    adminRoute(async () => {
      const rows = await db
        .select()
        .from(investmentProducts)
        .orderBy(asc(investmentProducts.name));
      return rows;
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/products — create a new product
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/products",
    adminRoute(async (req, auth) => {
      const parsed = adminCreateProductSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(
          new Error("Invalid payload: " + parsed.error.issues.map((i) => i.message).join("; ")),
          { status: 400 },
        );
      }
      const data = parsed.data;
      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(investmentProducts)
          .values(data as any)
          .returning();
        await auditTx(
          tx,
          auth.userId,
          "admin_product_created",
          "investment_product",
          String(row.id),
          {
            name: row.name,
            category: row.category,
            isActive: row.isActive,
            isPublished: row.isPublished,
          },
          req.ip || null,
        );
        return row;
      });
      return created;
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/admin/products/:id — partial update / isActive toggle
  // -------------------------------------------------------------------------
  app.patch(
    "/api/admin/products/:id",
    adminRoute(async (req, auth) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw Object.assign(new Error("Invalid product id"), { status: 400 });
      }
      const parsed = adminUpdateProductSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(
          new Error("Invalid payload: " + parsed.error.issues.map((i) => i.message).join("; ")),
          { status: 400 },
        );
      }
      const updates = parsed.data;
      if (Object.keys(updates).length === 0) {
        throw Object.assign(new Error("No fields to update"), { status: 400 });
      }

      const [existing] = await db
        .select()
        .from(investmentProducts)
        .where(eq(investmentProducts.id, id))
        .limit(1);
      if (!existing) {
        throw Object.assign(new Error("Product not found"), { status: 404 });
      }

      // Mirror the create-time invariant: an active product must have an
      // annualReturn, else portfolio valuation degrades to "unknown".
      // We compute the post-update view and reject the PATCH if it would
      // leave the row {isActive: true, annualReturn: null/empty}.
      const willBeActive =
        updates.isActive === undefined ? existing.isActive : updates.isActive;
      const futureAnnualReturn =
        Object.prototype.hasOwnProperty.call(updates, "annualReturn")
          ? updates.annualReturn
          : existing.annualReturn;
      const futureHasReturn =
        futureAnnualReturn !== null &&
        futureAnnualReturn !== undefined &&
        futureAnnualReturn !== "";
      if (willBeActive && !futureHasReturn) {
        throw Object.assign(
          new Error(
            "Cannot activate a product without an annualReturn — set annualReturn first or keep the product inactive.",
          ),
          { status: 400 },
        );
      }

      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(investmentProducts)
          .set(updates as any)
          .where(eq(investmentProducts.id, id))
          .returning();
        await auditTx(
          tx,
          auth.userId,
          "admin_product_updated",
          "investment_product",
          String(id),
          {
            updatedFields: Object.keys(updates),
            previousIsActive: existing.isActive,
            newIsActive: row.isActive,
            previousIsPublished: existing.isPublished,
            newIsPublished: row.isPublished,
          },
          req.ip || null,
        );
        return row;
      });
      return updated;
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/products/:id/active-holdings-count — Task #359
  //
  // Returns the number of distinct investors that currently hold an active
  // position in the given product. The admin catalogue calls this right
  // before flipping `isPublished` from true → false so the confirmation
  // dialog can warn "N investors still hold this product" and the admin
  // can decide whether to proceed. "Active" matches the user_investments
  // status enum value used everywhere else in this codebase (the other
  // states being `matured` and `withdrawn`, which we deliberately exclude:
  // those holders no longer see the product on their dashboard so hiding
  // it from investor reads cannot confuse them).
  //
  // Strictly read-only.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/products/:id/active-holdings-count",
    adminRoute(async (req) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw Object.assign(new Error("Invalid product id"), { status: 400 });
      }
      const [row] = await db
        .select({
          count: sql<number>`count(distinct ${userInvestments.userId})::int`,
        })
        .from(userInvestments)
        .where(
          and(
            eq(userInvestments.productId, id),
            eq(userInvestments.status, "active"),
          ),
        );
      return { count: row?.count ?? 0 };
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/products/:id/history — Task #385
  //
  // Per-product change history powered by the existing `audit_logs` rows
  // written on every PATCH /api/admin/products/:id (action
  // `admin_product_updated`, entityType `investment_product`, entityId =
  // the product id as a string). Returns the most recent entries first
  // joined with the actor's username/email so the admin UI can show
  // "who changed what, when" without going to the database.
  //
  // Strictly read-only.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/products/:id/history",
    adminRoute(async (req) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw Object.assign(new Error("Invalid product id"), { status: 400 });
      }
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

      const rows = await db
        .select({
          id: auditLogs.id,
          userId: auditLogs.userId,
          action: auditLogs.action,
          metadata: auditLogs.metadata,
          createdAt: auditLogs.createdAt,
          actorUsername: users.username,
          actorEmail: users.email,
        })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.userId))
        .where(
          and(
            eq(auditLogs.action, "admin_product_updated"),
            eq(auditLogs.entityType, "investment_product"),
            eq(auditLogs.entityId, String(id)),
          ),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit);

      return { items: rows };
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/instructions — read-only review list (paginated, filterable)
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/instructions",
    adminRoute(async (req) => {
      const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const offset = (page - 1) * limit;

      const where = status ? eq(investmentInstructions.status, status) : undefined;

      const [rows, totalRow] = await Promise.all([
        db
          .select({
            id: investmentInstructions.id,
            adviserUserId: investmentInstructions.adviserUserId,
            clientUserId: investmentInstructions.clientUserId,
            productId: investmentInstructions.productId,
            action: investmentInstructions.action,
            amount: investmentInstructions.amount,
            status: investmentInstructions.status,
            adviceRecordId: investmentInstructions.adviceRecordId,
            feeConsentId: investmentInstructions.feeConsentId,
            executionAuthorisationId: investmentInstructions.executionAuthorisationId,
            notes: investmentInstructions.notes,
            rejectionReason: investmentInstructions.rejectionReason,
            consentedAt: investmentInstructions.consentedAt,
            rejectedAt: investmentInstructions.rejectedAt,
            createdAt: investmentInstructions.createdAt,
            updatedAt: investmentInstructions.updatedAt,
            adviserUsername: sql<string>`(SELECT username FROM ${users} u WHERE u.id = ${investmentInstructions.adviserUserId})`,
            adviserEmail: sql<string>`(SELECT email FROM ${users} u WHERE u.id = ${investmentInstructions.adviserUserId})`,
            clientUsername: sql<string>`(SELECT username FROM ${users} u WHERE u.id = ${investmentInstructions.clientUserId})`,
            clientEmail: sql<string>`(SELECT email FROM ${users} u WHERE u.id = ${investmentInstructions.clientUserId})`,
            productName: sql<string>`(SELECT name FROM ${investmentProducts} p WHERE p.id = ${investmentInstructions.productId})`,
          })
          .from(investmentInstructions)
          .where(where as any)
          .orderBy(desc(investmentInstructions.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(investmentInstructions)
          .where(where as any),
      ]);

      return {
        items: rows,
        page,
        limit,
        total: Number(totalRow[0]?.count ?? 0),
      };
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/instructions/:id/review-notes — list admin notes for an instruction
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/instructions/:id/review-notes",
    adminRoute(async (req) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw Object.assign(new Error("Invalid instruction id"), { status: 400 });
      }
      const rows = await db
        .select({
          id: adminReviewNotes.id,
          adminUserId: adminReviewNotes.adminUserId,
          entityType: adminReviewNotes.entityType,
          entityId: adminReviewNotes.entityId,
          note: adminReviewNotes.note,
          createdAt: adminReviewNotes.createdAt,
          adminUsername: sql<string>`(SELECT username FROM ${users} u WHERE u.id = ${adminReviewNotes.adminUserId})`,
        })
        .from(adminReviewNotes)
        .where(
          and(
            eq(adminReviewNotes.entityType, "investment_instruction"),
            eq(adminReviewNotes.entityId, String(id)),
          ),
        )
        .orderBy(desc(adminReviewNotes.createdAt))
        .limit(200);
      return rows;
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/review-notes — attach a note to an entity
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/review-notes",
    adminRoute(async (req, auth) => {
      const parsed = adminCreateReviewNoteSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(
          new Error("Invalid payload: " + parsed.error.issues.map((i) => i.message).join("; ")),
          { status: 400 },
        );
      }
      const { entityType, entityId, note } = parsed.data;

      // Validate the referenced entity exists so admins don't pin notes to
      // non-existent rows. Today only investment_instruction is supported.
      if (entityType === "investment_instruction") {
        const idNum = Number(entityId);
        if (!Number.isInteger(idNum) || idNum <= 0) {
          throw Object.assign(new Error("Invalid entityId for investment_instruction"), { status: 400 });
        }
        const [hit] = await db
          .select({ id: investmentInstructions.id })
          .from(investmentInstructions)
          .where(eq(investmentInstructions.id, idNum))
          .limit(1);
        if (!hit) {
          throw Object.assign(new Error("Instruction not found"), { status: 404 });
        }
      }

      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(adminReviewNotes)
          .values({
            adminUserId: auth.userId,
            entityType,
            entityId,
            note,
          })
          .returning();
        await auditTx(
          tx,
          auth.userId,
          "admin_review_note_added",
          entityType,
          entityId,
          { noteLength: note.length },
          req.ip || null,
        );
        return row;
      });

      return created;
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/reports — list all report requests (paginated, filterable)
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/reports",
    adminRoute(async (req) => {
      const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
      const reportType = typeof req.query.reportType === "string" ? req.query.reportType.trim() : "";
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const offset = (page - 1) * limit;

      const conditions = [] as any[];
      if (status) conditions.push(eq(reportRequests.status, status));
      if (reportType) conditions.push(eq(reportRequests.reportType, reportType));
      const where = conditions.length ? and(...conditions) : undefined;

      const [rows, totalRow, statusCountRows] = await Promise.all([
        db
          .select({
            id: reportRequests.id,
            adviserUserId: reportRequests.adviserUserId,
            clientUserId: reportRequests.clientUserId,
            reportType: reportRequests.reportType,
            format: reportRequests.format,
            status: reportRequests.status,
            notes: reportRequests.notes,
            downloadUrl: reportRequests.downloadUrl,
            failureReason: reportRequests.failureReason,
            requestedAt: reportRequests.requestedAt,
            generatedAt: reportRequests.generatedAt,
            expiresAt: reportRequests.expiresAt,
            // Task #315 — version chain metadata so the admin row can show
            // a "v2 ← v1" chip without a per-row round-trip.
            versionNumber: reportRequests.versionNumber,
            supersedesReportId: reportRequests.supersedesReportId,
            downloadLinkExpiresAt: reportRequests.downloadLinkExpiresAt,
            adviserUsername: sql<string>`(SELECT username FROM ${users} u WHERE u.id = ${reportRequests.adviserUserId})`,
            clientUsername: sql<string>`(SELECT username FROM ${users} u WHERE u.id = ${reportRequests.clientUserId})`,
            clientEmail: sql<string>`(SELECT email FROM ${users} u WHERE u.id = ${reportRequests.clientUserId})`,
          })
          .from(reportRequests)
          .where(where as any)
          .orderBy(desc(reportRequests.requestedAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(reportRequests)
          .where(where as any),
        // Task #315 — counts strip is global (NOT page-scoped) so the
        // admin can see the true backlog regardless of current filter.
        // Computed in a single GROUP BY rather than N round-trips.
        db
          .select({
            status: reportRequests.status,
            count: sql<number>`count(*)::int`,
          })
          .from(reportRequests)
          .groupBy(reportRequests.status),
      ]);

      const counts: Record<string, number> = {};
      for (const r of statusCountRows) counts[r.status] = Number(r.count);

      return {
        items: rows,
        page,
        limit,
        total: Number(totalRow[0]?.count ?? 0),
        counts,
      };
    }),
  );

  // -------------------------------------------------------------------------
  // Task #315 — POST /api/admin/reports/:id/retry
  // Inserts a fresh job (versionNumber + 1, supersedesReportId = id) and,
  // as of Task #332, hands the PDF render to the background worker via
  // enqueueReportJob; the response carries the freshly inserted row in
  // 'requested' state so the UI can show progress immediately. Does NOT
  // mutate the failed row — the chain itself is the audit trail.
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/reports/:id/retry",
    adminRoute(async (req, auth) => {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        throw Object.assign(new Error("Invalid report id"), { status: 400 });
      }
      const [orig] = await db
        .select()
        .from(reportRequests)
        .where(eq(reportRequests.id, id))
        .limit(1);
      if (!orig) {
        throw Object.assign(new Error("Report not found"), { status: 404 });
      }
      // Admin retry impersonates the original adviser (admin is acting on
      // their behalf so the new row's adviserUserId stays unchanged and
      // ownership semantics on download still hold).
      const { regenerateReport, enqueueReportJob } = await import("./services/reports");
      const next = await regenerateReport(orig.adviserUserId, id);
      await writeAuditLog({
        userId: auth.userId,
        action: "admin_report_retry",
        entityType: "report_request",
        entityId: String(next.id),
        after: {
          supersedesReportId: id,
          versionNumber: next.versionNumber,
          originalAdviserUserId: orig.adviserUserId,
          clientUserId: next.clientUserId,
          reportType: next.reportType,
        },
        ipAddress: req.ip || null,
      });
      // Task #332 — fire-and-forget enqueue so the admin retry response
      // returns immediately. The in-process worker (drained by the route's
      // setImmediate and by the periodic tick in server/index.ts) flips
      // the row to ready/failed; the existing 10-minute sweeper remains
      // the safety net for a worker that crashes mid-flight.
      enqueueReportJob(next.id);
      return next;
    }),
  );

  // -------------------------------------------------------------------------
  // Task #315 — POST /api/admin/reports/sweeper/run-once
  // Manual trigger of the report sweeper — useful when an operator wants
  // to clear stuck rows immediately rather than wait for the next minute
  // tick. Returns the same summary structure the cron records.
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/reports/sweeper/run-once",
    adminRoute(async (req, auth) => {
      const { runReportJobSweeper } = await import("./services/reports");
      const summary = await runReportJobSweeper();
      await writeAuditLog({
        userId: auth.userId,
        action: "admin_report_sweeper_run_once",
        entityType: "background_job",
        entityId: "report-sweeper",
        after: { scanned: summary.scanned, flipped: summary.flipped, flippedIds: summary.flippedIds },
        ipAddress: req.ip || null,
      });
      return summary;
    }),
  );

  // -------------------------------------------------------------------------
  // SESSION 20 — admin oversight of fee-consent REQUESTS and live consents.
  // Both endpoints are read-only paginated lists for the admin fee-consents
  // page (Requests tab + Live consents tab).
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/fee-consent-requests",
    adminRoute(async (req) => {
      const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const offset = (page - 1) * limit;
      const where = status ? eq(feeConsentRequests.status, status) : undefined;

      const [rows, totalRow] = await Promise.all([
        db
          .select({
            id: feeConsentRequests.id,
            adviserUserId: feeConsentRequests.adviserUserId,
            clientUserId: feeConsentRequests.clientUserId,
            adviceRecordId: feeConsentRequests.adviceRecordId,
            feeType: feeConsentRequests.feeType,
            amountType: feeConsentRequests.amountType,
            amount: feeConsentRequests.amount,
            accountNumber: feeConsentRequests.accountNumber,
            deductionFrequency: feeConsentRequests.deductionFrequency,
            // Task #293 — surface the reference day + the renewal window
            // so the admin doesn't have to mentally back-derive them from
            // the expiry alone (the previous "stale-looking expiry, no
            // reference day" complaint).
            proposedReferenceDay: feeConsentRequests.proposedReferenceDay,
            proposedRenewalWindowStart: feeConsentRequests.proposedRenewalWindowStart,
            proposedRenewalWindowEnd: feeConsentRequests.proposedRenewalWindowEnd,
            proposedConsentExpiryDate: feeConsentRequests.proposedConsentExpiryDate,
            status: feeConsentRequests.status,
            declineReason: feeConsentRequests.declineReason,
            signedFeeConsentId: feeConsentRequests.signedFeeConsentId,
            // Task #293 — supersede chain back-pointer.
            supersedesRequestId: feeConsentRequests.supersedesRequestId,
            respondedAt: feeConsentRequests.respondedAt,
            createdAt: feeConsentRequests.createdAt,
            adviserUsername: sql<string>`(SELECT username FROM ${users} u WHERE u.id = ${feeConsentRequests.adviserUserId})`,
            clientUsername: sql<string>`(SELECT username FROM ${users} u WHERE u.id = ${feeConsentRequests.clientUserId})`,
          })
          .from(feeConsentRequests)
          .where(where as any)
          .orderBy(desc(feeConsentRequests.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(feeConsentRequests)
          .where(where as any),
      ]);
      // Task #293 — compute the deduction-block reason server-side so the
      // UI never has to recreate the rule. Strings: "expired" | "pending"
      // | "no_advice_record" | null. Money movement is gated separately;
      // this is the user-facing reason a request would not be permitted
      // to drive a deduction TODAY if the kill-switch were lifted.
      const now = Date.now();
      const items = rows.map((r) => {
        let deductionsBlockedReason: string | null = null;
        if (!r.adviceRecordId) deductionsBlockedReason = "no_advice_record";
        else if (r.status === "pending") deductionsBlockedReason = "pending";
        else if (
          r.proposedConsentExpiryDate &&
          r.proposedConsentExpiryDate.getTime() < now
        )
          deductionsBlockedReason = "expired";
        return { ...r, deductionsBlockedReason };
      });
      return {
        items,
        page,
        limit,
        total: Number(totalRow[0]?.count ?? 0),
      };
    }),
  );

  app.get(
    "/api/admin/fee-consents",
    adminRoute(async (req) => {
      const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const offset = (page - 1) * limit;
      const where = status ? eq(feeConsents.renewalStatus, status) : undefined;

      const [rows, totalRow] = await Promise.all([
        db
          .select({
            id: feeConsents.id,
            adviceRecordId: feeConsents.adviceRecordId,
            clientId: feeConsents.clientId,
            adviserId: feeConsents.adviserId,
            feeType: feeConsents.feeType,
            amountType: feeConsents.amountType,
            amount: feeConsents.amount,
            accountNumber: feeConsents.accountNumber,
            accountName: feeConsents.accountName,
            deductionFrequency: feeConsents.deductionFrequency,
            referenceDay: feeConsents.referenceDay,
            // Task #293 — surface the renewal window and the client's
            // signature name so the admin doesn't have to open the audit
            // log to see who signed and when the renewal opens.
            renewalWindowStart: feeConsents.renewalWindowStart,
            renewalWindowEnd: feeConsents.renewalWindowEnd,
            consentExpiryDate: feeConsents.consentExpiryDate,
            renewalStatus: feeConsents.renewalStatus,
            consentedAt: feeConsents.consentedAt,
            withdrawnAt: feeConsents.withdrawnAt,
            clientSignatureName: feeConsents.clientSignatureName,
            // Task #293 — supersede chain links (both directions). The
            // forward link `supersededByRequestId` is set when this
            // consent was replaced; the reverse `supersedesRequestId` is
            // looked up via the request that signed THIS consent.
            supersededByRequestId: feeConsents.supersededByRequestId,
            supersededAt: feeConsents.supersededAt,
            supersededReason: feeConsents.supersededReason,
            // Task #372 — Drizzle's sql template renders `${feeConsents.id}`
            // as the bare column name `"id"` rather than
            // `"fee_consents"."id"`, which inside this correlated subquery
            // accidentally resolves to `fcr.id` and makes the back-pointer
            // always look like null. Pin the outer reference explicitly so
            // the cross-table lookup actually works (same fix as the
            // client-side route).
            supersedesRequestId: sql<number | null>`(
              SELECT supersedes_request_id
              FROM ${feeConsentRequests} fcr
              WHERE fcr.signed_fee_consent_id = ${sql.raw('"fee_consents"."id"')}
              LIMIT 1
            )`,
            // Task #293 — pull the IP address recorded on the audit row
            // for the actual sign-event. The audit writer uses
            // entityType='fee_consent', entityId=String(consent.id) for
            // the create row written inside the same tx as the sign.
            // Task #372 — same bare-column-name bug applies here: the
            // `${feeConsents.id}::text` template would render as
            // `"id"::text` inside the subquery and resolve to
            // `al.id::text`, so the IP would never match. Use a
            // fully-qualified outer reference instead.
            signedIp: sql<string | null>`(
              SELECT ip_address
              FROM ${auditLogs} al
              WHERE al.entity_type = 'fee_consent'
                AND al.entity_id = ${sql.raw('"fee_consents"."id"')}::text
                AND al.action = 'fee_consent_created'
              ORDER BY al.created_at DESC
              LIMIT 1
            )`,
            adviserUsername: sql<string>`(SELECT username FROM ${users} u WHERE u.id = ${feeConsents.adviserId})`,
            clientUsername: sql<string>`(SELECT username FROM ${users} u WHERE u.id = ${feeConsents.clientId})`,
          })
          .from(feeConsents)
          .where(where as any)
          .orderBy(desc(feeConsents.consentedAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(feeConsents)
          .where(where as any),
      ]);
      // Task #293 — server-side computation of the deduction-block reason.
      // Kept in lockstep with the requests endpoint above so the UI has a
      // single shape to reason about.
      const now = Date.now();
      const items = rows.map((r) => {
        let deductionsBlockedReason: string | null = null;
        if (!r.adviceRecordId) deductionsBlockedReason = "no_advice_record";
        else if (
          r.renewalStatus === "expired" ||
          (r.consentExpiryDate && r.consentExpiryDate.getTime() < now)
        )
          deductionsBlockedReason = "expired";
        return { ...r, deductionsBlockedReason };
      });
      return {
        items,
        page,
        limit,
        total: Number(totalRow[0]?.count ?? 0),
      };
    }),
  );

  // ---------------------------------------------------------------------
  // Task #294 — single-consent fetch for the admin "create fee rule" form.
  // The form takes a feeConsentId as input; on blur it calls this endpoint
  // to autofill the bound client/adviser and surface the supersede-preview
  // (i.e. "creating a rule against this consent will supersede rule #N").
  // Returns the same shape as a listing row PLUS the active-rule pointer.
  // ---------------------------------------------------------------------
  app.get(
    "/api/admin/fee-consents/:id",
    adminRoute(async (req) => {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        throw Object.assign(new Error("Invalid consent id"), { status: 400 });
      }
      const [row] = await db
        .select({
          id: feeConsents.id,
          adviceRecordId: feeConsents.adviceRecordId,
          clientId: feeConsents.clientId,
          adviserId: feeConsents.adviserId,
          feeType: feeConsents.feeType,
          amountType: feeConsents.amountType,
          amount: feeConsents.amount,
          accountNumber: feeConsents.accountNumber,
          accountName: feeConsents.accountName,
          deductionFrequency: feeConsents.deductionFrequency,
          referenceDay: feeConsents.referenceDay,
          renewalWindowStart: feeConsents.renewalWindowStart,
          renewalWindowEnd: feeConsents.renewalWindowEnd,
          consentExpiryDate: feeConsents.consentExpiryDate,
          renewalStatus: feeConsents.renewalStatus,
          consentedAt: feeConsents.consentedAt,
          withdrawnAt: feeConsents.withdrawnAt,
          supersededByRequestId: feeConsents.supersededByRequestId,
          supersededAt: feeConsents.supersededAt,
          supersededReason: feeConsents.supersededReason,
          adviserUsername: sql<string>`(SELECT username FROM ${users} u WHERE u.id = ${feeConsents.adviserId})`,
          clientUsername: sql<string>`(SELECT username FROM ${users} u WHERE u.id = ${feeConsents.clientId})`,
        })
        .from(feeConsents)
        .where(eq(feeConsents.id, id))
        .limit(1);
      if (!row) {
        throw Object.assign(new Error("Fee consent not found"), { status: 404 });
      }
      // Existing live rule on this consent (the one a new createFeeRule
      // call would auto-supersede). At most one because of the partial
      // unique index ux_fee_rule_active_per_consent.
      const [activeRule] = await db
        .select({
          id: adviserFeeRules.id,
          status: adviserFeeRules.status,
          effectiveDate: adviserFeeRules.effectiveDate,
        })
        .from(adviserFeeRules)
        .where(
          and(
            eq(adviserFeeRules.feeConsentId, id),
            inArray(adviserFeeRules.status, ["active", "draft", "paused"]),
          ),
        )
        .limit(1);
      const now = Date.now();
      let deductionsBlockedReason: string | null = null;
      if (!row.adviceRecordId) deductionsBlockedReason = "no_advice_record";
      else if (
        row.renewalStatus === "expired" ||
        (row.consentExpiryDate && row.consentExpiryDate.getTime() < now)
      )
        deductionsBlockedReason = "expired";
      return { ...row, deductionsBlockedReason, activeRule: activeRule ?? null };
    }),
  );

  // ---------------------------------------------------------------------
  // Task #293 — admin-only Revoke a pending fee-consent REQUEST.
  // Mirrors the adviser PATCH /withdraw shape but is admin-driven and
  // tags `revokedByAdmin: true` in the audit `extra` so a reviewer can
  // tell at a glance which control plane fired the action. Pending only.
  // ---------------------------------------------------------------------
  app.post(
    "/api/admin/fee-consent-requests/:id/revoke",
    adminRoute(async (req, auth) => {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        throw Object.assign(new Error("Invalid request id"), { status: 400 });
      }
      const reasonSchema = z.object({
        reason: z.string().max(2000).optional().nullable(),
      });
      const parsed = reasonSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw Object.assign(new Error("Invalid payload"), { status: 400 });
      }
      const updated = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(feeConsentRequests)
          .where(eq(feeConsentRequests.id, id))
          .for("update")
          .limit(1);
        if (!existing) {
          throw Object.assign(new Error("Fee consent request not found"), {
            status: 404,
          });
        }
        if (existing.status !== "pending") {
          throw Object.assign(
            new Error(
              `Cannot revoke request in status '${existing.status}' — only pending requests are revocable.`,
            ),
            { status: 400 },
          );
        }
        // Task #293 — Revoke is the adviser-side "I shouldn't have asked
        // for this" exit. Admin-generated supersede requests carry a
        // non-null supersedesRequestId; the correct way to undo one of
        // those is via the original consent's audit trail, not by
        // revoking the replacement. Block here so the audit log stays
        // unambiguous.
        if (existing.supersedesRequestId !== null) {
          throw Object.assign(
            new Error(
              "Cannot revoke an admin-generated supersede request — only adviser-issued pending requests are revocable.",
            ),
            { status: 400 },
          );
        }
        const updatedRows = await tx
          .update(feeConsentRequests)
          .set({
            status: "withdrawn_by_adviser",
            declineReason: parsed.data.reason ?? "Revoked by admin",
            respondedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(feeConsentRequests.id, id),
              eq(feeConsentRequests.status, "pending"),
            ),
          )
          .returning();
        const row = updatedRows[0];
        if (!row) {
          throw Object.assign(
            new Error("Fee consent request was already actioned"),
            { status: 409 },
          );
        }
        await writeAuditLog({
          executor: tx,
          userId: auth.userId,
          action: "fee_consent_request_revoked_by_admin",
          entityType: "fee_consent_request",
          entityId: String(id),
          before: {
            status: existing.status,
            declineReason: existing.declineReason,
            respondedAt: existing.respondedAt,
          },
          after: {
            status: row.status,
            declineReason: row.declineReason,
            respondedAt: row.respondedAt,
          },
          extra: {
            revokedByAdmin: true,
            adviserUserId: existing.adviserUserId,
            clientUserId: existing.clientUserId,
            reason: parsed.data.reason ?? null,
          },
          ipAddress: req.ip || null,
        });
        return row;
      });
      return updated;
    }),
  );

  // ---------------------------------------------------------------------
  // Task #293 — admin-only Supersede a live consent.
  // Atomically (a) marks the existing consent's renewalStatus='superseded'
  // with a back-pointer to the new request, and (b) inserts a fresh
  // pending request that mirrors the existing consent's terms. The
  // adviser/client then drive the new request through the normal
  // sign/decline flow. No money moves.
  // ---------------------------------------------------------------------
  app.post(
    "/api/admin/fee-consents/:id/supersede",
    adminRoute(async (req, auth) => {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        throw Object.assign(new Error("Invalid consent id"), { status: 400 });
      }
      const supersedeSchema = z.object({
        reason: z.string().min(3).max(2000),
      });
      const parsed = supersedeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw Object.assign(
          new Error(
            "Invalid payload: " +
              parsed.error.issues.map((i) => i.message).join("; "),
          ),
          { status: 400 },
        );
      }
      const result = await db.transaction(async (tx) => {
        const [consent] = await tx
          .select()
          .from(feeConsents)
          .where(eq(feeConsents.id, id))
          .for("update")
          .limit(1);
        if (!consent) {
          throw Object.assign(new Error("Fee consent not found"), {
            status: 404,
          });
        }
        if (
          consent.renewalStatus !== "active" &&
          consent.renewalStatus !== "renewal_due"
        ) {
          throw Object.assign(
            new Error(
              `Cannot supersede a consent in renewal status '${consent.renewalStatus}'.`,
            ),
            { status: 400 },
          );
        }
        // Look up the request that produced this consent so we can chain
        // `supersedesRequestId` on the freshly inserted request.
        const [originalRequest] = await tx
          .select({ id: feeConsentRequests.id })
          .from(feeConsentRequests)
          .where(eq(feeConsentRequests.signedFeeConsentId, consent.id))
          .limit(1);

        // Mirror the renewal window from the consent to the new request
        // (admin doesn't restate it — the supersede flow is "same terms,
        // fresh signature"). Adviser can edit before sending if needed.
        const [newRequest] = await tx
          .insert(feeConsentRequests)
          .values({
            adviserUserId: consent.adviserId ?? auth.userId,
            clientUserId: consent.clientId,
            adviceRecordId: consent.adviceRecordId,
            feeType: consent.feeType,
            amountType: consent.amountType,
            amount: consent.amount,
            calculationMethod: consent.calculationMethod,
            accountNumber: consent.accountNumber,
            accountName: consent.accountName,
            deductionFrequency: consent.deductionFrequency,
            proposedReferenceDay: consent.referenceDay,
            proposedRenewalWindowStart: consent.renewalWindowStart,
            proposedRenewalWindowEnd: consent.renewalWindowEnd,
            proposedConsentExpiryDate: consent.consentExpiryDate,
            requestNote: `Supersedes consent #${consent.id}: ${parsed.data.reason}`,
            status: "pending",
            supersedesRequestId: originalRequest?.id ?? null,
          })
          .returning();

        const consentBefore = {
          renewalStatus: consent.renewalStatus,
          supersededByRequestId: consent.supersededByRequestId,
          supersededAt: consent.supersededAt,
          supersededReason: consent.supersededReason,
        };
        const [supersededConsent] = await tx
          .update(feeConsents)
          .set({
            renewalStatus: "superseded",
            supersededByRequestId: newRequest.id,
            supersededAt: new Date(),
            supersededReason: parsed.data.reason,
            updatedAt: new Date(),
          })
          .where(eq(feeConsents.id, consent.id))
          .returning();

        await writeAuditLog({
          executor: tx,
          userId: auth.userId,
          action: "fee_consent_superseded_by_admin",
          entityType: "fee_consent",
          entityId: String(consent.id),
          before: consentBefore,
          after: {
            renewalStatus: supersededConsent.renewalStatus,
            supersededByRequestId: supersededConsent.supersededByRequestId,
            supersededAt: supersededConsent.supersededAt,
            supersededReason: supersededConsent.supersededReason,
          },
          extra: {
            newFeeConsentRequestId: newRequest.id,
            originalRequestId: originalRequest?.id ?? null,
            clientId: consent.clientId,
            adviserId: consent.adviserId,
            reason: parsed.data.reason,
          },
          ipAddress: req.ip || null,
        });
        await writeAuditLog({
          executor: tx,
          userId: auth.userId,
          action: "fee_consent_request_created_by_admin_supersede",
          entityType: "fee_consent_request",
          entityId: String(newRequest.id),
          before: null,
          after: {
            status: newRequest.status,
            clientUserId: newRequest.clientUserId,
            adviserUserId: newRequest.adviserUserId,
            adviceRecordId: newRequest.adviceRecordId,
            supersedesRequestId: newRequest.supersedesRequestId,
          },
          extra: {
            supersededFeeConsentId: consent.id,
            reason: parsed.data.reason,
          },
          ipAddress: req.ip || null,
        });
        return {
          supersededConsent,
          newRequest,
        };
      });
      // Task #301 — best-effort client notification with deep-link to the
      // sign page. Runs OUTSIDE the supersede transaction so SMTP latency
      // / failure can never roll back the supersede + new-request inserts
      // (which already produced their own audit rows on lines above).
      // Delivery success/failure is recorded as a separate audit_logs row
      // with action `fee_consent_request.client_notified` /
      // `_client_notification_failed` and trigger='supersede' so an
      // operator can prove a notice was attempted for every superseded
      // consent — including the dev / preview "SMTP not configured" case
      // where we log only.
      await notifyClientOfFeeConsentRequest({
        requestRow: result.newRequest,
        adviserUserId: auth.userId,
        trigger: "supersede",
        ipAddress: req.ip || null,
      });
      return result;
    }),
  );

  // -------------------------------------------------------------------------
  // Task #293 — on-demand PDF rendering for the Actions column.
  // Task #302 — Now renders an AMAX-branded form (per-page letterhead with the
  //   licensee identity + AFSL details, the same legal language as the paper
  //   consent template, a styled signature box reproducing the captured
  //   signature name + IP + timestamp, and a separate "Audit Appendix" page
  //   that lists the supersede chain and every revoke/supersede/sign event
  //   tied to this artefact). Nothing is persisted: each call rebuilds the
  //   document from current row state so superseded fields, expiry, etc.
  //   always reflect the latest record. No money moves; this is read-only.
  // Task #343 — The 800-line PDF builder + helpers used to live inline here.
  //   They were lifted into server/services/fee-consent-pdf.ts so the new
  //   client-facing download routes can render the SAME artefact through the
  //   SAME code path (RG175 expects clients to be able to retain their own
  //   copy of an executed consent — see server/client-routes.ts).
  // -----------------------------------------------------------------------------
  app.get(
    "/api/admin/fee-consent-requests/:id/pdf",
    adminStreamRoute(async (req, res, auth) => {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        throw Object.assign(new Error("Invalid request id"), { status: 400 });
      }
      const artefact = await buildFeeConsentRequestPdf({
        id,
        exportedByUserId: auth.userId,
        purpose: "fee_consent_request_download",
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${artefact.filename}"`,
      );
      res.setHeader("Content-Length", String(artefact.buf.length));
      await writeAuditLog({
        userId: auth.userId,
        action: "fee_consent_request_pdf_exported",
        entityType: "fee_consent_request",
        entityId: String(id),
        before: null,
        after: null,
        extra: { source: "admin_ui" },
        ipAddress: req.ip || null,
      });
      // Task #318 — also emit the unified `document.download` audit row so
      // the regulator surface can answer "who pulled what when" with a
      // single query across reports + uploads + consent PDFs.
      await writeAuditLog({
        userId: auth.userId,
        action: "document.download",
        entityType: "fee_consent_request",
        entityId: String(id),
        before: null,
        after: null,
        extra: {
          clientUserId: artefact.clientUserId,
          documentId: id,
          documentKind: "fee_consent_request",
          purpose: "fee_consent_request_download",
          downloadedAtUtc: artefact.downloadedAtUtc.toISOString(),
        },
        ipAddress: req.ip || null,
      });
      res.end(artefact.buf);
    }),
  );

  app.get(
    "/api/admin/fee-consents/:id/pdf",
    adminStreamRoute(async (req, res, auth) => {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        throw Object.assign(new Error("Invalid consent id"), { status: 400 });
      }
      const artefact = await buildFeeConsentPdf({
        id,
        exportedByUserId: auth.userId,
        purpose: "fee_consent_download",
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${artefact.filename}"`,
      );
      res.setHeader("Content-Length", String(artefact.buf.length));
      await writeAuditLog({
        userId: auth.userId,
        action: "fee_consent_pdf_exported",
        entityType: "fee_consent",
        entityId: String(id),
        before: null,
        after: null,
        extra: { source: "admin_ui" },
        ipAddress: req.ip || null,
      });
      // Task #318 — unified document.download row for cross-surface auditing.
      await writeAuditLog({
        userId: auth.userId,
        action: "document.download",
        entityType: "fee_consent",
        entityId: String(id),
        before: null,
        after: null,
        extra: {
          clientUserId: artefact.clientUserId,
          documentId: id,
          documentKind: "fee_consent",
          purpose: "fee_consent_download",
          downloadedAtUtc: artefact.downloadedAtUtc.toISOString(),
        },
        ipAddress: req.ip || null,
      });
      res.end(artefact.buf);
    }),
  );


  // -------------------------------------------------------------------------
  // GET /api/admin/compliance/overview — single-call dashboard for the
  // compliance page. Aggregates KYC mix, fee-consent renewal status, advice
  // gate counts, instruction status mix, and the most recent compliance-shaped
  // audit events.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/compliance/overview",
    adminRoute(async () => {
      const [
        kycCounts,
        feeConsentCounts,
        instructionCounts,
        adviceRecordsCount,
        adviceAcksCount,
        recentComplianceAudit,
      ] = await Promise.all([
        db
          .select({ status: users.kycStatus, count: sql<number>`count(*)::int` })
          .from(users)
          .where(eq(users.role, "client"))
          .groupBy(users.kycStatus),
        db
          .select({ status: feeConsents.renewalStatus, count: sql<number>`count(*)::int` })
          .from(feeConsents)
          .groupBy(feeConsents.renewalStatus),
        db
          .select({ status: investmentInstructions.status, count: sql<number>`count(*)::int` })
          .from(investmentInstructions)
          .groupBy(investmentInstructions.status),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(adviceRecords),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(adviceAcknowledgements),
        db
          .select({
            id: auditLogs.id,
            userId: auditLogs.userId,
            action: auditLogs.action,
            entityType: auditLogs.entityType,
            entityId: auditLogs.entityId,
            createdAt: auditLogs.createdAt,
          })
          .from(auditLogs)
          .where(
            sql`${auditLogs.action} ILIKE 'admin_%'
              OR ${auditLogs.action} ILIKE '%fee_consent%'
              OR ${auditLogs.action} ILIKE '%advice_%'
              OR ${auditLogs.action} ILIKE '%execution_%'
              OR ${auditLogs.action} ILIKE '%instruction%'`,
          )
          .orderBy(desc(auditLogs.createdAt))
          .limit(25),
      ]);

      const kyc: Record<string, number> = {};
      for (const r of kycCounts) {
        kyc[r.status ?? "unknown"] = Number(r.count);
      }
      const feeConsent: Record<string, number> = {};
      for (const r of feeConsentCounts) {
        feeConsent[r.status] = Number(r.count);
      }
      const instructions: Record<string, number> = {};
      for (const r of instructionCounts) {
        instructions[r.status] = Number(r.count);
      }

      // Soon-to-expire fee consents (within 30 days, still active)
      const expiringFeeConsents = await db
        .select({
          id: feeConsents.id,
          clientId: feeConsents.clientId,
          adviserId: feeConsents.adviserId,
          feeType: feeConsents.feeType,
          consentExpiryDate: feeConsents.consentExpiryDate,
          renewalStatus: feeConsents.renewalStatus,
          clientUsername: sql<string>`(SELECT username FROM ${users} u WHERE u.id = ${feeConsents.clientId})`,
          adviserUsername: sql<string>`(SELECT username FROM ${users} u WHERE u.id = ${feeConsents.adviserId})`,
        })
        .from(feeConsents)
        .where(
          and(
            sql`${feeConsents.consentExpiryDate} <= now() + interval '30 days'`,
            sql`${feeConsents.renewalStatus} IN ('active', 'renewal_due')`,
          ),
        )
        .orderBy(asc(feeConsents.consentExpiryDate))
        .limit(50);

      return {
        kyc,
        feeConsent,
        instructions,
        adviceRecordsTotal: Number(adviceRecordsCount[0]?.count ?? 0),
        adviceAcknowledgementsTotal: Number(adviceAcksCount[0]?.count ?? 0),
        expiringFeeConsents,
        recentComplianceAudit,
      };
    }),
  );

  // ===========================================================================
  // SESSION 23A — FEE ENGINE GATE A (admin write surface)
  // ---------------------------------------------------------------------------
  // SCAFFOLD ONLY — no money moves. Approval = status flip + audit row only.
  // Reads + service helpers live in server/services/fee-engine.ts.
  // ===========================================================================

  app.post(
    "/api/admin/fee-rules",
    adminRoute(async (req, auth) => {
      const parsed = insertAdviserFeeRuleSchema.parse(req.body);
      // Optional caller-supplied effectiveDate for back-dating a rule. We
      // accept either an ISO string or a numeric epoch — anything else is a
      // 400 (don't silently fall back to "now" or the date would be a lie).
      let effectiveDate: Date | undefined;
      if (req.body?.effectiveDate !== undefined && req.body?.effectiveDate !== null && req.body?.effectiveDate !== "") {
        const d = new Date(req.body.effectiveDate);
        if (Number.isNaN(d.getTime())) {
          throw Object.assign(new Error("Invalid effectiveDate"), { status: 400 });
        }
        effectiveDate = d;
      }
      const supersedeReason =
        typeof req.body?.supersedeReason === "string" && req.body.supersedeReason.trim().length > 0
          ? req.body.supersedeReason.trim().slice(0, 256)
          : undefined;

      let created;
      try {
        // Task #294 — delegate to createFeeRule so the supersede chain runs
        // inside the SAME tx as the insert. Auto-superseded rule audit
        // rows are written by the service.
        const { createFeeRule } = await import("./services/fee-engine");
        created = await createFeeRule(parsed, {
          actorUserId: auth.userId,
          effectiveDate,
          supersedeReason,
        });
      } catch (err: any) {
        // Map the DB-level CHECK violations (splits not summing to 10000,
        // splits out of range) to a 400 with a useful message instead of a
        // generic 500.
        const msg = String(err?.message ?? "");
        if (
          err?.code === "23514" ||
          /adviser_fee_rules_splits_total_chk/.test(msg) ||
          /adviser_fee_rules_splits_range_chk/.test(msg)
        ) {
          throw Object.assign(
            new Error(
              "Splits must sum to 10000bps (100%) and each be in [0,10000]",
            ),
            { status: 400 },
          );
        }
        // Task #294 — partial unique index trip. Should be unreachable on
        // the happy path (the service supersede pass takes the lock first)
        // but a concurrent direct INSERT would fall through to here. Map
        // 23505 to a clean 409 so the UI can render a useful message.
        if (
          err?.code === "23505" ||
          /adviser_fee_rules_supersede_uniq/.test(msg)
        ) {
          throw Object.assign(
            new Error(
              "Another active fee rule already exists for this client + fee type + account; supersede chain conflict.",
            ),
            { status: 409 },
          );
        }
        throw err;
      }

      // Task #95 — fresh insert: no prior state, so `before` is null.
      // `after` carries the durable state-machine fields auditors expect
      // to see flip later (status, pausedAt, supersededByRuleId). Per-rule
      // economics live in `extra`. Audit row for any auto-superseded
      // predecessor(s) is written by createFeeRule itself.
      await writeAuditLog({
        userId: auth.userId,
        action: "fee_rule_created",
        entityType: "adviser_fee_rule",
        entityId: String(created.id),
        before: null,
        after: {
          id: created.id,
          status: created.status,
          feeConsentId: created.feeConsentId,
          clientUserId: created.clientUserId,
          adviserUserId: created.adviserUserId,
          accountNumber: created.accountNumber,
          effectiveDate: created.effectiveDate,
          pausedAt: created.pausedAt,
        },
        extra: {
          feeType: parsed.feeType,
          amountType: parsed.amountType,
          adviserSplitBps: parsed.adviserSplitBps,
          platformSplitBps: parsed.platformSplitBps,
        },
        ipAddress: req.ip ?? null,
      });
      return created;
    }),
  );

  app.get(
    "/api/admin/fee-rules",
    adminRoute(async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const offset = (page - 1) * limit;
      // Task #294 — `?status` accepts a comma-separated list so the
      // admin fees page can drive Active and History cards as two
      // independent fetches. Empty / missing → all statuses.
      const statusParam =
        typeof req.query.status === "string" ? req.query.status.trim() : "";
      const statuses = statusParam
        ? statusParam
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [];
      const adviserId = Number(req.query.adviserUserId);
      const clientId = Number(req.query.clientUserId);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const filters: any[] = [];
      if (statuses.length === 1) filters.push(eq(adviserFeeRules.status, statuses[0]));
      else if (statuses.length > 1) filters.push(inArray(adviserFeeRules.status, statuses));
      if (Number.isInteger(adviserId) && adviserId > 0) filters.push(eq(adviserFeeRules.adviserUserId, adviserId));
      if (Number.isInteger(clientId) && clientId > 0) filters.push(eq(adviserFeeRules.clientUserId, clientId));
      if (q) {
        const ids = await findUserIdsByQuery(q);
        if (ids.length === 0) {
          return { items: [], page, limit, total: 0, users: {} };
        }
        filters.push(
          or(
            inArray(adviserFeeRules.clientUserId, ids),
            inArray(adviserFeeRules.adviserUserId, ids),
          ),
        );
      }
      const where = filters.length ? and(...filters) : undefined;
      // Task #294 — LEFT JOIN feeConsents so the rule surface carries the
      // legal context (consent renewal status, expiry, account, frequency)
      // without forcing the client to do a second round-trip per row.
      // Only the columns the UI cards / pills actually render are projected
      // so the payload doesn't drag the entire consents row into every
      // response (PII minimisation).
      const ruleSelect = {
        id: adviserFeeRules.id,
        feeConsentId: adviserFeeRules.feeConsentId,
        clientUserId: adviserFeeRules.clientUserId,
        adviserUserId: adviserFeeRules.adviserUserId,
        feeType: adviserFeeRules.feeType,
        amountType: adviserFeeRules.amountType,
        rateBps: adviserFeeRules.rateBps,
        fixedAmount: adviserFeeRules.fixedAmount,
        currency: adviserFeeRules.currency,
        adviserSplitBps: adviserFeeRules.adviserSplitBps,
        platformSplitBps: adviserFeeRules.platformSplitBps,
        status: adviserFeeRules.status,
        accountNumber: adviserFeeRules.accountNumber,
        effectiveDate: adviserFeeRules.effectiveDate,
        pausedAt: adviserFeeRules.pausedAt,
        pausedReason: adviserFeeRules.pausedReason,
        supersededByRuleId: adviserFeeRules.supersededByRuleId,
        supersededAt: adviserFeeRules.supersededAt,
        supersededReason: adviserFeeRules.supersededReason,
        createdAt: adviserFeeRules.createdAt,
        updatedAt: adviserFeeRules.updatedAt,
        consentRenewalStatus: feeConsents.renewalStatus,
        consentExpiryDate: feeConsents.consentExpiryDate,
        consentWithdrawnAt: feeConsents.withdrawnAt,
        consentAccountNumber: feeConsents.accountNumber,
        consentAccountName: feeConsents.accountName,
        consentDeductionFrequency: feeConsents.deductionFrequency,
      } as const;

      const [rows, totalRow] = await Promise.all([
        db
          .select(ruleSelect)
          .from(adviserFeeRules)
          .leftJoin(
            feeConsents,
            eq(feeConsents.id, adviserFeeRules.feeConsentId),
          )
          .where(where as any)
          .orderBy(desc(adviserFeeRules.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(adviserFeeRules)
          .where(where as any),
      ]);
      const usersMap = await getUserNameMap(
        rows.flatMap((r) => [r.clientUserId, r.adviserUserId]),
      );
      return {
        items: rows,
        page,
        limit,
        total: Number(totalRow[0]?.count ?? 0),
        users: usersMap,
      };
    }),
  );

  // Task #294 — Operator-triggered reconciliation between adviser_fee_rules
  // and the underlying feeConsents row. Same code path as the daily cron
  // tick; the admin endpoint exists so an operator can force a reconcile
  // immediately after a renewal flow without waiting for the next sweep.
  // Returns the same summary the cron records on `background_job_runs`.
  app.post(
    "/api/admin/fee-rules/reconcile-consent-state",
    adminRoute(async (req, auth) => {
      const { reconcileRuleConsentState } = await import(
        "./services/fee-engine"
      );
      const summary = await reconcileRuleConsentState({
        actorUserId: auth.userId,
      });
      // Audit a single roll-up row so operators can see the manual trigger
      // separately from the per-rule transition rows that the service writes.
      // Task #324 — `triggeredAt` is also stamped on every per-rule
      // `fee_rule_consent_reconciled` audit row, so the admin "consent
      // reconciliation history" panel uses it to correlate this rollup row
      // back to the transitions emitted by the same run.
      await writeAuditLog({
        userId: auth.userId,
        action: "fee_rules_consent_reconciled",
        entityType: "adviser_fee_rules",
        entityId: null,
        before: null,
        after: null,
        extra: {
          trigger: "manual",
          summary,
          triggeredAt: summary.triggeredAt,
        },
        ipAddress: req.ip ?? null,
      });
      return summary;
    }),
  );

  // -------------------------------------------------------------------------
  // Task #324 — Consent reconciliation history
  // -------------------------------------------------------------------------
  // Lists the most recent rollup audit rows for the fee-rule consent
  // reconciliation sweep (action = 'fee_rules_consent_reconciled'). Both the
  // daily cron AND the manual admin trigger write one rollup row per run,
  // tagged with `trigger ∈ {cron, manual}` and the `summary` counts the run
  // produced. Used by the admin "Consent reconciliation history" card on
  // the Fees page so an operator can answer "did the cron actually run last
  // night?" without scraping audit_logs by hand.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/fee-rules/consent-reconcile-runs",
    adminRoute(async () => {
      const HISTORY_LIMIT = 30;
      const rows = await db
        .select({
          id: auditLogs.id,
          userId: auditLogs.userId,
          createdAt: auditLogs.createdAt,
          metadata: auditLogs.metadata,
        })
        .from(auditLogs)
        .where(eq(auditLogs.action, "fee_rules_consent_reconciled"))
        .orderBy(desc(auditLogs.createdAt))
        .limit(HISTORY_LIMIT);

      const usersMap = await getUserNameMap(rows.map((r) => r.userId));

      // Re-shape the metadata jsonb into a stable, type-safe view for the
      // frontend. The writer always passes a `summary` of the documented
      // shape (see ReconcileRuleConsentStateSummary), but defend against
      // partial/legacy rows by falling back to nulls where a field is
      // missing — the UI shows "—" rather than crashing.
      const items = rows.map((r) => {
        const m = asRecord(r.metadata);
        const s = asRecord(m.summary);
        const trigger =
          m.trigger === "cron" || m.trigger === "manual" ? m.trigger : null;
        return {
          id: r.id,
          createdAt: r.createdAt,
          userId: r.userId,
          trigger,
          triggeredAt: pickString(m.triggeredAt),
          summary: {
            checked: pickNumber(s.checked),
            expired: pickNumber(s.expired),
            pausedForWithdrawal: pickNumber(s.pausedForWithdrawal),
            alreadyAligned: pickNumber(s.alreadyAligned),
            consentMissing: pickNumber(s.consentMissing),
          },
        };
      });

      return { items, users: usersMap };
    }),
  );

  // Per-rule transition lines (action = 'fee_rule_consent_reconciled', note
  // the singular) emitted by a single reconcile run. Correlated to the
  // rollup row by `metadata->>'triggeredAt'` — both writers stamp the same
  // ISO timestamp on the rollup row and on every per-rule audit line they
  // emit during the same call to reconcileRuleConsentState. Returns an
  // empty list when the rollup row was written by an idempotent run that
  // produced no transitions, OR when the rollup is too old to have a
  // `triggeredAt` (legacy rows pre-Task-#324 fall through here harmlessly).
  app.get(
    "/api/admin/fee-rules/consent-reconcile-runs/:id/transitions",
    adminRoute(async (req) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw Object.assign(new Error("Invalid run id"), { status: 400 });
      }
      const [rollup] = await db
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          metadata: auditLogs.metadata,
        })
        .from(auditLogs)
        .where(eq(auditLogs.id, id))
        .limit(1);
      if (!rollup || rollup.action !== "fee_rules_consent_reconciled") {
        throw Object.assign(new Error("Reconcile run not found"), {
          status: 404,
        });
      }
      const meta = asRecord(rollup.metadata);
      const triggeredAt = pickString(meta.triggeredAt);
      if (!triggeredAt) {
        // No correlation key on this rollup row — legacy or partial. Return
        // an empty transitions list rather than 500-ing; the UI surfaces
        // "no per-rule lines available for this run" so the operator
        // understands the gap.
        return { items: [], triggeredAt: null };
      }
      const transitions = await db
        .select({
          id: auditLogs.id,
          createdAt: auditLogs.createdAt,
          entityId: auditLogs.entityId,
          metadata: auditLogs.metadata,
          userId: auditLogs.userId,
        })
        .from(auditLogs)
        .where(
          and(
            // Tighter than action alone: only the per-rule lines (which
            // always have entityType='adviser_fee_rule') are part of a
            // reconcile run. Excludes any future row that might reuse the
            // singular action under a different entity tag.
            eq(auditLogs.entityType, "adviser_fee_rule"),
            eq(auditLogs.action, "fee_rule_consent_reconciled"),
            sql`${auditLogs.metadata}->>'triggeredAt' = ${triggeredAt}`,
          ),
        )
        .orderBy(asc(auditLogs.id));
      const items = transitions.map((t) => {
        const m = asRecord(t.metadata);
        const before = asRecord(m.before);
        const after = asRecord(m.after);
        return {
          id: t.id,
          createdAt: t.createdAt,
          ruleId: t.entityId,
          transition: pickString(m.transition),
          consentId: pickNumber(m.consentId),
          beforeStatus: pickString(before.status),
          afterStatus: pickString(after.status),
        };
      });
      return { items, triggeredAt };
    }),
  );


  app.patch(
    "/api/admin/fee-rules/:id/pause",
    adminRoute(async (req, auth) => {
      const ruleId = Number(req.params.id);
      if (!Number.isInteger(ruleId) || ruleId <= 0) {
        throw Object.assign(new Error("Invalid rule id"), { status: 400 });
      }
      const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
      const updated = await db.transaction(async (tx) => {
        // Task #95 — pre-fetch the row inside the same tx so the before
        // snapshot is consistent with the update we're about to apply.
        const [beforeRow] = await tx
          .select({
            status: adviserFeeRules.status,
            pausedAt: adviserFeeRules.pausedAt,
            pausedReason: adviserFeeRules.pausedReason,
          })
          .from(adviserFeeRules)
          .where(eq(adviserFeeRules.id, ruleId))
          .limit(1);
        if (!beforeRow) {
          throw Object.assign(new Error("Fee rule not found"), { status: 404 });
        }
        const [row] = await tx
          .update(adviserFeeRules)
          .set({
            status: "paused",
            pausedAt: new Date(),
            pausedReason: reason,
            updatedAt: new Date(),
          })
          .where(eq(adviserFeeRules.id, ruleId))
          .returning();
        await writeAuditLog({
          executor: tx,
          userId: auth.userId,
          action: "fee_rule_paused",
          entityType: "adviser_fee_rule",
          entityId: String(ruleId),
          before: {
            status: beforeRow.status,
            pausedAt: beforeRow.pausedAt,
            pausedReason: beforeRow.pausedReason,
          },
          after: {
            status: row.status,
            pausedAt: row.pausedAt,
            pausedReason: row.pausedReason,
          },
          extra: { reason },
          ipAddress: req.ip ?? null,
        });
        return row;
      });
      return updated;
    }),
  );

  // Task #307 — Resume / activate a paused (or draft) fee rule. Mirror of the
  // pause endpoint above, with a runtime consent integrity gate so an
  // operator cannot un-pause a rule whose underlying consent has been
  // withdrawn / expired / moved out of `active` while the rule was paused.
  // On gate failure: 409 + structured `code: <reason>` body and a
  // `.blocked` audit row. On success: status flips to 'active', pause
  // markers are cleared, and a `fee_rule_activated` audit row is written.
  app.post(
    "/api/admin/fee-rules/:id/activate",
    adminRoute(async (req, auth) => {
      const ruleId = Number(req.params.id);
      if (!Number.isInteger(ruleId) || ruleId <= 0) {
        throw Object.assign(new Error("Invalid rule id"), { status: 400 });
      }
      const [beforeRow] = await db
        .select()
        .from(adviserFeeRules)
        .where(eq(adviserFeeRules.id, ruleId))
        .limit(1);
      if (!beforeRow) {
        throw Object.assign(new Error("Fee rule not found"), { status: 404 });
      }
      // Terminal states (superseded, expired) are not resumable — those are
      // legal end-states. Only paused / draft can move back to active.
      if (beforeRow.status !== "paused" && beforeRow.status !== "draft") {
        throw Object.assign(
          new Error(
            `Cannot activate a rule in status '${beforeRow.status}'. Only paused/draft rules can be activated.`,
          ),
          { status: 409, body: { code: "rule_not_resumable", currentStatus: beforeRow.status } },
        );
      }

      // Runtime consent integrity gate — same ladder as the accrual job and
      // the deduction-approve route. Single source of truth lives in
      // server/services/consent-integrity.ts.
      const { assertConsentValidForExecution, CONSENT_GATE_AUDIT_ACTIONS } =
        await import("./services/consent-integrity");
      const gate = await assertConsentValidForExecution(beforeRow.feeConsentId);
      if (!gate.ok) {
        await writeAuditLog({
          userId: auth.userId,
          action: CONSENT_GATE_AUDIT_ACTIONS.ruleActivate,
          entityType: "adviser_fee_rule",
          entityId: String(ruleId),
          before: {
            status: beforeRow.status,
            pausedAt: beforeRow.pausedAt,
            pausedReason: beforeRow.pausedReason,
          },
          after: null,
          extra: {
            reason: gate.reason,
            consentId: beforeRow.feeConsentId,
          },
          ipAddress: req.ip ?? null,
        });
        throw Object.assign(
          new Error(
            `Cannot activate rule — consent integrity gate failed: ${gate.reason}`,
          ),
          {
            status: 409,
            body: {
              code: gate.reason,
              reason: gate.reason,
              consentId: beforeRow.feeConsentId,
              ruleId,
            },
          },
        );
      }

      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(adviserFeeRules)
          .set({
            status: "active",
            pausedAt: null,
            pausedReason: null,
            updatedAt: new Date(),
          })
          .where(eq(adviserFeeRules.id, ruleId))
          .returning();
        await writeAuditLog({
          executor: tx,
          userId: auth.userId,
          action: "fee_rule_activated",
          entityType: "adviser_fee_rule",
          entityId: String(ruleId),
          before: {
            status: beforeRow.status,
            pausedAt: beforeRow.pausedAt,
            pausedReason: beforeRow.pausedReason,
          },
          after: {
            status: row.status,
            pausedAt: row.pausedAt,
            pausedReason: row.pausedReason,
          },
          extra: { fromStatus: beforeRow.status },
          ipAddress: req.ip ?? null,
        });
        return row;
      });
      return updated;
    }),
  );

  // Task #307 — Parameter-drift survey endpoint. Returns the rows where
  // adviser_fee_rules.amount has drifted from the linked feeConsents.amount
  // (the $150-vs-$495 class of bug). Read-only — operators decide per-row
  // how to resolve. The shared service-layer + DB-trigger guard installed
  // by Task #307 prevents new drift; this endpoint surfaces the legacy
  // gap so it can be cleaned up by hand without auto-rewriting history.
  app.get(
    "/api/admin/fee-rules/parameter-drift",
    adminRoute(async () => {
      // SQL-side filter: only non-terminal rules (active/paused/draft) whose
      // consent is non-`calculation_method` and whose monetary parameter
      // doesn't equate. We compare in SQL so the comparison happens at the
      // DB's numeric precision — exactly the same engine the trigger uses.
      const rows = await db.execute(sql`
        SELECT
          r.id              AS rule_id,
          r.fee_consent_id  AS fee_consent_id,
          r.client_user_id  AS client_user_id,
          r.adviser_user_id AS adviser_user_id,
          r.fee_type        AS fee_type,
          r.account_number  AS account_number,
          r.amount_type     AS rule_amount_type,
          r.fixed_amount    AS rule_fixed_amount,
          r.rate_bps        AS rule_rate_bps,
          c.amount_type     AS consent_amount_type,
          c.amount          AS consent_amount,
          r.status          AS rule_status
        FROM adviser_fee_rules r
        JOIN fee_consents c ON c.id = r.fee_consent_id
        WHERE r.status IN ('active', 'paused', 'draft')
          AND c.amount_type <> 'calculation_method'
          AND (
            r.amount_type <> c.amount_type
            OR (
              r.amount_type = 'fixed'
              AND (r.fixed_amount IS NULL OR c.amount IS NULL OR r.fixed_amount <> c.amount)
            )
            OR (
              r.amount_type = 'percentage'
              AND (r.rate_bps IS NULL OR c.amount IS NULL OR ROUND(r.rate_bps::numeric / 100, 4) <> c.amount)
            )
          )
        ORDER BY r.id ASC
      `);
      const items = (rows.rows ?? []).map((r: any) => ({
        ruleId: Number(r.rule_id),
        feeConsentId: Number(r.fee_consent_id),
        clientUserId: Number(r.client_user_id),
        adviserUserId: Number(r.adviser_user_id),
        feeType: r.fee_type,
        accountNumber: r.account_number,
        ruleAmountType: r.rule_amount_type,
        ruleFixedAmount: r.rule_fixed_amount,
        ruleRateBps: r.rule_rate_bps == null ? null : Number(r.rule_rate_bps),
        consentAmountType: r.consent_amount_type,
        consentAmount: r.consent_amount,
        ruleStatus: r.rule_status,
      }));
      return { count: items.length, items };
    }),
  );

  // Task #307 — Compliance Snapshot. Single-shot read that returns the
  // full provenance chain for one deduction:
  //   { deduction, accrual (representative), rule, consent, advice,
  //     auditEvents }
  // All linked rows are as-of-now (no point-in-time replay yet — that's a
  // later task). Used by the future audit-log read screen and by ad-hoc
  // ASIC enquiries. Read-only, admin-only, no UI in this task.
  app.get(
    "/api/admin/compliance-snapshot/deduction/:id",
    adminRoute(async (req) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw Object.assign(new Error("Invalid deduction id"), { status: 400 });
      }
      const [deduction] = await db
        .select()
        .from(adviserFeeDeductions)
        .where(eq(adviserFeeDeductions.id, id))
        .limit(1);
      if (!deduction) {
        throw Object.assign(new Error("Deduction not found"), { status: 404 });
      }

      // Walk to the rule via the first accrual id on the deduction. All
      // accruals in a batch share the same rule (Task #294), so the first
      // one is representative.
      const accrualIdsRaw = deduction.accrualIds;
      const accrualIds: number[] = Array.isArray(accrualIdsRaw)
        ? (accrualIdsRaw as unknown[]).filter(
            (v): v is number => typeof v === "number" && Number.isFinite(v),
          )
        : [];
      let accrual: any = null;
      let rule: any = null;
      let consent: any = null;
      let advice: any = null;
      if (accrualIds.length > 0) {
        const [a] = await db
          .select()
          .from(adviserFeeAccruals)
          .where(eq(adviserFeeAccruals.id, accrualIds[0]))
          .limit(1);
        accrual = a ?? null;
        if (accrual) {
          const [r] = await db
            .select()
            .from(adviserFeeRules)
            .where(eq(adviserFeeRules.id, accrual.feeRuleId))
            .limit(1);
          rule = r ?? null;
          if (rule) {
            const [c] = await db
              .select()
              .from(feeConsents)
              .where(eq(feeConsents.id, rule.feeConsentId))
              .limit(1);
            consent = c ?? null;
            if (consent) {
              const [adv] = await db
                .select()
                .from(adviceRecords)
                .where(eq(adviceRecords.id, consent.adviceRecordId))
                .limit(1);
              advice = adv ?? null;
            }
          }
        }
      }

      // Audit events for this deduction (id-keyed entityType lookup). We
      // also include rule + consent audit rows so the regulator sees the
      // full provenance chain in one response — they are typically the
      // deciding rows in an ASIC enquiry.
      const eventClauses: any[] = [
        and(
          eq(auditLogs.entityType, "adviser_fee_deduction"),
          eq(auditLogs.entityId, String(id)),
        ),
      ];
      if (rule) {
        eventClauses.push(
          and(
            eq(auditLogs.entityType, "adviser_fee_rule"),
            eq(auditLogs.entityId, String(rule.id)),
          ),
        );
      }
      if (consent) {
        eventClauses.push(
          and(
            eq(auditLogs.entityType, "fee_consent"),
            eq(auditLogs.entityId, String(consent.id)),
          ),
        );
      }
      const auditEvents = await db
        .select()
        .from(auditLogs)
        .where(or(...eventClauses) as any)
        .orderBy(desc(auditLogs.createdAt))
        .limit(200);

      return {
        deduction,
        accrual,
        rule,
        consent,
        advice,
        auditEvents,
      };
    }),
  );

  app.post(
    "/api/admin/fee-accruals/run",
    adminRoute(async (req, auth) => {
      const dateRaw = typeof req.body?.accrualDate === "string"
        ? req.body.accrualDate
        : new Date().toISOString();
      const accrualDate = new Date(dateRaw);
      if (Number.isNaN(accrualDate.getTime())) {
        throw Object.assign(new Error("Invalid accrualDate"), { status: 400 });
      }
      // The service inserts each row in its own write — that's intentional so
      // a single bad row doesn't block the others. We audit the run as one
      // event with the summary outcome.
      //
      // Session 27 (Task #23): use the recording wrapper so this manual run
      // ALSO writes one row to `fee_accrual_runs` with trigger='manual' and
      // the admin's user id, so the "last run" card on the admin fees page
      // works identically for cron and manual runs.
      const { runDailyAccrualsAndRecord } = await import("./services/fee-engine");
      const { run, ...summary } = await runDailyAccrualsAndRecord({
        accrualDate,
        trigger: "manual",
        triggeredByUserId: auth.userId,
      });
      // Task #95 — bulk pipeline run: there is no single entity whose
      // before/after state we are flipping. The "entity" is the run row
      // itself (`fee_accrual_runs`), which is a fresh insert from the
      // service above — so `before` is null and `after` carries the run
      // identity + status. Per-rule outcomes live in `extra.summary`.
      await writeAuditLog({
        userId: auth.userId,
        action: "fee_accruals_run",
        entityType: "fee_accrual_run",
        entityId: String(run.id),
        before: null,
        after: { id: run.id, trigger: "manual", accrualDate: accrualDate.toISOString() },
        extra: { summary },
        ipAddress: req.ip ?? null,
      });
      return { accrualDate: accrualDate.toISOString(), feeAccrualRunId: run.id, ...summary };
    }),
  );

  // Session 27 (Task #23) — Latest accrual run summary for admins.
  // Returns the most recent row from `fee_accrual_runs` (or null if the table
  // is empty, e.g. on a fresh install before the cron has fired). Used by the
  // admin fees page to surface "last run" status without scanning logs.
  app.get(
    "/api/admin/fee-accrual-runs/latest",
    adminRoute(async () => {
      const [row] = await db
        .select({
          id: feeAccrualRuns.id,
          accrualDate: feeAccrualRuns.accrualDate,
          trigger: feeAccrualRuns.trigger,
          triggeredByUserId: feeAccrualRuns.triggeredByUserId,
          triggeredByUsername: users.username,
          inserted: feeAccrualRuns.inserted,
          skipped: feeAccrualRuns.skipped,
          duplicates: feeAccrualRuns.duplicates,
          byGateReason: feeAccrualRuns.byGateReason,
          errorMessage: feeAccrualRuns.errorMessage,
          // Task #29 — surfaces the "we clipped the auto-backfill window"
          // annotation so the admin Fees page can warn that some UTC dates
          // need a manual replay.
          droppedFromBackfill: feeAccrualRuns.droppedFromBackfill,
          startedAt: feeAccrualRuns.startedAt,
          finishedAt: feeAccrualRuns.finishedAt,
        })
        .from(feeAccrualRuns)
        .leftJoin(users, eq(users.id, feeAccrualRuns.triggeredByUserId))
        .orderBy(desc(feeAccrualRuns.startedAt))
        .limit(1);
      return { run: row ?? null };
    }),
  );

  app.get(
    "/api/admin/fee-accruals",
    adminRoute(async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const offset = (page - 1) * limit;
      const ruleId = Number(req.query.ruleId);
      const adviserId = Number(req.query.adviserUserId);
      const clientId = Number(req.query.clientUserId);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const filters: any[] = [];
      if (Number.isInteger(ruleId) && ruleId > 0) filters.push(eq(adviserFeeAccruals.feeRuleId, ruleId));
      if (Number.isInteger(adviserId) && adviserId > 0) filters.push(eq(adviserFeeAccruals.adviserUserId, adviserId));
      if (Number.isInteger(clientId) && clientId > 0) filters.push(eq(adviserFeeAccruals.clientUserId, clientId));
      if (q) {
        const ids = await findUserIdsByQuery(q);
        if (ids.length === 0) {
          return { items: [], page, limit, total: 0, users: {} };
        }
        filters.push(
          or(
            inArray(adviserFeeAccruals.clientUserId, ids),
            inArray(adviserFeeAccruals.adviserUserId, ids),
          ),
        );
      }
      const where = filters.length ? and(...filters) : undefined;

      const [rows, totalRow] = await Promise.all([
        db
          .select()
          .from(adviserFeeAccruals)
          .where(where as any)
          .orderBy(desc(adviserFeeAccruals.accrualDate), desc(adviserFeeAccruals.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(adviserFeeAccruals)
          .where(where as any),
      ]);
      const usersMap = await getUserNameMap(
        rows.flatMap((r) => [r.clientUserId, r.adviserUserId]),
      );
      return {
        items: rows,
        page,
        limit,
        total: Number(totalRow[0]?.count ?? 0),
        users: usersMap,
      };
    }),
  );

  app.post(
    "/api/admin/fee-deductions/generate",
    adminRoute(async (req, auth) => {
      const startRaw = typeof req.body?.periodStart === "string" ? req.body.periodStart : "";
      const endRaw = typeof req.body?.periodEnd === "string" ? req.body.periodEnd : "";
      const periodStart = new Date(startRaw);
      const periodEnd = new Date(endRaw);
      if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
        throw Object.assign(new Error("Invalid periodStart / periodEnd"), { status: 400 });
      }
      const { generatePendingDeductions } = await import("./services/fee-engine");
      const summary = await generatePendingDeductions({ periodStart, periodEnd });
      // Task #95 — same shape as fee_accruals_run above. The deduction
      // generator inserts many `adviser_fee_deductions` rows in one pass;
      // we capture the bulk run as a single audit row keyed by the
      // billing period. There is no pre-existing entity to snapshot, so
      // `before` is null and `after` carries the period identity. The
      // per-deduction outcomes (count, total) live in `extra.summary`.
      await writeAuditLog({
        userId: auth.userId,
        action: "fee_deductions_generated",
        entityType: "adviser_fee_deductions_run",
        entityId: `${periodStart.toISOString()}_${periodEnd.toISOString()}`,
        before: null,
        after: {
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
        },
        extra: { summary },
        ipAddress: req.ip ?? null,
      });
      return {
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        ...summary,
      };
    }),
  );

  app.get(
    "/api/admin/fee-deductions",
    adminRoute(async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const offset = (page - 1) * limit;
      const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
      const adviserId = Number(req.query.adviserUserId);
      const clientId = Number(req.query.clientUserId);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      // Task #65 — sort modes for the deductions table.
      //   created_desc       (default) newest first
      //   created_asc        oldest first
      //   status_held_first  groups insufficient_funds rows at the top
      //                      (oldest-held-first within them) so admins can
      //                      triage top-ups without scanning every page.
      const sortRaw = typeof req.query.sort === "string" ? req.query.sort.trim() : "";
      const sort: "created_desc" | "created_asc" | "status_held_first" =
        sortRaw === "created_asc" || sortRaw === "status_held_first"
          ? sortRaw
          : "created_desc";
      const filters: any[] = [];
      if (status) filters.push(eq(adviserFeeDeductions.status, status));
      if (Number.isInteger(adviserId) && adviserId > 0) filters.push(eq(adviserFeeDeductions.adviserUserId, adviserId));
      if (Number.isInteger(clientId) && clientId > 0) filters.push(eq(adviserFeeDeductions.clientUserId, clientId));
      if (q) {
        const ids = await findUserIdsByQuery(q);
        if (ids.length === 0) {
          // No users matched — short-circuit the listing, but still report
          // the GLOBAL held count so the header counter stays stable
          // regardless of the active search/filter (Task #65).
          const heldRow = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(adviserFeeDeductions)
            .where(eq(adviserFeeDeductions.status, "insufficient_funds"));
          return {
            items: [],
            page,
            limit,
            total: 0,
            users: {},
            heldCount: Number(heldRow[0]?.count ?? 0),
          };
        }
        filters.push(
          or(
            inArray(adviserFeeDeductions.clientUserId, ids),
            inArray(adviserFeeDeductions.adviserUserId, ids),
          ),
        );
      }
      const where = filters.length ? and(...filters) : undefined;

      const orderBy =
        sort === "created_asc"
          ? [asc(adviserFeeDeductions.createdAt)]
          : sort === "status_held_first"
            ? [
                // 0 for held, 1 for everything else, then oldest first within
                // the held bucket so the longest-stuck top-ups float to the top.
                sql`CASE WHEN ${adviserFeeDeductions.status} = 'insufficient_funds' THEN 0 ELSE 1 END`,
                asc(adviserFeeDeductions.createdAt),
              ]
            : [desc(adviserFeeDeductions.createdAt)];

      const [rows, totalRow, heldRow] = await Promise.all([
        db
          .select()
          .from(adviserFeeDeductions)
          .where(where as any)
          .orderBy(...(orderBy as any))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(adviserFeeDeductions)
          .where(where as any),
        // Task #65 — global count of held rows (NOT scoped to the current
        // status/sort filter) so the header counter stays stable as admins
        // toggle filters.
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(adviserFeeDeductions)
          .where(eq(adviserFeeDeductions.status, "insufficient_funds")),
      ]);
      const usersMap = await getUserNameMap(
        rows.flatMap((r) => [r.clientUserId, r.adviserUserId, r.approvedByUserId]),
      );
      // Task #204 — strip IF-only bookkeeping columns (lastRecheckedAt,
      // clientNotifiedAt, clientNotificationCount) from any row whose status
      // is no longer `insufficient_funds` so the admin UI cannot accidentally
      // render stale "still held" notification text on a settled row.
      const projected = rows.map((r) => projectDeductionForApiContract(r));
      return {
        items: projected,
        page,
        limit,
        total: Number(totalRow[0]?.count ?? 0),
        users: usersMap,
        heldCount: Number(heldRow[0]?.count ?? 0),
      };
    }),
  );

  // -------------------------------------------------------------------------
  // Task #204 — manual insufficient-funds sweep trigger.
  //
  // The daily cron in server/index.ts already calls
  // runInsufficientFundsSweep() once per day. Operators occasionally need to
  // re-run the sweep on demand (e.g. after a batch of clients deposit funds
  // following an outage) without waiting for the next cron tick. This route
  // is the manual entry point: it calls the SAME service function the cron
  // uses, so there is exactly one settlement code path. It honours the
  // `fee_deductions` kill switch transparently — when the switch is engaged
  // the service returns an empty summary without selecting any candidates.
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/insufficient-funds-sweep/run",
    adminRoute(async (req, auth) => {
      // Code-review follow-up — surface the kill-switch state explicitly so
      // the admin UI can show "no rows checked because the fee_deductions
      // kill switch is engaged" instead of a bare checked=0 summary that's
      // ambiguous (no IF rows vs sweep blocked). We probe the switch
      // BEFORE invoking the service so the response carries an accurate
      // pre-run snapshot; the service itself still re-checks and bails
      // cleanly if the operator flips the switch mid-run.
      const killSwitchActive = await isKillSwitchActive("fee_deductions");
      const summary: InsufficientFundsSweepSummary =
        await runInsufficientFundsSweep({
          approverUserId: auth.userId,
        });
      const message = killSwitchActive
        ? "Sweep skipped: fee_deductions kill switch is engaged. " +
          "Disable the switch on the kill switches page to allow the next run to process held rows."
        : `Sweep complete: checked ${summary.checked}, settled ${summary.settled}, ` +
          `still insufficient ${summary.stillInsufficient}, errors ${summary.errors}.`;
      await writeAuditLog({
        userId: auth.userId,
        action: "insufficient_funds_sweep.manual_run",
        entityType: "insufficient_funds_sweep",
        // No persistent run-row identity (the sweep doesn't write a runs
        // table the way fee_accruals_run does), so use the timestamp as the
        // entity id — uniquely identifies this manual trigger in the audit
        // log and is enough to correlate with downstream
        // fee_deduction.auto_resettled / client_notified rows the sweep
        // itself writes.
        entityId: new Date().toISOString(),
        before: null,
        after: { trigger: "manual", invokedByUserId: auth.userId },
        extra: { summary, killSwitchActive },
        ipAddress: req.ip ?? null,
      });
      return { trigger: "manual", killSwitchActive, message, ...summary };
    }),
  );

  app.post(
    "/api/admin/fee-deductions/:id/approve",
    adminRoute(async (req, auth) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw Object.assign(new Error("Invalid deduction id"), { status: 400 });
      }

      // GATE B: approve = settle. The service performs the entire flow
      // (lock → insert transaction → post ledger entries → refresh wallet
      // cache → mark settled) inside one DB transaction. Idempotent on
      // deduction id — a retry of an already-settled deduction returns the
      // existing row without re-posting.
      const { settleApprovedDeduction } = await import("./services/fee-engine");
      const { LedgerUnbalancedError, notifyLedgerUnbalanced, LEDGER_UNBALANCED_USER_MESSAGE } =
        await import("./services/ledger");

      // Task #95 — capture the row state BEFORE the settle attempt so the
      // audit row can show exactly what changed (or what was about to change
      // when the attempt failed). We pick the small set of fields that flip
      // during settlement; capturing the full row would bloat the metadata
      // jsonb without making the diff any clearer.
      const [beforeRow] = await db
        .select()
        .from(adviserFeeDeductions)
        .where(eq(adviserFeeDeductions.id, id))
        .limit(1);
      const beforeSnapshot = beforeRow
        ? {
            status: beforeRow.status,
            settledTransactionId: beforeRow.settledTransactionId,
            settledAt: beforeRow.settledAt,
            approvedByUserId: beforeRow.approvedByUserId,
            approvedAt: beforeRow.approvedAt,
            failureReason: beforeRow.failureReason,
          }
        : null;

      // Task #307 / Task #476 — runtime consent integrity gate. The accrual
      // job's gate ladder runs at accrual time, but a consent can be
      // withdrawn, expire, or move out of `active` between accrual and
      // approval. If we let the settle path run anyway, an admin click
      // could move money against a consent that no longer exists. Re-run
      // the same ladder here using the shared helper so the chokepoint is
      // gated by exactly the same definition as the accrual loop.
      //
      // Task #476: a single deduction is rolled up by
      // `generatePendingDeductions` from accruals grouped on
      // (clientUserId, adviserUserId, currency) — meaning multiple distinct
      // rules (different fee_types / account numbers) can contribute to
      // ONE deduction. We must therefore check every distinct rule's
      // consent, not just the first accrual's. Refuse on the FIRST gate
      // failure encountered (the audit row records that specific rule +
      // reason; subsequent failures, if any, will surface on retry once
      // the operator has resolved the first).
      const accrualIdsRaw = beforeRow?.accrualIds;
      const accrualIds: number[] = Array.isArray(accrualIdsRaw)
        ? (accrualIdsRaw as unknown[]).filter(
            (v): v is number => typeof v === "number" && Number.isFinite(v),
          )
        : [];
      if (accrualIds.length > 0) {
        const accrualRows = await db
          .select({ feeRuleId: adviserFeeAccruals.feeRuleId })
          .from(adviserFeeAccruals)
          .where(inArray(adviserFeeAccruals.id, accrualIds));
        const distinctRuleIds = Array.from(
          new Set(accrualRows.map((a) => a.feeRuleId)),
        );
        if (distinctRuleIds.length > 0) {
          const ruleRows = await db
            .select({
              id: adviserFeeRules.id,
              feeConsentId: adviserFeeRules.feeConsentId,
            })
            .from(adviserFeeRules)
            .where(inArray(adviserFeeRules.id, distinctRuleIds));
          const { assertConsentValidForExecution, CONSENT_GATE_AUDIT_ACTIONS } =
            await import("./services/consent-integrity");

          // Defensive completeness — if any backing rule has been
          // deleted (referential integrity is FK-protected today, but
          // a future migration or a manual intervention could orphan a
          // deduction), the consent gate would silently skip them and
          // the approval would proceed against a deduction whose legal
          // basis we cannot verify. Refuse explicitly with a typed
          // 409 so the operator surfaces the data-integrity break
          // rather than money moving on partial evidence.
          const foundRuleIds = new Set(ruleRows.map((r) => r.id));
          const missingRuleIds = distinctRuleIds.filter(
            (rid) => !foundRuleIds.has(rid),
          );
          if (missingRuleIds.length > 0) {
            await writeAuditLog({
              userId: auth.userId,
              action: CONSENT_GATE_AUDIT_ACTIONS.deductionApproveRoute,
              entityType: "adviser_fee_deduction",
              entityId: String(id),
              before: beforeSnapshot,
              after: null,
              extra: {
                reason: "backing_rule_missing",
                missingRuleIds,
                rulesExpected: distinctRuleIds.length,
                rulesFound: ruleRows.length,
              },
              ipAddress: req.ip ?? null,
            });
            throw Object.assign(
              new Error(
                `Cannot approve deduction — ${missingRuleIds.length} backing rule(s) missing: [${missingRuleIds.join(", ")}]`,
              ),
              {
                status: 409,
                body: {
                  code: "backing_rule_missing",
                  reason: "backing_rule_missing",
                  missingRuleIds,
                },
              },
            );
          }

          // Iterate in stable id order so the "first failure" is
          // deterministic across reruns — important for audit-row
          // reproducibility.
          ruleRows.sort((a, b) => a.id - b.id);
          for (const rule of ruleRows) {
            const gate = await assertConsentValidForExecution(rule.feeConsentId);
            if (!gate.ok) {
              await writeAuditLog({
                userId: auth.userId,
                action: CONSENT_GATE_AUDIT_ACTIONS.deductionApproveRoute,
                entityType: "adviser_fee_deduction",
                entityId: String(id),
                before: beforeSnapshot,
                after: null,
                extra: {
                  reason: gate.reason,
                  consentId: rule.feeConsentId,
                  ruleId: rule.id,
                  rulesChecked: ruleRows.length,
                },
                ipAddress: req.ip ?? null,
              });
              throw Object.assign(
                new Error(
                  `Cannot approve deduction — consent integrity gate failed: ${gate.reason}`,
                ),
                {
                  status: 409,
                  body: {
                    code: gate.reason,
                    reason: gate.reason,
                    consentId: rule.feeConsentId,
                    ruleId: rule.id,
                  },
                },
              );
            }
          }
        }
      }

      let settled;
      try {
        settled = await settleApprovedDeduction({
          deductionId: id,
          approverUserId: auth.userId,
        });
      } catch (err: any) {
        // Audit the failed attempt so the operator trail is continuous.
        // We do NOT rollback the audit row on the (already-rolled-back)
        // settlement attempt — auditing a failure is the whole point.
        //
        // Task #95 (post-review fix): settleApprovedDeduction's catch block
        // performs a SEPARATE persisted update on the deduction row even
        // when the ledger-posting tx rolls back — it flips
        // `failureReason` (and, for insufficient funds, `status` →
        // 'insufficient_funds') so admins can see why the attempt failed.
        // That mutation IS visible after the throw, so we must re-read
        // the row to capture the real post-failure state in `after`.
        // Recording `after: null` here would have hidden a real DB
        // mutation from regulators.
        const [afterRow] = await db
          .select()
          .from(adviserFeeDeductions)
          .where(eq(adviserFeeDeductions.id, id))
          .limit(1);
        const afterSnapshot = afterRow
          ? {
              status: afterRow.status,
              settledTransactionId: afterRow.settledTransactionId,
              settledAt: afterRow.settledAt,
              approvedByUserId: afterRow.approvedByUserId,
              approvedAt: afterRow.approvedAt,
              failureReason: afterRow.failureReason,
            }
          : null;
        await writeAuditLog({
          userId: auth.userId,
          action: "fee_deduction_settle_failed",
          entityType: "adviser_fee_deduction",
          entityId: String(id),
          before: beforeSnapshot,
          after: afterSnapshot,
          extra: {
            error: err?.message ? String(err.message) : String(err),
            status: err?.status ?? null,
            errorName: err?.name ?? null,
          },
          ipAddress: req.ip ?? null,
        });
        // Task #54 — if the failure was specifically the balanced-journal
        // guard tripping, page an operator and re-throw a sanitized 422
        // so the admin sees a clean message instead of the raw internal
        // credits/debits numbers from the technical Error message.
        if (err instanceof LedgerUnbalancedError) {
          await notifyLedgerUnbalanced({
            source: "fee_deduction_settlement",
            err,
            context: {
              route: "/api/admin/fee-deductions/:id/approve",
              deductionId: id,
              approverUserId: auth.userId,
              ipAddress: req.ip ?? null,
            },
          });
          throw Object.assign(new Error(LEDGER_UNBALANCED_USER_MESSAGE), {
            status: 422,
            body: { code: "ledger_unbalanced" },
          });
        }
        throw err;
      }

      // Successful settlement → audit the posting (with the transaction id
      // so the auditor can walk straight to the ledger entries). The
      // before/after diff makes the status flip + settled-transaction
      // attachment explicit; total/share/currency live in `extra` because
      // they are immutable invariants of the deduction, not state changes.
      await writeAuditLog({
        userId: auth.userId,
        action: "fee_deduction_settled",
        entityType: "adviser_fee_deduction",
        entityId: String(id),
        before: beforeSnapshot,
        after: {
          status: settled.status,
          settledTransactionId: settled.settledTransactionId,
          settledAt: settled.settledAt,
          approvedByUserId: settled.approvedByUserId,
          approvedAt: settled.approvedAt,
          failureReason: settled.failureReason,
        },
        extra: {
          totalAccrued: settled.totalAccrued,
          adviserShareAmount: settled.adviserShareAmount,
          platformShareAmount: settled.platformShareAmount,
          currency: settled.currency,
        },
        ipAddress: req.ip ?? null,
      });
      return settled;
    }),
  );

  // -------------------------------------------------------------------------
  // TASK #33 — Reverse a settled deduction.
  //   POST /api/admin/fee-deductions/:id/reverse
  //   Body: { reason: string }   (required, non-empty, ≤1000 chars)
  //
  // Posts the OPPOSITE balanced ledger triple against a NEW transactions row
  // and flips the deduction to status='reversed'. The original `settled_*`
  // columns are NEVER edited — history is append-only; the reversal pointer
  // lives in `reversal_transaction_id`.
  //
  // Audit log row is written for both success ('fee_deduction_reversed') and
  // failure ('fee_deduction_reverse_failed') so the operator trail is
  // continuous even when the underlying DB transaction rolled back.
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/fee-deductions/:id/reverse",
    adminRoute(async (req, auth) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw Object.assign(new Error("Invalid deduction id"), { status: 400 });
      }
      const reason =
        typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (!reason) {
        throw Object.assign(
          new Error("A reason is required to reverse a settled deduction"),
          { status: 400 },
        );
      }

      const { reverseSettledDeduction } = await import("./services/fee-engine");

      // Task #95 — capture the row state BEFORE the reversal attempt so the
      // audit row carries an explicit "settled → reversed" diff rather than
      // just "the new reversed values". Pulled from a one-shot SELECT (the
      // service does its own FOR UPDATE inside its tx).
      const [beforeRow] = await db
        .select()
        .from(adviserFeeDeductions)
        .where(eq(adviserFeeDeductions.id, id))
        .limit(1);
      const beforeSnapshot = beforeRow
        ? {
            status: beforeRow.status,
            settledTransactionId: beforeRow.settledTransactionId,
            reversedAt: beforeRow.reversedAt,
            reversedByUserId: beforeRow.reversedByUserId,
            reversedReason: beforeRow.reversedReason,
            reversalTransactionId: beforeRow.reversalTransactionId,
          }
        : null;

      let reversed;
      try {
        reversed = await reverseSettledDeduction({
          deductionId: id,
          reverserUserId: auth.userId,
          reason,
        });
      } catch (err: any) {
        await writeAuditLog({
          userId: auth.userId,
          action: "fee_deduction_reverse_failed",
          entityType: "adviser_fee_deduction",
          entityId: String(id),
          before: beforeSnapshot,
          after: null,
          extra: {
            reason,
            error: err?.message ? String(err.message) : String(err),
            status: err?.status ?? null,
          },
          ipAddress: req.ip ?? null,
        });
        throw err;
      }

      await writeAuditLog({
        userId: auth.userId,
        action: "fee_deduction_reversed",
        entityType: "adviser_fee_deduction",
        entityId: String(id),
        before: beforeSnapshot,
        after: {
          status: reversed.status,
          settledTransactionId: reversed.settledTransactionId,
          reversedAt: reversed.reversedAt,
          reversedByUserId: reversed.reversedByUserId,
          reversedReason: reversed.reversedReason,
          reversalTransactionId: reversed.reversalTransactionId,
        },
        extra: {
          reason,
          totalAccrued: reversed.totalAccrued,
          adviserShareAmount: reversed.adviserShareAmount,
          platformShareAmount: reversed.platformShareAmount,
          currency: reversed.currency,
        },
        ipAddress: req.ip ?? null,
      });
      return reversed;
    }),
  );

  // ===========================================================================
  // TASK #93 — Fee reconciliation + payout REPORTING (read-only)
  // ---------------------------------------------------------------------------
  // Four read-only endpoints that let admins answer:
  //   1. "What does each adviser get paid this period?"  (/adviser-payouts)
  //   2. "What's the platform's share of fee revenue?"   (/platform-fee-revenue)
  //   3. "What fee deductions are stuck?"                (/fee-exceptions)
  //   4. "How does the picture roll up overall?"          (/fee-reconciliation)
  //
  // HARD RULES (do not relax without a new gate):
  //   - Reporting only. NO money movement, NO external payout, NO bank
  //     transfer, NO automatic monthly sweep. Any future endpoint that
  //     mutates payout state belongs behind its own gate.
  //   - Period-scoped. Every query reads `?from=ISO&to=ISO` and validates
  //     the bounds the same way `/api/admin/operator-alerts` does
  //     (length-bound, NaN-guard, 400 on invalid, 400 on `from > to`).
  //     A fresh DB load with no period filter must NEVER trigger an
  //     unbounded scan over `adviser_fee_deductions`.
  //   - Read-only. No `auditLogs` row is written.
  //   - Reuse `MATCH_EPSILON` from `services/reconciliation` for any drift
  //     comparison; do not introduce a second tolerance constant.
  //   - Access: admin OR compliance_admin (see feeReportingRoute below).
  //     The latter role is reserved for compliance-only operators who
  //     should be able to read fee-flow numbers without the rest of the
  //     admin surface.
  // ===========================================================================

  // ---- Reporting-route wrapper: admin OR compliance_admin ------------------
  // We do NOT reuse `adminRoute` because that calls
  // `requireRole(auth, "admin")` and would lock compliance_admin out. The
  // reporting endpoints are strictly read-only so the broader audience is
  // safe — and is required by the spec.
  function feeReportingRoute(
    handler: (
      req: Request,
      auth: { userId: number; username: string; email: string; role: string },
    ) => Promise<unknown>,
  ) {
    return async (req: Request, res: any) => {
      try {
        const auth = requireAuth(req);
        requireRole(auth, "admin", "compliance_admin");
        const result = await handler(req, auth);
        res.json(result);
      } catch (error: any) {
        handleError(res, error, "Fee reporting request failed");
      }
    };
  }

  // ---- Typed row extractor for raw db.execute() results --------------------
  // drizzle-orm/neon-serverless returns a pg-shaped QueryResult whose `rows`
  // is `Record<string, unknown>[]`. The rest of this file uses `(result as
  // any).rows`; for the new reporting endpoints we use a tiny generic helper
  // so the call sites stay typed instead of leaking `as any` everywhere.
  function rowsFrom<T extends Record<string, unknown>>(
    result: { rows?: unknown },
  ): T[] {
    const r = result.rows;
    return Array.isArray(r) ? (r as T[]) : [];
  }

  // ---- Shared period parser (mirrors the operator-alerts endpoint) ---------
  function parseFeeReportingPeriod(req: Request): { from: Date; to: Date } {
    const fromRaw =
      typeof req.query.from === "string" ? req.query.from.trim() : "";
    const toRaw =
      typeof req.query.to === "string" ? req.query.to.trim() : "";
    const parseBound = (raw: string, label: string): Date | null => {
      if (raw.length === 0) return null;
      if (raw.length > 64) {
        throw Object.assign(new Error(`${label} is too long`), { status: 400 });
      }
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) {
        throw Object.assign(
          new Error(`${label} is not a valid ISO timestamp`),
          { status: 400 },
        );
      }
      return d;
    };
    const fromDate = parseBound(fromRaw, "from");
    const toDate = parseBound(toRaw, "to");
    if (!fromDate || !toDate) {
      throw Object.assign(
        new Error(
          "Both `from` and `to` are required (ISO timestamps). Reporting endpoints never run unbounded.",
        ),
        { status: 400 },
      );
    }
    if (fromDate.getTime() > toDate.getTime()) {
      throw Object.assign(
        new Error("from must be earlier than or equal to to"),
        { status: 400 },
      );
    }
    return { from: fromDate, to: toDate };
  }

  // -------------------------------------------------------------------------
  // GET /api/admin/fee-reconciliation?from=ISO&to=ISO
  //
  // Single-shot summary across deduction statuses for the period plus any
  // wallet-vs-ledger drift attributable to users involved in fee deductions
  // in that period. The drift count is the number of distinct (userId,
  // currency) pairs whose MOST RECENT wallet_ledger_reconciliations row is
  // a mismatch above MATCH_EPSILON, restricted to users that appeared on
  // either side of a fee deduction in the period (clients OR advisers).
  // We use the most-recent recon row per pair to avoid double-counting the
  // daily entries the cron writes.
  //
  // Status buckets:
  //   - settled         → settledAt ∈ [from, to]
  //   - reversed        → reversedAt ∈ [from, to]
  //   - insufficient_funds / pending_approval → CURRENT status,
  //                       createdAt ∈ [from, to] (so a fresh load is bounded)
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/fee-reconciliation",
    feeReportingRoute(async (req) => {
      const { from, to } = parseFeeReportingPeriod(req);

      // Settled in window — keyed by settledAt because that's when the
      // money actually moved on the ledger.
      const settledAgg = await db
        .select({
          count: sql<number>`count(*)::int`,
          totalAccrued: sql<string>`coalesce(sum(${adviserFeeDeductions.totalAccrued}), 0)::text`,
          adviserShare: sql<string>`coalesce(sum(${adviserFeeDeductions.adviserShareAmount}), 0)::text`,
          platformShare: sql<string>`coalesce(sum(${adviserFeeDeductions.platformShareAmount}), 0)::text`,
        })
        .from(adviserFeeDeductions)
        .where(
          and(
            eq(adviserFeeDeductions.status, "settled"),
            gte(adviserFeeDeductions.settledAt, from),
            lte(adviserFeeDeductions.settledAt, to),
          ),
        );

      // Reversed in window — keyed by reversedAt for the same reason.
      const reversedAgg = await db
        .select({
          count: sql<number>`count(*)::int`,
          totalAccrued: sql<string>`coalesce(sum(${adviserFeeDeductions.totalAccrued}), 0)::text`,
          adviserShare: sql<string>`coalesce(sum(${adviserFeeDeductions.adviserShareAmount}), 0)::text`,
          platformShare: sql<string>`coalesce(sum(${adviserFeeDeductions.platformShareAmount}), 0)::text`,
        })
        .from(adviserFeeDeductions)
        .where(
          and(
            eq(adviserFeeDeductions.status, "reversed"),
            gte(adviserFeeDeductions.reversedAt, from),
            lte(adviserFeeDeductions.reversedAt, to),
          ),
        );

      // Currently held / pending — bound to createdAt so the scan stays
      // period-shaped.
      const heldAgg = await db
        .select({
          count: sql<number>`count(*)::int`,
          totalAccrued: sql<string>`coalesce(sum(${adviserFeeDeductions.totalAccrued}), 0)::text`,
        })
        .from(adviserFeeDeductions)
        .where(
          and(
            eq(adviserFeeDeductions.status, "insufficient_funds"),
            gte(adviserFeeDeductions.createdAt, from),
            lte(adviserFeeDeductions.createdAt, to),
          ),
        );

      const pendingAgg = await db
        .select({
          count: sql<number>`count(*)::int`,
          totalAccrued: sql<string>`coalesce(sum(${adviserFeeDeductions.totalAccrued}), 0)::text`,
        })
        .from(adviserFeeDeductions)
        .where(
          and(
            eq(adviserFeeDeductions.status, "pending_approval"),
            gte(adviserFeeDeductions.createdAt, from),
            lte(adviserFeeDeductions.createdAt, to),
          ),
        );

      // Wallet-vs-ledger drift attributable to fee transactions in the
      // period.
      //
      // The wallet_ledger_reconciliations table stores per-(user, currency)
      // SNAPSHOTS — it has no transactionId column, because a snapshot is
      // a balance comparison, not a per-posting receipt. So we can't
      // directly filter recon rows by "this transaction belongs to a fee
      // deduction in the period". Instead we walk the link the other way:
      //
      //   1. Collect the fee deduction transaction ids that POSTED in the
      //      period — i.e. any settledTransactionId whose deduction was
      //      settled in the window, plus any reversalTransactionId whose
      //      deduction was reversed in the window.
      //   2. Look up the (userId, currency) pairs those ledger entries
      //      moved (via ledger_entries.transaction_id → user_id, currency).
      //   3. For each such pair, take the LATEST wallet_ledger_reconciliations
      //      row and count it as "drifted" iff abs(drift_amount) >
      //      MATCH_EPSILON.
      //
      // This is fee-transaction-linked attribution: a wallet that drifted
      // for some unrelated cause does not count here unless a fee posting
      // touched the same (user, currency) in the window.
      const driftRow = await db.execute(sql`
        WITH fee_tx_ids AS (
          SELECT ${adviserFeeDeductions.settledTransactionId} AS transaction_id
          FROM ${adviserFeeDeductions}
          WHERE ${adviserFeeDeductions.status} = 'settled'
            AND ${adviserFeeDeductions.settledAt} BETWEEN ${from} AND ${to}
            AND ${adviserFeeDeductions.settledTransactionId} IS NOT NULL
          UNION
          SELECT ${adviserFeeDeductions.reversalTransactionId} AS transaction_id
          FROM ${adviserFeeDeductions}
          WHERE ${adviserFeeDeductions.status} = 'reversed'
            AND ${adviserFeeDeductions.reversedAt} BETWEEN ${from} AND ${to}
            AND ${adviserFeeDeductions.reversalTransactionId} IS NOT NULL
        ),
        touched_pairs AS (
          SELECT DISTINCT le.user_id, le.currency
          FROM ${ledgerEntries} le
          INNER JOIN fee_tx_ids f ON f.transaction_id = le.transaction_id
        ),
        latest_recon AS (
          SELECT DISTINCT ON (r.user_id, r.currency)
                 r.user_id, r.currency, r.drift_amount, r.status
          FROM ${walletLedgerReconciliations} r
          INNER JOIN touched_pairs tp
            ON tp.user_id = r.user_id AND tp.currency = r.currency
          ORDER BY r.user_id, r.currency, r.created_at DESC, r.id DESC
        )
        SELECT user_id AS "userId", currency
        FROM latest_recon
        WHERE abs(drift_amount) > ${MATCH_EPSILON}
        ORDER BY user_id, currency
      `);
      const driftPairs = rowsFrom<{ userId: number; currency: string }>(
        driftRow,
      ).map((r) => ({ userId: Number(r.userId), currency: String(r.currency) }));
      const driftCount = driftPairs.length;

      return {
        period: { from: from.toISOString(), to: to.toISOString() },
        settled: {
          count: Number(settledAgg[0]?.count ?? 0),
          totalAccrued: String(settledAgg[0]?.totalAccrued ?? "0"),
          adviserShare: String(settledAgg[0]?.adviserShare ?? "0"),
          platformShare: String(settledAgg[0]?.platformShare ?? "0"),
        },
        reversed: {
          count: Number(reversedAgg[0]?.count ?? 0),
          totalAccrued: String(reversedAgg[0]?.totalAccrued ?? "0"),
          adviserShare: String(reversedAgg[0]?.adviserShare ?? "0"),
          platformShare: String(reversedAgg[0]?.platformShare ?? "0"),
        },
        insufficientFunds: {
          count: Number(heldAgg[0]?.count ?? 0),
          totalAccrued: String(heldAgg[0]?.totalAccrued ?? "0"),
        },
        pendingApproval: {
          count: Number(pendingAgg[0]?.count ?? 0),
          totalAccrued: String(pendingAgg[0]?.totalAccrued ?? "0"),
        },
        walletLedgerDrift: {
          count: driftCount,
          // Surfaced so the UI can explain the number without the admin
          // having to hunt down where the tolerance lives.
          matchEpsilon: MATCH_EPSILON,
          // The exact (userId, currency) pairs counted above. The drift
          // card uses these to drill down into the reconciliation page
          // showing the SAME source rows — so the count never disagrees
          // with what the recon page itself displays.
          pairs: driftPairs,
        },
      };
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/adviser-payouts?from=ISO&to=ISO
  //
  // Per-adviser roll-up for the period:
  //   - settled count + sum of adviser_share_amount (settled in window)
  //   - reversed count + sum of adviser_share_amount (reversed in window)
  //   - net payable = settled adviser_share - reversed adviser_share
  //
  // Joined to `users` so the UI can render the adviser's name + email and
  // link straight to the adviser detail page. The join filters on
  // `users.role = 'adviser'`. A non-adviser user with a settled deduction
  // (data corruption) is intentionally NOT silently aggregated here — it
  // surfaces as an exception in /fee-exceptions instead.
  //
  // Sorted by net payable DESC by default; client-side resort is fine since
  // payload size is per-adviser, not per-deduction.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/adviser-payouts",
    feeReportingRoute(async (req) => {
      const { from, to } = parseFeeReportingPeriod(req);

      // Settled-in-window aggregates joined to users(adviser).
      const settledRows = await db
        .select({
          adviserUserId: adviserFeeDeductions.adviserUserId,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          settledCount: sql<number>`count(*)::int`,
          settledTotal: sql<string>`coalesce(sum(${adviserFeeDeductions.adviserShareAmount}), 0)::text`,
          settledTotalAccrued: sql<string>`coalesce(sum(${adviserFeeDeductions.totalAccrued}), 0)::text`,
        })
        .from(adviserFeeDeductions)
        .innerJoin(users, eq(users.id, adviserFeeDeductions.adviserUserId))
        .where(
          and(
            eq(adviserFeeDeductions.status, "settled"),
            eq(users.role, "adviser"),
            gte(adviserFeeDeductions.settledAt, from),
            lte(adviserFeeDeductions.settledAt, to),
          ),
        )
        .groupBy(
          adviserFeeDeductions.adviserUserId,
          users.firstName,
          users.lastName,
          users.email,
        );

      const reversedRows = await db
        .select({
          adviserUserId: adviserFeeDeductions.adviserUserId,
          reversedCount: sql<number>`count(*)::int`,
          reversedTotal: sql<string>`coalesce(sum(${adviserFeeDeductions.adviserShareAmount}), 0)::text`,
          reversedTotalAccrued: sql<string>`coalesce(sum(${adviserFeeDeductions.totalAccrued}), 0)::text`,
        })
        .from(adviserFeeDeductions)
        .innerJoin(users, eq(users.id, adviserFeeDeductions.adviserUserId))
        .where(
          and(
            eq(adviserFeeDeductions.status, "reversed"),
            eq(users.role, "adviser"),
            gte(adviserFeeDeductions.reversedAt, from),
            lte(adviserFeeDeductions.reversedAt, to),
          ),
        )
        .groupBy(adviserFeeDeductions.adviserUserId);

      // Merge the two halves keyed by adviser id. An adviser may have
      // settlements without reversals (the common case) or vice versa
      // (e.g. unwinding a settlement that happened pre-period).
      type Row = {
        adviserUserId: number;
        firstName: string;
        lastName: string;
        email: string;
        settledCount: number;
        settledTotal: string;
        settledTotalAccrued: string;
        reversedCount: number;
        reversedTotal: string;
        reversedTotalAccrued: string;
        netPayable: string;
      };
      const map = new Map<number, Row>();
      for (const s of settledRows) {
        map.set(s.adviserUserId, {
          adviserUserId: s.adviserUserId,
          firstName: s.firstName ?? "",
          lastName: s.lastName ?? "",
          email: s.email ?? "",
          settledCount: Number(s.settledCount ?? 0),
          settledTotal: String(s.settledTotal ?? "0"),
          settledTotalAccrued: String(s.settledTotalAccrued ?? "0"),
          reversedCount: 0,
          reversedTotal: "0",
          reversedTotalAccrued: "0",
          netPayable: "0",
        });
      }
      // For advisers that ONLY have reversals in the window we still want a
      // row, so look up their identity separately.
      const advisersNeedingLookup: number[] = [];
      for (const r of reversedRows) {
        const existing = map.get(r.adviserUserId);
        if (existing) {
          existing.reversedCount = Number(r.reversedCount ?? 0);
          existing.reversedTotal = String(r.reversedTotal ?? "0");
          existing.reversedTotalAccrued = String(r.reversedTotalAccrued ?? "0");
        } else {
          advisersNeedingLookup.push(r.adviserUserId);
        }
      }
      if (advisersNeedingLookup.length > 0) {
        const lookupRows = await db
          .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
          })
          .from(users)
          .where(
            and(
              inArray(users.id, advisersNeedingLookup),
              eq(users.role, "adviser"),
            ),
          );
        const byId = new Map(lookupRows.map((u) => [u.id, u]));
        for (const r of reversedRows) {
          if (map.has(r.adviserUserId)) continue;
          const u = byId.get(r.adviserUserId);
          if (!u) continue; // non-adviser corruption — Exceptions tab will surface it
          map.set(r.adviserUserId, {
            adviserUserId: r.adviserUserId,
            firstName: u.firstName ?? "",
            lastName: u.lastName ?? "",
            email: u.email ?? "",
            settledCount: 0,
            settledTotal: "0",
            settledTotalAccrued: "0",
            reversedCount: Number(r.reversedCount ?? 0),
            reversedTotal: String(r.reversedTotal ?? "0"),
            reversedTotalAccrued: String(r.reversedTotalAccrued ?? "0"),
            netPayable: "0",
          });
        }
      }

      // Compute net payable (settled adviser-share minus reversed
      // adviser-share). Strings → Number → toFixed(4) so the response
      // matches the 4dp precision the deductions table stores at.
      const items: Row[] = Array.from(map.values()).map((row) => ({
        ...row,
        netPayable: (
          Number(row.settledTotal) - Number(row.reversedTotal)
        ).toFixed(4),
      }));

      items.sort((a, b) => Number(b.netPayable) - Number(a.netPayable));

      return {
        period: { from: from.toISOString(), to: to.toISOString() },
        items,
      };
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/platform-fee-revenue?from=ISO&to=ISO&buckets=monthly|weekly
  //
  // Time-bucketed sums of `platform_share_amount` from settled deductions
  // (status='settled' AND settledAt in window). Once a deduction is
  // reversed its status flips to 'reversed' and the row drops out of this
  // sum — so the result is implicitly "settled and not subsequently
  // reversed", as the spec requires, without us having to maintain a
  // separate "is currently active" join.
  //
  // Buckets:
  //   - monthly (default): truncate settledAt to the first day of its month.
  //   - weekly           : truncate to the start of its ISO week (Mon).
  //
  // The response also exposes a `sparkline` of the LAST 12 buckets ending
  // at `to`, regardless of `from`, so the UI can render trend context even
  // when the admin has selected a narrow window.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/platform-fee-revenue",
    feeReportingRoute(async (req) => {
      const { from, to } = parseFeeReportingPeriod(req);
      const bucketsRaw =
        typeof req.query.buckets === "string"
          ? req.query.buckets.trim()
          : "monthly";
      const bucket: "monthly" | "weekly" =
        bucketsRaw === "weekly" ? "weekly" : "monthly";
      const truncUnit = bucket === "weekly" ? "week" : "month";

      // Period rollup.
      const inWindow = await db.execute(sql`
        SELECT
          date_trunc(${truncUnit}, ${adviserFeeDeductions.settledAt}) AS bucket,
          count(*)::int AS count,
          coalesce(sum(${adviserFeeDeductions.platformShareAmount}), 0)::text AS platform_share,
          coalesce(sum(${adviserFeeDeductions.totalAccrued}), 0)::text AS total_accrued
        FROM ${adviserFeeDeductions}
        WHERE ${adviserFeeDeductions.status} = 'settled'
          AND ${adviserFeeDeductions.settledAt} BETWEEN ${from} AND ${to}
        GROUP BY bucket
        ORDER BY bucket ASC
      `);
      type RevenueRow = {
        bucket: string | Date;
        count: number;
        platform_share: string;
        total_accrued: string;
      };
      const items = rowsFrom<RevenueRow>(inWindow).map((row) => ({
        bucket: new Date(row.bucket).toISOString(),
        count: Number(row.count ?? 0),
        platformShare: String(row.platform_share ?? "0"),
        totalAccrued: String(row.total_accrued ?? "0"),
      }));

      // 12-bucket sparkline ending at `to`. We compute the start window
      // server-side so the client doesn't need to know the bucket
      // arithmetic (handles month-of-31-days vs leap-day correctly).
      // The densification cursor MUST land on the same boundaries that
      // postgres' `date_trunc(...)` produces, otherwise the lookup map
      // misses every bucket. `date_trunc('month', x)` → first-of-month
      // 00:00 UTC; `date_trunc('week', x)` → Monday 00:00 UTC (ISO).
      const sparkStart = new Date(to.getTime());
      if (bucket === "monthly") {
        sparkStart.setUTCMonth(sparkStart.getUTCMonth() - 11);
        sparkStart.setUTCDate(1);
        sparkStart.setUTCHours(0, 0, 0, 0);
      } else {
        sparkStart.setUTCHours(0, 0, 0, 0);
        // Snap back to Monday (PG ISO week start). getUTCDay(): 0=Sun..6=Sat.
        const dayOffset = (sparkStart.getUTCDay() + 6) % 7;
        sparkStart.setUTCDate(sparkStart.getUTCDate() - dayOffset - 7 * 11);
      }
      const sparkRaw = await db.execute(sql`
        SELECT
          date_trunc(${truncUnit}, ${adviserFeeDeductions.settledAt}) AS bucket,
          coalesce(sum(${adviserFeeDeductions.platformShareAmount}), 0)::text AS platform_share
        FROM ${adviserFeeDeductions}
        WHERE ${adviserFeeDeductions.status} = 'settled'
          AND ${adviserFeeDeductions.settledAt} BETWEEN ${sparkStart} AND ${to}
        GROUP BY bucket
        ORDER BY bucket ASC
      `);
      type SparkRow = { bucket: string | Date; platform_share: string };
      const sparkByIso = new Map<string, string>();
      for (const row of rowsFrom<SparkRow>(sparkRaw)) {
        sparkByIso.set(
          new Date(row.bucket).toISOString(),
          String(row.platform_share ?? "0"),
        );
      }
      // Densify to exactly 12 buckets so the UI sparkline renders a stable
      // 12-period band even when revenue was zero in some intervals.
      const sparkline: { bucket: string; platformShare: string }[] = [];
      const cursor = new Date(sparkStart.getTime());
      for (let i = 0; i < 12; i++) {
        const iso = cursor.toISOString();
        sparkline.push({
          bucket: iso,
          platformShare: sparkByIso.get(iso) ?? "0",
        });
        if (bucket === "monthly") {
          cursor.setUTCMonth(cursor.getUTCMonth() + 1);
        } else {
          cursor.setUTCDate(cursor.getUTCDate() + 7);
        }
      }

      return {
        period: { from: from.toISOString(), to: to.toISOString() },
        bucket,
        items,
        sparkline,
      };
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/fee-exceptions?from=ISO&to=ISO
  //
  // One row per problem deduction in the period:
  //   - status = 'insufficient_funds'                              (held)
  //   - status = 'pending_approval' AND createdAt < now() - 7 days (stuck)
  //   - failureReason IS NOT NULL                                  (failed)
  //
  // Includes Task #64 sweep tracking columns so the admin can see what the
  // daily insufficient-funds sweep last did. Plus a `kind` discriminator
  // (`held|stuck|failed|role_corruption`) the UI uses to render an icon and
  // pre-build the "Open in deductions" link (which sets status filter +
  // jumps to the row).
  //
  // Also includes "role corruption" rows: settled or reversed deductions
  // whose adviserUserId points at a user whose role is NOT 'adviser'. These
  // would silently aggregate into an adviser payout row otherwise — the
  // /adviser-payouts query filters them out so they MUST surface here.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/fee-exceptions",
    feeReportingRoute(async (req) => {
      const { from, to } = parseFeeReportingPeriod(req);
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
      const stuckCutoff = new Date(Date.now() - SEVEN_DAYS_MS);

      // Held + stuck + failed are simple per-row classifiers; we union them
      // server-side so the response is one shape the UI can render with a
      // single table. Period-scoped to createdAt so a fresh load is bounded.
      const rows = await db
        .select()
        .from(adviserFeeDeductions)
        .where(
          and(
            gte(adviserFeeDeductions.createdAt, from),
            lte(adviserFeeDeductions.createdAt, to),
            or(
              eq(adviserFeeDeductions.status, "insufficient_funds"),
              and(
                eq(adviserFeeDeductions.status, "pending_approval"),
                lte(adviserFeeDeductions.createdAt, stuckCutoff),
              ),
              sql`${adviserFeeDeductions.failureReason} IS NOT NULL`,
            ),
          ),
        )
        .orderBy(desc(adviserFeeDeductions.createdAt));
      // No .limit() here: the spec says "one row per problem deduction in
      // the period" and the period filter is the bound. Truncating would
      // silently hide real exceptions and defeat the whole point of this
      // tab. The query is bound by createdAt ∈ [from, to] so the result
      // size is operator-controllable from the period picker.

      type Exception = {
        kind: "held" | "stuck" | "failed" | "role_corruption";
        deduction: typeof rows[number];
        ageDays: number;
      };
      const now = Date.now();
      const items: Exception[] = rows.map((d) => {
        const createdAtMs = d.createdAt
          ? new Date(d.createdAt).getTime()
          : now;
        const ageDays = Math.max(
          0,
          Math.floor((now - createdAtMs) / (24 * 60 * 60 * 1000)),
        );
        let kind: Exception["kind"];
        if (d.status === "insufficient_funds") kind = "held";
        else if (
          d.status === "pending_approval" &&
          createdAtMs < stuckCutoff.getTime()
        )
          kind = "stuck";
        else kind = "failed";
        // Task #208 — push the kind-based gating into the response itself.
        // `failed` / `stuck` rows are not in the insufficient_funds state,
        // so they must not surface failureReason / lastRecheckedAt /
        // clientNotifiedAt / clientNotificationCount. `held` rows pass
        // through unchanged because the helper preserves IF metadata when
        // kind === "held".
        return {
          kind,
          deduction: projectFeeExceptionRow(d, kind) as typeof d,
          ageDays,
        };
      });

      // Role-corruption sweep: settled OR reversed deductions in the window
      // whose adviserUserId belongs to a non-adviser user. Critical because
      // /adviser-payouts filters these out — without a surface here they
      // would be invisible.
      const corruptRows = await db
        .select({
          d: adviserFeeDeductions,
          actualRole: users.role,
        })
        .from(adviserFeeDeductions)
        .innerJoin(users, eq(users.id, adviserFeeDeductions.adviserUserId))
        .where(
          and(
            sql`${users.role} <> 'adviser'`,
            or(
              and(
                eq(adviserFeeDeductions.status, "settled"),
                gte(adviserFeeDeductions.settledAt, from),
                lte(adviserFeeDeductions.settledAt, to),
              ),
              and(
                eq(adviserFeeDeductions.status, "reversed"),
                gte(adviserFeeDeductions.reversedAt, from),
                lte(adviserFeeDeductions.reversedAt, to),
              ),
            ),
          ),
        );
      // No .limit() here either — same reasoning as the held/stuck/failed
      // sweep above: we never want to silently swallow a corruption row.

      for (const row of corruptRows) {
        const createdAtMs = row.d.createdAt
          ? new Date(row.d.createdAt).getTime()
          : now;
        const ageDays = Math.max(
          0,
          Math.floor((now - createdAtMs) / (24 * 60 * 60 * 1000)),
        );
        // Task #208 — corruption rows are settled or reversed by definition
        // (the WHERE clause filters status IN settled/reversed), so they
        // MUST be projected to strip every IF-only bookkeeping column,
        // including failureReason. The kind is never "held" here, so the
        // helper clears all four IF-only fields uniformly.
        items.push({
          kind: "role_corruption",
          deduction: projectFeeExceptionRow(row.d, "role_corruption") as typeof row.d,
          ageDays,
        });
      }

      // Resolve display names for both client and adviser per row so the UI
      // doesn't need a second round-trip.
      const userIds = items.flatMap((x) => [
        x.deduction.clientUserId,
        x.deduction.adviserUserId,
      ]);
      const usersMap = await getUserNameMap(userIds);

      return {
        period: { from: from.toISOString(), to: to.toISOString() },
        stuckCutoff: stuckCutoff.toISOString(),
        items,
        users: usersMap,
      };
    }),
  );

  // -------------------------------------------------------------------------
  // Task #146 — Kill switches admin
  // -------------------------------------------------------------------------
  // GET  /api/admin/kill-switches              — list all four switches with
  //                                              current state, env-forced
  //                                              flag, and human label.
  // POST /api/admin/kill-switches/:key         — toggle (body: enabled, reason).
  // GET  /api/admin/kill-switches/:key/history — recent audit entries for the
  //                                              switch (entity_type=kill_switch).
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/kill-switches",
    adminRoute(async () => {
      const states = await getAllKillSwitchStates();
      // Resolve toggle-author display names so the UI doesn't have to
      // round-trip a second time. We only fetch ids that actually appear.
      const userIds = states
        .map((s) => s.lastToggledByUserId)
        .filter((x): x is number => typeof x === "number");
      const usersMap = userIds.length ? await getUserNameMap(userIds) : {};

      return {
        switches: states.map((s) => ({
          key: s.key,
          label: killSwitchLabel(s.key),
          envVar: killSwitchEnvVarName(s.key),
          enabled: s.enabled,
          envForced: s.envForced,
          reason: s.reason,
          lastToggledByUserId: s.lastToggledByUserId,
          lastToggledAt: s.lastToggledAt
            ? s.lastToggledAt.toISOString()
            : null,
        })),
        users: usersMap,
        // Task #182 — initial blocked-attempt counts so the widget renders
        // a real "0 in last 5m" instead of an "unknown" placeholder on the
        // first paint. The widget polls the dedicated /blocked-attempts
        // endpoint after that for cheap refreshes.
        blockedAttempts: getKillSwitchBlockedStats().map((s) => ({
          key: s.key,
          last5m: s.last5m,
          last15m: s.last15m,
          last60m: s.last60m,
          lastBlockedAt: s.lastBlockedAt
            ? s.lastBlockedAt.toISOString()
            : null,
        })),
      };
    }),
  );

  // Task #182 — Per-switch blocked-attempt counters served from an
  // in-memory ring buffer. Cheap enough to poll every few seconds from
  // the admin Kill switches page so operators get a live "we're actually
  // rejecting traffic right now" signal after engaging a switch.
  app.get(
    "/api/admin/kill-switches/blocked-attempts",
    adminRoute(async () => {
      return {
        blockedAttempts: getKillSwitchBlockedStats().map((s) => ({
          key: s.key,
          last5m: s.last5m,
          last15m: s.last15m,
          last60m: s.last60m,
          lastBlockedAt: s.lastBlockedAt
            ? s.lastBlockedAt.toISOString()
            : null,
        })),
      };
    }),
  );

  // Body validator — kept here (not in @shared) because it never leaves the
  // admin route surface and references a server-only enum helper.
  const killSwitchToggleSchema = z.object({
    enabled: z.boolean(),
    // Reason is mandatory on every flip — surfaces in the audit log and
    // operator alert. Trim + min-length is enforced inside
    // setKillSwitchState too, but we duplicate here so a bad payload gets
    // a 400 with a Zod-shaped error envelope before any DB work.
    reason: z.string().trim().min(1, "Reason is required").max(1000),
  });

  app.post(
    "/api/admin/kill-switches/:key",
    adminRoute(async (req, auth) => {
      const key = req.params.key;
      if (!isKillSwitchKey(key)) {
        throw Object.assign(new Error(`Unknown kill switch: ${key}`), {
          status: 400,
        });
      }
      const parsed = killSwitchToggleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(
          new Error(parsed.error.errors[0]?.message ?? "Invalid payload"),
          { status: 400 },
        );
      }
      const state = await setKillSwitchState({
        key: key as KillSwitchKey,
        enabled: parsed.data.enabled,
        reason: parsed.data.reason,
        actorUserId: auth.userId,
        ipAddress: req.ip ?? null,
      });
      return {
        switch: {
          key: state.key,
          label: killSwitchLabel(state.key),
          envVar: killSwitchEnvVarName(state.key),
          enabled: state.enabled,
          envForced: state.envForced,
          reason: state.reason,
          lastToggledByUserId: state.lastToggledByUserId,
          lastToggledAt: state.lastToggledAt
            ? state.lastToggledAt.toISOString()
            : null,
        },
      };
    }),
  );

  app.get(
    "/api/admin/kill-switches/:key/history",
    adminRoute(async (req) => {
      const key = req.params.key;
      if (!isKillSwitchKey(key)) {
        throw Object.assign(new Error(`Unknown kill switch: ${key}`), {
          status: 400,
        });
      }
      const limitRaw = Number(req.query.limit ?? 50);
      const limit =
        Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 200
          ? limitRaw
          : 50;
      const history = await getKillSwitchHistory(
        key as KillSwitchKey,
        limit,
      );
      const userIds = history
        .map((h) => h.userId)
        .filter((x): x is number => typeof x === "number");
      const usersMap = userIds.length ? await getUserNameMap(userIds) : {};
      return {
        key,
        label: killSwitchLabel(key as KillSwitchKey),
        history: history.map((h) => ({
          id: h.id,
          userId: h.userId,
          action: h.action,
          metadata: h.metadata,
          ipAddress: h.ipAddress,
          createdAt: h.createdAt ? h.createdAt.toISOString() : null,
        })),
        users: usersMap,
      };
    }),
  );
}
