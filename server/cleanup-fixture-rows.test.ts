// =============================================================================
// TASK #366 — cleanup-fixture-rows regression test
// -----------------------------------------------------------------------------
// Locks in two invariants the code-review pass surfaced:
//
// 1. FK-locked deductions (settledTransactionId IS NOT NULL) are reported
//    as `skippedIds` by the dry-run summary AND are NOT touched when
//    `applyDeletes` runs. Both halves matter — a previous version of the
//    script flagged them in the summary but still deleted them, which would
//    corrupt the ledger.
// 2. The script does NOT pull in `_bootstrap-test-env`, which would import
//    the production-insertion guard. The cleanup pass is delete-only and
//    must remain runnable against production-reachable databases.
// =============================================================================

import "../scripts/_bootstrap-test-env";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { db } from "./db";
import {
  users,
  adviserClients,
  adviserFeeDeductions,
  transactions,
} from "../shared/schema";
import {
  findFixtureUsers,
  buildSummary,
  applyDeletes,
} from "../scripts/cleanup-fixture-rows";

let seedKey: string;
let fixtureUserId: number;
let adviserUserId: number;
let settledTxnId: number;
let lockedDeductionId: number;
let unlockedDeductionId: number;

beforeAll(async () => {
  seedKey = `t366cln_${randomBytes(4).toString("hex")}`;

  // Real adviser (non-fixture) so the deduction has both sides populated.
  const [adviser] = await db
    .insert(users)
    .values({
      username: `${seedKey}_adv`,
      email: `${seedKey}_adv@test.invalid`,
      password: "x",
      firstName: "Real",
      lastName: "Adviser",
      role: "adviser",
    })
    .returning();
  adviserUserId = adviser.id;

  // Fixture client — @example.com is the canonical fixture domain.
  const [fixture] = await db
    .insert(users)
    .values({
      username: `${seedKey}_fix`,
      email: `${seedKey}_fix@example.com`,
      password: "x",
      firstName: "Fixture",
      lastName: "Client",
      role: "client",
    })
    .returning();
  fixtureUserId = fixture.id;

  await db.insert(adviserClients).values({
    adviserUserId,
    clientUserId: fixtureUserId,
    relationshipType: "servicing",
    isActive: true,
  });

  // Stub settled transaction so we can FK-lock one of the deductions. The
  // shape is the minimum that satisfies the NOT NULL columns on the
  // `transactions` table — we never read it back, the FK existence is the
  // only thing we need.
  const [txn] = await db
    .insert(transactions)
    .values({
      userId: fixtureUserId,
      type: "fee",
      amount: "1.00",
      fee: "0",
      status: "completed",
      description: `${seedKey} settled fee`,
    })
    .returning();
  settledTxnId = txn.id;

  // Two deductions for the fixture user. Both have identical shape EXCEPT
  // for `settledTransactionId`: one set (FK-locked → must survive --apply),
  // one null (must be deleted). Schema fields per `shared/schema.ts`:
  // periodStart/periodEnd, totalAccrued/adviserShareAmount/platformShareAmount,
  // currency, accrualIds. There is no `feeConsentId` or `amount` column.
  const periodStart = new Date("2026-01-01T00:00:00Z");
  const periodEnd = new Date("2026-01-31T23:59:59Z");
  const [locked] = await db
    .insert(adviserFeeDeductions)
    .values({
      clientUserId: fixtureUserId,
      adviserUserId,
      periodStart,
      periodEnd,
      totalAccrued: "10.0000",
      adviserShareAmount: "8.0000",
      platformShareAmount: "2.0000",
      currency: "AUD",
      accrualIds: [],
      status: "settled",
      settledTransactionId: settledTxnId,
    })
    .returning();
  lockedDeductionId = locked.id;

  const [unlocked] = await db
    .insert(adviserFeeDeductions)
    .values({
      clientUserId: fixtureUserId,
      adviserUserId,
      periodStart,
      periodEnd,
      totalAccrued: "20.0000",
      adviserShareAmount: "16.0000",
      platformShareAmount: "4.0000",
      currency: "AUD",
      accrualIds: [],
      status: "pending_approval",
    })
    .returning();
  unlockedDeductionId = unlocked.id;
});

