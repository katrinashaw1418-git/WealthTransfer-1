// =============================================================================
// SESSION 10B — CLIENT-FACING INVESTMENT INSTRUCTION ROUTES
// -----------------------------------------------------------------------------
// Routes the END CLIENT (not the adviser) calls to consent or reject an
// investment instruction created by their adviser.
//
// Hard rules:
//   1. requireAuth — JWT must be valid.
//   2. The client may only see/act on instructions where
//      investmentInstructions.clientUserId === auth.userId. Service layer
//      enforces this in loadClientInstruction.
//   3. State machine: pending_consent -> consented OR rejected. Anything
//      else returns 400.
//   4. Audit log on every transition.
//   5. NO downstream cash movement is wired here. "consented" is terminal
//      for this session.
// =============================================================================

import type { Express, Request } from "express";
import { z } from "zod";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { db } from "./db";
import {
  auditLogs,
  feeConsentRequests,
  feeConsents,
  // Session 23A — fee engine Gate A (read-only client view)
  adviserFeeRules,
  adviserFeeAccruals,
  adviserFeeDeductions,
} from "@shared/schema";
import { requireAuth } from "./auth";
import { getUserNameMap } from "./services/user-name-map";
// Task #204 — banner shortfall is computed from the live ledger-derived
// balance per currency, not from the failureReason text (which is
// operator-only and can be stale across re-checks).
import { getUserCurrencyBalance } from "./services/ledger";
import {
  isInsufficientFundsStatus,
  FEE_DEDUCTION_STATUS_INSUFFICIENT_FUNDS,
} from "../shared/fee-deduction-status";
import {
  listClientPendingInstructions,
  consentClientInstruction,
  rejectClientInstruction,
} from "./services/adviser-access";
import { storage } from "./storage";

// Task #94 — wealth planner compliance: client read-only objectives, documents,
// and a viewing-ack-gated advice payload reader.
import {
  listClientObjectivesForClient,
  listClientDocumentsForClient,
  getClientDocumentForOwner,
  requireAcknowledgedAdvice,
} from "./services/wealth-planner";
import { getObjectBytes, getObjectStream, statObject } from "./services/object-storage";
import { applyDocumentWatermark } from "./services/document-watermark";
import { resolveWatermarkNames } from "./services/watermark-context";
import { adviceRecords } from "@shared/schema";
// Task #95 — standardised audit-log writer (before/after snapshots) for the
// advice + fee-engine surfaces. The local audit() helper below is still
// used for non-fee/advice paths (instruction consent/reject); only the
// fee-consent sign/decline writes have been migrated to writeAuditLog.
import { writeAuditLog } from "./services/audit";
// Task #343 — shared fee-consent PDF builder; identical artefact to the admin
// surface so the two never drift.
import {
  buildFeeConsentPdf,
  buildFeeConsentRequestPdf,
} from "./services/fee-consent-pdf";

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

function handleError(res: any, error: any, fallbackMessage: string) {
  if (error?.status) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error(`[client-routes] ${fallbackMessage}:`, error);
  res.status(500).json({ error: fallbackMessage });
}

const rejectSchema = z.object({
  reason: z.string().max(2000).optional().nullable(),
});

