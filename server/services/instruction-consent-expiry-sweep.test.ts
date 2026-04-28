// =============================================================================
// Task #309 — automated tests for the instruction-consent expiry sweep
// =============================================================================
// Locks in the behaviour of `runInstructionConsentExpirySweep`:
//
//   1. A `pending_consent` row whose `expiresAt` is in the past is flipped
//      to `cancelled` and gets one audit row under
//      `investment_instruction.auto_cancelled_expired`.
//   2. A `pending_consent` row whose `expiresAt` is still in the future is
//      left untouched (no status change, no audit row).
//   3. A row already in a terminal state (e.g. `consented`) is not touched
//      even when its `expiresAt` is in the past — the state machine guard
//      inside the UPDATE WHERE clause closes the consent/cancel race.
//   4. The sweep is idempotent: re-running it back-to-back picks up zero
//      rows on the second tick.
//
// Also locks in the configurable TTL helper:
//   * Default returns 7 days when the env var is unset.
//   * A positive integer overrides the default.
//   * Garbage / zero / negative falls back to the default rather than
//     silently producing "never expires".
//
// Hard rules:
//   - Each test owns its own deterministic fixture rows so the suite is
//     idempotent — beforeAll wipes leftovers, afterAll cleans up.
//   - The sweep is invoked with an injected `now` so the candidate
//     selection is deterministic without time travel.
// =============================================================================

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  auditLogs,
  investmentInstructions,
  investmentProducts,
  users,
} from "@shared/schema";
import {
  DEFAULT_INSTRUCTION_CONSENT_TTL_DAYS,
  getInstructionConsentTtlMs,
} from "./adviser-access";
import { runInstructionConsentExpirySweep } from "./instruction-consent-expiry-sweep";

const ADVISER_USERNAME = "__t309_adviser__";
const CLIENT_USERNAME = "__t309_client__";
const ADVISER_EMAIL = "task309-adviser@example.invalid";
const CLIENT_EMAIL = "task309-client@example.invalid";
const PRODUCT_NAME = "__t309_product__";

let adviserUserId = 0;
let clientUserId = 0;
let productId = 0;
const createdInstructionIds: number[] = [];

