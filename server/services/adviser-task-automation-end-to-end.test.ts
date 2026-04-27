// =============================================================================
// Task #283 — adviser task generator end-to-end test
// -----------------------------------------------------------------------------
// Drives `runAdviserTaskAutomation()` against the real dev DB to confirm
// that when a linked client has blank firstName/lastName but a usable
// email, the generated KYC task title and notes contain the EMAIL
// (not "Client #<id>"). The helper-only label test pins the pure
// function; this test pins the actual title written into adviser_tasks.
//
// Fixture lifecycle:
//   - beforeAll inserts: one adviser, one blank-name client, an active
//     adviser_clients link, and ensures no leftover adviser_tasks rows
//     exist for the pair.
//   - afterAll deletes adviser_tasks, the link, and both users so the
//     dev DB is restored regardless of test outcome.
// =============================================================================
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db";
import { users, adviserClients, adviserTasks } from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { runAdviserTaskAutomation } from "./adviser-task-automation";

const ADVISER_EMAIL = "task283-e2e-adviser@example.invalid";
const CLIENT_EMAIL = "task283-e2e-blank-name@example.invalid";
const FIXTURE_EMAILS = [ADVISER_EMAIL, CLIENT_EMAIL];

let adviserId = 0;
let clientId = 0;

async function cleanup() {
  if (adviserId && clientId) {
    await db
      .delete(adviserTasks)
      .where(
        and(
          eq(adviserTasks.adviserUserId, adviserId),
          eq(adviserTasks.clientUserId, clientId),
        ),
      );
    await db
      .delete(adviserClients)
      .where(
        and(
          eq(adviserClients.adviserUserId, adviserId),
          eq(adviserClients.clientUserId, clientId),
        ),
      );
  }
  await db.delete(users).where(inArray(users.email, FIXTURE_EMAILS));
}

describe("runAdviserTaskAutomation — KYC task label end-to-end", () => {
  beforeAll(async () => {
    // Cold-start cleanup in case a prior failed run left residue.
    await db.delete(users).where(inArray(users.email, FIXTURE_EMAILS));

    const [adviser] = await db
      .insert(users)
      .values({
        username: "task283-e2e-adviser",
        email: ADVISER_EMAIL,
        password: "x",
        firstName: "Adviser",
        lastName: "Fixture",
        role: "adviser",
        kycStatus: "verified",
      })
      .returning({ id: users.id });
    const [client] = await db
      .insert(users)
      .values({
        username: "task283-e2e-blank-name",
        email: CLIENT_EMAIL,
        password: "x",
        // Blank name on purpose — this is the regression case the task
        // automation must handle gracefully.
        firstName: "",
        lastName: "",
        role: "client",
        // kycStatus != verified so the KYC follow-up trigger fires.
        kycStatus: "pending",
      })
      .returning({ id: users.id });

    adviserId = adviser.id;
    clientId = client.id;

    await db.insert(adviserClients).values({
      adviserUserId: adviserId,
      clientUserId: clientId,
      relationshipType: "servicing",
      isActive: true,
    });
  });

  afterAll(async () => {
    await cleanup();
  });

  it("writes a KYC task whose title and notes contain the email, not Client #<id>", async () => {
    await runAdviserTaskAutomation();

    const tasks = await db
      .select({
        title: adviserTasks.title,
        notes: adviserTasks.notes,
        taskType: adviserTasks.taskType,
      })
      .from(adviserTasks)
      .where(
        and(
          eq(adviserTasks.adviserUserId, adviserId),
          eq(adviserTasks.clientUserId, clientId),
          eq(adviserTasks.taskType, "kyc_followup"),
        ),
      );

    expect(tasks.length).toBeGreaterThanOrEqual(1);
    const kyc = tasks[0];

    // Title contract:
    expect(kyc.title).toContain(CLIENT_EMAIL);
    expect(kyc.title).not.toContain(`Client #${clientId}`);
    expect(kyc.title.startsWith("Follow up KYC for ")).toBe(true);

    // Notes contract: the body now echoes the label so it's standalone.
    expect(kyc.notes).not.toBeNull();
    expect(kyc.notes!).toContain(CLIENT_EMAIL);
    expect(kyc.notes!).not.toContain(`Client #${clientId}`);
  });
});
