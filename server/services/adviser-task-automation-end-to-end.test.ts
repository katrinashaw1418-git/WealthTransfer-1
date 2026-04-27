// End-to-end: drive runAdviserTaskAutomation against the dev DB and
// assert the persisted KYC task title + notes contain email, not Client #<id>.

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

describe("runAdviserTaskAutomation — KYC label end-to-end", () => {
  beforeAll(async () => {
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
        firstName: "",
        lastName: "",
        role: "client",
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

  afterAll(cleanup);

  it("writes a KYC task whose title and notes contain the email", async () => {
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

    expect(kyc.title).toContain(CLIENT_EMAIL);
    expect(kyc.title).not.toContain(`Client #${clientId}`);
    expect(kyc.title.startsWith("Follow up KYC for ")).toBe(true);

    expect(kyc.notes).not.toBeNull();
    expect(kyc.notes!).toContain(CLIENT_EMAIL);
    expect(kyc.notes!).not.toContain(`Client #${clientId}`);
  });
});