async function ensureUser(
  username: string,
  email: string,
): Promise<number> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.username, username));
  if (existing) return existing.id;
  const [created] = await db
    .insert(users)
    .values({
      username,
      email,
      password: "x",
      firstName: "Task309",
      lastName: "Fixture",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  return created.id;
}

async function ensureProduct(): Promise<number> {
  const [existing] = await db
    .select()
    .from(investmentProducts)
    .where(eq(investmentProducts.name, PRODUCT_NAME));
  if (existing) return existing.id;
  const [created] = await db
    .insert(investmentProducts)
    .values({
      name: PRODUCT_NAME,
      category: "real_estate",
      subCategory: "first_mortgage",
      investmentStrategy: "fixture",
      targetNetIrr: "0.08",
      term: "12 months",
      structure: "trust",
      distributions: "monthly",
      liquidity: "low",
      minimumInvestment: "1000.00",
      riskProfile: "moderate",
      returnType: "income",
    })
    .returning();
  return created.id;
}

async function insertInstruction(opts: {
  status: string;
  expiresAt: Date | null;
}): Promise<number> {
  const [row] = await db
    .insert(investmentInstructions)
    .values({
      adviserUserId,
      clientUserId,
      productId,
      action: "buy",
      amount: "1000.00",
      status: opts.status,
      expiresAt: opts.expiresAt,
      adviceRecordNotLinked: true,
    })
    .returning({ id: investmentInstructions.id });
  createdInstructionIds.push(row.id);
  return row.id;
}

async function getInstruction(id: number) {
  const [row] = await db
    .select()
    .from(investmentInstructions)
    .where(eq(investmentInstructions.id, id));
  return row;
}

async function cleanupInstructions() {
  // `audit_logs` is immutable (Task #95 — DELETE is forbidden by a DB
  // trigger), so the audit rows produced by the sweep stay behind. Each
  // test asserts on its own freshly-inserted instructionId, so leftover
  // audit rows from previous runs cannot pollute the per-test queries.
  //
  // We delete by (adviserUserId, clientUserId) rather than by the in-process
  // `createdInstructionIds` set so a previous test-run that crashed mid
  // flight (and never reached its afterAll) doesn't leave orphaned rows
  // that would block our investmentProducts cleanup with an FK violation.
  if (adviserUserId && clientUserId) {
    await db
      .delete(investmentInstructions)
      .where(
        and(
          eq(investmentInstructions.adviserUserId, adviserUserId),
          eq(investmentInstructions.clientUserId, clientUserId),
        ),
      );
  }
  createdInstructionIds.length = 0;
}

describe("getInstructionConsentTtlMs — configurable TTL", () => {
  const ENV_KEY = "INVESTMENT_INSTRUCTION_CONSENT_TTL_DAYS";

  it("defaults to 7 days when the env var is unset", () => {
    const prev = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    try {
      expect(getInstructionConsentTtlMs()).toBe(
        DEFAULT_INSTRUCTION_CONSENT_TTL_DAYS * 24 * 60 * 60 * 1000,
      );
    } finally {
      if (prev !== undefined) process.env[ENV_KEY] = prev;
    }
  });

  it("honours a positive integer override", () => {
    const prev = process.env[ENV_KEY];
    process.env[ENV_KEY] = "3";
    try {
      expect(getInstructionConsentTtlMs()).toBe(3 * 24 * 60 * 60 * 1000);
    } finally {
      if (prev === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = prev;
    }
  });

  it("falls back to the default for garbage / zero / negative values", () => {
    const prev = process.env[ENV_KEY];
    const expected =
      DEFAULT_INSTRUCTION_CONSENT_TTL_DAYS * 24 * 60 * 60 * 1000;
    try {
      for (const bad of ["banana", "0", "-1", "1.5", ""]) {
        process.env[ENV_KEY] = bad;
        expect(getInstructionConsentTtlMs()).toBe(expected);
      }
    } finally {
      if (prev === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = prev;
    }
  });
});

describe("runInstructionConsentExpirySweep — DB integration", () => {
  beforeAll(async () => {
    adviserUserId = await ensureUser(ADVISER_USERNAME, ADVISER_EMAIL);
    clientUserId = await ensureUser(CLIENT_USERNAME, CLIENT_EMAIL);
    productId = await ensureProduct();
    await cleanupInstructions();
  });

  // Each test seeds its own fixture rows; wipe between tests so a row left
  // over from the previous case can't be re-cancelled (and inflate counts).
  beforeEach(async () => {
    await cleanupInstructions();
  });

  afterAll(async () => {
    await cleanupInstructions();
    // Best-effort product cleanup — if a parallel test or a leftover row
    // is still referencing it, leave it; the per-test cleanup above is
    // what keeps the suite deterministic.
    try {
      await db
        .delete(investmentProducts)
        .where(eq(investmentProducts.id, productId));
    } catch {
      /* ignore — fixture row remains, harmless */
    }
    // Test users are deliberately left behind: they have stable usernames
    // and may be referenced by FK-bound rows from other test files
    // (portfolio_snapshots etc.) we don't own.
  });

  it(
    "cancels expired pending instructions, leaves future ones alone, " +
      "ignores already-terminal rows, and writes one audit row per cancellation",
    async () => {
      const now = new Date("2026-04-01T00:00:00Z");
      const past = new Date(now.getTime() - 60 * 60 * 1000); // 1h ago
      const future = new Date(now.getTime() + 60 * 60 * 1000); // 1h ahead

      const expiredId = await insertInstruction({
        status: "pending_consent",
        expiresAt: past,
      });
      const futureId = await insertInstruction({
        status: "pending_consent",
        expiresAt: future,
      });
      const consentedId = await insertInstruction({
        status: "consented",
        expiresAt: past, // would be a candidate but the status guard skips it
      });

      const summary = await runInstructionConsentExpirySweep({ now });
      expect(summary.checked).toBe(1);
      expect(summary.cancelled).toBe(1);
      expect(summary.errors).toBe(0);

      const expiredRow = await getInstruction(expiredId);
      expect(expiredRow.status).toBe("cancelled");
      expect(expiredRow.updatedAt?.toISOString()).toBe(now.toISOString());

      const futureRow = await getInstruction(futureId);
      expect(futureRow.status).toBe("pending_consent");

      const consentedRow = await getInstruction(consentedId);
      expect(consentedRow.status).toBe("consented");

      const auditRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, "investment_instruction"),
            eq(auditLogs.entityId, String(expiredId)),
            eq(
              auditLogs.action,
              "investment_instruction.auto_cancelled_expired",
            ),
          ),
        )
        .orderBy(desc(auditLogs.createdAt));
      expect(auditRows.length).toBe(1);
      const meta = auditRows[0].metadata as Record<string, unknown>;
      expect((meta.before as Record<string, unknown>).status).toBe(
        "pending_consent",
      );
      expect((meta.after as Record<string, unknown>).status).toBe("cancelled");
      expect(meta.trigger).toBe("instruction_consent_expiry_sweep");
      expect(meta.adviserUserId).toBe(adviserUserId);
      expect(meta.clientUserId).toBe(clientUserId);
    },
  );

  it("is idempotent — a second tick after the first picks up zero rows", async () => {
    const now = new Date("2026-04-02T00:00:00Z");
    const past = new Date(now.getTime() - 60 * 60 * 1000);
    await insertInstruction({ status: "pending_consent", expiresAt: past });

    const first = await runInstructionConsentExpirySweep({ now });
    expect(first.cancelled).toBe(1);

    const second = await runInstructionConsentExpirySweep({ now });
    expect(second.checked).toBe(0);
    expect(second.cancelled).toBe(0);
  });

  // Atomicity guard: if the audit insert blows up inside the per-row
  // transaction, the status flip MUST roll back so the next sweep tick
  // can retry — otherwise we'd leave a `cancelled` row with no audit
  // trail and no path to recovery.
  //
  // Implementation: we re-import the sweep with the audit module mocked
  // to throw, run it once, assert the row stayed `pending_consent`,
  // then re-import the un-mocked sweep and confirm the next tick
  // successfully cancels the row. Module-cache resets keep the mock
  // scoped to this test so the rest of the suite is unaffected.
  it(
    "rolls back the status flip when the audit insert fails so the next " +
      "tick can retry",
    async () => {
      const now = new Date("2026-04-03T00:00:00Z");
      const past = new Date(now.getTime() - 60 * 60 * 1000);
      const id = await insertInstruction({
        status: "pending_consent",
        expiresAt: past,
      });

      vi.resetModules();
      vi.doMock("./audit", () => ({
        writeAuditLog: vi.fn(async () => {
          throw new Error("simulated audit insert failure");
        }),
      }));
      try {
        const { runInstructionConsentExpirySweep: sweepWithFailingAudit } =
          await import("./instruction-consent-expiry-sweep");
        const summary = await sweepWithFailingAudit({ now });
        expect(summary.checked).toBe(1);
        expect(summary.cancelled).toBe(0);
        expect(summary.errors).toBe(1);
      } finally {
        vi.doUnmock("./audit");
        vi.resetModules();
      }

      // The status flip rolled back inside the transaction.
      const stillPending = await getInstruction(id);
      expect(stillPending.status).toBe("pending_consent");

      // And the next tick (audit working again) successfully cancels it,
      // proving the row remains a candidate for retry.
      const { runInstructionConsentExpirySweep: realSweep } = await import(
        "./instruction-consent-expiry-sweep"
      );
      const retry = await realSweep({ now });
      expect(retry.cancelled).toBe(1);
      const cancelled = await getInstruction(id);
      expect(cancelled.status).toBe("cancelled");
    },
  );
});
