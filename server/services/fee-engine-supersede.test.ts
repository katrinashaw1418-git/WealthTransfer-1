// =============================================================================
// Task #294 — createFeeRule auto-supersede contract
// -----------------------------------------------------------------------------
// Locks the invariants the rest of the fee subsystem now relies on:
//
//   1. Inserting a second rule for the same (clientUserId, feeType,
//      accountNumber) AUTOMATICALLY flips the predecessor to
//      status='superseded' inside the SAME transaction, sets
//      supersededByRuleId to the new row, and writes one
//      `fee_rule_superseded` audit line. The application path is the only
//      writer that should ever populate the chain — but the partial unique
//      index `adviser_fee_rules_supersede_uniq` is the hard backstop, so
//      this test also asserts that a direct INSERT bypassing the service
//      gets rejected with a 23505.
//
//   2. The accountNumber on the new row is taken from the consent, not from
//      the input — the route layer must not be able to spoof it.
//
//   3. A supersede chain may be longer than two — A → B → C must all walk
//      cleanly via supersededByRuleId, with B carrying status='superseded'
//      and C the only 'active' row at the end.
//
//   4. A second active rule with a DIFFERENT accountNumber under the same
//      (client, feeType) is allowed — the unique key is (client, feeType,
//      accountNumber), so each per-account stream has its own active rule.
// =============================================================================

import "../../scripts/_bootstrap-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  adviceRecords,
  adviserFeeRules,
  auditLogs,
  feeConsents,
  users,
} from "@shared/schema";
import { createFeeRule } from "./fee-engine";

// Stable per-suite identifier. Embedded in usernames/emails so a second run
// against the same DB does not collide with the prior run's seed rows. We
// also clean up at the end via afterAll, but the suffix is the safety net.
const TAG = `t294-supersede-${Date.now()}`;

let clientUserId: number;
let adviserUserId: number;
let adviceRecordId: number;
let consentAcct1Id: number;
let consentAcct2Id: number;

async function seed() {
  const [client] = await db
    .insert(users)
    .values({
      username: `${TAG}-client`,
      email: `${TAG}-client@test.local`,
      password: "x",
      firstName: "Test",
      lastName: "Client",
      role: "client",
    })
    .returning();
  const [adviser] = await db
    .insert(users)
    .values({
      username: `${TAG}-adviser`,
      email: `${TAG}-adviser@test.local`,
      password: "x",
      firstName: "Test",
      lastName: "Adviser",
      role: "adviser",
    })
    .returning();
  clientUserId = client.id;
  adviserUserId = adviser.id;

  const [advice] = await db
    .insert(adviceRecords)
    .values({
      clientId: clientUserId,
      adviserId: adviserUserId,
      adviceType: "personal",
      adviceSource: "hybrid",
      status: "issued",
    })
    .returning();
  adviceRecordId = advice.id;

  const baseConsent = {
    adviceRecordId,
    clientId: clientUserId,
    adviserId: adviserUserId,
    feeType: "ongoing_service_fee",
    amountType: "percentage",
    amount: "1.0000",
    deductionFrequency: "monthly",
    referenceDay: new Date(),
    renewalWindowStart: new Date(),
    renewalWindowEnd: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    consentExpiryDate: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    renewalStatus: "active",
    clientSignatureName: "Test Client",
  };

  const [c1] = await db
    .insert(feeConsents)
    .values({ ...baseConsent, accountNumber: `${TAG}-ACC-1` })
    .returning();
  const [c2] = await db
    .insert(feeConsents)
    .values({ ...baseConsent, accountNumber: `${TAG}-ACC-2` })
    .returning();
  consentAcct1Id = c1.id;
  consentAcct2Id = c2.id;
}

async function cleanup() {
  // Best-effort teardown — order matches FK dependencies. We swallow errors
  // so a partial seed (e.g. due to a mid-test crash) does not block the
  // next run.
  try {
    await db
      .delete(auditLogs)
      .where(
        sql`${auditLogs.entityType} = 'adviser_fee_rule' AND ${auditLogs.metadata}->>'clientUserId' = ${String(clientUserId)}`,
      );
  } catch {}
  try {
    await db.delete(adviserFeeRules).where(eq(adviserFeeRules.clientUserId, clientUserId));
  } catch {}
  try {
    await db.delete(feeConsents).where(eq(feeConsents.clientId, clientUserId));
  } catch {}
  try {
    await db.delete(adviceRecords).where(eq(adviceRecords.id, adviceRecordId));
  } catch {}
  try {
    await db.delete(users).where(eq(users.id, clientUserId));
    await db.delete(users).where(eq(users.id, adviserUserId));
  } catch {}
}

beforeAll(async () => {
  await seed();
});

afterAll(async () => {
  await cleanup();
});

