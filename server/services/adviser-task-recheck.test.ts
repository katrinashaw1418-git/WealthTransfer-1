// =============================================================================
// Task #368 — adviser-task triggers, recheck pipeline, and dismissal-honour.
// -----------------------------------------------------------------------------
// Four behaviours under test (per the Task #368 spec):
//
//   1. Only the three trigger types are accepted by the route+service writes.
//   2. An unrelated/legacy trigger condition does NOT produce a task.
//   3. An open task whose underlying condition has resolved is auto-closed
//      with autoCloseReason='resolved automatically' and is excluded from
//      the listAdviserTasks() response.
//   4. A task the adviser explicitly dismissed is NOT recreated by the
//      automation while its triggerKey suppression is in effect; once the
//      condition resolves and then flips back to unresolved, a fresh task
//      DOES appear.
//
// Each test owns its own (adviser, client) fixture row using a unique email
// so it can run in parallel against the dev DB without interfering with
// other tests. Cleanup runs in afterAll regardless of pass/fail.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db";
import {
  users,
  adviserClients,
  adviserTasks,
  feeConsents,
  ADVISER_TASK_ALLOWED_TYPES,
  buildAdviserTaskTriggerKey,
  assertAllowedAdviserTaskType,
} from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { runAdviserTaskAutomation } from "./adviser-task-automation";
import {
  listAdviserTasks,
  createAdviserTask,
  updateAdviserTask,
} from "./adviser-access";
import { recheckAdviserTasks } from "./adviser-task-recheck";

// -----------------------------------------------------------------------------
// Per-suite fixture seeding helper. Each `seedFixture` call returns a new
// (adviser, client) pair and registers cleanup so the suite-level afterAll
// can drop everything in one go.
// -----------------------------------------------------------------------------
const fixtureEmails: string[] = [];

async function seedFixture(label: string, opts: { kycStatus?: string } = {}) {
  const adviserEmail = `task368-${label}-adviser-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}@example.invalid`;
  const clientEmail = `task368-${label}-client-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}@example.invalid`;
  fixtureEmails.push(adviserEmail, clientEmail);

  const [adviser] = await db
    .insert(users)
    .values({
      username: adviserEmail,
      email: adviserEmail,
      password: "x",
      firstName: "T368",
      lastName: "Adviser",
      role: "adviser",
      kycStatus: "verified",
    })
    .returning({ id: users.id });

  const [client] = await db
    .insert(users)
    .values({
      username: clientEmail,
      email: clientEmail,
      password: "x",
      firstName: "T368",
      lastName: "Client",
      role: "client",
      kycStatus: opts.kycStatus ?? "pending",
    })
    .returning({ id: users.id });

  await db.insert(adviserClients).values({
    adviserUserId: adviser.id,
    clientUserId: client.id,
    relationshipType: "servicing",
    isActive: true,
  });

  return { adviserId: adviser.id, clientId: client.id };
}

afterAll(async () => {
  if (fixtureEmails.length === 0) return;
  // Dependent rows first.
  const userRows = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, fixtureEmails));
  const ids = userRows.map((u) => u.id);
  if (ids.length > 0) {
    await db
      .delete(adviserTasks)
      .where(inArray(adviserTasks.adviserUserId, ids));
    await db
      .delete(adviserClients)
      .where(inArray(adviserClients.adviserUserId, ids));
    await db.delete(feeConsents).where(inArray(feeConsents.clientId, ids));
  }
  await db.delete(users).where(inArray(users.email, fixtureEmails));
});

// =============================================================================
// 1. Allow-list — only the three trigger types are accepted.
// =============================================================================
describe("Task #368: only three trigger types are allowed", () => {
  it("exports exactly the three trigger types", () => {
    expect(ADVISER_TASK_ALLOWED_TYPES).toEqual([
      "kyc_followup",
      "fee_consent_renewal",
      "portfolio_review",
    ]);
  });

  it("assertAllowedAdviserTaskType throws for legacy / unknown types", () => {
    for (const t of ["document_request", "meeting_prep", "other", "random"]) {
      expect(() => assertAllowedAdviserTaskType(t)).toThrowError(
        /must be one of/,
      );
    }
    for (const t of ADVISER_TASK_ALLOWED_TYPES) {
      expect(() => assertAllowedAdviserTaskType(t)).not.toThrow();
    }
  });

  it("createAdviserTask rejects non-allow-list task types at the service layer", async () => {
    const { adviserId, clientId } = await seedFixture("allowlist", {
      kycStatus: "verified",
    });
    await expect(
      createAdviserTask(adviserId, {
        clientUserId: clientId,
        // bypass the route enum to prove the service guard is the source
        // of truth, not the route's z.enum.
        taskType: "document_request" as any,
        title: "should not insert",
        notes: null,
        priority: "normal",
        status: "open",
        dueAt: null,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/must be one of/),
    });

    // Side-effect check: nothing was inserted.
    const rows = await db
      .select({ id: adviserTasks.id })
      .from(adviserTasks)
      .where(eq(adviserTasks.adviserUserId, adviserId));
    expect(rows.length).toBe(0);
  });
});

