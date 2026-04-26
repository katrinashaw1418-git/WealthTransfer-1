// =============================================================================
// Task #96 — automated test for the advice-record write gate
// =============================================================================
// Locks in three contracts:
//
//   1. While adviceRecords.status='review_pending', requireAdviceRecordWritable
//      rejects with HTTP 423 + reason='record_locked_under_review'.
//   2. The same lock fires through the service layer that the adviser routes
//      call: createClientObjective throws the same shaped error, so the route
//      returns 423 to the adviser instead of silently appending to a record
//      a compliance reviewer is in the middle of reading.
//   3. Flipping status back to 'draft' (or leaving it on any non-review state)
//      restores writeability — the next createClientObjective call succeeds.
//
// adviser_notes are exempt by design (the reviewer needs to leave notes).
// We assert that exemption explicitly so a future refactor cannot silently
// turn the lock on for notes and break compliance reviews.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Auth module asserts JWT_SECRET at import time outside local-dev. The dev
// shell sets it but child workers spawned by vitest do not always inherit
// it, so hoist a deterministic value before any module loads.
vi.hoisted(() => {
  process.env.JWT_SECRET ||= "advice-write-gate-test-secret";
});

import { eq, inArray } from "drizzle-orm";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "../db";
import {
  users,
  adviserClients,
  adviceRecords,
  clientObjectives,
  adviserNotes,
} from "@shared/schema";
import {
  getAdviceRecordWritability,
  requireAdviceRecordWritable,
} from "./advice-write-gate";
import { createClientObjective, createAdviserNote } from "./wealth-planner";
import { registerAdviserRoutes } from "../adviser-routes";
import { signToken } from "../auth";

const ADVISER_USERNAME = "__advice_write_gate_adviser__";
const CLIENT_USERNAME = "__advice_write_gate_client__";

let adviserUserId: number;
let clientUserId: number;
let adviceRecordId: number;
const objectiveIdsToCleanup: number[] = [];
const noteIdsToCleanup: number[] = [];

