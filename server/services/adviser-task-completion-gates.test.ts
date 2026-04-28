// Task #313 — automated coverage for the Task #285 completion gates in
// updateAdviserTask. The service-layer rules being asserted here:
//
//   * kyc_followup: closing requires a non-empty completionNotes entry
//     UNLESS the linked client's kycStatus is "verified".
//   * portfolio_review: closing always requires non-empty completionNotes
//     AND a future nextReviewAt date.
//
// These were previously covered only by code review and manual UI testing.
// This file drives updateAdviserTask directly against the dev database so
// the contract holds for any caller (route, cron, future RPC, etc.).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { adviserClients, adviserTasks, users } from "@shared/schema";
import { updateAdviserTask } from "./adviser-access";

const ADVISER_EMAIL = "task313-gates-adviser@example.invalid";
const PENDING_CLIENT_EMAIL = "task313-gates-pending-client@example.invalid";
const VERIFIED_CLIENT_EMAIL = "task313-gates-verified-client@example.invalid";
const FIXTURE_EMAILS = [
  ADVISER_EMAIL,
  PENDING_CLIENT_EMAIL,
  VERIFIED_CLIENT_EMAIL,
];

let adviserId = 0;
let pendingClientId = 0;
let verifiedClientId = 0;

async function deleteFixtureUsers(): Promise<void> {
  const fixtureUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, FIXTURE_EMAILS));
  const ids = fixtureUsers.map((u) => u.id);
  if (ids.length > 0) {
    await db
      .delete(adviserTasks)
      .where(inArray(adviserTasks.adviserUserId, ids));
    await db
      .delete(adviserClients)
      .where(inArray(adviserClients.adviserUserId, ids));
  }
  await db.delete(users).where(inArray(users.email, FIXTURE_EMAILS));
}

async function insertTask(input: {
  clientUserId: number;
  taskType: "kyc_followup" | "portfolio_review";
  title: string;
  nextReviewAt?: Date | null;
  completionNotes?: string | null;
}): Promise<number> {
  const [row] = await db
    .insert(adviserTasks)
    .values({
      adviserUserId: adviserId,
      clientUserId: input.clientUserId,
      taskType: input.taskType,
      title: input.title,
      status: "open",
      priority: "normal",
      nextReviewAt: input.nextReviewAt ?? null,
      completionNotes: input.completionNotes ?? null,
    })
    .returning({ id: adviserTasks.id });
  return row.id;
}