// =============================================================================
// 2. Irrelevant trigger ignored — the automation does not create tasks for
//    conditions outside its three triggers (here, a verified-KYC client
//    with no expiring consent and a recent review yields zero tasks).
// =============================================================================
describe("Task #368: irrelevant trigger condition is ignored", () => {
  it("does not create any task when none of the three triggers fire", async () => {
    const { adviserId, clientId } = await seedFixture("irrelevant", {
      kycStatus: "verified",
    });

    // Pre-seed a recent COMPLETED portfolio_review so the 90-day cadence
    // gate suppresses the portfolio_review trigger as well. With no
    // expiring fee consent and no unverified KYC, this client is fully
    // up-to-date and the automation should make no inserts at all.
    const recent = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await db.insert(adviserTasks).values({
      adviserUserId: adviserId,
      clientUserId: clientId,
      taskType: "portfolio_review",
      triggerKey: buildAdviserTaskTriggerKey({
        taskType: "portfolio_review",
        adviserUserId: adviserId,
        clientUserId: clientId,
      }),
      title: "Recent review",
      notes: null,
      priority: "normal",
      status: "done",
      completedAt: recent,
    });

    await runAdviserTaskAutomation();

    const open = await db
      .select({
        id: adviserTasks.id,
        taskType: adviserTasks.taskType,
        status: adviserTasks.status,
      })
      .from(adviserTasks)
      .where(
        and(
          eq(adviserTasks.adviserUserId, adviserId),
          eq(adviserTasks.clientUserId, clientId),
          inArray(adviserTasks.status, ["open", "in_progress"]),
        ),
      );
    expect(open).toEqual([]);
  });
});

// =============================================================================
// 3. Stale auto-close — an open kyc_followup whose client became verified
//    after the task was created is silently auto-closed and excluded from
//    the listAdviserTasks() response.
// =============================================================================
describe("Task #368: stale open task is auto-closed and hidden from the list", () => {
  it("auto-closes an open kyc_followup whose client is now verified", async () => {
    const { adviserId, clientId } = await seedFixture("stale", {
      kycStatus: "pending",
    });

    // 1. Run automation against a pending-KYC client — this MUST create
    //    an open kyc_followup task.
    await runAdviserTaskAutomation();
    const beforeOpen = await db
      .select({
        id: adviserTasks.id,
        status: adviserTasks.status,
        autoCloseReason: adviserTasks.autoCloseReason,
      })
      .from(adviserTasks)
      .where(
        and(
          eq(adviserTasks.adviserUserId, adviserId),
          eq(adviserTasks.clientUserId, clientId),
          eq(adviserTasks.taskType, "kyc_followup"),
        ),
      );
    expect(beforeOpen.length).toBe(1);
    expect(beforeOpen[0].status).toBe("open");
    expect(beforeOpen[0].autoCloseReason).toBeNull();

    // 2. Resolve the underlying condition.
    await db
      .update(users)
      .set({ kycStatus: "verified" })
      .where(eq(users.id, clientId));

    // 3. Run the recheck (or hit listAdviserTasks which calls it). The row
    //    must be auto-closed AND excluded from the response.
    const visible = await listAdviserTasks(adviserId);
    expect(visible.find((t) => t.taskType === "kyc_followup")).toBeUndefined();

    const afterClose = await db
      .select({
        id: adviserTasks.id,
        status: adviserTasks.status,
        autoCloseReason: adviserTasks.autoCloseReason,
        dismissedByAdviser: adviserTasks.dismissedByAdviser,
        completedAt: adviserTasks.completedAt,
      })
      .from(adviserTasks)
      .where(
        and(
          eq(adviserTasks.adviserUserId, adviserId),
          eq(adviserTasks.clientUserId, clientId),
          eq(adviserTasks.taskType, "kyc_followup"),
        ),
      );
    expect(afterClose.length).toBe(1);
    expect(afterClose[0].status).toBe("done");
    expect(afterClose[0].autoCloseReason).toBe("resolved automatically");
    expect(afterClose[0].dismissedByAdviser).toBe(false);
    expect(afterClose[0].completedAt).toBeInstanceOf(Date);
  });
});