export function registerClientRoutes(app: Express): void {
  // ---------------------------------------------------------------------------
  // GET /api/client/instructions/pending
  // List of pending instructions the current client must consent to or reject.
  // ---------------------------------------------------------------------------
  app.get("/api/client/instructions/pending", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const rows = await listClientPendingInstructions(auth.userId);
      res.json(rows);
    } catch (error: any) {
      handleError(res, error, "Failed to list pending instructions");
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/client/instructions/:id/consent
  // Client approves the instruction — transitions pending_consent -> consented.
  // ---------------------------------------------------------------------------
  app.post("/api/client/instructions/:id/consent", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid instruction id" });
      }
      const updated = await consentClientInstruction(auth.userId, id);
      await audit(
        auth.userId,
        "client_instruction_consented",
        "investment_instruction",
        String(id),
        { adviserUserId: updated.adviserUserId, productId: updated.productId, amount: updated.amount },
        (req as Request).ip || null,
      );
      res.json(updated);
    } catch (error: any) {
      handleError(res, error, "Failed to consent to instruction");
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/client/instructions/:id/reject
  // Client rejects the instruction — transitions pending_consent -> rejected.
  // ---------------------------------------------------------------------------
  app.post("/api/client/instructions/:id/reject", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid instruction id" });
      }
      const parsed = rejectSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid reject payload: " + parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const updated = await rejectClientInstruction(auth.userId, id, parsed.data.reason ?? null);
      await audit(
        auth.userId,
        "client_instruction_rejected",
        "investment_instruction",
        String(id),
        {
          adviserUserId: updated.adviserUserId,
          productId: updated.productId,
          reason: parsed.data.reason ?? null,
        },
        (req as Request).ip || null,
      );
      res.json(updated);
    } catch (error: any) {
      handleError(res, error, "Failed to reject instruction");
    }
  });

  // ===========================================================================
  // SESSION 20 — Client-side fee consent REQUESTS (sign / decline / live view)
  // ---------------------------------------------------------------------------
  // The client is the only role that can sign or decline. Signing inserts a
  // row into the existing `feeConsents` table (the executed consent) AND flips
  // the request status atomically. NO money moves here — fee deduction is
  // gated separately (Session 23A/B).
  // ===========================================================================

  // GET /api/client/fee-consent-requests?status=
  // Task #300 — mirror the admin endpoint's shape so the client UI can show
  // the supersede chain back-pointer (`supersedesRequestId` is already on
  // the row via select()) and the server-computed `deductionsBlockedReason`
  // ("expired" | "pending" | "no_advice_record" | null). Money movement is
  // gated separately; this is the user-facing reason a request would not be
  // permitted to drive a deduction TODAY if the kill-switch were lifted.
  app.get("/api/client/fee-consent-requests", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const status = typeof req.query.status === "string" ? req.query.status : null;
      const conds: any[] = [eq(feeConsentRequests.clientUserId, auth.userId)];
      if (status) conds.push(eq(feeConsentRequests.status, status));
      const rows = await db
        .select()
        .from(feeConsentRequests)
        .where(conds.length === 1 ? conds[0] : and(...conds))
        .orderBy(desc(feeConsentRequests.createdAt));
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
      res.json(items);
    } catch (error: any) {
      handleError(res, error, "Failed to list fee consent requests");
    }
  });

  // POST /api/client/fee-consent-requests/:id/sign
  // Atomic transition pending -> consented + insert executed feeConsents row.
  const signSchema = z.object({
    signatureName: z.string().min(2).max(200),
  });
  app.post("/api/client/fee-consent-requests/:id/sign", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid request id" });
      }
      const parsed = signSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          error:
            "Invalid sign payload: " +
            parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const result = await db.transaction(async (tx) => {
        // Row-level lock so two concurrent sign attempts can't both read
        // status='pending' and both insert a feeConsents row. The loser
        // blocks until the winner commits, then sees status='consented' and
        // is rejected by the state-machine guard below.
        const [request] = await tx
          .select()
          .from(feeConsentRequests)
          .where(eq(feeConsentRequests.id, id))
          .for("update")
          .limit(1);
        if (!request) {
          throw Object.assign(new Error("Fee consent request not found"), {
            status: 404,
          });
        }
        if (request.clientUserId !== auth.userId) {
          throw Object.assign(new Error("Not your fee consent request"), {
            status: 403,
          });
        }
        if (request.status !== "pending") {
          throw Object.assign(
            new Error(`Cannot sign request in status '${request.status}'`),
            { status: 400 },
          );
        }
        // Executed consent row is required to have an adviceRecordId. If the
        // request didn't carry one, refuse here so the upstream advice trail
        // is preserved.
        if (!request.adviceRecordId) {
          throw Object.assign(
            new Error(
              "Cannot sign — request is not linked to an advice record. Ask your adviser to attach one.",
            ),
            { status: 400 },
          );
        }
        const [executed] = await tx
          .insert(feeConsents)
          .values({
            adviceRecordId: request.adviceRecordId,
            clientId: request.clientUserId,
            adviserId: request.adviserUserId,
            feeType: request.feeType,
            amountType: request.amountType,
            amount: request.amount,
            calculationMethod: request.calculationMethod,
            accountNumber: request.accountNumber,
            accountName: request.accountName,
            deductionFrequency: request.deductionFrequency,
            referenceDay: request.proposedReferenceDay,
            renewalWindowStart: request.proposedRenewalWindowStart,
            renewalWindowEnd: request.proposedRenewalWindowEnd,
            consentExpiryDate: request.proposedConsentExpiryDate,
            renewalStatus: "active",
            clientSignatureName: parsed.data.signatureName,
          })
          .returning();
        // Belt-and-braces: even with FOR UPDATE the conditional WHERE on
        // status='pending' makes a second-attempt update a no-op rather than
        // overwriting a consented request.
        const updatedRows = await tx
          .update(feeConsentRequests)
          .set({
            status: "consented",
            signedFeeConsentId: executed.id,
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
        const updated = updatedRows[0];
        if (!updated) {
          throw Object.assign(
            new Error("Fee consent request was already actioned"),
            { status: 409 },
          );
        }
        // Task #95 — two audit rows so each artefact (request + executed
        // consent) has its own searchable trail. The signed request flips
        // pending → consented; the executed consent is a fresh insert
        // (before: null) so an auditor can see the explicit creation.
        await writeAuditLog({
          executor: tx,
          userId: auth.userId,
          action: "fee_consent_signed",
          entityType: "fee_consent_request",
          entityId: String(id),
          before: {
            status: request.status,
            signedFeeConsentId: request.signedFeeConsentId,
            respondedAt: request.respondedAt,
          },
          after: {
            status: updated.status,
            signedFeeConsentId: updated.signedFeeConsentId,
            respondedAt: updated.respondedAt,
          },
          extra: {
            feeConsentId: executed.id,
            adviserUserId: request.adviserUserId,
            signatureName: parsed.data.signatureName,
          },
          ipAddress: (req as Request).ip || null,
        });
        await writeAuditLog({
          executor: tx,
          userId: auth.userId,
          action: "fee_consent_created",
          entityType: "fee_consent",
          entityId: String(executed.id),
          before: null,
          after: {
            id: executed.id,
            adviceRecordId: executed.adviceRecordId,
            clientId: executed.clientId,
            adviserId: executed.adviserId,
            feeType: executed.feeType,
            amount: executed.amount,
            renewalStatus: executed.renewalStatus,
            consentExpiryDate: executed.consentExpiryDate,
          },
          extra: {
            feeConsentRequestId: id,
          },
          ipAddress: (req as Request).ip || null,
        });
        return { request: updated, feeConsent: executed };
      });
      res.json(result);
    } catch (error: any) {
      handleError(res, error, "Failed to sign fee consent request");
    }
  });

  // POST /api/client/fee-consent-requests/:id/decline
  const declineSchema = z.object({
    reason: z.string().max(2000).optional().nullable(),
  });
  app.post("/api/client/fee-consent-requests/:id/decline", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid request id" });
      }
      const parsed = declineSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid decline payload" });
      }
      const updated = await db.transaction(async (tx) => {
        const [request] = await tx
          .select()
          .from(feeConsentRequests)
          .where(eq(feeConsentRequests.id, id))
          .for("update")
          .limit(1);
        if (!request) {
          throw Object.assign(new Error("Fee consent request not found"), {
            status: 404,
          });
        }
        if (request.clientUserId !== auth.userId) {
          throw Object.assign(new Error("Not your fee consent request"), {
            status: 403,
          });
        }
        if (request.status !== "pending") {
          throw Object.assign(
            new Error(`Cannot decline request in status '${request.status}'`),
            { status: 400 },
          );
        }
        const updatedRows = await tx
          .update(feeConsentRequests)
          .set({
            status: "declined",
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
        // Task #95 — explicit pending → declined diff plus the decline
        // reason being attached on the same row.
        await writeAuditLog({
          executor: tx,
          userId: auth.userId,
          action: "fee_consent_declined",
          entityType: "fee_consent_request",
          entityId: String(id),
          before: {
            status: request.status,
            declineReason: request.declineReason,
            respondedAt: request.respondedAt,
          },
          after: {
            status: row.status,
            declineReason: row.declineReason,
            respondedAt: row.respondedAt,
          },
          extra: {
            adviserUserId: request.adviserUserId,
            reason: parsed.data.reason ?? null,
          },
          ipAddress: (req as Request).ip || null,
        });
        return row;
      });
      res.json(updated);
    } catch (error: any) {
      handleError(res, error, "Failed to decline fee consent request");
    }
  });

  // GET /api/client/fee-consents — read-only list of executed consents.
  // Task #300 — surface the supersede chain (both directions) and the
  // server-computed `deductionsBlockedReason` the same way the admin
  // endpoint does, so the client UI can render "this consent replaced an
  // earlier one" trails and the same inline "deductions blocked" warning
  // an admin sees. The `supersededByRequestId/At/Reason` columns live on
  // `feeConsents` directly; the reverse `supersedesRequestId` is looked
  // up via the request that signed THIS consent.
  app.get("/api/client/fee-consents", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const rows = await db
        .select({
          id: feeConsents.id,
          adviceRecordId: feeConsents.adviceRecordId,
          clientId: feeConsents.clientId,
          adviserId: feeConsents.adviserId,
          feeType: feeConsents.feeType,
          amountType: feeConsents.amountType,
          amount: feeConsents.amount,
          calculationMethod: feeConsents.calculationMethod,
          accountNumber: feeConsents.accountNumber,
          accountName: feeConsents.accountName,
          deductionFrequency: feeConsents.deductionFrequency,
          referenceDay: feeConsents.referenceDay,
          renewalWindowStart: feeConsents.renewalWindowStart,
          renewalWindowEnd: feeConsents.renewalWindowEnd,
          consentExpiryDate: feeConsents.consentExpiryDate,
          renewalStatus: feeConsents.renewalStatus,
          clientSignatureName: feeConsents.clientSignatureName,
          consentedAt: feeConsents.consentedAt,
          withdrawnAt: feeConsents.withdrawnAt,
          supersededByRequestId: feeConsents.supersededByRequestId,
          supersededAt: feeConsents.supersededAt,
          supersededReason: feeConsents.supersededReason,
          // Drizzle's sql template renders `${feeConsents.id}` as the bare
          // column name `"id"` rather than `"fee_consents"."id"`, which inside
          // a correlated subquery accidentally resolves to `fcr.id` and makes
          // the back-pointer always look like null. Pin the outer reference
          // explicitly so the cross-table lookup actually works.
          supersedesRequestId: sql<number | null>`(
            SELECT supersedes_request_id
            FROM ${feeConsentRequests} fcr
            WHERE fcr.signed_fee_consent_id = ${sql.raw('"fee_consents"."id"')}
            LIMIT 1
          )`,
        })
        .from(feeConsents)
        .where(eq(feeConsents.clientId, auth.userId))
        .orderBy(desc(feeConsents.consentedAt));
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
      res.json(items);
    } catch (error: any) {
      handleError(res, error, "Failed to list fee consents");
    }
  });

  // -------------------------------------------------------------------------
  // Task #343 — let a client retain their own copy of a consent artefact.
  // Both endpoints render the SAME PDF as the admin-side equivalents (same
  // helper in server/services/fee-consent-pdf.ts) so the two surfaces can
  // never drift, then write a `*_pdf_exported_by_client` audit row + the
  // unified `document.download` row used by the cross-surface auditor.
  // Ownership is enforced inside the helper via `requireOwnerUserId`: the
  // builder throws a 403-tagged Error if the row's clientUserId/clientId
  // does not match `auth.userId`, mirroring the boundary the existing list
  // endpoints already enforce (see server/client-fee-consents.test.ts).
  // -------------------------------------------------------------------------
  app.get("/api/client/fee-consent-requests/:id/pdf", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        throw Object.assign(new Error("Invalid request id"), { status: 400 });
      }
      const artefact = await buildFeeConsentRequestPdf({
        id,
        exportedByUserId: auth.userId,
        purpose: "fee_consent_request_download",
        requireOwnerUserId: auth.userId,
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${artefact.filename}"`,
      );
      res.setHeader("Content-Length", String(artefact.buf.length));
      await writeAuditLog({
        userId: auth.userId,
        action: "fee_consent_request_pdf_exported_by_client",
        entityType: "fee_consent_request",
        entityId: String(id),
        before: null,
        after: null,
        extra: { source: "client_ui" },
        ipAddress: req.ip || null,
      });
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
    } catch (error: any) {
      handleError(res, error, "Failed to download fee consent request");
    }
  });

  app.get("/api/client/fee-consents/:id/pdf", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        throw Object.assign(new Error("Invalid consent id"), { status: 400 });
      }
      const artefact = await buildFeeConsentPdf({
        id,
        exportedByUserId: auth.userId,
        purpose: "fee_consent_download",
        requireOwnerUserId: auth.userId,
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${artefact.filename}"`,
      );
      res.setHeader("Content-Length", String(artefact.buf.length));
      await writeAuditLog({
        userId: auth.userId,
        action: "fee_consent_pdf_exported_by_client",
        entityType: "fee_consent",
        entityId: String(id),
        before: null,
        after: null,
        extra: { source: "client_ui" },
        ipAddress: req.ip || null,
      });
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
    } catch (error: any) {
      handleError(res, error, "Failed to download fee consent");
    }
  });

  // ===========================================================================
  // SESSION 23A — FEE ENGINE GATE A (client READ-ONLY combined view)
  // ---------------------------------------------------------------------------
  // GET /api/client/fees — single payload for the client fees page.
  //   - rules: ALL fee rules attached to me (active + paused so the client
  //            can see if a fee was paused).
  //   - recentAccruals: last 90 days of accrual rows touching me.
  //   - pendingDeductions: status=pending_approval batches for me.
  // ===========================================================================
  app.get("/api/client/fees", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

      // Task #294 — `?status` accepts a comma-separated list so the
      // client fees page can pull Active rules and History rules into
      // independent cards (each with its own paginator). Empty / missing
      // → all statuses (back-compat with existing callers).
      const statusParam =
        typeof req.query.status === "string" ? req.query.status.trim() : "";
      const statuses = statusParam
        ? statusParam
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [];
      const rulesLimit = Math.min(
        Math.max(Number(req.query.rulesLimit) || 50, 1),
        200,
      );
      const rulesPage = Math.max(Number(req.query.rulesPage) || 1, 1);
      const rulesOffset = (rulesPage - 1) * rulesLimit;

      const ruleFilters: any[] = [eq(adviserFeeRules.clientUserId, auth.userId)];
      if (statuses.length === 1) {
        ruleFilters.push(eq(adviserFeeRules.status, statuses[0]));
      } else if (statuses.length > 1) {
        ruleFilters.push(inArray(adviserFeeRules.status, statuses));
      }

      // Task #61 — explicit projection for the deduction-shaped fields so
      // the API contract names every column (including the new reversal
      // pointers reversedAt / reversedReason / reversalTransactionId)
      // instead of relying on `select *`. Operator-only fields
      // (reversedByUserId, approvedByUserId, idempotencyKey, ...) stay
      // hidden from clients.
      const deductionClientCols = {
        id: adviserFeeDeductions.id,
        adviserUserId: adviserFeeDeductions.adviserUserId,
        periodStart: adviserFeeDeductions.periodStart,
        periodEnd: adviserFeeDeductions.periodEnd,
        totalAccrued: adviserFeeDeductions.totalAccrued,
        adviserShareAmount: adviserFeeDeductions.adviserShareAmount,
        platformShareAmount: adviserFeeDeductions.platformShareAmount,
        currency: adviserFeeDeductions.currency,
        status: adviserFeeDeductions.status,
        settledAt: adviserFeeDeductions.settledAt,
        settledTransactionId: adviserFeeDeductions.settledTransactionId,
        reversedAt: adviserFeeDeductions.reversedAt,
        reversedReason: adviserFeeDeductions.reversedReason,
        reversalTransactionId: adviserFeeDeductions.reversalTransactionId,
        createdAt: adviserFeeDeductions.createdAt,
      } as const;

      const [rules, recentAccruals, pendingDeductions, recentReversals] = await Promise.all([
        // Task #294 — LEFT JOIN feeConsents so the client-side fees page can
        // explain "this rule is active because consent X is in force, expires
        // on Y, and authorises Z account" without a per-row round-trip. Only
        // the columns the cards / pills render are projected so the response
        // payload stays small.
        db
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
          .where(and(...ruleFilters))
          .orderBy(desc(adviserFeeRules.createdAt))
          .limit(rulesLimit)
          .offset(rulesOffset),
        db
          .select()
          .from(adviserFeeAccruals)
          .where(
            and(
              eq(adviserFeeAccruals.clientUserId, auth.userId),
              sql`${adviserFeeAccruals.accrualDate} >= ${ninetyDaysAgo}`,
            ),
          )
          .orderBy(desc(adviserFeeAccruals.accrualDate))
          .limit(200),
        db
          .select(deductionClientCols)
          .from(adviserFeeDeductions)
          .where(
            and(
              eq(adviserFeeDeductions.clientUserId, auth.userId),
              eq(adviserFeeDeductions.status, "pending_approval"),
            ),
          )
          .orderBy(desc(adviserFeeDeductions.createdAt)),
        // Task #61 — surface recently reversed deductions on the same
        // payload so the client fees page shows refunds without a second
        // round-trip. Bounded to the 90-day window already used for
        // recentAccruals so the response stays small.
        db
          .select(deductionClientCols)
          .from(adviserFeeDeductions)
          .where(
            and(
              eq(adviserFeeDeductions.clientUserId, auth.userId),
              eq(adviserFeeDeductions.status, "reversed"),
              sql`${adviserFeeDeductions.reversedAt} >= ${ninetyDaysAgo}`,
            ),
          )
          .orderBy(desc(adviserFeeDeductions.reversedAt))
          .limit(50),
      ]);

      const usersMap = await getUserNameMap([
        ...rules.map((r) => r.adviserUserId),
        ...recentAccruals.map((a) => a.adviserUserId),
        ...pendingDeductions.map((d) => d.adviserUserId),
        ...recentReversals.map((d) => d.adviserUserId),
      ]);

      // Task #294 — paired total so the client UI can show "Page 2 of 5"
      // for the rules card under the same status filter the page used.
      const [rulesTotalRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(adviserFeeRules)
        .where(and(...ruleFilters));

      res.json({
        rules,
        rulesPage,
        rulesLimit,
        rulesTotal: Number(rulesTotalRow?.count ?? 0),
        recentAccruals,
        pendingDeductions,
        recentReversals,
        users: usersMap,
      });
    } catch (error: any) {
      handleError(res, error, "Failed to load client fees");
    }
  });

  // ===========================================================================
  // SESSION 32 — CLIENT VIEW OF OWN FEE DEDUCTIONS (Gate B follow-up)
  // ---------------------------------------------------------------------------
  // GET /api/client/fee-deductions
  //   Returns every adviser_fee_deductions row scoped to the signed-in client
  //   so they can see what was charged, when it settled, and which underlying
  //   transaction it links to. Strictly read-only and strictly self-scoped:
  //   the where clause is `clientUserId = auth.userId`, and we only ever
  //   project the deduction columns that are safe to expose to the client
  //   (we deliberately omit operator-only fields like accrualIds,
  //   approvedByUserId, idempotencyKey, rejectedReason).
  //
  // Task #204 — `failureReason` is selectively exposed for rows in
  //   `insufficient_funds` status ONLY, so the client banner can render
  //   "you need $X more to clear this fee". We strip it for every other
  //   status so an operator's diagnostic note on a non-IF row (which uses
  //   the same column for unrelated settlement crashes) cannot leak. The
  //   schema bookkeeping fields `lastRecheckedAt`, `clientNotifiedAt`,
  //   `clientNotificationCount` remain server-side only.
  // ===========================================================================
  app.get("/api/client/fee-deductions", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const rawRows = await db
        .select({
          id: adviserFeeDeductions.id,
          adviserUserId: adviserFeeDeductions.adviserUserId,
          periodStart: adviserFeeDeductions.periodStart,
          periodEnd: adviserFeeDeductions.periodEnd,
          totalAccrued: adviserFeeDeductions.totalAccrued,
          adviserShareAmount: adviserFeeDeductions.adviserShareAmount,
          platformShareAmount: adviserFeeDeductions.platformShareAmount,
          currency: adviserFeeDeductions.currency,
          status: adviserFeeDeductions.status,
          settledAt: adviserFeeDeductions.settledAt,
          settledTransactionId: adviserFeeDeductions.settledTransactionId,
          // Task #61 — surface reversal info so a client whose fee was
          // refunded can see when and why it was reversed. We deliberately
          // do NOT expose `reversedByUserId` (operator-only).
          reversedAt: adviserFeeDeductions.reversedAt,
          reversedReason: adviserFeeDeductions.reversedReason,
          reversalTransactionId: adviserFeeDeductions.reversalTransactionId,
          // Task #204 — projected here, gated below for non-IF rows.
          failureReason: adviserFeeDeductions.failureReason,
          createdAt: adviserFeeDeductions.createdAt,
        })
        .from(adviserFeeDeductions)
        .where(eq(adviserFeeDeductions.clientUserId, auth.userId))
        .orderBy(desc(adviserFeeDeductions.createdAt));

      // Task #204 render contract — strip failureReason for any row whose
      // CURRENT status isn't `insufficient_funds`. A previously-IF row that
      // has since been settled must NOT keep leaking its old shortfall
      // message to the client even though the column lingers in the table.
      const rows = rawRows.map((r) => ({
        ...r,
        failureReason:
          r.status === "insufficient_funds" ? r.failureReason : null,
      }));

      const usersMap = await getUserNameMap(rows.map((r) => r.adviserUserId));
      res.json({ items: rows, users: usersMap });
    } catch (error: any) {
      handleError(res, error, "Failed to load client fee deductions");
    }
  });

  // ===========================================================================
  // TASK #204 — INSUFFICIENT-FUNDS BANNER PAYLOAD (CLIENT-SCOPED)
  // ---------------------------------------------------------------------------
  // GET /api/client/fee-deductions/insufficient-funds-summary
  //   Lightweight banner-shaped projection of the client's currently-held
  //   deductions. Powers the red banner on /client/fees AND /dashboard. We
  //   compute the live shortfall per currency from the ledger-derived
  //   balance (not from the cached failureReason text, which can be stale
  //   across sweep re-checks). When the client has no IF rows, the response
  //   is `{ hasInsufficientFunds: false, items: [], shortfallsByCurrency: {} }`
  //   so the UI can simply call .hasInsufficientFunds to decide whether to
  //   render the banner — no extra "is this empty?" logic required.
  //
  //   Self-scoped (where clientUserId = auth.userId). Honours the centralised
  //   isInsufficientFundsStatus() predicate so a row that races to settled
  //   between the cron tick and this read drops out of the banner cleanly.
  // ===========================================================================
  app.get(
    "/api/client/fee-deductions/insufficient-funds-summary",
    async (req, res) => {
      try {
        const auth = requireAuth(req);
        const rows = await db
          .select({
            id: adviserFeeDeductions.id,
            adviserUserId: adviserFeeDeductions.adviserUserId,
            periodStart: adviserFeeDeductions.periodStart,
            periodEnd: adviserFeeDeductions.periodEnd,
            totalAccrued: adviserFeeDeductions.totalAccrued,
            currency: adviserFeeDeductions.currency,
            status: adviserFeeDeductions.status,
          })
          .from(adviserFeeDeductions)
          .where(
            and(
              eq(adviserFeeDeductions.clientUserId, auth.userId),
              eq(
                adviserFeeDeductions.status,
                FEE_DEDUCTION_STATUS_INSUFFICIENT_FUNDS,
              ),
              // Never include reversed rows — once refunded, the client owes
              // nothing on that batch even if it transiently sat at IF.
              sql`${adviserFeeDeductions.reversedAt} IS NULL`,
            ),
          )
          .orderBy(desc(adviserFeeDeductions.createdAt));

        // Belt-and-braces: drop any row that the centralised predicate says
        // is no longer IF (defensive — the WHERE above already enforces it).
        const heldRows = rows.filter((r) => isInsufficientFundsStatus(r));

        // Sum totalAccrued per currency, then look up the live ledger
        // balance per distinct currency exactly once.
        const currencies = Array.from(new Set(heldRows.map((r) => r.currency)));
        const balanceByCurrency: Record<string, string> = {};
        await Promise.all(
          currencies.map(async (cur) => {
            balanceByCurrency[cur] = await getUserCurrencyBalance(
              auth.userId,
              cur,
            );
          }),
        );

        const shortfallsByCurrency: Record<
          string,
          { totalAccrued: string; available: string; shortfall: string }
        > = {};
        for (const cur of currencies) {
          const totalAccrued = heldRows
            .filter((r) => r.currency === cur)
            .reduce((s, r) => s + Number(r.totalAccrued), 0);
          const available = Number(balanceByCurrency[cur] ?? "0");
          const shortfall = Math.max(0, totalAccrued - available);
          shortfallsByCurrency[cur] = {
            totalAccrued: totalAccrued.toFixed(4),
            available: available.toFixed(4),
            shortfall: shortfall.toFixed(4),
          };
        }

        const items = heldRows.map((r) => {
          const available = Number(balanceByCurrency[r.currency] ?? "0");
          const required = Number(r.totalAccrued);
          const shortfall = Math.max(0, required - available);
          return {
            deductionId: r.id,
            adviserUserId: r.adviserUserId,
            periodStart: r.periodStart,
            periodEnd: r.periodEnd,
            totalAccrued: r.totalAccrued,
            currency: r.currency,
            available: available.toFixed(4),
            shortfall: shortfall.toFixed(4),
          };
        });

        res.json({
          hasInsufficientFunds: heldRows.length > 0,
          items,
          shortfallsByCurrency,
        });
      } catch (error: any) {
        handleError(
          res,
          error,
          "Failed to load insufficient-funds summary",
        );
      }
    },
  );

  // ===========================================================================
  // TASK #94 — Client read-only views over the wealth-planner tables.
  // ---------------------------------------------------------------------------
  // The client never writes to objectives / documents — those originate from
  // their adviser. Reading their own data is unconditionally allowed and is
  // scoped on auth.userId so cross-client leakage is impossible.
  // ===========================================================================

  // GET /api/client/objectives — own structured objectives.
  app.get("/api/client/objectives", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const items = await listClientObjectivesForClient(auth.userId);
      // Read audit so the regulator-facing surface can prove the client
      // looked at their own objectives (a positive disclosure signal).
      audit(
        auth.userId,
        "client_objective.read",
        "client_objective",
        null,
        { actor: "client", count: items.length },
        req.ip ?? null,
      );
      res.json({ items });
    } catch (error: any) {
      handleError(res, error, "Failed to load client objectives");
    }
  });

  // GET /api/client/documents — own uploaded documents (fact-finds, etc.).
  app.get("/api/client/documents", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const items = await listClientDocumentsForClient(auth.userId);
      // Document reads are an explicit compliance requirement: the audit
      // log must record every retrieval, not just the upload.
      audit(
        auth.userId,
        "client_document.read",
        "client_document",
        null,
        { actor: "client", count: items.length },
        req.ip ?? null,
      );
      res.json({ items });
    } catch (error: any) {
      handleError(res, error, "Failed to load client documents");
    }
  });

  // ---------------------------------------------------------------------------
  // Task #99 — GET /api/client/documents/:id/download
  //
  // Streams the document bytes from object storage to the requesting client.
  // The owner check (clientDocuments.clientId === auth.userId) is enforced
  // in getClientDocumentForOwner(), which throws 404 (NOT 403) on a
  // cross-client probe so we don't reveal which document ids exist on other
  // clients. Every successful download writes an audit row so the regulator
  // surface knows who pulled what and when.
  // ---------------------------------------------------------------------------
  app.get("/api/client/documents/:id/download", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const documentId = parseInt(req.params.id, 10);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        return res.status(400).json({ error: "Invalid document id" });
      }
      const row = await getClientDocumentForOwner(documentId, auth.userId);

      // Verify the underlying file is still present in object storage. If a
      // backup/restore left the metadata row but lost the blob we MUST 404
      // rather than stream an empty body that the UI would silently treat
      // as a successful zero-byte file.
      const head = await statObject(row.storageKey);
      if (!head) {
        return res.status(404).json({ error: "Document file missing in storage" });
      }

      // Task #117 — harden the response headers against MIME-sniffing-based
      // XSS. Two complementary controls:
      //
      //   1. Force `application/octet-stream` for everything except a small
      //      allow-list of "known browser-safe to render" types (PDF +
      //      common image formats). A document stored with mime
      //      `text/html` (or any other rich type a future bug somehow lets
      //      slip past the upload allow-list) is therefore served as an
      //      opaque binary blob — the browser can't render it inline.
      //
      //   2. Add `X-Content-Type-Options: nosniff` so even browsers that
      //      ignore `Content-Disposition: attachment` cannot fall back to
      //      sniffing the body and rendering it as HTML.
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

      // Task #318 — for PDF downloads, post-process the stored bytes through
      // the confidential watermark before streaming. Non-PDF downloads
      // (images, etc.) pass through unchanged. The watermark carries the
      // exact request instant + the canonical purpose label so a leaked
      // PDF is forensically attributable to the (client, download instant)
      // pair, not just to the upload event.
      const downloadedAtUtc = new Date();
      let payload: Buffer | null = null;
      let payloadLength = head.sizeBytes;
      if (storedMime === "application/pdf") {
        const original = await getObjectBytes(row.storageKey);
        const names = await resolveWatermarkNames(row.clientId, null);
        payload = await applyDocumentWatermark(original, {
          clientName: names.clientName,
          adviserName: names.adviserName,
          downloadedAtUtc,
          purpose: "client_document_download",
        });
        payloadLength = payload.length;
      }

      // Task #318 — emit the unified `document.download` audit row alongside
      // the legacy `client_document.download` event. The unified action lets
      // the regulator surface answer "who pulled what" with a single query
      // across reports + uploaded documents; the legacy action stays so the
      // existing audit dashboards keep working unchanged.
      audit(
        auth.userId,
        "client_document.download",
        "client_document",
        String(row.id),
        { actor: "client", sizeBytes: head.sizeBytes },
        req.ip ?? null,
      );
      audit(
        auth.userId,
        "document.download",
        "client_document",
        String(row.id),
        {
          actor: "client",
          clientUserId: auth.userId,
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
      const safeName = (row.fileName ?? "download.bin").replace(/[\r\n"]/g, "_");
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
        console.error("[client-routes] document stream error:", err);
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
  });

  // ---------------------------------------------------------------------------
  // GET /api/client/advice/:id
  // ---------------------------------------------------------------------------
  // Viewing-ack gate: the client must have signed an adviceAcknowledgements row
  // for THIS advice record before the route returns ANY part of the payload.
  // Until then the route returns 403 with a structured body so the UI can
  // render the disclaimer interstitial. This gate is re-evaluated against
  // live state on every request — a cached "I already acked" boolean from the
  // client cannot bypass it.
  // ---------------------------------------------------------------------------
  app.get("/api/client/advice/:id", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const adviceRecordId = parseInt(req.params.id, 10);
      if (!Number.isFinite(adviceRecordId)) {
        return res.status(400).json({ error: "Invalid advice record id" });
      }

      const gate = await requireAcknowledgedAdvice(adviceRecordId, auth.userId);
      if (!gate.allowed) {
        const status = gate.reason === "advice_record_not_found" ? 404 : 403;
        // When the gate fails because of a missing acknowledgement, return
        // the full `adviceAcknowledgements` shape contract so the client UI
        // knows exactly which fields to render in the disclaimer interstitial
        // (the eleven required confirm_* booleans + signatureName). Without
        // this shape the client can't safely build the form to retry.
        const requiredShape =
          gate.reason === "acknowledgement_missing"
            ? {
                table: "adviceAcknowledgements",
                requiredFields: [
                  "confirmPersonalDetails",
                  "confirmFinancialInfo",
                  "confirmObjectives",
                  "confirmRiskProfile",
                  "confirmScopeUnderstood",
                  "confirmSoaViewed",
                  "confirmFeesUnderstood",
                  "confirmFeesConsented",
                  "confirmValuesMayFall",
                  "confirmReturnsNotGuaranteed",
                  "confirmFsgReceived",
                ],
                signatureField: "signatureName",
                allRequiredTrue: true,
              }
            : null;
        return res.status(status).json({
          error: gate.detail,
          reason: gate.reason,
          adviceRecordId,
          adviceAcknowledgements: requiredShape,
        });
      }

      // Gate cleared — load and return the full advice record. We do NOT trust
      // the live row for audit reconstruction (that's adviceRecordVersions);
      // for a viewing payload the live row is the right source.
      const [row] = await db
        .select()
        .from(adviceRecords)
        .where(eq(adviceRecords.id, adviceRecordId))
        .limit(1);

      res.json({
        advice: row,
        acknowledgement: {
          id: gate.acknowledgementId,
          acknowledgedAt: gate.acknowledgedAt,
        },
      });
    } catch (error: any) {
      handleError(res, error, "Failed to load advice record");
    }
  });
}
