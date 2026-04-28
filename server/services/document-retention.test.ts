// =============================================================================
// Task #318 — Retention lock evaluation + delete-route 423 contract
// =============================================================================
// Two layers of coverage:
//
//   1. Pure unit tests for `evaluateRetentionLock` — the four matrix corners
//      (locked + retained, locked alone, retained alone, neither). Owns the
//      contract independently of HTTP plumbing.
//
//   2. End-to-end test that drives the real adviser DELETE route via
//      supertest, confirms the 423 status code + structured body
//      (`reason`, `extra.deletionLocked`, `extra.retentionUntil`,
//      `extra.policy`), AND confirms a `document.delete.blocked` audit
//      row was written. This exercise mirrors the production path: real
//      DB rows, real route handler, real `evaluateRetentionLock`,
//      real audit-log insert.
//
// The integration leg uses the same vitest pattern as the other route-level
// tests in this folder: bootstrap the test env, spin up an Express app,
// register the adviser routes, and stub `requireAuth`/`requireRole` via a
// minimal Authorization header parser. We do NOT exercise the JWT path —
// that's covered by the auth tests — we exercise the lock contract.
// =============================================================================

import "../../scripts/_bootstrap-test-env";
import { describe, expect, it, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import { sql, eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import {
  users,
  adviserClients,
  clientDocuments,
  auditLogs,
} from "@shared/schema";
import { evaluateRetentionLock } from "./document-retention";
import { registerAdviserRoutes } from "../adviser-routes";
import { signToken } from "../auth";

describe("evaluateRetentionLock (Task #318)", () => {
  it("locks when deletionLocked=true regardless of retentionUntil", () => {
    const past = new Date(Date.now() - 86_400_000);
    const out = evaluateRetentionLock({
      retentionUntil: past,
      deletionLocked: true,
    });
    expect(out.locked).toBe(true);
    expect(out.reason).toBe("deletion_locked");
    expect(out.deletionLocked).toBe(true);
    expect(out.retentionUntil).toBe(past.toISOString());
  });

  it("locks when retentionUntil is in the future even if deletionLocked=false", () => {
    const future = new Date(Date.now() + 7 * 86_400_000);
    const out = evaluateRetentionLock({
      retentionUntil: future,
      deletionLocked: false,
    });
    expect(out.locked).toBe(true);
    expect(out.reason).toBe("retention_window_active");
    expect(out.deletionLocked).toBe(false);
    expect(out.retentionUntil).toBe(future.toISOString());
  });

  it("unlocks when deletionLocked=false and retentionUntil is past", () => {
    const past = new Date(Date.now() - 86_400_000);
    const out = evaluateRetentionLock({
      retentionUntil: past,
      deletionLocked: false,
    });
    expect(out.locked).toBe(false);
    expect(out.reason).toBeUndefined();
  });

  it("unlocks when retentionUntil is null and deletionLocked=false", () => {
    const out = evaluateRetentionLock({
      retentionUntil: null,
      deletionLocked: false,
    });
    expect(out.locked).toBe(false);
    expect(out.retentionUntil).toBeNull();
  });

  it("respects an injected `now` (lets the route freeze time deterministically)", () => {
    // retentionUntil is in the future relative to wall-clock but the caller
    // passes a `now` that's even further ahead — the helper must use the
    // injected clock, not the system clock.
    const retention = new Date(Date.now() + 60_000);
    const futureNow = new Date(Date.now() + 120_000);
    const out = evaluateRetentionLock(
      { retentionUntil: retention, deletionLocked: false },
      futureNow,
    );
    expect(out.locked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end DELETE /api/adviser/client-documents/:id contract
// ---------------------------------------------------------------------------
describe("DELETE /api/adviser/client-documents/:id (Task #318)", () => {
  let app: express.Express;
  let adviserId: number;
  let clientId: number;
  let lockedDocId: number;
  let adviserToken: string;

  beforeAll(async () => {
    // Build the smallest possible app that registers the adviser routes.
    // We don't mount global error middleware; the route's own try/catch
    // wrapper produces the JSON response.
    app = express();
    app.use(express.json());
    // requireAuth() reads the JWT from Authorization: Bearer <token> OR a
    // cookie. Supertest is happy with either; we'll send a header.
    registerAdviserRoutes(app);

    // ---- Seed: adviser, client, link, locked document -------------------
    // Use a deterministic per-run suffix so concurrent CI runs do not
    // collide on the unique username/email indexes.
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const [adviser] = await db
      .insert(users)
      .values({
        username: `t318-adv-${stamp}`,
        email: `t318-adv-${stamp}@example.test`,
        password: "x",
        firstName: "Test",
        lastName: "Adviser",
        role: "adviser",
        kycStatus: "verified",
      })
      .returning();
    const [client] = await db
      .insert(users)
      .values({
        username: `t318-cli-${stamp}`,
        email: `t318-cli-${stamp}@example.test`,
        password: "x",
        firstName: "Test",
        lastName: "Client",
        role: "user",
        kycStatus: "verified",
      })
      .returning();
    adviserId = adviser.id;
    clientId = client.id;

    await db.insert(adviserClients).values({
      adviserUserId: adviserId,
      clientUserId: clientId,
      isActive: true,
    });

    const [doc] = await db
      .insert(clientDocuments)
      .values({
        clientId,
        documentType: "fact_find",
        fileName: "test-locked.pdf",
        storageKey: `client-documents/${clientId}/test-locked.pdf`,
        mimeType: "application/pdf",
        fileSizeBytes: 1024,
        uploadedByUserId: adviserId,
        // Force lock on. The schema default is `true` already, but being
        // explicit here makes the test self-documenting.
        deletionLocked: true,
        // retention_until further in the future so we know which leg
        // would have fired if deletion_locked weren't set.
        retentionUntil: new Date(Date.now() + 365 * 86_400_000),
      })
      .returning();
    lockedDocId = doc.id;

    // Sign a JWT for the seeded adviser; the route stack reads it.
    adviserToken = signToken({
      userId: adviserId,
      username: adviser.username,
      email: adviser.email,
      role: "adviser",
    });
  });

  it("returns 423 with structured body when the document is lock-flagged", async () => {
    const res = await request(app)
      .delete(`/api/adviser/client-documents/${lockedDocId}`)
      .set("Authorization", `Bearer ${adviserToken}`);

    expect(res.status).toBe(423);
    expect(res.body.reason).toBe("deletion_locked");
    expect(res.body.extra).toBeDefined();
    expect(res.body.extra.documentId).toBe(lockedDocId);
    expect(res.body.extra.deletionLocked).toBe(true);
    expect(typeof res.body.extra.retentionUntil).toBe("string");
    expect(res.body.extra.policy).toMatch(/Corporations Act s912G/);
  });

  it("writes a `document.delete.blocked` audit row on every blocked attempt", async () => {
    // The previous test already produced one audit row; we make a fresh
    // attempt and assert the row exists with the expected metadata shape.
    await request(app)
      .delete(`/api/adviser/client-documents/${lockedDocId}`)
      .set("Authorization", `Bearer ${adviserToken}`);

    const rows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.userId, adviserId),
          eq(auditLogs.action, "document.delete.blocked"),
          eq(auditLogs.entityType, "client_document"),
          eq(auditLogs.entityId, String(lockedDocId)),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);

    expect(rows.length).toBe(1);
    const meta = rows[0].metadata as Record<string, unknown>;
    expect(meta.documentId).toBe(lockedDocId);
    expect(meta.clientUserId).toBe(clientId);
    expect(meta.reason).toBe("deletion_locked");
    expect(meta.deletionLocked).toBe(true);
    expect(typeof meta.retentionUntil).toBe("string");
  });

  it("returns 404 (not 423) for a non-existent document id", async () => {
    const res = await request(app)
      .delete("/api/adviser/client-documents/99999999")
      .set("Authorization", `Bearer ${adviserToken}`);
    expect(res.status).toBe(404);
  });
});