afterAll(async () => {
  // applyDeletes will have removed the unlocked deduction. Clean up
  // whatever survives by primary key so we never accidentally delete a
  // row this test didn't seed.
  await db
    .delete(adviserFeeDeductions)
    .where(inArray(adviserFeeDeductions.id, [lockedDeductionId, unlockedDeductionId]));
  await db.delete(transactions).where(eq(transactions.id, settledTxnId));
  await db
    .delete(adviserClients)
    .where(eq(adviserClients.adviserUserId, adviserUserId));
  await db.delete(users).where(inArray(users.id, [adviserUserId, fixtureUserId]));
});

describe("scripts/cleanup-fixture-rows.ts — FK-locked deduction invariant", () => {
  it("reports the locked deduction under skippedIds in the dry-run summary", async () => {
    const fixtureUsers = await findFixtureUsers();
    const us = fixtureUsers.find((u) => u.id === fixtureUserId);
    expect(us, "test fixture user must be picked up by findFixtureUsers").toBeDefined();

    const summary = await buildSummary([us!]);
    expect(summary).toHaveLength(1);
    const ded = summary[0].perTable.find((t) => t.table === "adviser_fee_deductions");
    expect(ded).toBeDefined();
    expect(ded!.count).toBe(1); // unlocked one
    expect(ded!.skippedIds).toContain(lockedDeductionId);
    expect(ded!.skippedIds).not.toContain(unlockedDeductionId);
  });

  it("--apply deletes the unlocked deduction but leaves the FK-locked one intact", async () => {
    const fixtureUsers = await findFixtureUsers();
    const us = fixtureUsers.find((u) => u.id === fixtureUserId)!;
    const summary = await buildSummary([us]);
    await applyDeletes(summary);

    // Locked row MUST still exist — the dry-run summary classified it as
    // skipped, and the SQL DELETE must honour that classification.
    const lockedAfter = await db
      .select({ id: adviserFeeDeductions.id })
      .from(adviserFeeDeductions)
      .where(eq(adviserFeeDeductions.id, lockedDeductionId));
    expect(
      lockedAfter,
      "FK-locked deduction must NOT be deleted by --apply",
    ).toHaveLength(1);

    // Unlocked row MUST be gone.
    const unlockedAfter = await db
      .select({ id: adviserFeeDeductions.id })
      .from(adviserFeeDeductions)
      .where(eq(adviserFeeDeductions.id, unlockedDeductionId));
    expect(
      unlockedAfter,
      "Unlocked deduction must be deleted by --apply",
    ).toHaveLength(0);
  });
});

describe("scripts/cleanup-fixture-rows.ts — bootstrap import contract", () => {
  it("does NOT import _bootstrap-test-env (would block the script in production)", () => {
    // Source-level assertion: the cleanup script is delete-only and must
    // remain runnable against production-reachable databases. Importing
    // `_bootstrap-test-env` would pull in the production-insertion guard
    // (assertFixtureInsertionAllowed), which hard-refuses NODE_ENV=production.
    // If a future edit re-introduces that import, this test fails LOUDLY.
    const src = readFileSync(
      join(process.cwd(), "scripts/cleanup-fixture-rows.ts"),
      "utf-8",
    );
    // Match either `import "./_bootstrap-test-env"` or
    // `import x from "./_bootstrap-test-env"` — both forms would re-arm
    // the production guard. Negate both.
    expect(src).not.toMatch(/import\s+["']\.\/_bootstrap-test-env["']/);
    expect(src).not.toMatch(/from\s+["']\.\/_bootstrap-test-env["']/);
  });
});