// =============================================================================
// 4. Dismissal honoured — once the adviser closes a task, the next
//    automation run must not recreate a duplicate. Once the underlying
//    condition resolves and then flips back, a NEW task DOES appear.
// =============================================================================
describe("Task #368: adviser dismissal suppresses recreation until condition flips", () => {
  it("does not recreate a dismissed task while the condition is still unresolved", async () => {
    const { adviserId, clientId } = await seedFixture("dismiss", {
      kycStatus: "pending",
    });

    // 1. Initial automation pass creates the kyc_followup.
    await runAdviserTaskAutomation();
    const [initial] = await db
      .select({ id: adviserTasks.id, triggerKey: adviserTasks.triggerKey })
      .from(adviserTasks)
      .where(
        and(
          eq(adviserTasks.adviserUserId, adviserId),
          eq(adviserTasks.clientUserId, clientId),
          eq(adviserTasks.taskType, "kyc_followup"),
        ),
      );
    expect(initial).toBeDefined();
    expect(initial.triggerKey).toBe(`kyc:${clientId}`);

    // 2. Adviser closes the task — must mark dismissedByAdviser=true.
    //    KYC is still pending, so close requires a completionNotes note.
    const closed = await updateAdviserTask(adviserId, initial.id, {
      status: "done",
      completionNotes: "Discussed with client — they will resubmit later.",
    });
    expect(closed?.dismissedByAdviser).toBe(true);
    expect(closed?.autoCloseReason).toBeNull();

    // 3. Re-run automation while KYC is STILL pending. The dismissed-not-
    //    consumed row must suppress recreation.
    await runAdviserTaskAutomation();
    const afterDismissal = await db
      .select({
        id: adviserTasks.id,
        status: adviserTasks.status,
        dismissedByAdviser: adviserTasks.dismissedByAdviser,
        autoCloseReason: adviserTasks.autoCloseReason,
      })
      .from(adviserTasks)
      .where(
        and(
          eq(adviserTasks.adviserUserId, adviserId),
          eq(adviserTasks.clientUserId, clientId),
          eq(adviserTasks.taskType, "kyc_followup"),
        ),
      );
    expect(afterDismissal.length).toBe(1); // no duplicate created
    expect(afterDismissal[0].id).toBe(initial.id);
    expect(afterDismissal[0].status).toBe("done");
    expect(afterDismissal[0].dismissedByAdviser).toBe(true);
    expect(afterDismissal[0].autoCloseReason).toBeNull();

    // 4. Resolve the underlying condition (KYC verified). The recheck
    //    should "consume" the dismissed row by stamping autoCloseReason
    //    WITHOUT changing status / completedAt / dismissedByAdviser.
    await db
      .update(users)
      .set({ kycStatus: "verified" })
      .where(eq(users.id, clientId));
    await recheckAdviserTasks(adviserId);

    const consumed = await db
      .select({
        id: adviserTasks.id,
        status: adviserTasks.status,
        dismissedByAdviser: adviserTasks.dismissedByAdviser,
        autoCloseReason: adviserTasks.autoCloseReason,
      })
      .from(adviserTasks)
      .where(eq(adviserTasks.id, initial.id));
    expect(consumed[0].status).toBe("done");
    expect(consumed[0].dismissedByAdviser).toBe(true);
    expect(consumed[0].autoCloseReason).toBe("resolved automatically");

    // 5. Flip the condition back (KYC reverts to pending) and re-run the
    //    automation. The previous suppression has been consumed, so a
    //    FRESH task with the same triggerKey must now be created.
    await db
      .update(users)
      .set({ kycStatus: "pending" })
      .where(eq(users.id, clientId));
    await runAdviserTaskAutomation();

    const final = await db
      .select({
        id: adviserTasks.id,
        status: adviserTasks.status,
        triggerKey: adviserTasks.triggerKey,
      })
      .from(adviserTasks)
      .where(
        and(
          eq(adviserTasks.adviserUserId, adviserId),
          eq(adviserTasks.clientUserId, clientId),
          eq(adviserTasks.taskType, "kyc_followup"),
        ),
      );
    expect(final.length).toBe(2);
    const fresh = final.find((r) => r.id !== initial.id);
    expect(fresh).toBeDefined();
    expect(fresh!.status).toBe("open");
    expect(fresh!.triggerKey).toBe(`kyc:${clientId}`);
  });
});
