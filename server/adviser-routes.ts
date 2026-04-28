// =============================================================================
// SESSION 9 — ADVISER ROUTES (read-only overlay; mounted at /api/adviser/*)
// -----------------------------------------------------------------------------
// All endpoints in this file:
//   1. require a valid JWT (requireAuth)
//   2. require role === 'adviser' (requireRole)
//   3. for any client-scoped read/write, validate the adviser_clients link
//      via assertAdviserClientLink in the service layer
//
// Nothing in this file mutates client-owned state. The only writes are to
// adviser_tasks and report_requests (the adviser's own working tables).
// =============================================================================

import fs from "node:fs";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { eq, and, desc, sql, inArray, isNull } from "drizzle-orm";
import { db } from "./db";
import {
  auditLogs,
  reportRequests,
  // Task #95 — keep the legacy `auditLogs` import: the local audit() helper
  // below still uses direct inserts for non-fee/advice surfaces (adviser
  // tasks, report requests, etc.). Fee-consent + advice-record paths have
  // been migrated to writeAuditLog (see import below).
  adviserNotificationDismissals,
  feeConsentRequests,
  feeConsents,
  insertFeeConsentRequestSchema,
  // Session 23A — fee engine Gate A (read-only adviser views)
  adviserFeeRules,
  adviserFeeAccruals,
  adviserFeeDeductions,
  // Task #318 — needed by the DELETE endpoint to evaluate retentionUntil /
  // deletionLocked directly on the row.
  clientDocuments,
} from "@shared/schema";
import { storage } from "./storage";
import { requireAuth, requireRole } from "./auth";
import { findUserIdsByQuery, getUserNameMap } from "./services/user-name-map";
// Task #204 — centralised "show as IF?" projection. Strips IF-only bookkeeping
// columns from non-IF rows so the adviser surface can never accidentally
// render stale "still held" notification metadata for a settled-formerly-IF row.
import { projectDeductionForApiContract } from "../shared/fee-deduction-status";
import {
  generateReportPdf,
  REPORTS_DIR,
  sweepStaleReportJobs,
} from "./services/reports";
import path from "node:path";
import {
  listAdviserClients,
  getAdviserClientDetail,
  getAdviserClientPortfolio,
  getAdviserClientFeeConsents,
  getAdviserClientAdviceRecords,
  listAdviserTasks,
  createAdviserTask,
  updateAdviserTask,
  listAdviserReportRequests,
  createReportRequest,
  findActiveReportRequest,
  getAdviserDashboardSummary,
  getAdviserNotifications,
  listAdviserProducts,
  getAdviserClientHoldings,
  getAdviserClientTransactions,
  listAdviserInstructions,
  createAdviserInstruction,
  assertAdviserClientLink,
  loadAdviserFixtureFilterContext,
} from "./services/adviser-access";
import {
  insertAdviserTaskSchema,
  insertReportRequestSchema,
  ADVISER_TASK_ALLOWED_TYPES,
} from "@shared/schema";

// Task #94 — wealth planner compliance helpers (objectives, documents,
// append-only adviser notes, advice-record version snapshot hook).
import {
  OBJECTIVE_TYPES,
  OBJECTIVE_PRIORITIES,
  CLIENT_DOCUMENT_TYPES,
  createClientObjective,
  listClientObjectivesForAdviser,
  uploadClientDocument,
  listClientDocumentsForAdviser,
  createAdviserNote,
  listAdviserNotes,
  transitionAdviceStatus,
  // Task #96 — review-pending lock guard. Notes are deliberately exempt:
  // compliance reviewers must be able to add notes on a record under review.
  REVIEW_LOCK_REASON,
} from "./services/wealth-planner";
import { adviceRecords } from "@shared/schema";
// Task #95 — standardised audit-log writer (before/after snapshots) for the
// advice + fee-engine surfaces. Other adviser routes still use the local
// audit() helper below; only fee-consent + advice-record paths have been
// migrated.
import { writeAuditLog } from "./services/audit";
// Task #301 — best-effort client notification when a fresh fee-consent
// request is created. The helper looks up the client email, sends the
// deep-link, and writes an audit_logs row recording delivery success or
// failure (audit row is the source of truth — see helper docstring).
import { notifyClientOfFeeConsentRequest } from "./services/fee-consent-notifications";
import {
  evaluateRetentionLock,
  RETENTION_POLICY_TEXT,
} from "./services/document-retention";
import { applyDocumentWatermark } from "./services/document-watermark";
import { resolveWatermarkNames } from "./services/watermark-context";
// Task #383 — adviser-side document download needs the same object-storage
// helpers the client route uses (statObject for the existence check, plus
// getObjectBytes for PDF watermarking and getObjectStream for non-PDF
// passthrough).
import {
  getObjectBytes,
  getObjectStream,
  statObject,
} from "./services/object-storage";
// Task #148 — shared multer factory that enforces a maximum file size and a
// strict mime allow-list, returning 400 BEFORE any bytes are handed off to
// uploadClientDocument(). Replaces the route-local multer config.
import { buildUploadMiddleware } from "./services/upload-security";

// Both `clientUserId` (the established adviser-route convention used by
// fee-rules / fee-deductions / etc.) AND `clientId` (the spec wording for the
// new wealth-planner endpoints) are accepted on every list endpoint. This
// avoids a noisy contract migration for callers built against either name.
function readClientIdQuery(req: Request): number | null {
  const raw =
    (req.query as Record<string, unknown>).clientUserId ??
    (req.query as Record<string, unknown>).clientId;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Local audit-log helper (fire-and-forget, never throws into the route).
// ---------------------------------------------------------------------------
async function audit(
  userId: number,
  action: string,
  entityType: string | null,
  entityId: string | null,
  metadata: unknown,
  ipAddress: string | null,
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      userId,
      action,
      entityType,
      entityId,
      metadata: metadata as any,
      ipAddress,
    });
  } catch {
    // Audit failures must never break the response
  }
}

// ---------------------------------------------------------------------------
// Common error handler — preserves the .status convention used elsewhere.
// ---------------------------------------------------------------------------
function handleError(res: any, error: any, fallbackMessage: string) {
  if (error?.status) {
    // Task #96 — surface a structured `reason` when the thrown error carries
    // one (e.g. the review-pending lock returns reason='record_locked_under_review').
    // The client UI keys lock banners off this field, so the envelope must
    // carry it through verbatim instead of collapsing to a generic message.
    const body: Record<string, unknown> = { error: error.message };
    if (typeof error.reason === "string") {
      body.reason = error.reason;
    }
    // Task #117 — surface a machine-readable error code when an error class
    // sets one (e.g. UploadContentMismatchError → "UPLOAD_CONTENT_MISMATCH").
    // Mirrors the rejection envelope used by buildUploadMiddleware so the
    // client UI can branch on `code` instead of fragile message matching.
    if (typeof error.code === "string") {
      body.code = error.code;
    }
    // Task #298 — structured 409 from POST /api/adviser/reports carries the
    // existing row so the UI can immediately offer Regenerate / Latest /
    // Previous versions without a follow-up GET.
    if (error.existingReport && typeof error.existingReport === "object") {
      body.existingReport = error.existingReport;
    }
    // Task #318 — surface a structured `extra` payload (e.g. the retentionUntil
    // ISO string + policy text on a 423 Locked response) so the UI can render
    // a tooltip without parsing the human-readable error string. The shape
    // is opaque to handleError; routes set whatever fields the UI needs.
    if (error.extra && typeof error.extra === "object") {
      body.extra = error.extra;
    }
    return res.status(error.status).json(body);
  }
  console.error(`[adviser-routes] ${fallbackMessage}:`, error);
  res.status(500).json({ error: fallbackMessage });
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
// Task #368 — the adviser-task surface is restricted to exactly the three
// trigger types the automation manages. Manual creation through the route
// uses the same allow-list as the automation, sourced from the schema so
// the contract cannot drift between layers. Older route inputs
// ("document_request", "meeting_prep", "other") are intentionally rejected
// at validation time with a 400.
const TASK_TYPES = ADVISER_TASK_ALLOWED_TYPES;
const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const REPORT_TYPES = [
  "portfolio_summary",
  "fee_summary",
  "transaction_history",
  "full_statement",
] as const;

const createTaskSchema = insertAdviserTaskSchema
  .omit({ adviserUserId: true, triggerKey: true })
  .extend({
    taskType: z.enum(TASK_TYPES),
    priority: z.enum(TASK_PRIORITIES).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    dueAt: z.coerce.date().optional().nullable(),
    // Task #368 — required when manually creating a fee_consent_renewal
    // task; the service uses it to derive the per-condition triggerKey
    // so the recheck/auto-close pipeline can later evaluate the consent.
    feeConsentId: z.coerce.number().int().positive().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.taskType === "fee_consent_renewal" && !val.feeConsentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["feeConsentId"],
        message:
          "feeConsentId is required when manually creating a fee_consent_renewal task",
      });
    }
  });

const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  notes: z.string().max(5000).optional().nullable(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueAt: z.coerce.date().optional().nullable(),
  // Task #285 — completion notes are required when closing a portfolio
  // review or a kyc_followup with non-verified KYC; the service-layer gate
  // enforces the requirement, this schema just admits the field.
  completionNotes: z.string().max(5000).optional().nullable(),
  // Required when closing a portfolio_review (must be a future date); the
  // service-layer gate enforces it.
  nextReviewAt: z.coerce.date().optional().nullable(),
});

// Task #298 — date-only ISO string (YYYY-MM-DD). Stored in a Postgres `date`
// column so the timezone of the issuing browser is irrelevant; the rendered
// PDF header and the stored audit row both use the literal date the adviser
// picked.
const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