async function ensureUser(
  username: string,
  email: string,
  role: "adviser" | "client",
): Promise<number> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.username, username));
  if (existing) {
    await db
      .update(users)
      .set({ email, role: role === "adviser" ? "adviser" : "client" })
      .where(eq(users.id, existing.id));
    return existing.id;
  }
  const [created] = await db
    .insert(users)
    .values({
      username,
      email,
      password: "not-a-real-password",
      firstName: "AdviceGate",
      lastName: "Test",
      role: role === "adviser" ? "adviser" : "client",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  return created.id;
}

async function ensureAdviserClientLink(): Promise<void> {
  const [existing] = await db
    .select()
    .from(adviserClients)
    .where(eq(adviserClients.adviserUserId, adviserUserId));
  if (existing) {
    await db
      .update(adviserClients)
      .set({ isActive: true, clientUserId })
      .where(eq(adviserClients.id, existing.id));
    return;
  }
  await db.insert(adviserClients).values({
    adviserUserId,
    clientUserId,
    isActive: true,
    relationshipType: "servicing",
  });
}

async function setAdviceStatus(status: string): Promise<void> {
  await db
    .update(adviceRecords)
    .set({ status })
    .where(eq(adviceRecords.id, adviceRecordId));
}

beforeAll(async () => {
  adviserUserId = await ensureUser(
    ADVISER_USERNAME,
    "advice-gate-adviser@test.invalid",
    "adviser",
  );
  clientUserId = await ensureUser(
    CLIENT_USERNAME,
    "advice-gate-client@test.invalid",
    "client",
  );
  await ensureAdviserClientLink();

  // Wipe any leftover advice record from a previous run so each test starts
  // from a known status='draft' baseline.
  const stale = await db
    .select({ id: adviceRecords.id })
    .from(adviceRecords)
    .where(eq(adviceRecords.clientId, clientUserId));
  if (stale.length) {
    const ids = stale.map((r) => r.id);
    await db.delete(clientObjectives).where(inArray(clientObjectives.adviceRecordId, ids));
    await db.delete(adviserNotes).where(inArray(adviserNotes.adviceRecordId, ids));
    await db.delete(adviceRecords).where(inArray(adviceRecords.id, ids));
  }

  const [advice] = await db
    .insert(adviceRecords)
    .values({
      clientId: clientUserId,
      adviserId: adviserUserId,
      adviceType: "personal",
      adviceSource: "adviser",
      status: "draft",
    })
    .returning();
  adviceRecordId = advice.id;
});

afterAll(async () => {
  if (objectiveIdsToCleanup.length) {
    await db
      .delete(clientObjectives)
      .where(inArray(clientObjectives.id, objectiveIdsToCleanup));
  }
  if (noteIdsToCleanup.length) {
    await db
      .delete(adviserNotes)
      .where(inArray(adviserNotes.id, noteIdsToCleanup));
  }
  if (adviceRecordId) {
    await db.delete(adviceRecords).where(eq(adviceRecords.id, adviceRecordId));
  }
  await db.delete(adviserClients).where(eq(adviserClients.adviserUserId, adviserUserId));
  // Test users are intentionally left in place (mirrors the pattern used by
  // insufficient-funds-sweep.test.ts and friends). They have many incidental
  // FK referrers — wallets, portfolio_snapshots, audit_logs — and the next
  // run reuses the same usernames idempotently via ensureUser().
});

describe("advice-write-gate", () => {
  it("returns writable=true while status='draft'", async () => {
    await setAdviceStatus("draft");
    const result = await getAdviceRecordWritability(adviceRecordId);
    expect(result.writable).toBe(true);
    if (result.writable) {
      expect(result.status).toBe("draft");
    }
  });

  it("rejects with HTTP 423 + reason='record_locked_under_review' when status='review_pending'", async () => {
    await setAdviceStatus("review_pending");

    const result = await getAdviceRecordWritability(adviceRecordId);
    expect(result.writable).toBe(false);
    if (!result.writable) {
      expect(result.reason).toBe("record_locked_under_review");
      expect(result.status).toBe("review_pending");
    }

    let thrown: any = null;
    try {
      await requireAdviceRecordWritable(adviceRecordId);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.status).toBe(423);
    expect(thrown.reason).toBe("record_locked_under_review");
  });

  it("blocks createClientObjective with the same 423 + reason while review_pending", async () => {
    await setAdviceStatus("review_pending");

    let thrown: any = null;
    try {
      await createClientObjective(adviserUserId, {
        clientId: clientUserId,
        adviceRecordId,
        objectiveType: "retirement",
        label: "Should be blocked while under review",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.status).toBe(423);
    expect(thrown.reason).toBe("record_locked_under_review");

    // Confirm no objective row was inserted as a side effect of the failed call.
    const rows = await db
      .select({ id: clientObjectives.id })
      .from(clientObjectives)
      .where(eq(clientObjectives.adviceRecordId, adviceRecordId));
    expect(rows.length).toBe(0);
  });

  it("allows createClientObjective once status returns to 'draft'", async () => {
    await setAdviceStatus("draft");

    const row = await createClientObjective(adviserUserId, {
      clientId: clientUserId,
      adviceRecordId,
      objectiveType: "retirement",
      label: "Now writeable again after review resolved",
    });
    objectiveIdsToCleanup.push(row.id);

    expect(row.adviceRecordId).toBe(adviceRecordId);
    expect(row.clientId).toBe(clientUserId);
  });

  it("leaves adviser-notes writeable while status='review_pending' (explicit exemption)", async () => {
    await setAdviceStatus("review_pending");

    const note = await createAdviserNote(adviserUserId, {
      clientUserId,
      adviceRecordId,
      body: "Reviewer note left while record is under compliance review",
    });
    noteIdsToCleanup.push(note.id);

    expect(note.adviceRecordId).toBe(adviceRecordId);
    expect(note.clientUserId).toBe(clientUserId);
  });
});

// ---------------------------------------------------------------------------
// HTTP-level proof: an authenticated adviser POST really does come back as
// 423 Locked + reason='record_locked_under_review' end-to-end. This boots a
// minimal in-process express server with the real adviser routes so the
// request travels through requireAuth → requireRole → service → handleError
// exactly as it would in production.
// ---------------------------------------------------------------------------
describe("advice-write-gate (HTTP route)", () => {
  let server: http.Server;
  let baseUrl: string;
  let token: string;
  const httpObjectiveIds: number[] = [];

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerAdviserRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    token = signToken({
      userId: adviserUserId,
      username: ADVISER_USERNAME,
      email: "advice-gate-adviser@test.invalid",
      role: "adviser",
    });
  });

  afterAll(async () => {
    if (httpObjectiveIds.length) {
      await db
        .delete(clientObjectives)
        .where(inArray(clientObjectives.id, httpObjectiveIds));
    }
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  async function postObjective(label: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}/api/adviser/client-objectives`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        clientId: clientUserId,
        adviceRecordId,
        objectiveType: "retirement",
        label,
      }),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  it("POST /api/adviser/client-objectives returns 423 + reason while status='review_pending'", async () => {
    await setAdviceStatus("review_pending");
    const { status, body } = await postObjective("HTTP-blocked while under review");
    expect(status).toBe(423);
    expect(body.reason).toBe("record_locked_under_review");
    expect(typeof body.error).toBe("string");
  });

  it("POST /api/adviser/client-objectives succeeds (200) once status returns to 'draft'", async () => {
    await setAdviceStatus("draft");
    const { status, body } = await postObjective("HTTP-allowed after review resolved");
    expect(status).toBe(200);
    expect(body.adviceRecordId).toBe(adviceRecordId);
    expect(body.clientId).toBe(clientUserId);
    if (typeof body.id === "number") httpObjectiveIds.push(body.id);
  });
});