describe("createFeeRule auto-supersede chain (Task #294)", () => {
  it("supersedes the previous active rule and writes a fee_rule_superseded audit row", async () => {
    const ruleA = await createFeeRule(
      {
        feeConsentId: consentAcct1Id,
        clientUserId,
        adviserUserId,
        feeType: "ongoing_service_fee",
        amountType: "percentage",
        rateBps: 100,
        adviserSplitBps: 8000,
        platformSplitBps: 2000,
      },
      { actorUserId: adviserUserId, supersedeReason: "first_rule" },
    );
    expect(ruleA.status).toBe("active");
    expect(ruleA.accountNumber).toBe(`${TAG}-ACC-1`);
    expect(ruleA.effectiveDate).not.toBeNull();

    const ruleB = await createFeeRule(
      {
        feeConsentId: consentAcct1Id,
        clientUserId,
        adviserUserId,
        feeType: "ongoing_service_fee",
        amountType: "percentage",
        rateBps: 150,
        adviserSplitBps: 8000,
        platformSplitBps: 2000,
      },
      { actorUserId: adviserUserId, supersedeReason: "rate_change" },
    );
    expect(ruleB.status).toBe("active");
    expect(ruleB.id).not.toBe(ruleA.id);

    const [aAfter] = await db
      .select()
      .from(adviserFeeRules)
      .where(eq(adviserFeeRules.id, ruleA.id));
    expect(aAfter.status).toBe("superseded");
    expect(aAfter.supersededByRuleId).toBe(ruleB.id);
    expect(aAfter.supersededAt).not.toBeNull();
    expect(aAfter.supersededReason).toBe("rate_change");

    const auditRows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "adviser_fee_rule"),
          eq(auditLogs.entityId, String(ruleA.id)),
          eq(auditLogs.action, "fee_rule_superseded"),
        ),
      );
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const meta = auditRows[auditRows.length - 1].metadata as any;
    expect(meta.after.status).toBe("superseded");
    expect(meta.after.supersededByRuleId).toBe(ruleB.id);
    expect(meta.replacedByRuleId).toBe(ruleB.id);

    // Walk one step further: a third rule supersedes ruleB.
    const ruleC = await createFeeRule(
      {
        feeConsentId: consentAcct1Id,
        clientUserId,
        adviserUserId,
        feeType: "ongoing_service_fee",
        amountType: "percentage",
        rateBps: 200,
        adviserSplitBps: 8000,
        platformSplitBps: 2000,
      },
      { actorUserId: adviserUserId, supersedeReason: "second_rate_change" },
    );
    const [bAfter] = await db
      .select()
      .from(adviserFeeRules)
      .where(eq(adviserFeeRules.id, ruleB.id));
    expect(bAfter.status).toBe("superseded");
    expect(bAfter.supersededByRuleId).toBe(ruleC.id);

    // Only one active row in the supersede stream.
    const activeForAcct1 = await db
      .select()
      .from(adviserFeeRules)
      .where(
        and(
          eq(adviserFeeRules.clientUserId, clientUserId),
          eq(adviserFeeRules.feeType, "ongoing_service_fee"),
          eq(adviserFeeRules.accountNumber, `${TAG}-ACC-1`),
          eq(adviserFeeRules.status, "active"),
        ),
      );
    expect(activeForAcct1.map((r) => r.id)).toEqual([ruleC.id]);
  });

  it("allows a separate active rule for a DIFFERENT accountNumber under the same (client, feeType)", async () => {
    const ruleAcc2 = await createFeeRule(
      {
        feeConsentId: consentAcct2Id,
        clientUserId,
        adviserUserId,
        feeType: "ongoing_service_fee",
        amountType: "percentage",
        rateBps: 75,
        adviserSplitBps: 8000,
        platformSplitBps: 2000,
      },
      { actorUserId: adviserUserId },
    );
    expect(ruleAcc2.status).toBe("active");
    expect(ruleAcc2.accountNumber).toBe(`${TAG}-ACC-2`);

    // The unique index does NOT collide with the existing active rule on
    // ACC-1 because the partial uniqueness key is (client, feeType, account).
    const allActive = await db
      .select()
      .from(adviserFeeRules)
      .where(
        and(
          eq(adviserFeeRules.clientUserId, clientUserId),
          eq(adviserFeeRules.feeType, "ongoing_service_fee"),
          eq(adviserFeeRules.status, "active"),
        ),
      )
      .orderBy(desc(adviserFeeRules.id));
    const accts = allActive.map((r) => r.accountNumber).sort();
    expect(accts).toEqual([`${TAG}-ACC-1`, `${TAG}-ACC-2`]);
  });

  it("the partial unique index rejects a direct INSERT that bypasses createFeeRule", async () => {
    // Find the surviving active rule on ACC-1 from the first test.
    const [active] = await db
      .select()
      .from(adviserFeeRules)
      .where(
        and(
          eq(adviserFeeRules.clientUserId, clientUserId),
          eq(adviserFeeRules.feeType, "ongoing_service_fee"),
          eq(adviserFeeRules.accountNumber, `${TAG}-ACC-1`),
          eq(adviserFeeRules.status, "active"),
        ),
      );
    expect(active).toBeDefined();

    // Direct INSERT of another active row on the same tuple — the partial
    // unique index `adviser_fee_rules_supersede_uniq` MUST reject it. We
    // accept any error whose message mentions the unique-violation code or
    // index name, since the exact phrasing varies by driver.
    let raised: unknown = null;
    try {
      await db.insert(adviserFeeRules).values({
        feeConsentId: consentAcct1Id,
        clientUserId,
        adviserUserId,
        feeType: "ongoing_service_fee",
        amountType: "percentage",
        rateBps: 50,
        adviserSplitBps: 8000,
        platformSplitBps: 2000,
        accountNumber: `${TAG}-ACC-1`,
        status: "active",
      });
    } catch (err) {
      raised = err;
    }
    expect(raised).not.toBeNull();
    const msg = String((raised as Error)?.message ?? raised);
    expect(
      msg.includes("adviser_fee_rules_supersede_uniq") ||
        msg.includes("23505") ||
        /duplicate key/i.test(msg),
    ).toBe(true);
  });
});
