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
import { db } from "./db";
import { auditLogs } from "@shared/schema";
import { requireAuth } from "./auth";
import {
  listClientPendingInstructions,
  consentClientInstruction,
  rejectClientInstruction,
} from "./services/adviser-access";

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
}
