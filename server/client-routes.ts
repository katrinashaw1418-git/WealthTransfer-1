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
import { eq, and, desc, sql } from "drizzle-orm";
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
  requireAcknowledgedAdvice,
} from "./services/wealth-planner";
import { adviceRecords } from "@shared/schema";

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
      res.json(rows);
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
        // Two audit rows so each artefact (request + executed consent) has its
        // own searchable trail.
        await tx.insert(auditLogs).values([
          {
            userId: auth.userId,
            action: "fee_consent_signed",
            entityType: "fee_consent_request",
            entityId: String(id),
            metadata: {
              feeConsentId: executed.id,
              adviserUserId: request.adviserUserId,
              signatureName: parsed.data.signatureName,
            } as any,
            ipAddress: (req as Request).ip || null,
          },
          {
            userId: auth.userId,
            action: "fee_consent_created",
            entityType: "fee_consent",
            entityId: String(executed.id),
            metadata: {
              feeConsentRequestId: id,
              adviserUserId: request.adviserUserId,
              feeType: executed.feeType,
              amount: executed.amount,
            } as any,
            ipAddress: (req as Request).ip || null,
          },
        ]);
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
        await tx.insert(auditLogs).values({
          userId: auth.userId,
          action: "fee_consent_declined",
          entityType: "fee_consent_request",
          entityId: String(id),
          metadata: {
            adviserUserId: request.adviserUserId,
            reason: parsed.data.reason ?? null,
          } as any,
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
  app.get("/api/client/fee-consents", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const rows = await db
        .select()
        .from(feeConsents)
        .where(eq(feeConsents.clientId, auth.userId))
        .orderBy(desc(feeConsents.consentedAt));
      res.json(rows);
    } catch (error: any) {
      handleError(res, error, "Failed to list fee consents");
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
        db
          .select()
          .from(adviserFeeRules)
          .where(eq(adviserFeeRules.clientUserId, auth.userId))
          .orderBy(desc(adviserFeeRules.createdAt)),
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

      res.json({
        rules,
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
  //   approvedByUserId, idempotencyKey, failureReason, rejectedReason).
  // ===========================================================================
  app.get("/api/client/fee-deductions", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const rows = await db
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
          createdAt: adviserFeeDeductions.createdAt,
        })
        .from(adviserFeeDeductions)
        .where(eq(adviserFeeDeductions.clientUserId, auth.userId))
        .orderBy(desc(adviserFeeDeductions.createdAt));

      const usersMap = await getUserNameMap(rows.map((r) => r.adviserUserId));
      res.json({ items: rows, users: usersMap });
    } catch (error: any) {
      handleError(res, error, "Failed to load client fee deductions");
    }
  });

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
