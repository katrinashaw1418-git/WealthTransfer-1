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
import { eq } from "drizzle-orm";
import { db } from "./db";
import { auditLogs, reportRequests } from "@shared/schema";
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
}
