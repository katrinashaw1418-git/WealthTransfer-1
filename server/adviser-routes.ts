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
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "./db";
import {
  auditLogs,
  reportRequests,
  adviserNotificationDismissals,
  feeConsentRequests,
  feeConsents,
  insertFeeConsentRequestSchema,
} from "@shared/schema";
import { requireAuth, requireRole } from "./auth";
import { generateReportPdf, REPORTS_DIR } from "./services/reports";
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
  getAdviserDashboardSummary,
  getAdviserNotifications,
  listAdviserProducts,
  getAdviserClientHoldings,
  getAdviserClientTransactions,
  listAdviserInstructions,
  createAdviserInstruction,
  assertAdviserClientLink,
} from "./services/adviser-access";
import { insertAdviserTaskSchema, insertReportRequestSchema } from "@shared/schema";

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
    return res.status(error.status).json({ error: error.message });
  }
  console.error(`[adviser-routes] ${fallbackMessage}:`, error);
  res.status(500).json({ error: fallbackMessage });
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
const TASK_TYPES = [
  "portfolio_review",
  "fee_consent_renewal",
  "kyc_followup",
  "document_request",
  "meeting_prep",
  "other",
] as const;
const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const REPORT_TYPES = [
  "portfolio_summary",
  "fee_summary",
  "transaction_history",
  "full_statement",
] as const;

const createTaskSchema = insertAdviserTaskSchema
  .omit({ adviserUserId: true })
  .extend({
    taskType: z.enum(TASK_TYPES),
    priority: z.enum(TASK_PRIORITIES).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    dueAt: z.coerce.date().optional().nullable(),
  });

const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  notes: z.string().max(5000).optional().nullable(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueAt: z.coerce.date().optional().nullable(),
});

const createReportSchema = insertReportRequestSchema
  .omit({ adviserUserId: true })
  .extend({
    reportType: z.enum(REPORT_TYPES),
    format: z.enum(["pdf"]).optional(),
  });

const INSTRUCTION_ACTIONS = ["buy", "sell", "switch"] as const;

const createInstructionSchema = z.object({
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
  feeConsentId: z.number().int().positive().optional().nullable(),
});

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
      return listAdviserReportRequests(auth.userId);
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
      const report = await createReportRequest(auth.userId, parsed.data);
      await audit(auth.userId, "adviser_report_requested", "report_request", String(report.id), {
        clientUserId: report.clientUserId,
        reportType: report.reportType,
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
        }, (req as Request).ip || null);
      } else {
        await audit(auth.userId, "adviser_report_failed", "report_request", String(report.id), {
          clientUserId: report.clientUserId,
          reportType: report.reportType,
          failureReason: result.failureReason,
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

        if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
          await db.update(reportRequests).set({ status: "expired" }).where(eq(reportRequests.id, id));
          return res.status(410).json({ error: "Report has expired" });
        }

        const filePath = path.join(REPORTS_DIR, `${id}.pdf`);
        if (!fs.existsSync(filePath)) {
          return res.status(404).json({ error: "Report file missing on disk" });
        }

        await audit(auth.userId, "adviser_report_downloaded", "report_request", String(id), {
          clientUserId: row.clientUserId,
          reportType: row.reportType,
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
        fs.createReadStream(filePath).pipe(res);
      } catch (error: any) {
        handleError(res, error, "Report download failed");
      }
    },
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
      adviceRecordId: z.number().int().positive().optional().nullable(),
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

        const created = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(feeConsentRequests)
            .values({
              adviserUserId: auth.userId,
              clientUserId: parsed.data.clientUserId,
              adviceRecordId: parsed.data.adviceRecordId ?? null,
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
          await tx.insert(auditLogs).values({
            userId: auth.userId,
            action: "fee_consent_requested",
            entityType: "fee_consent_request",
            entityId: String(row.id),
            metadata: {
              clientUserId: row.clientUserId,
              feeType: row.feeType,
              amountType: row.amountType,
              amount: row.amount,
              deductionFrequency: row.deductionFrequency,
            } as any,
            ipAddress: req.ip || null,
          });
          return row;
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
        if (clientIdRaw && Number.isFinite(clientIdRaw)) {
          await assertAdviserClientLink(auth.userId, clientIdRaw);
          conds.push(eq(feeConsentRequests.clientUserId, clientIdRaw));
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
          await tx.insert(auditLogs).values({
            userId: auth.userId,
            action: "fee_consent_request_withdrawn",
            entityType: "fee_consent_request",
            entityId: String(id),
            metadata: {
              clientUserId: existing.clientUserId,
              reason: parsed.data.reason ?? null,
            } as any,
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
}