const createReportSchema = insertReportRequestSchema
  .omit({ adviserUserId: true, periodFrom: true, periodTo: true })
  .extend({
    reportType: z.enum(REPORT_TYPES),
    format: z.enum(["pdf"]).optional(),
    // Task #298 — explicit reporting window. Required so the generated PDF
    // is unambiguous about what slice of the client's history was rendered.
    // Both fields are kept independent (rather than a single tuple) so a
    // future CSV/XLSX path can serialise them in whichever order it wants
    // without re-plumbing the schema.
    periodFrom: isoDateString,
    periodTo: isoDateString,
    // Set by the UI when the adviser explicitly chose Regenerate against an
    // existing ready row — opt-in cancellation of the prior version.
    regenerate: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    // Validate the calendar order without doing timezone arithmetic — the
    // strings sort lexically when both are YYYY-MM-DD.
    if (val.periodFrom > val.periodTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["periodTo"],
        message: "End date must be on or after start date",
      });
    }
  });

const INSTRUCTION_ACTIONS = ["buy", "sell", "switch"] as const;

const createInstructionSchema = z
  .object({
    clientUserId: z.number().int().positive(),
    productId: z.number().int().positive(),
    action: z.enum(INSTRUCTION_ACTIONS),
    // Decimal AUD amount as string (preserves precision). Must be > 0.
    amount: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/, "amount must be a non-negative decimal with up to 2 dp")
      .refine((v) => Number(v) > 0, "amount must be greater than 0"),
    notes: z.string().max(2000).optional().nullable(),
    adviceRecordId: z.number().int().positive().optional().nullable(),
    // Adviser must explicitly opt out of linking an advice record when no
    // adviceRecordId is supplied. The service layer enforces the same rule;
    // checking here too keeps the 400 message clean.
    adviceRecordNotLinked: z.boolean().optional(),
    feeConsentId: z.number().int().positive().optional().nullable(),
    suitabilityBasis: z.string().max(4000).optional().nullable(),
    switchFromProductId: z.number().int().positive().optional().nullable(),
  })
  .refine(
    (v) => v.adviceRecordId != null || v.adviceRecordNotLinked === true,
    {
      message:
        "Either choose a linked advice record or explicitly select 'no linked advice record'",
      path: ["adviceRecordId"],
    },
  )
  .refine(
    (v) => v.action !== "switch" || (v.switchFromProductId != null && v.switchFromProductId !== v.productId),
    {
      message: "Switch instructions require a 'switch from' source product different from the destination",
      path: ["switchFromProductId"],
    },
  );

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------
export function registerAdviserRoutes(app: Express): void {
  // Convenience wrapper: auth + role + try/catch envelope.
  // Every adviser route gets the same guard wrapper, so we cannot accidentally
  // ship a route with a missing role check.
  function adviserRoute(
    handler: (req: Request, auth: { userId: number; username: string; email: string; role: string }) => Promise<unknown>,
  ) {
    return async (req: Request, res: any) => {
      try {
        const auth = requireAuth(req);
        requireRole(auth, "adviser");
        const result = await handler(req, auth);
        res.json(result);
      } catch (error: any) {
        handleError(res, error, "Adviser request failed");
      }
    };
  }

  // -------------------------------------------------------------------------
  // GET /api/adviser/dashboard — single-call summary for the landing page
  // -------------------------------------------------------------------------
  app.get(
    "/api/adviser/dashboard",
    adviserRoute(async (_req, auth) => {
      return getAdviserDashboardSummary(auth.userId);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/adviser/notifications — bell-icon counters + recent items
  // Read-only aggregator. No mutations, no execution paths.
  // -------------------------------------------------------------------------
  app.get(
    "/api/adviser/notifications",
    adviserRoute(async (_req, auth) => {
      return getAdviserNotifications(auth.userId);
    }),
  );

  // -------------------------------------------------------------------------
  // SESSION 15B — Notification dismissals (preference layer only).
  //
  //   POST   /api/adviser/notifications/dismiss   { sourceType, sourceId }
  //   DELETE /api/adviser/notifications/dismiss   { sourceType, sourceId }
  //
  // Notifications themselves are never stored — the aggregator continues to
  // read from source-of-truth tables. These endpoints record only the
  // adviser's preference to hide a specific item from their bell. Dismissals
  // are scoped per-adviser; they cannot affect another adviser's view, the
  // underlying source data, or any compliance signal.
  //
  // Idempotency: re-POSTing the same (sourceType, sourceId) is treated as
  // success (the unique index swallows the duplicate). Re-DELETing a row that
  // doesn't exist is also success.
  // -------------------------------------------------------------------------
  const dismissBodySchema = z.object({
    sourceType: z.enum(["consent", "task", "fee_consent", "report", "kyc"]),
    sourceId: z.number().int().positive(),
  });

  app.post(
    "/api/adviser/notifications/dismiss",
    adviserRoute(async (req, auth) => {
      const parsed = dismissBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(new Error("Invalid dismiss payload"), { status: 400 });
      }
      const { sourceType, sourceId } = parsed.data;
      try {
        await db.insert(adviserNotificationDismissals).values({
          adviserUserId: auth.userId,
          sourceType,
          sourceId,
        });
      } catch (err: any) {
        // Postgres unique_violation — already dismissed; treat as success.
        if (err?.code !== "23505") throw err;
      }
      return { success: true };
    }),
  );

  app.delete(
    "/api/adviser/notifications/dismiss",
    adviserRoute(async (req, auth) => {
      const parsed = dismissBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(new Error("Invalid dismiss payload"), { status: 400 });
      }
      const { sourceType, sourceId } = parsed.data;
      await db
        .delete(adviserNotificationDismissals)
        .where(
          and(
            eq(adviserNotificationDismissals.adviserUserId, auth.userId),
            eq(adviserNotificationDismissals.sourceType, sourceType),
            eq(adviserNotificationDismissals.sourceId, sourceId),
          ),
        );
      return { success: true };
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/adviser/clients — list of linked clients with summary fields
  // -------------------------------------------------------------------------
  app.get(
    "/api/adviser/clients",
    adviserRoute(async (_req, auth) => {
      return listAdviserClients(auth.userId);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/adviser/clients/:id — single client detail (link enforced inside)
  // -------------------------------------------------------------------------
  app.get(
    "/api/adviser/clients/:id",
    adviserRoute(async (req, auth) => {
      const clientId = parseInt(req.params.id, 10);
      if (!Number.isFinite(clientId)) {
        throw Object.assign(new Error("Invalid client id"), { status: 400 });
      }
      const detail = await getAdviserClientDetail(auth.userId, clientId);
      if (!detail) {
        throw Object.assign(new Error("Client not found"), { status: 404 });
      }
      const [feeConsentsList, adviceRecordsList] = await Promise.all([
        getAdviserClientFeeConsents(auth.userId, clientId),
        getAdviserClientAdviceRecords(auth.userId, clientId),
      ]);
      return { client: detail, feeConsents: feeConsentsList, adviceRecords: adviceRecordsList };
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/adviser/clients/:id/portfolio — read-only portfolio + wallets
  // -------------------------------------------------------------------------
  app.get(
    "/api/adviser/clients/:id/portfolio",
    adviserRoute(async (req, auth) => {
      const clientId = parseInt(req.params.id, 10);
      if (!Number.isFinite(clientId)) {
        throw Object.assign(new Error("Invalid client id"), { status: 400 });
      }
      return getAdviserClientPortfolio(auth.userId, clientId);
    }),
  );

  // -------------------------------------------------------------------------
  // SESSION 10A — GET /api/adviser/products
  // Read-only AMAX product shelf (isActive=true). No client scoping needed:
  // every authenticated adviser can see the catalogue.
  // -------------------------------------------------------------------------
  app.get(
    "/api/adviser/products",
    adviserRoute(async (_req, _auth) => {
      return listAdviserProducts();
    }),
  );

  // -------------------------------------------------------------------------
  // SESSION 10A — GET /api/adviser/clients/:id/holdings
  // Read-only view of a linked client's userInvestments rows joined to the
  // product shelf. Link enforcement runs inside getAdviserClientHoldings.
  // -------------------------------------------------------------------------
  app.get(
    "/api/adviser/clients/:id/holdings",
    adviserRoute(async (req, auth) => {
      const clientId = parseInt(req.params.id, 10);
      if (!Number.isFinite(clientId)) {
        throw Object.assign(new Error("Invalid client id"), { status: 400 });
      }
      return getAdviserClientHoldings(auth.userId, clientId);
    }),
  );

  // -------------------------------------------------------------------------
  // SESSION 10A.5 — GET /api/adviser/clients/:id/transactions
  // Read-only client transaction history. Link enforcement runs inside service.
  // -------------------------------------------------------------------------
  app.get(
    "/api/adviser/clients/:id/transactions",
    adviserRoute(async (req, auth) => {
      const clientId = parseInt(req.params.id, 10);
      if (!Number.isFinite(clientId)) {
        throw Object.assign(new Error("Invalid client id"), { status: 400 });
      }
      const limit = req.query.limit
        ? Math.min(500, Math.max(1, parseInt(String(req.query.limit), 10) || 100))
        : 100;
      return getAdviserClientTransactions(auth.userId, clientId, limit);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/adviser/clients/:id/advice-records — light advice-record list
  // used by the New Investment Instruction form to populate the "Linked
  // advice record" dropdown without re-fetching the full client detail.
  // -------------------------------------------------------------------------
  app.get(
    "/api/adviser/clients/:id/advice-records",
    adviserRoute(async (req, auth) => {
      const clientId = parseInt(req.params.id, 10);
      if (!Number.isFinite(clientId)) {
        throw Object.assign(new Error("Invalid client id"), { status: 400 });
      }
      return getAdviserClientAdviceRecords(auth.userId, clientId);
    }),
  );

  // -------------------------------------------------------------------------
  // SESSION 10B — Investment Instructions
  // -------------------------------------------------------------------------
  app.get(
    "/api/adviser/instructions",
    adviserRoute(async (_req, auth) => {
      return listAdviserInstructions(auth.userId);
    }),
  );

  app.post(
    "/api/adviser/instructions",
    adviserRoute(async (req, auth) => {
      const parsed = createInstructionSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(
          new Error(
            "Invalid instruction payload: " +
              parsed.error.issues.map((i) => i.message).join("; "),
          ),
          { status: 400 },
        );
      }
      const instruction = await createAdviserInstruction(auth.userId, parsed.data);
      await audit(
        auth.userId,
        "adviser_instruction_created",
        "investment_instruction",
        String(instruction.id),
        {
          clientUserId: instruction.clientUserId,
          productId: instruction.productId,
          action: instruction.action,
          amount: instruction.amount,
          adviceRecordId: instruction.adviceRecordId,
          adviceRecordNotLinked: instruction.adviceRecordNotLinked,
          suitabilityBasisRecorded: instruction.suitabilityBasis != null,
          switchFromProductId: instruction.switchFromProductId,
        },
        (req as Request).ip || null,
      );
      return instruction;
    }),
  );

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------
  app.get(
    "/api/adviser/tasks",
    adviserRoute(async (req, auth) => {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const clientUserId = req.query.clientUserId
        ? parseInt(String(req.query.clientUserId), 10)
        : undefined;
      return listAdviserTasks(auth.userId, { status, clientUserId });
    }),
  );

  app.post(
    "/api/adviser/tasks",
    adviserRoute(async (req, auth) => {
      const parsed = createTaskSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(
          new Error("Invalid task payload: " + parsed.error.issues.map((i) => i.message).join("; ")),
          { status: 400 },
        );
      }
      const task = await createAdviserTask(auth.userId, parsed.data);
      await audit(auth.userId, "adviser_task_created", "adviser_task", String(task.id), {
        clientUserId: task.clientUserId,
        taskType: task.taskType,
      }, (req as Request).ip || null);
      return task;
    }),
  );

  app.patch(
    "/api/adviser/tasks/:id",
    adviserRoute(async (req, auth) => {
      const taskId = parseInt(req.params.id, 10);
      if (!Number.isFinite(taskId)) {
        throw Object.assign(new Error("Invalid task id"), { status: 400 });
      }
      const parsed = updateTaskSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(
          new Error("Invalid task patch: " + parsed.error.issues.map((i) => i.message).join("; ")),
          { status: 400 },
        );
      }
      const updated = await updateAdviserTask(auth.userId, taskId, parsed.data);
      if (!updated) {
        throw Object.assign(new Error("Task not found or not yours"), { status: 404 });
      }
      await audit(auth.userId, "adviser_task_updated", "adviser_task", String(taskId), parsed.data, (req as Request).ip || null);
      return updated;
    }),
  );

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------
  app.get(
    "/api/adviser/reports",
    adviserRoute(async (_req, auth) => {
      // Task #315 — augment each row with the prior-version chain so the UI
      // can render a "v2 (prior: v1, v0)" chip without a second round-trip.
      // Task #298's on-demand stale sweep was dropped here in favour of
      // Task #315's `report-sweeper` cron (server/index.ts) which runs every
      // 60s and writes the same failed/timeout transition.
      const rows = await listAdviserReportRequests(auth.userId);
      const { listPriorVersions } = await import("./services/reports");
      const enriched = await Promise.all(
        rows.map(async (r) => ({
          ...r,
          versions: await listPriorVersions(r.id),
        })),
      );
      // Status counts strip — single source of truth so adviser + admin
      // pages never disagree about what's pending.
      const counts = enriched.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      }, {});
      return { rows: enriched, counts };
    }),
  );

  app.post(
    "/api/adviser/reports",
    adviserRoute(async (req, auth) => {
      const parsed = createReportSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(
          new Error("Invalid report payload: " + parsed.error.issues.map((i) => i.message).join("; ")),
          { status: 400 },
        );
      }
      const { regenerate, periodFrom, periodTo, ...insertData } = parsed.data;

      // Task #298 — duplicate prevention. Look up the most recent active row
      // for this (adviser, client, reportType) BEFORE inserting:
      //   - in-flight (requested/generating): always block; explain that
      //     "another request is already in progress" so the adviser doesn't
      //     spam the queue with N copies of the same report.
      //   - ready and not-expired: block UNLESS the caller passed
      //     regenerate=true. If they did, we mark the prior row as
      //     "superseded" (download URL cleared so the old PDF can no
      //     longer be downloaded) and continue with a fresh insert.
      const existing = await findActiveReportRequest(
        auth.userId,
        insertData.clientUserId,
        insertData.reportType,
      );
      if (existing) {
        if (existing.status === "requested" || existing.status === "generating") {
          throw Object.assign(
            new Error(
              `A ${insertData.reportType.replace(/_/g, " ")} report for this client is already in progress.`,
            ),
            {
              status: 409,
              code: "REPORT_ALREADY_IN_PROGRESS",
              existingReport: existing,
            },
          );
        }
        // existing.status === "ready" and still within expiry
        if (!regenerate) {
          throw Object.assign(
            new Error(
              `A ready ${insertData.reportType.replace(/_/g, " ")} report for this client already exists. Download it directly or regenerate it.`,
            ),
            {
              status: 409,
              code: "REPORT_ALREADY_EXISTS",
              existingReport: existing,
            },
          );
        }
        // Adviser explicitly chose Regenerate — supersede the prior ready
        // row so the UI's "latest version" only ever points at the freshly
        // generated PDF. Keep the audit trail intact (status flipped to
        // "expired" rather than deleted), and write an audit row so the
        // supersession itself is reviewable.
        await db
          .update(reportRequests)
          .set({ status: "expired", downloadUrl: null })
          .where(eq(reportRequests.id, existing.id));
        await audit(
          auth.userId,
          "adviser_report_superseded",
          "report_request",
          String(existing.id),
          { clientUserId: existing.clientUserId, reportType: existing.reportType },
          (req as Request).ip || null,
        );
      }

      const report = await createReportRequest(auth.userId, {
        ...insertData,
        periodFrom,
        periodTo,
      });
      await audit(auth.userId, "adviser_report_requested", "report_request", String(report.id), {
        clientUserId: report.clientUserId,
        reportType: report.reportType,
        // Task #298 — capture the requested window in the audit payload so
        // a later reviewer can answer "what slice was this PDF promised to
        // cover?" without re-reading the report_requests row (which may
        // have moved on by then).
        periodFrom: report.periodFrom,
        periodTo: report.periodTo,
        regenerate: regenerate === true,
        // Task #345 — record whether the request was submitted as a draft
        // so an auditor can correlate a watermarked PDF on disk with the
        // adviser's intent at submit time.
        isDraft: report.isDraft === true,
      }, (req as Request).ip || null);

      // Generate the PDF synchronously. Datasets are small (one client, ≤100
      // transactions) so an inline await keeps the implementation simple and
      // means the row returned to the UI is already in its terminal state.
      const result = await generateReportPdf(report.id);
      if (result.status === "ready") {
        await audit(auth.userId, "adviser_report_generated", "report_request", String(report.id), {
          clientUserId: report.clientUserId,
          reportType: report.reportType,
          downloadUrl: result.downloadUrl,
          periodFrom: report.periodFrom,
          periodTo: report.periodTo,
        }, (req as Request).ip || null);
      } else {
        await audit(auth.userId, "adviser_report_failed", "report_request", String(report.id), {
          clientUserId: report.clientUserId,
          reportType: report.reportType,
          failureReason: result.failureReason,
          periodFrom: report.periodFrom,
          periodTo: report.periodTo,
        }, (req as Request).ip || null);
      }

      // Re-read the row so the UI gets the final status / downloadUrl / etc.
      const [final] = await db
        .select()
        .from(reportRequests)
        .where(eq(reportRequests.id, report.id))
        .limit(1);
      return final;
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/adviser/reports/:id/download — stream the generated PDF.
  // Not wrapped in adviserRoute() because we send binary, not JSON.
  // Auth checks are performed inline with the same shape: requireAuth +
  // requireRole + ownership check (report.adviserUserId === auth.userId).
  // -------------------------------------------------------------------------
  app.get(
    "/api/adviser/reports/:id/download",
    async (req: Request, res: Response) => {
      try {
        const auth = requireAuth(req);
        requireRole(auth, "adviser");

        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
          return res.status(400).json({ error: "Invalid report id" });
        }

        const [row] = await db
          .select()
          .from(reportRequests)
          .where(eq(reportRequests.id, id))
          .limit(1);

        if (!row) return res.status(404).json({ error: "Report not found" });

        // Ownership: only the requesting adviser can download. Defence in depth
        // beyond the role check.
        if (row.adviserUserId !== auth.userId) {
          return res.status(403).json({ error: "Forbidden — this report does not belong to you" });
        }

        // Live entitlement: even though the adviser owns the report row, they
        // must STILL be linked to the client at download time. If the adviser-
        // client link has been deactivated since generation, deny access — the
        // PDF contains client data the adviser is no longer authorised to see.
        // Throws 403 from assertAdviserClientLink if link is missing/inactive.
        await assertAdviserClientLink(auth.userId, row.clientUserId);

        if (row.status !== "ready") {
          return res.status(409).json({
            error: `Report is not ready (status: ${row.status})`,
            failureReason: row.failureReason ?? undefined,
          });
        }

        // Task #315 — 7-day download-link expiry check (tighter than the 30d
        // data-retention `expiresAt`). A forwarded URL past the cutoff returns
        // 410 with a structured body so the UI can prompt the adviser to
        // re-generate rather than show a generic error toast.
        if (
          row.downloadLinkExpiresAt &&
          new Date(row.downloadLinkExpiresAt).getTime() < Date.now()
        ) {
          await db
            .update(reportRequests)
            .set({ status: "expired_link" })
            .where(eq(reportRequests.id, id));
          return res.status(410).json({
            error:
              "This download link has expired (7-day limit). Please regenerate the report.",
            code: "link_expired",
            reportId: id,
          });
        }
        if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
          await db.update(reportRequests).set({ status: "expired" }).where(eq(reportRequests.id, id));
          return res.status(410).json({
            error: "Report has expired",
            code: "report_expired",
            reportId: id,
          });
        }

        const filePath = path.join(REPORTS_DIR, `${id}.pdf`);
        if (!fs.existsSync(filePath)) {
          return res.status(404).json({ error: "Report file missing on disk" });
        }

        // Task #318 — apply the per-download confidential watermark. The
        // PDF on disk is unmarked; we read it into memory, watermark every
        // page with the request instant + purpose, and stream the
        // transformed buffer. Two downloads of the same report produce
        // two distinguishable PDFs (different timestamp), giving the
        // regulator surface forensic traceability if a leak is reported.
        const downloadedAtUtc = new Date();
        const names = await resolveWatermarkNames(row.clientUserId, row.adviserUserId);
        const original = await fs.promises.readFile(filePath);
        const watermarked = await applyDocumentWatermark(original, {
          clientName: names.clientName,
          adviserName: names.adviserName,
          downloadedAtUtc,
          purpose: "report_download",
        });

        // Task #318 — every PDF the platform serves to a regulated party
        // gets the SAME audit action name (`document.download`) so the
        // regulator surface can answer "who pulled what and when" with one
        // query. The report-specific shape stays in the metadata payload.
        await audit(auth.userId, "document.download", "report_request", String(id), {
          clientUserId: row.clientUserId,
          documentId: id,
          documentKind: "adviser_report",
          reportType: row.reportType,
          purpose: "report_download",
          downloadedAtUtc: downloadedAtUtc.toISOString(),
        }, req.ip || null);

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="amax-report-${id}.pdf"`,
        );
        // Anti-cache: PDFs may contain sensitive client data; never let an
        // intermediate proxy or browser cache hold them.
        res.setHeader("Cache-Control", "no-store, private, max-age=0, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Length", String(watermarked.length));
        res.end(watermarked);

        // Task #344 — stamp first-download timestamp so the expiring-soon
        // reminder cron skips this row. Conditional UPDATE so subsequent
        // downloads don't overwrite the original download instant. Best-
        // effort: a failure here must not affect the response we just sent.
        try {
          await db
            .update(reportRequests)
            .set({ firstDownloadedAt: downloadedAtUtc })
            .where(
              and(
                eq(reportRequests.id, id),
                isNull(reportRequests.firstDownloadedAt),
              ),
            );
        } catch (stampErr) {
          console.error(
            `[reports] failed to stamp firstDownloadedAt for #${id}:`,
            (stampErr as Error)?.message ?? stampErr,
          );
        }
      } catch (error: any) {
        handleError(res, error, "Report download failed");
      }
    },
  );

  // -------------------------------------------------------------------------
  // Task #299 — Cancel. Only succeeds when the report is still in flight
  // (status='requested' or 'generating'). Flips the row to 'cancelled' and
  // writes an audit row so the lifecycle is reviewable. The PDF generator
  // currently runs inline so 'generating' is a transient sliver of the
  // request lifecycle, but cancelling it still makes sense for the long-
  // term shape (a future async worker would honour the status flip).
  // -------------------------------------------------------------------------
  app.post(
    "/api/adviser/reports/:id/cancel",
    adviserRoute(async (req, auth) => {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        throw Object.assign(new Error("Invalid report id"), { status: 400 });
      }
      const [row] = await db
        .select()
        .from(reportRequests)
        .where(eq(reportRequests.id, id))
        .limit(1);
      if (!row) {
        throw Object.assign(new Error("Report not found"), { status: 404 });
      }
      if (row.adviserUserId !== auth.userId) {
        throw Object.assign(
          new Error("Forbidden — this report does not belong to you"),
          { status: 403 },
        );
      }
      if (row.status !== "requested" && row.status !== "generating") {
        throw Object.assign(
          new Error(
            `Only requested or generating reports can be cancelled (current status: ${row.status})`,
          ),
          { status: 409 },
        );
      }
      await db
        .update(reportRequests)
        .set({ status: "cancelled", failureReason: "cancelled_by_adviser" })
        .where(eq(reportRequests.id, id));
      await audit(
        auth.userId,
        "adviser_report_cancelled",
        "report_request",
        String(id),
        {
          previousStatus: row.status,
          clientUserId: row.clientUserId,
          reportType: row.reportType,
        },
        (req as Request).ip || null,
      );
      const [final] = await db
        .select()
        .from(reportRequests)
        .where(eq(reportRequests.id, id))
        .limit(1);
      return final;
    }),
  );

  // -------------------------------------------------------------------------
  // Task #299 — Audit log for one report. Powers the "View audit log" side
  // sheet in the adviser Reports page. Scoped strictly to the requesting
  // adviser's own reports so an adviser cannot read another adviser's
  // request/generation/download events even by guessing ids.
  // -------------------------------------------------------------------------
  app.get(
    "/api/adviser/reports/:id/audit-log",
    adviserRoute(async (req, auth) => {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        throw Object.assign(new Error("Invalid report id"), { status: 400 });
      }
      const [row] = await db
        .select({
          id: reportRequests.id,
          adviserUserId: reportRequests.adviserUserId,
        })
        .from(reportRequests)
        .where(eq(reportRequests.id, id))
        .limit(1);
      if (!row) {
        throw Object.assign(new Error("Report not found"), { status: 404 });
      }
      if (row.adviserUserId !== auth.userId) {
        throw Object.assign(
          new Error("Forbidden — this report does not belong to you"),
          { status: 403 },
        );
      }
      const rows = await db
        .select({
          id: auditLogs.id,
          userId: auditLogs.userId,
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          metadata: auditLogs.metadata,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, "report_request"),
            eq(auditLogs.entityId, String(id)),
          ),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(200);
      return { items: rows };
    }),
  );

  // -------------------------------------------------------------------------
  // Task #315 — Regenerate. Inserts a new row pointing back at the supplied
  // original via supersedesReportId, then runs the PDF generator inline so
  // the response carries the new row in its terminal state.
  //
  // Bypasses the duplicate guard (regeneration IS deliberately a duplicate);
  // the chain itself is the audit record so a recovering operator can see
  // every prior attempt without trawling the audit log.
  // -------------------------------------------------------------------------
  app.post(
    "/api/adviser/reports/:id/regenerate",
    adviserRoute(async (req, auth) => {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        throw Object.assign(new Error("Invalid report id"), { status: 400 });
      }
      const { regenerateReport } = await import("./services/reports");
      const next = await regenerateReport(auth.userId, id);
      await audit(
        auth.userId,
        "adviser_report_regenerated",
        "report_request",
        String(next.id),
        {
          supersedesReportId: id,
          versionNumber: next.versionNumber,
          clientUserId: next.clientUserId,
          reportType: next.reportType,
        },
        (req as Request).ip || null,
      );
      const result = await generateReportPdf(next.id);
      if (result.status === "ready") {
        await audit(
          auth.userId,
          "adviser_report_generated",
          "report_request",
          String(next.id),
          {
            clientUserId: next.clientUserId,
            reportType: next.reportType,
            downloadUrl: result.downloadUrl,
            versionNumber: next.versionNumber,
          },
          (req as Request).ip || null,
        );
      } else {
        await audit(
          auth.userId,
          "adviser_report_failed",
          "report_request",
          String(next.id),
          {
            clientUserId: next.clientUserId,
            reportType: next.reportType,
            failureReason: result.failureReason,
            versionNumber: next.versionNumber,
          },
          (req as Request).ip || null,
        );
      }
      const [final] = await db
        .select()
        .from(reportRequests)
        .where(eq(reportRequests.id, next.id))
        .limit(1);
      return final;
    }),
  );

  // ===========================================================================
  // SESSION 20 — Adviser-side fee consent REQUESTS (DBFO live consents)
  // ---------------------------------------------------------------------------
  // Adviser proposes terms; client signs/declines from their portal. NOTHING
  // here moves money — this is request-and-record only. The fee engine
  // (Session 23A/B) is gated separately.
  // ===========================================================================

  const FEE_TYPES = ["ongoing_service_fee", "advice_fee", "platform_fee"] as const;
  const AMOUNT_TYPES = ["fixed", "percentage", "calculation_method"] as const;
  const DEDUCTION_FREQUENCIES = ["monthly", "quarterly", "annually"] as const;

  // RG175/Netwealth window: opens 60 days before reference, closes 150 days
  // after — same window used by the existing renewal cron in index.ts.
  const RENEWAL_WINDOW_BEFORE_DAYS = 60;
  const RENEWAL_WINDOW_AFTER_DAYS = 150;
  const DAY_MS = 24 * 60 * 60 * 1000;

  const createFeeConsentRequestSchema = insertFeeConsentRequestSchema
    .omit({ adviserUserId: true })
    .extend({
      clientUserId: z.number().int().positive(),
      feeType: z.enum(FEE_TYPES),
      amountType: z.enum(AMOUNT_TYPES),
      amount: z.union([z.string(), z.number()]).transform(String).optional().nullable(),
      calculationMethod: z.string().max(2000).optional().nullable(),
      accountNumber: z.string().min(1).max(120),
      accountName: z.string().max(200).optional().nullable(),
      deductionFrequency: z.enum(DEDUCTION_FREQUENCIES),
      proposedReferenceDay: z.coerce.date(),
      proposedRenewalWindowStart: z.coerce.date(),
      proposedRenewalWindowEnd: z.coerce.date(),
      proposedConsentExpiryDate: z.coerce.date(),
      // Task #293 — DBFO consents are legally required to be tied to a
      // specific advice record. The adviser UI now blocks Send until one
      // is picked; the server enforces the same rule so any direct API
      // caller (or stale build) is rejected with a clear validation error
      // rather than silently storing an unsignable request.
      adviceRecordId: z.number().int().positive(
        "adviceRecordId is required — a fee consent must reference an advice record",
      ),
      requestNote: z.string().max(4000).optional().nullable(),
    })
    .superRefine((val, ctx) => {
      // Amount must be present unless explicitly using a free-text
      // calculation method (DBFO requires a quantifiable basis either way,
      // but a calc-method consent legitimately defers the dollar amount).
      const hasAmount =
        val.amount !== null && val.amount !== undefined && val.amount !== "";
      if (val.amountType !== "calculation_method" && !hasAmount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["amount"],
          message: "amount is required unless amountType is calculation_method",
        });
      }
      if (val.amountType === "calculation_method" && !val.calculationMethod) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["calculationMethod"],
          message: "calculationMethod is required when amountType is calculation_method",
        });
      }
      // RG175 / DBFO: renewal window relative to reference day. We allow a
      // ±2 day tolerance for timezone rounding when the client computes
      // dates locally.
      const ref = val.proposedReferenceDay.getTime();
      const start = val.proposedRenewalWindowStart.getTime();
      const end = val.proposedRenewalWindowEnd.getTime();
      const expiry = val.proposedConsentExpiryDate.getTime();
      const expectedStart = ref - RENEWAL_WINDOW_BEFORE_DAYS * DAY_MS;
      const expectedEnd = ref + RENEWAL_WINDOW_AFTER_DAYS * DAY_MS;
      const tolerance = 2 * DAY_MS;
      if (Math.abs(start - expectedStart) > tolerance) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["proposedRenewalWindowStart"],
          message: `Renewal window must open ${RENEWAL_WINDOW_BEFORE_DAYS} days before referenceDay`,
        });
      }
      if (Math.abs(end - expectedEnd) > tolerance) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["proposedRenewalWindowEnd"],
          message: `Renewal window must close ${RENEWAL_WINDOW_AFTER_DAYS} days after referenceDay`,
        });
      }
      if (expiry < end - tolerance) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["proposedConsentExpiryDate"],
          message: "Consent expiry cannot be earlier than the renewal window end",
        });
      }
    });

  // POST /api/adviser/fee-consent-requests
  app.post(
    "/api/adviser/fee-consent-requests",
    async (req: Request, res: Response) => {
      try {
        const auth = requireAuth(req);
        requireRole(auth, "adviser");
        const parsed = createFeeConsentRequestSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return res.status(400).json({
            error:
              "Invalid payload: " +
              parsed.error.issues.map((i) => i.message).join("; "),
          });
        }
        // Must be linked to this client (active link).
        await assertAdviserClientLink(auth.userId, parsed.data.clientUserId);

        // Task #293 — pre-flight duplicate check. The DB partial unique
        // indexes are the source of truth, but we look first so the API
        // can return a friendly 409 carrying the offending row id (which
        // the UI uses to deep-link the adviser to the existing request /
        // consent instead of forcing them to hunt through the table).
        const conflictingRequest = await db
          .select({ id: feeConsentRequests.id })
          .from(feeConsentRequests)
          .where(
            and(
              eq(feeConsentRequests.clientUserId, parsed.data.clientUserId),
              eq(feeConsentRequests.adviceRecordId, parsed.data.adviceRecordId),
              eq(feeConsentRequests.feeType, parsed.data.feeType),
              eq(feeConsentRequests.accountNumber, parsed.data.accountNumber),
              eq(feeConsentRequests.status, "pending"),
            ),
          )
          .limit(1);
        if (conflictingRequest.length > 0) {
          return res.status(409).json({
            error:
              "An active pending fee-consent request already exists for this client, advice record, fee type and account.",
            existingRequestId: conflictingRequest[0].id,
            kind: "duplicate_pending_request",
          });
        }
        const conflictingConsent = await db
          .select({ id: feeConsents.id })
          .from(feeConsents)
          .where(
            and(
              eq(feeConsents.clientId, parsed.data.clientUserId),
              eq(feeConsents.adviceRecordId, parsed.data.adviceRecordId),
              eq(feeConsents.feeType, parsed.data.feeType),
              eq(feeConsents.accountNumber, parsed.data.accountNumber),
              sql`${feeConsents.renewalStatus} IN ('active', 'renewal_due')`,
            ),
          )
          .limit(1);
        if (conflictingConsent.length > 0) {
          return res.status(409).json({
            error:
              "A live fee consent already covers this client, advice record, fee type and account. Use Supersede on the admin page if you need to replace it.",
            existingConsentId: conflictingConsent[0].id,
            kind: "duplicate_active_consent",
          });
        }

        const created = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(feeConsentRequests)
            .values({
              adviserUserId: auth.userId,
              clientUserId: parsed.data.clientUserId,
              adviceRecordId: parsed.data.adviceRecordId,
              feeType: parsed.data.feeType,
              amountType: parsed.data.amountType,
              amount: parsed.data.amount ?? null,
              calculationMethod: parsed.data.calculationMethod ?? null,
              accountNumber: parsed.data.accountNumber,
              accountName: parsed.data.accountName ?? null,
              deductionFrequency: parsed.data.deductionFrequency,
              proposedReferenceDay: parsed.data.proposedReferenceDay,
              proposedRenewalWindowStart: parsed.data.proposedRenewalWindowStart,
              proposedRenewalWindowEnd: parsed.data.proposedRenewalWindowEnd,
              proposedConsentExpiryDate: parsed.data.proposedConsentExpiryDate,
              requestNote: parsed.data.requestNote ?? null,
              status: "pending",
            })
            .returning();
          // Task #95 — fresh insert: no prior state to record, so `before`
          // is null. `after` carries the durable state-machine fields the
          // request will move through; per-fee economics live in `extra`.
          await writeAuditLog({
            executor: tx,
            userId: auth.userId,
            action: "fee_consent_requested",
            entityType: "fee_consent_request",
            entityId: String(row.id),
            before: null,
            after: {
              status: row.status,
              clientUserId: row.clientUserId,
              adviserUserId: row.adviserUserId,
              adviceRecordId: row.adviceRecordId,
            },
            extra: {
              feeType: row.feeType,
              amountType: row.amountType,
              amount: row.amount,
              deductionFrequency: row.deductionFrequency,
            },
            ipAddress: req.ip || null,
          });
          return row;
        });
        // Task #301 — best-effort client notification with deep-link to
        // /client/fee-consents?request=:id. Runs OUTSIDE the transaction so
        // SMTP latency / failure can never roll back the inserted request.
        // Delivery success/failure is recorded as a separate audit_logs row
        // (action `fee_consent_request.client_notified` or
        // `_client_notification_failed`) so an auditor can prove a notice
        // was attempted for every created request — including the dev /
        // preview "SMTP not configured" case where we log only.
        await notifyClientOfFeeConsentRequest({
          requestRow: created,
          adviserUserId: auth.userId,
          trigger: "new_request",
          ipAddress: req.ip || null,
        });
        res.status(201).json(created);
      } catch (error: any) {
        handleError(res, error, "Failed to create fee consent request");
      }
    },
  );

  // GET /api/adviser/fee-consent-requests?clientId=&status=&page=&limit=
  app.get(
    "/api/adviser/fee-consent-requests",
    async (req: Request, res: Response) => {
      try {
        const auth = requireAuth(req);
        requireRole(auth, "adviser");
        const clientIdRaw = req.query.clientId
          ? Number(req.query.clientId)
          : null;
        const status = typeof req.query.status === "string" ? req.query.status : null;
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
        const offset = (page - 1) * limit;

        const conds: any[] = [eq(feeConsentRequests.adviserUserId, auth.userId)];
        // Task #308 — fixture-client filter, see fee-rules above. Even
        // pending fee-consent requests authored against a fixture-pattern
        // client must be hidden from a real adviser's list view.
        const fixtureCtx = await loadAdviserFixtureFilterContext(auth.userId);
        if (clientIdRaw && Number.isFinite(clientIdRaw)) {
          await assertAdviserClientLink(auth.userId, clientIdRaw);
          if (fixtureCtx.excludedClientIds.includes(clientIdRaw)) {
            return res.json({ items: [], page, limit, total: 0 });
          }
          conds.push(eq(feeConsentRequests.clientUserId, clientIdRaw));
        } else {
          if (fixtureCtx.visibleClientIds.length === 0) {
            return res.json({ items: [], page, limit, total: 0 });
          }
          conds.push(inArray(feeConsentRequests.clientUserId, fixtureCtx.visibleClientIds));
        }
        if (status) conds.push(eq(feeConsentRequests.status, status));

        const where = conds.length === 1 ? conds[0] : and(...conds);
        const [items, totalRow] = await Promise.all([
          db
            .select()
            .from(feeConsentRequests)
            .where(where)
            .orderBy(desc(feeConsentRequests.createdAt))
            .limit(limit)
            .offset(offset),
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(feeConsentRequests)
            .where(where),
        ]);
        res.json({
          items,
          page,
          limit,
          total: Number(totalRow[0]?.count ?? 0),
        });
      } catch (error: any) {
        handleError(res, error, "Failed to list fee consent requests");
      }
    },
  );

  // PATCH /api/adviser/fee-consent-requests/:id/withdraw
  app.patch(
    "/api/adviser/fee-consent-requests/:id/withdraw",
    async (req: Request, res: Response) => {
      try {
        const auth = requireAuth(req);
        requireRole(auth, "adviser");
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
          return res.status(400).json({ error: "Invalid request id" });
        }
        const reasonSchema = z.object({
          reason: z.string().max(2000).optional().nullable(),
        });
        const parsed = reasonSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid payload" });
        }
        const updated = await db.transaction(async (tx) => {
          const [existing] = await tx
            .select()
            .from(feeConsentRequests)
            .where(eq(feeConsentRequests.id, id))
            .for("update")
            .limit(1);
          if (!existing) {
            throw Object.assign(new Error("Fee consent request not found"), { status: 404 });
          }
          if (existing.adviserUserId !== auth.userId) {
            throw Object.assign(new Error("Not your fee consent request"), { status: 403 });
          }
          if (existing.status !== "pending") {
            throw Object.assign(
              new Error(`Cannot withdraw request in status '${existing.status}'`),
              { status: 400 },
            );
          }
          const updatedRows = await tx
            .update(feeConsentRequests)
            .set({
              status: "withdrawn_by_adviser",
              declineReason: parsed.data.reason ?? null,
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
          // Task #95 — capture the explicit pending → withdrawn flip plus
          // the decline reason being attached on the same row.
          await writeAuditLog({
            executor: tx,
            userId: auth.userId,
            action: "fee_consent_request_withdrawn",
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
              clientUserId: existing.clientUserId,
              reason: parsed.data.reason ?? null,
            },
            ipAddress: req.ip || null,
          });
          return row;
        });
        res.json(updated);
      } catch (error: any) {
        handleError(res, error, "Failed to withdraw fee consent request");
      }
    },
  );

  // ===========================================================================
  // SESSION 23A — FEE ENGINE GATE A (adviser READ-ONLY views)
  // ---------------------------------------------------------------------------
  // The adviser sees ONLY rules / accruals / deductions for clients they are
  // currently linked to. There are NO write endpoints in this file for the
  // fee engine — all writes are admin-only.
  // ===========================================================================

  app.get("/api/adviser/fee-rules", async (req, res) => {
    try {
      const auth = requireAuth(req);
      requireRole(auth, "adviser");
      const clientIdQ = Number(req.query.clientUserId);
      // Task #294 — `?status` accepts a comma-separated list so the
      // Active and History cards on the adviser fees page can each pull
      // ONLY the rows that belong to that card. Empty / missing → all
      // statuses (back-compat for any existing caller).
      const statusParam =
        typeof req.query.status === "string" ? req.query.status.trim() : "";
      const statuses = statusParam
        ? statusParam
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [];
      // Task #294 — `?q` is a name/email search across the joined client.
      // The adviser already has `?clientUserId` for an explicit drill-down;
      // `?q` powers the per-card search box on the rules table.
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const offset = (page - 1) * limit;

      const filters: any[] = [eq(adviserFeeRules.adviserUserId, auth.userId)];
      // Task #308 — defence-in-depth: scope every fee-engine read to the
      // adviser's post-fixture-filter visible client set. Mirrors the
      // policy already applied to listAdviserTasks / dashboard /
      // notifications so a fixture-pattern client (e.g.
      // `adviser-race-...@example.com`) can never surface fee rules,
      // accruals, or deductions to a real adviser, even via direct URL.
      const fixtureCtx = await loadAdviserFixtureFilterContext(auth.userId);
      if (Number.isInteger(clientIdQ) && clientIdQ > 0) {
        await assertAdviserClientLink(auth.userId, clientIdQ);
        if (fixtureCtx.excludedClientIds.includes(clientIdQ)) {
          return res.json({ items: [], page, limit, total: 0, users: {} });
        }
        filters.push(eq(adviserFeeRules.clientUserId, clientIdQ));
      } else {
        if (fixtureCtx.visibleClientIds.length === 0) {
          return res.json({ items: [], page, limit, total: 0, users: {} });
        }
        filters.push(inArray(adviserFeeRules.clientUserId, fixtureCtx.visibleClientIds));
      }
      if (statuses.length === 1) filters.push(eq(adviserFeeRules.status, statuses[0]));
      else if (statuses.length > 1) filters.push(inArray(adviserFeeRules.status, statuses));
      if (q) {
        // Reuse findUserIdsByQuery if available; otherwise inline the lookup.
        const ids = await findUserIdsByQuery(q);
        if (ids.length === 0) {
          return res.json({ items: [], page, limit, total: 0, users: {} });
        }
        // The adviser only ever sees their own clients, so we filter the
        // candidate id-set down to the linked client list before inArray.
        filters.push(inArray(adviserFeeRules.clientUserId, ids));
      }
      // Task #294 — LEFT JOIN feeConsents so the adviser-side rule cards can
      // surface the legal context (consent renewal status, expiry, account
      // number, deduction frequency) without forcing a per-row round-trip.
      const rows = await db
        .select({
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
        })
        .from(adviserFeeRules)
        .leftJoin(feeConsents, eq(feeConsents.id, adviserFeeRules.feeConsentId))
        .where(and(...filters))
        .orderBy(desc(adviserFeeRules.createdAt))
        .limit(limit)
        .offset(offset);
      const [totalRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(adviserFeeRules)
        .where(and(...filters));
      const usersMap = await getUserNameMap(
        rows.flatMap((r) => [r.clientUserId, r.adviserUserId]),
      );
      res.json({
        items: rows,
        page,
        limit,
        total: Number(totalRow?.count ?? 0),
        users: usersMap,
      });
    } catch (error: any) {
      handleError(res, error, "Failed to list fee rules");
    }
  });

  app.get("/api/adviser/fee-accruals", async (req, res) => {
    try {
      const auth = requireAuth(req);
      requireRole(auth, "adviser");
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const clientIdQ = Number(req.query.clientUserId);
      const filters: any[] = [eq(adviserFeeAccruals.adviserUserId, auth.userId)];
      // Task #308 — fixture-client filter, see fee-rules above.
      const fixtureCtx = await loadAdviserFixtureFilterContext(auth.userId);
      if (Number.isInteger(clientIdQ) && clientIdQ > 0) {
        await assertAdviserClientLink(auth.userId, clientIdQ);
        if (fixtureCtx.excludedClientIds.includes(clientIdQ)) {
          return res.json({ items: [], users: {} });
        }
        filters.push(eq(adviserFeeAccruals.clientUserId, clientIdQ));
      } else {
        if (fixtureCtx.visibleClientIds.length === 0) {
          return res.json({ items: [], users: {} });
        }
        filters.push(inArray(adviserFeeAccruals.clientUserId, fixtureCtx.visibleClientIds));
      }
      const rows = await db
        .select()
        .from(adviserFeeAccruals)
        .where(and(...filters))
        .orderBy(desc(adviserFeeAccruals.accrualDate), desc(adviserFeeAccruals.id))
        .limit(limit);
      const usersMap = await getUserNameMap(
        rows.flatMap((r) => [r.clientUserId, r.adviserUserId]),
      );
      res.json({ items: rows, users: usersMap });
    } catch (error: any) {
      handleError(res, error, "Failed to list fee accruals");
    }
  });

  app.get("/api/adviser/fee-deductions", async (req, res) => {
    try {
      const auth = requireAuth(req);
      requireRole(auth, "adviser");
      const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
      const clientIdQ = Number(req.query.clientUserId);
      const filters: any[] = [eq(adviserFeeDeductions.adviserUserId, auth.userId)];
      if (status) filters.push(eq(adviserFeeDeductions.status, status));
      // Task #308 — fixture-client filter, see fee-rules above.
      const fixtureCtx = await loadAdviserFixtureFilterContext(auth.userId);
      if (Number.isInteger(clientIdQ) && clientIdQ > 0) {
        await assertAdviserClientLink(auth.userId, clientIdQ);
        if (fixtureCtx.excludedClientIds.includes(clientIdQ)) {
          return res.json({ items: [], users: {} });
        }
        filters.push(eq(adviserFeeDeductions.clientUserId, clientIdQ));
      } else {
        if (fixtureCtx.visibleClientIds.length === 0) {
          return res.json({ items: [], users: {} });
        }
        filters.push(inArray(adviserFeeDeductions.clientUserId, fixtureCtx.visibleClientIds));
      }
      const rows = await db
        .select()
        .from(adviserFeeDeductions)
        .where(and(...filters))
        .orderBy(desc(adviserFeeDeductions.createdAt));
      const usersMap = await getUserNameMap(
        rows.flatMap((r) => [r.clientUserId, r.adviserUserId]),
      );
      // Task #204 — strip IF-only bookkeeping columns (lastRecheckedAt,
      // clientNotifiedAt, clientNotificationCount) from non-IF rows. Even
      // though the adviser UI doesn't currently render those columns, the
      // contract is enforced server-side so a future consumer adding a
      // "client notified" column can't accidentally show stale data on a
      // settled-formerly-IF row.
      const projected = rows.map((r) => projectDeductionForApiContract(r));
      res.json({ items: projected, users: usersMap });
    } catch (error: any) {
      handleError(res, error, "Failed to list fee deductions");
    }
  });

  // ===========================================================================
  // TASK #94 — WEALTH PLANNER COMPLIANCE GAPS
  // ---------------------------------------------------------------------------
  // Adviser-side surface for the four new tables. Reads/writes are gated by
  // assertAdviserClientLink in the service layer; this file only validates the
  // request shape. Note carefully: there is intentionally NO PATCH and NO
  // DELETE route for adviser_notes — that absence IS the append-only
  // guarantee. Edits are expressed as a brand-new POST whose previousNoteId
  // points at the row being amended.
  // ===========================================================================

  // ---- client objectives ----
  const createObjectiveSchema = z.object({
    clientId: z.number().int().positive(),
    adviceRecordId: z.number().int().positive(),
    objectiveType: z.enum(OBJECTIVE_TYPES),
    label: z.string().min(1).max(200),
    targetAmount: z
      .string()
      .regex(/^\d+(\.\d{1,4})?$/, "targetAmount must be a non-negative decimal with up to 4 dp")
      .optional()
      .nullable(),
    targetCurrency: z.string().length(3).optional(),
    targetDate: z.coerce.date().optional().nullable(),
    priority: z.enum(OBJECTIVE_PRIORITIES).optional(),
    notes: z.string().max(5000).optional().nullable(),
  });

  app.post(
    "/api/adviser/client-objectives",
    adviserRoute(async (req, auth) => {
      const parsed = createObjectiveSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(new Error("Invalid objective payload"), { status: 400 });
      }
      // Task #96 — block all structured writes against an advice record that
      // is currently under compliance review. Notes are exempt (separate
      // route below). Throws 423 + reason='record_locked_under_review'.
      // Task #108 — the gate now lives INSIDE createClientObjective() and
      // additionally writes a blocked-write audit row before throwing. The
      // route-level pre-check that used to live here was removed because
      // it short-circuited the throw and the audit row never landed.
      const row = await createClientObjective(auth.userId, parsed.data);
      audit(
        auth.userId,
        "client_objective.create",
        "client_objective",
        String(row.id),
        { clientId: row.clientId, adviceRecordId: row.adviceRecordId },
        req.ip ?? null,
      );
      return row;
    }),
  );

  app.get(
    "/api/adviser/client-objectives",
    adviserRoute(async (req, auth) => {
      const clientId = readClientIdQuery(req);
      if (clientId == null) {
        throw Object.assign(new Error("clientId is required"), { status: 400 });
      }
      const items = await listClientObjectivesForAdviser(auth.userId, clientId);
      // Audit-trail every read so the regulator-facing surface can prove who
      // looked at which client's objectives and when.
      audit(
        auth.userId,
        "client_objective.read",
        "client_objective",
        null,
        { clientId, count: items.length },
        req.ip ?? null,
      );
      return { items };
    }),
  );

  // ---- client documents ----
  // Task #381 — the legacy JSON POST /api/adviser/client-documents (which
  // accepted a caller-supplied `storageKey`) has been retired. No UI surface
  // ever called it after Task #115 moved the adviser dialog onto the proper
  // multipart `/upload` route below, and leaving a route alive that lets a
  // caller bind an arbitrary storage key to a client document is a security
  // smell (a leaked adviser token could register a key pointing at an
  // unrelated bucket object and trick the download path). The verification
  // script now exercises `uploadClientDocument()` directly for the tests
  // that previously round-tripped through the legacy route.
  //
  // Task #99 — real upload route. Streams a multipart/form-data file via
  // multer (in-memory, capped at MAX_UPLOAD_BYTES, default 25 MiB) and
  // routes it through uploadClientDocument(), which computes the storageKey
  // itself instead of trusting the caller.
  //
  // Task #148 — size + mime allow-list enforcement is delegated to the
  // shared `buildUploadMiddleware` factory so the rejection contract (400
  // with structured `code` + nothing written to object storage) is identical
  // for every upload route and is unit-tested in one place. The audit-log
  // entry below now records the detected mime alongside the byte size so a
  // regulator can see exactly what was uploaded.
  const uploadMetadataSchema = z.object({
    clientId: z.coerce.number().int().positive(),
    adviceRecordId: z.coerce.number().int().positive().optional().nullable(),
    documentType: z.enum(CLIENT_DOCUMENT_TYPES),
    fileName: z.string().min(1).max(500).optional(),
    mimeType: z.string().max(200).optional().nullable(),
    description: z.string().max(2000).optional().nullable(),
  });
  const clientDocumentUpload = buildUploadMiddleware();
  app.post(
    "/api/adviser/client-documents/upload",
    clientDocumentUpload.handler,
    adviserRoute(async (req, auth) => {
      // multer drops the parsed file on req.file and the form fields on
      // req.body. The verification script bypasses multer and supplies
      // req.file + req.body directly, so the handler reads from the same
      // shape either way.
      const file = (req as unknown as {
        file?: Express.Multer.File & { detectedMimeType?: string | null };
      }).file;
      if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
        throw Object.assign(new Error("Missing or empty 'file' upload"), {
          status: 400,
        });
      }
      const parsed = uploadMetadataSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw Object.assign(new Error("Invalid upload metadata"), { status: 400 });
      }
      const fileName = parsed.data.fileName ?? file.originalname ?? "upload.bin";
      // The declared mime type is what the browser sent on the multipart
      // headers; we persist that on the document row so the existing
      // download contract stays stable.
      const declaredMimeType = file.mimetype ?? null;
      const mimeType = declaredMimeType ?? parsed.data.mimeType ?? null;
      // Task #161 — detectedMimeType is now the value sniffed from the file's
      // leading bytes by buildUploadMiddleware (file-type / magic numbers),
      // NOT the declared mime. The middleware has already rejected mismatches
      // by this point, so on the happy path detected and declared are the
      // "same" type from a content perspective; the audit log records both
      // so a regulator can see what the browser claimed AND what we actually
      // received bytes-for.
      const detectedMimeType = file.detectedMimeType ?? null;

      const row = await uploadClientDocument(
        auth.userId,
        {
          clientId: parsed.data.clientId,
          adviceRecordId: parsed.data.adviceRecordId ?? null,
          documentType: parsed.data.documentType,
          fileName,
          mimeType,
          description: parsed.data.description ?? null,
        },
        file.buffer,
      );
      audit(
        auth.userId,
        "client_document.create",
        "client_document",
        String(row.id),
        {
          clientId: row.clientId,
          documentType: row.documentType,
          uploaded: true,
          // Task #148 — record file size alongside the upload audit entry so
          // a regulator can see exactly what landed in object storage
          // without joining back to client_documents.
          // Task #161 — `mimeType` is what the browser declared on the
          // multipart headers; `detectedMimeType` is what we sniffed from
          // the file's leading bytes. The middleware enforces compatibility
          // before we get here, but recording both keeps the audit trail
          // forensically useful (e.g. for future "browser said PDF, we
          // stored bytes that detected as application/x-cfb" investigations
          // around legacy Office files).
          sizeBytes: row.fileSizeBytes,
          mimeType: row.mimeType,
          detectedMimeType,
        },
        req.ip ?? null,
      );
      return row;
    }),
  );

  app.get(
    "/api/adviser/client-documents",
    adviserRoute(async (req, auth) => {
      const clientId = readClientIdQuery(req);
      if (clientId == null) {
        throw Object.assign(new Error("clientId is required"), { status: 400 });
      }
      const items = await listClientDocumentsForAdviser(auth.userId, clientId);
      // Document reads are an explicit compliance requirement: regulators
      // need to see who pulled what and when, not just who uploaded.
      audit(
        auth.userId,
        "client_document.read",
        "client_document",
        null,
        { clientId, count: items.length },
        req.ip ?? null,
      );
      return { items };
    }),
  );

  // ---------------------------------------------------------------------------
  // Task #383 — GET /api/adviser/client-documents/:id/download
  // ---------------------------------------------------------------------------
  // Streams a previously uploaded client document back to the requesting
  // adviser. Mirrors the client-side download contract (server/client-routes.ts
  // → /api/client/documents/:id/download) so:
  //
  //   - Cross-tenant access is blocked by assertAdviserClientLink against
  //     the document's clientId — an adviser without an active link gets 403.
  //   - The underlying blob is verified against object storage; if metadata
  //     exists but the file is missing we return 404 rather than streaming a
  //     zero-byte body.
  //   - Outbound headers force `application/octet-stream` for anything outside
  //     SAFE_INLINE_MIME_TYPES and always set `X-Content-Type-Options: nosniff`,
  //     so a smuggled rich type cannot render inline in the adviser's browser.
  //   - PDFs are passed through applyDocumentWatermark with the request
  //     instant + canonical purpose so a leaked file is forensically
  //     attributable to the (adviser, download instant) pair.
  //   - Two audit rows are emitted: the legacy `client_document.download`
  //     (so existing dashboards keep working) and the unified
  //     `document.download` (so the regulator surface can answer "who
  //     pulled what" with a single query). Both rows record actor:"adviser"
  //     so the cross-actor query can distinguish client self-pulls from
  //     adviser pulls.
  //
  // Not wrapped in adviserRoute() because the response body is binary, not
  // JSON. Auth + role + tenant checks are performed inline.
  // ---------------------------------------------------------------------------
  app.get(
    "/api/adviser/client-documents/:id/download",
    async (req: Request, res: Response) => {
      try {
        const auth = requireAuth(req);
        requireRole(auth, "adviser");

        const documentId = parseInt(req.params.id, 10);
        if (!Number.isFinite(documentId) || documentId <= 0) {
          return res.status(400).json({ error: "Invalid document id" });
        }

        const [row] = await db
          .select()
          .from(clientDocuments)
          .where(eq(clientDocuments.id, documentId))
          .limit(1);
        if (!row) {
          return res.status(404).json({ error: "Document not found" });
        }

        // Cross-tenant defence — the adviser must own the client this
        // document belongs to. Throws 403 if the link is missing/inactive.
        await assertAdviserClientLink(auth.userId, row.clientId);

        // Confirm the file is still present in object storage. Without this
        // a backup/restore that lost the blob would silently stream an
        // empty body that the UI would treat as a successful download.
        const head = await statObject(row.storageKey);
        if (!head) {
          return res
            .status(404)
            .json({ error: "Document file missing in storage" });
        }

        // Same MIME-sniff hardening as the client route — only a small
        // allow-list of browser-safe types is served as-declared; everything
        // else is forced to application/octet-stream so it can't render
        // inline. The nosniff header below covers browsers that ignore
        // Content-Disposition: attachment.
        const SAFE_INLINE_MIME_TYPES = new Set([
          "application/pdf",
          "image/jpeg",
          "image/png",
          "image/gif",
          "image/webp",
          "image/heic",
          "image/heif",
          "image/tiff",
        ]);
        const storedMime = (row.mimeType ?? "").toLowerCase();
        const safeContentType = SAFE_INLINE_MIME_TYPES.has(storedMime)
          ? storedMime
          : "application/octet-stream";

        // Per-download watermark for PDFs. Carries the request instant +
        // canonical purpose so a leaked PDF is attributable to this exact
        // download event, not just to the upload event. Non-PDF downloads
        // (images, etc.) pass through unchanged.
        const downloadedAtUtc = new Date();
        let payload: Buffer | null = null;
        let payloadLength = head.sizeBytes;
        if (storedMime === "application/pdf") {
          const original = await getObjectBytes(row.storageKey);
          const names = await resolveWatermarkNames(row.clientId, auth.userId);
          payload = await applyDocumentWatermark(original, {
            clientName: names.clientName,
            adviserName: names.adviserName,
            downloadedAtUtc,
            purpose: "client_document_download",
          });
          payloadLength = payload.length;
        }

        // Legacy + unified audit rows. The legacy action keeps existing
        // adviser dashboards working unchanged; the unified action lets the
        // regulator surface answer "who pulled what" across reports +
        // uploaded documents with a single query.
        await audit(
          auth.userId,
          "client_document.download",
          "client_document",
          String(row.id),
          {
            actor: "adviser",
            adviserUserId: auth.userId,
            clientUserId: row.clientId,
            sizeBytes: head.sizeBytes,
          },
          req.ip ?? null,
        );
        await audit(
          auth.userId,
          "document.download",
          "client_document",
          String(row.id),
          {
            actor: "adviser",
            adviserUserId: auth.userId,
            clientUserId: row.clientId,
            documentId: row.id,
            documentKind: "client_document",
            purpose:
              storedMime === "application/pdf"
                ? "client_document_download"
                : "client_document_download_passthrough",
            downloadedAtUtc: downloadedAtUtc.toISOString(),
            sizeBytes: head.sizeBytes,
            watermarked: storedMime === "application/pdf",
          },
          req.ip ?? null,
        );

        res.setHeader("Content-Type", safeContentType);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Length", String(payloadLength));
        // Quote the filename and strip CR/LF so a hostile filename cannot
        // inject extra response headers.
        const safeName = (row.fileName ?? "download.bin").replace(
          /[\r\n"]/g,
          "_",
        );
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${safeName}"`,
        );

        if (payload !== null) {
          // Watermarked PDF — small enough to send in one shot.
          res.end(payload);
          return;
        }

        const stream = getObjectStream(row.storageKey);
        stream.on("error", (err) => {
          console.error("[adviser-routes] document stream error:", err);
          if (!res.headersSent) {
            res.status(500).json({ error: "Failed to stream document" });
          } else {
            res.destroy(err as Error);
          }
        });
        stream.pipe(res);
      } catch (error: any) {
        handleError(res, error, "Failed to download client document");
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Task #318 — DELETE /api/adviser/client-documents/:id
  // ---------------------------------------------------------------------------
  // Documents are retained for 7 years from creation per Corporations Act
  // s912G. The schema carries `deletion_locked` (defaults true) and
  // `retention_until` (defaults to `now() + interval '7 years'` — Task #330).
  // An adviser CANNOT delete a document while the lock is set OR while the
  // retention window is still open. Both checks short-circuit with HTTP 423
  // Locked + a structured body so the UI can render the lock chip + tooltip.
  //
  // Once `retention_until < now()`, the daily retention-sweeper cron
  // (`server/services/retention-sweeper.ts`) flips `deletion_locked` to
  // false and writes a `document.retention.expired` audit row, after which
  // the row becomes delete-eligible through this route.
  //
  // The audit row is emitted for both successful deletes and blocked
  // attempts (`document.delete.blocked`) so a regulator can see when an
  // adviser tried to delete a still-retained file.
  // ---------------------------------------------------------------------------
  app.delete(
    "/api/adviser/client-documents/:id",
    adviserRoute(async (req, auth) => {
      const documentId = parseInt(req.params.id, 10);
      if (!Number.isInteger(documentId) || documentId <= 0) {
        throw Object.assign(new Error("Invalid document id"), { status: 400 });
      }

      // Load the row directly (cross-checking the adviser-client link below).
      // We deliberately do NOT use a service helper here so the route owns
      // the lock evaluation in one place.
      const [row] = await db
        .select()
        .from(clientDocuments)
        .where(eq(clientDocuments.id, documentId))
        .limit(1);
      if (!row) {
        throw Object.assign(new Error("Document not found"), { status: 404 });
      }
      // Cross-tenant defence — the adviser must own the client this document
      // belongs to. Throws 403 if the link is missing/inactive.
      await assertAdviserClientLink(auth.userId, row.clientId);

      // Centralised lock evaluation — see server/services/document-retention.ts
      // for the contract (locked when deletion_locked=true OR retention_until
      // > now). Keeping the eval in one place lets the unit test cover both
      // legs without double-mocking the route.
      const lock = evaluateRetentionLock({
        retentionUntil: row.retentionUntil,
        deletionLocked: row.deletionLocked,
      });

      if (lock.locked) {
        // Audit the blocked attempt so the regulator surface can see who
        // tried to delete a retained file.
        await audit(
          auth.userId,
          "document.delete.blocked",
          "client_document",
          String(documentId),
          {
            clientUserId: row.clientId,
            documentId,
            reason: lock.reason,
            deletionLocked: lock.deletionLocked,
            retentionUntil: lock.retentionUntil,
          },
          req.ip ?? null,
        );
        throw Object.assign(
          new Error(
            "Document is retained and cannot be deleted while the retention window is active.",
          ),
          {
            status: 423,
            reason: lock.reason,
            extra: {
              documentId,
              deletionLocked: lock.deletionLocked,
              retentionUntil: lock.retentionUntil,
              policy: RETENTION_POLICY_TEXT,
            },
          },
        );
      }

      // Lock cleared — proceed with the delete. (No production document is
      // currently lock-cleared because `deletionLocked` defaults to true;
      // this branch exists for the future "expired retention" sweeper.)
      await db
        .delete(clientDocuments)
        .where(eq(clientDocuments.id, documentId));
      await audit(
        auth.userId,
        "document.delete",
        "client_document",
        String(documentId),
        {
          clientUserId: row.clientId,
          documentId,
          documentKind: "client_document",
        },
        req.ip ?? null,
      );
      return { ok: true, documentId };
    }),
  );

  // ---- adviser notes (APPEND-ONLY: no PATCH, no DELETE on this resource) ----
  const createNoteSchema = z.object({
    clientUserId: z.number().int().positive(),
    body: z.string().min(1).max(10000),
    adviceRecordId: z.number().int().positive().optional().nullable(),
    previousNoteId: z.number().int().positive().optional().nullable(),
  });

  app.post(
    "/api/adviser/client-notes",
    adviserRoute(async (req, auth) => {
      const parsed = createNoteSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(new Error("Invalid note payload"), { status: 400 });
      }
      const row = await createAdviserNote(auth.userId, parsed.data);
      audit(
        auth.userId,
        "adviser_note.create",
        "adviser_note",
        String(row.id),
        {
          clientUserId: row.clientUserId,
          previousNoteId: row.previousNoteId,
          adviceRecordId: row.adviceRecordId,
        },
        req.ip ?? null,
      );
      return row;
    }),
  );

  app.get(
    "/api/adviser/client-notes",
    adviserRoute(async (req, auth) => {
      const clientId = readClientIdQuery(req);
      if (clientId == null) {
        throw Object.assign(new Error("clientId is required"), { status: 400 });
      }
      const items = await listAdviserNotes(auth.userId, clientId);
      audit(
        auth.userId,
        "adviser_note.read",
        "adviser_note",
        null,
        { clientUserId: clientId, count: items.length },
        req.ip ?? null,
      );
      return { items };
    }),
  );

  // ---------------------------------------------------------------------------
  // POST /api/adviser/advice-records/:id/transition
  // ---------------------------------------------------------------------------
  // Real production wiring of the snapshot hook. An adviser flips their
  // client's advice record to 'issued' (SOA goes live) or 'superseded' (a
  // newer SOA replaces it). The status flip and the version snapshot run
  // inside the same db.transaction so they succeed-or-fail together — there
  // is no path to issue without snapshotting.
  // ---------------------------------------------------------------------------
  const transitionSchema = z.object({
    newStatus: z.enum(["issued", "superseded"]),
    soaIssued: z.boolean().optional(),
    soaIssuedAt: z.coerce.date().optional().nullable(),
  });

  app.post(
    "/api/adviser/advice-records/:id/transition",
    adviserRoute(async (req, auth) => {
      const adviceRecordId = parseInt(req.params.id, 10);
      if (!Number.isInteger(adviceRecordId) || adviceRecordId <= 0) {
        throw Object.assign(new Error("Invalid advice record id"), { status: 400 });
      }
      const parsed = transitionSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(new Error("Invalid transition payload"), { status: 400 });
      }

      // Adviser must own the client this advice record belongs to.
      // Task #95 — also pull the prior status / soaIssued state so we can
      // record an explicit before/after diff in the audit row below. The
      // SELECT runs OUTSIDE the transition tx; the live row state is
      // re-loaded inside the tx by transitionAdviceStatus, so this snapshot
      // is purely for the audit metadata.
      const [advice] = await db
        .select({
          id: adviceRecords.id,
          clientId: adviceRecords.clientId,
          status: adviceRecords.status,
          soaIssued: adviceRecords.soaIssued,
          soaIssuedAt: adviceRecords.soaIssuedAt,
        })
        .from(adviceRecords)
        .where(eq(adviceRecords.id, adviceRecordId))
        .limit(1);
      if (!advice) {
        throw Object.assign(new Error("Advice record not found"), { status: 404 });
      }
      await assertAdviserClientLink(auth.userId, advice.clientId);

      // Task #96 — adviser cannot self-transition (issue or supersede) a
      // record that is currently under compliance review. The approval flow
      // for review_pending lives outside the adviser surface; the adviser
      // route returns 423 + reason='record_locked_under_review' so the UI
      // can surface a lock banner. We re-use the already-selected `advice`
      // row instead of re-querying.
      if (advice.status === "review_pending") {
        throw Object.assign(
          new Error("Advice record is locked while under compliance review"),
          { status: 423, reason: REVIEW_LOCK_REASON },
        );
      }

      // Task #95 — write the audit row INSIDE the same db.transaction as
      // the status flip + version snapshot so an audit-insert failure
      // rolls back the whole change. Previously the audit ran AFTER the
      // tx with fire-and-forget semantics, which meant a regulator could
      // see an issued SOA with no audit trail. writeAuditLog is fail-closed.
      const out = await db.transaction(async (tx) => {
        const result = await transitionAdviceStatus({
          adviceRecordId,
          newStatus: parsed.data.newStatus,
          issuedByUserId: auth.userId,
          executor: tx as unknown as typeof db,
          extraSets: {
            soaIssued: parsed.data.soaIssued,
            soaIssuedAt: parsed.data.soaIssuedAt ?? undefined,
          },
        });
        await writeAuditLog({
          executor: tx,
          userId: auth.userId,
          action: `advice_record.transition.${parsed.data.newStatus}`,
          entityType: "advice_record",
          entityId: String(adviceRecordId),
          before: {
            status: advice.status,
            soaIssued: advice.soaIssued,
            soaIssuedAt: advice.soaIssuedAt,
          },
          after: {
            status: result.advice.status,
            soaIssued: result.advice.soaIssued,
            soaIssuedAt: result.advice.soaIssuedAt,
          },
          extra: {
            versionId: result.version.id,
            versionNumber: result.version.versionNumber,
            clientId: advice.clientId,
          },
          ipAddress: req.ip ?? null,
        });
        return result;
      });

      return { advice: out.advice, version: out.version };
    }),
  );
}