describe("updateAdviserTask — Task #285 completion gates", () => {
  beforeAll(async () => {
    await deleteFixtureUsers();

    const [adviser] = await db
      .insert(users)
      .values({
        username: "task313-gates-adviser",
        email: ADVISER_EMAIL,
        password: "x",
        firstName: "Adviser",
        lastName: "Fixture",
        role: "adviser",
        kycStatus: "verified",
      })
      .returning({ id: users.id });
    const [pendingClient] = await db
      .insert(users)
      .values({
        username: "task313-gates-pending-client",
        email: PENDING_CLIENT_EMAIL,
        password: "x",
        firstName: "Pending",
        lastName: "Client",
        role: "client",
        kycStatus: "pending",
      })
      .returning({ id: users.id });
    const [verifiedClient] = await db
      .insert(users)
      .values({
        username: "task313-gates-verified-client",
        email: VERIFIED_CLIENT_EMAIL,
        password: "x",
        firstName: "Verified",
        lastName: "Client",
        role: "client",
        kycStatus: "verified",
      })
      .returning({ id: users.id });

    adviserId = adviser.id;
    pendingClientId = pendingClient.id;
    verifiedClientId = verifiedClient.id;

    await db.insert(adviserClients).values([
      {
        adviserUserId: adviserId,
        clientUserId: pendingClientId,
        relationshipType: "servicing",
        isActive: true,
      },
      {
        adviserUserId: adviserId,
        clientUserId: verifiedClientId,
        relationshipType: "servicing",
        isActive: true,
      },
    ]);
  });

  afterAll(deleteFixtureUsers);

  // ---------------------------------------------------------------------------
  // kyc_followup
  // ---------------------------------------------------------------------------

  it("rejects closing a kyc_followup with no completion notes when client KYC is not verified", async () => {
    const taskId = await insertTask({
      clientUserId: pendingClientId,
      taskType: "kyc_followup",
      title: "Follow up KYC for pending client",
    });

    await expect(
      updateAdviserTask(adviserId, taskId, { status: "done" }),
    ).rejects.toMatchObject({
      status: 400,
      reason: "kyc_completion_note_required",
    });

    // Status must remain open when the gate trips.
    const [row] = await db
      .select({ status: adviserTasks.status })
      .from(adviserTasks)
      .where(eq(adviserTasks.id, taskId));
    expect(row.status).toBe("open");
  });

  it("rejects closing a kyc_followup when notes are whitespace only and client KYC is not verified", async () => {
    const taskId = await insertTask({
      clientUserId: pendingClientId,
      taskType: "kyc_followup",
      title: "Follow up KYC for pending client (whitespace)",
    });

    await expect(
      updateAdviserTask(adviserId, taskId, {
        status: "done",
        completionNotes: "    ",
      }),
    ).rejects.toMatchObject({
      status: 400,
      reason: "kyc_completion_note_required",
    });
  });

  it("closes a kyc_followup when completion notes are supplied (pending KYC client)", async () => {
    const taskId = await insertTask({
      clientUserId: pendingClientId,
      taskType: "kyc_followup",
      title: "Follow up KYC for pending client (with notes)",
    });

    const result = await updateAdviserTask(adviserId, taskId, {
      status: "done",
      completionNotes: "  Emailed client; awaiting passport upload.  ",
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("done");
    // Trimmed before persisting.
    expect(result!.completionNotes).toBe(
      "Emailed client; awaiting passport upload.",
    );
    expect(result!.completedAt).toBeInstanceOf(Date);
  });

  it("closes a kyc_followup with NO completion notes when the client is KYC-verified", async () => {
    const taskId = await insertTask({
      clientUserId: verifiedClientId,
      taskType: "kyc_followup",
      title: "Follow up KYC for verified client",
    });

    const result = await updateAdviserTask(adviserId, taskId, {
      status: "done",
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("done");
    expect(result!.completionNotes).toBeNull();
    expect(result!.completedAt).toBeInstanceOf(Date);
  });

  // ---------------------------------------------------------------------------
  // portfolio_review
  // ---------------------------------------------------------------------------

  it("rejects closing a portfolio_review with no completion notes", async () => {
    const future = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const taskId = await insertTask({
      clientUserId: verifiedClientId,
      taskType: "portfolio_review",
      title: "Quarterly review (no notes)",
      nextReviewAt: future,
    });

    await expect(
      updateAdviserTask(adviserId, taskId, { status: "done" }),
    ).rejects.toMatchObject({
      status: 400,
      reason: "portfolio_review_notes_required",
    });

    const [row] = await db
      .select({ status: adviserTasks.status })
      .from(adviserTasks)
      .where(eq(adviserTasks.id, taskId));
    expect(row.status).toBe("open");
  });

  it("rejects closing a portfolio_review when notes are whitespace only", async () => {
    const future = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const taskId = await insertTask({
      clientUserId: verifiedClientId,
      taskType: "portfolio_review",
      title: "Quarterly review (whitespace notes)",
      nextReviewAt: future,
    });

    await expect(
      updateAdviserTask(adviserId, taskId, {
        status: "done",
        completionNotes: "   \t  ",
      }),
    ).rejects.toMatchObject({
      status: 400,
      reason: "portfolio_review_notes_required",
    });
  });

  it("rejects closing a portfolio_review when nextReviewAt is in the past", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const taskId = await insertTask({
      clientUserId: verifiedClientId,
      taskType: "portfolio_review",
      title: "Quarterly review (past next-review)",
      nextReviewAt: past,
    });

    await expect(
      updateAdviserTask(adviserId, taskId, {
        status: "done",
        completionNotes: "Review complete; rebalanced to target weights.",
      }),
    ).rejects.toMatchObject({
      status: 400,
      reason: "portfolio_review_next_date_required",
    });
  });

  it("rejects closing a portfolio_review when nextReviewAt is missing entirely", async () => {
    const taskId = await insertTask({
      clientUserId: verifiedClientId,
      taskType: "portfolio_review",
      title: "Quarterly review (no next-review)",
      nextReviewAt: null,
    });

    await expect(
      updateAdviserTask(adviserId, taskId, {
        status: "done",
        completionNotes: "Review complete; no rebalance required.",
      }),
    ).rejects.toMatchObject({
      status: 400,
      reason: "portfolio_review_next_date_required",
    });
  });

  it("closes a portfolio_review when notes AND a future nextReviewAt are supplied", async () => {
    const taskId = await insertTask({
      clientUserId: verifiedClientId,
      taskType: "portfolio_review",
      title: "Quarterly review (happy path)",
    });

    const future = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const result = await updateAdviserTask(adviserId, taskId, {
      status: "done",
      completionNotes: "Reviewed allocations; on track.",
      nextReviewAt: future,
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("done");
    expect(result!.completionNotes).toBe("Reviewed allocations; on track.");
    expect(result!.nextReviewAt?.getTime()).toBe(future.getTime());
    expect(result!.completedAt).toBeInstanceOf(Date);
  });
});
