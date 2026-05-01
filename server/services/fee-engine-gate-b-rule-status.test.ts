// =============================================================================
// Task #325 — Gate B per-rule status guard
// -----------------------------------------------------------------------------
// Locks the contract: `settleApprovedDeduction` MUST refuse to post a wallet /
// ledger triple when at least one rule that contributed accruals to the
// deduction is no longer in 'active' status (paused for consent_withdrawn,
// expired, or superseded by a newer rule).
//
// The refusal must:
//   1. throw a `RuleNotActiveError` carrying the offending rule's id, status,
//      and a stable `gateReason` ('rule_paused' | 'rule_superseded' |
//      'rule_expired' | 'rule_draft');
//   2. leave the deduction's `status` and `settled*` columns unchanged
//      (the rolled-back inner tx writes nothing; the outer catch only
//      stamps `failureReason` so admins know why);
//   3. write a `fee_deduction_gate_blocked` audit row whose metadata
//      surfaces `gateReason`, `ruleId`, and `ruleStatus`.
//
// Each scenario seeds its own client/adviser/consent/rule/accrual/deduction
// quartet so the four cases (paused / superseded / expired + a positive
// control where the rule is still active) cannot interfere with each other,
// and the suite stays idempotent across reruns by tagging fixture rows with
// a per-run TAG suffix.
// =============================================================================

import "../../scripts/_bootstrap-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  accounts,
  adviceRecords,
  adviserClients,
  adviserFeeAccruals,
  adviserFeeDeductions,
  adviserFeeRules,
  auditLogs,
  feeConsents,
  ledgerEntries,
  revenueLedger,
  transactions,
  users,
  wallets,
} from "@shared/schema";
import {
  RuleNotActiveError,
  settleApprovedDeduction,
} from "./fee-engine";
import {
  getOrCreateClientAccount,
  getOrCreateSuspenseAccount,
  postLedgerEntries,
  refreshWalletCacheBalance,
} from "./ledger";

const TAG = `t325-gate-b-${Date.now()}`;
const CURRENCY = "AUD";

let clientUserId: number;
let adviserUserId: number;
let adviceRecordId: number;

interface Scenario {
  label: string;
  consentId: number;
  ruleId: number;
  accrualId: number;
  deductionId: number;
}

const scenarios: Record<
  "paused" | "superseded" | "expired" | "active",
  Scenario
> = {} as any;

async function ensurePlatformUser(): Promise<void> {
  if (process.env.PLATFORM_USER_ID) return;
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.username, "__t325_platform__"));
  if (existing) {
    process.env.PLATFORM_USER_ID = String(existing.id);
    return;
  }
  const [created] = await db
    .insert(users)
    .values({
      username: "__t325_platform__",
      email: "t325-platform@test.invalid",
      password: "x",
      firstName: "T325",
      lastName: "Platform",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  process.env.PLATFORM_USER_ID = String(created.id);
}

async function seedClientWalletWith(amount: string): Promise<void> {
  const [existing] = await db
    .select()
    .from(wallets)
    .where(
      and(eq(wallets.userId, clientUserId), eq(wallets.currency, CURRENCY)),
    );
  if (!existing) {
    await db.insert(wallets).values({
      userId: clientUserId,
      currency: CURRENCY,
      balance: "0",
      availableBalance: "0",
      walletType: "fiat",
    });
  }
  // Top up the client via a real ledger pair so getAccountBalance returns
  // the funded amount inside the settle tx.
  await db.transaction(async (tx) => {
    const [txRow] = await (tx as any)
      .insert(transactions)
      .values({
        userId: clientUserId,
        type: "deposit",
        toCurrency: CURRENCY,
        amount,
        fee: "0",
        status: "completed",
        description: `${TAG} client top-up`,
      })
      .returning();
    const clientAccount = await getOrCreateClientAccount(
      clientUserId,
      CURRENCY,
      tx,
    );
    const suspense = await getOrCreateSuspenseAccount(CURRENCY, tx);
    await postLedgerEntries(
      txRow.id,
      [
        {
          accountId: suspense.id,
          userId: suspense.userId,
          currency: CURRENCY,
          direction: "debit",
          amount,
          description: `${TAG} top-up suspense debit`,
        },
        {
          accountId: clientAccount.id,
          userId: clientUserId,
          currency: CURRENCY,
          direction: "credit",
          amount,
          description: `${TAG} top-up client credit`,
        },
      ],
      tx,
    );
    await refreshWalletCacheBalance(tx, clientUserId, CURRENCY);
  });
}

async function buildScenario(
  key: "paused" | "superseded" | "expired" | "active",
  ruleStatus: "paused" | "superseded" | "expired" | "active",
): Promise<Scenario> {
  const acctNumber = `${TAG}-${key}-acct`;
  const future = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const [consent] = await db
    .insert(feeConsents)
    .values({
      adviceRecordId,
      clientId: clientUserId,
      adviserId: adviserUserId,
      feeType: "ongoing_service_fee",
      amountType: "percentage",
      amount: "1.0000",
      deductionFrequency: "monthly",
      referenceDay: new Date(),
      renewalWindowStart: new Date(),
      renewalWindowEnd: future,
      consentExpiryDate: future,
      renewalStatus: "active",
      clientSignatureName: "T325 Client",
      accountNumber: acctNumber,
    })
    .returning();

  const ruleValues: any = {
    feeConsentId: consent.id,
    clientUserId,
    adviserUserId,
    feeType: "ongoing_service_fee",
    accountNumber: acctNumber,
    amountType: "percentage" as const,
    rateBps: 100,
    adviserSplitBps: 8000,
    platformSplitBps: 2000,
    status: ruleStatus,
  };
  // The supersede_chain_chk constraint requires supersededByRuleId to be
  // populated when status='superseded'. We don't have a "newer" rule here
  // (Gate B fires regardless of WHICH rule replaced it), so self-point the
  // chain — same shape `createFeeRule` uses transiently inside its own tx.
  if (ruleStatus === "superseded") {
    // Insert without supersededByRuleId first (would violate the check),
    // so we use a two-step insert+self-point inside one tx.
    const [tmp] = await db.insert(adviserFeeRules).values({
      ...ruleValues,
      status: "active",
    }).returning();
    await db
      .update(adviserFeeRules)
      .set({
        status: "superseded",
        supersededByRuleId: tmp.id,
        supersededAt: new Date(),
        supersededReason: "t325 fixture",
      })
      .where(eq(adviserFeeRules.id, tmp.id));
    ruleValues.id = tmp.id;
  } else if (ruleStatus === "paused") {
    const [r] = await db
      .insert(adviserFeeRules)
      .values({
        ...ruleValues,
        pausedAt: new Date(),
        pausedReason: "consent_withdrawn",
      })
      .returning();
    ruleValues.id = r.id;
  } else {
    const [r] = await db
      .insert(adviserFeeRules)
      .values(ruleValues)
      .returning();
    ruleValues.id = r.id;
  }
  const ruleId = ruleValues.id as number;

  // Insert one accrual that "rolled up" into this rule's deduction. Note
  // the gateReason is null — this row was generated when the rule was
  // still active, before reconcileRuleConsentState transitioned it.
  const accrualDate = new Date(Date.UTC(2026, 2, 1));
  const [accrual] = await db
    .insert(adviserFeeAccruals)
    .values({
      feeRuleId: ruleId,
      clientUserId,
      adviserUserId,
      accrualDate,
      accrualAmount: "1.0000",
      adviserShareAmount: "0.8000",
      platformShareAmount: "0.2000",
      currency: CURRENCY,
      gateReason: null,
    })
    .returning();

  const periodStart = new Date(Date.UTC(2026, 2, 1));
  const periodEnd = new Date(Date.UTC(2026, 3, 1));
  const [deduction] = await db
    .insert(adviserFeeDeductions)
    .values({
      clientUserId,
      adviserUserId,
      periodStart,
      periodEnd,
      totalAccrued: "1.0000",
      adviserShareAmount: "0.8000",
      platformShareAmount: "0.2000",
      currency: CURRENCY,
      accrualIds: [accrual.id] as any,
      status: "pending_approval",
    })
    .returning();

  return {
    label: key,
    consentId: consent.id,
    ruleId,
    accrualId: accrual.id,
    deductionId: deduction.id,
  };
}

async function cleanup(): Promise<void> {
  // Order matters because of FKs — deductions ref transactions, accruals ref
  // rules, rules ref consents, consents ref advice records.
  try {
    await db
      .delete(revenueLedger)
      .where(eq(revenueLedger.clientUserId, clientUserId));
  } catch {}
  try {
    await db.execute(sql`
      DELETE FROM ledger_entries
      WHERE transaction_id IN (
        SELECT id FROM transactions
        WHERE description LIKE ${TAG + "%"}
      )
    `);
  } catch {}
  try {
    await db.execute(sql`
      DELETE FROM ledger_entries
      WHERE account_id IN (
        SELECT id FROM accounts WHERE user_id = ${clientUserId}
      )
    `);
  } catch {}
  try {
    await db
      .delete(adviserFeeDeductions)
      .where(eq(adviserFeeDeductions.clientUserId, clientUserId));
  } catch {}
  try {
    await db
      .delete(adviserFeeAccruals)
      .where(eq(adviserFeeAccruals.clientUserId, clientUserId));
  } catch {}
  try {
    await db
      .delete(adviserFeeRules)
      .where(eq(adviserFeeRules.clientUserId, clientUserId));
  } catch {}
  try {
    await db
      .delete(feeConsents)
      .where(eq(feeConsents.clientId, clientUserId));
  } catch {}
  try {
    await db
      .delete(transactions)
      .where(eq(transactions.userId, clientUserId));
  } catch {}
  try {
    await db
      .delete(adviserClients)
      .where(eq(adviserClients.clientUserId, clientUserId));
  } catch {}
  try {
    await db.delete(wallets).where(eq(wallets.userId, clientUserId));
  } catch {}
  try {
    await db.delete(accounts).where(eq(accounts.userId, clientUserId));
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
  await ensurePlatformUser();

  const [client] = await db
    .insert(users)
    .values({
      username: `${TAG}-client`,
      email: `${TAG}-client@test.local`,
      password: "x",
      firstName: "T325",
      lastName: "C",
      role: "client",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  const [adviser] = await db
    .insert(users)
    .values({
      username: `${TAG}-adv`,
      email: `${TAG}-adv@test.local`,
      password: "x",
      firstName: "T325",
      lastName: "A",
      role: "adviser",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  clientUserId = client.id;
  adviserUserId = adviser.id;

  // Active adviser-client link so the unrelated link gate (used by the
  // accrual path, not this one) cannot ever be in scope as a confounder.
  await db.insert(adviserClients).values({
    adviserUserId,
    clientUserId,
    isActive: true,
  });

  const [advice] = await db
    .insert(adviceRecords)
    .values({
      clientId: clientUserId,
      adviserId: adviserUserId,
      adviceType: "personal",
      adviceSource: "hybrid",
      status: "issued",
      soaIssued: true,
      soaIssuedAt: new Date(),
      soaViewed: true,
      soaViewedAt: new Date(),
      adviceAccepted: true,
      adviceAcceptedAt: new Date(),
    })
    .returning();
  adviceRecordId = advice.id;

  scenarios.paused = await buildScenario("paused", "paused");
  scenarios.superseded = await buildScenario("superseded", "superseded");
  scenarios.expired = await buildScenario("expired", "expired");
  scenarios.active = await buildScenario("active", "active");

  // Fund the client so an *active*-rule deduction can settle cleanly. Without
  // this, the positive control would fail with InsufficientFundsError and the
  // gate-blocked assertions would still pass for the wrong reason.
  await seedClientWalletWith("100.00");
});

afterAll(async () => {
  await cleanup();
});

describe("Gate B — settleApprovedDeduction refuses non-active rules (Task #325)", () => {
  for (const key of ["paused", "superseded", "expired"] as const) {
    it(`refuses to settle a deduction whose contributing rule is '${key}' and writes a gateReason audit row`, async () => {
      const s = scenarios[key];
      let caught: unknown = null;
      try {
        await settleApprovedDeduction({
          deductionId: s.deductionId,
          approverUserId: adviserUserId,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RuleNotActiveError);
      const e = caught as RuleNotActiveError;
      expect(e.ruleId).toBe(s.ruleId);
      expect(e.ruleStatus).toBe(key);
      const expectedGateReason =
        key === "paused"
          ? "rule_paused"
          : key === "superseded"
          ? "rule_superseded"
          : "rule_expired";
      expect(e.gateReason).toBe(expectedGateReason);

      // Deduction was NOT settled — status stays at pending_approval and no
      // ledger / transactions row was written. failureReason carries the
      // reason so admins can see what happened without grepping logs.
      const [row] = await db
        .select()
        .from(adviserFeeDeductions)
        .where(eq(adviserFeeDeductions.id, s.deductionId));
      expect(row.status).toBe("pending_approval");
      expect(row.settledAt).toBeNull();
      expect(row.settledTransactionId).toBeNull();
      expect(row.idempotencyKey).toBeNull();
      expect(row.failureReason ?? "").toContain(expectedGateReason);

      // No transactions row was inserted with this deduction's idempotency
      // key — proves the inner tx fully rolled back.
      const txRows = await db
        .select()
        .from(transactions)
        .where(
          eq(transactions.idempotencyKey, `fee_deduction_${s.deductionId}`),
        );
      expect(txRows.length).toBe(0);

      // No ledger entries were posted against the client account — second
      // hard guarantee that money was not moved.
      const ledgerRows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(ledgerEntries)
        .where(
          sql`${ledgerEntries.description} LIKE ${
            "Adviser fee deduction #" + s.deductionId + "%"
          }`,
        );
      expect(ledgerRows[0].n).toBe(0);

      // Audit row carries the gate-blocked action with the right metadata.
      const auditRows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, "adviser_fee_deduction"),
            eq(auditLogs.entityId, String(s.deductionId)),
            eq(auditLogs.action, "fee_deduction_gate_blocked"),
          ),
        );
      expect(auditRows.length).toBeGreaterThanOrEqual(1);
      const meta = auditRows[0].metadata as Record<string, any>;
      expect(meta.gateReason).toBe(expectedGateReason);
      expect(meta.ruleId).toBe(s.ruleId);
      expect(meta.ruleStatus).toBe(key);
      expect(meta.gate).toBe("B");
    });
  }

  it("settles cleanly when the contributing rule is still active (positive control)", async () => {
    const s = scenarios.active;
    const result = await settleApprovedDeduction({
      deductionId: s.deductionId,
      approverUserId: adviserUserId,
    });
    expect(result.status).toBe("settled");
    expect(result.settledTransactionId).not.toBeNull();
    expect(result.failureReason).toBeNull();

    // No revenue split config exists in this fixture, so settlement succeeds
    // and attribution is explicitly skipped (non-blocking).
    const [revCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(revenueLedger)
      .where(eq(revenueLedger.deductionId, s.deductionId));
    expect(revCount.n).toBe(0);

    const [skipAudit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "revenue_attribution_skipped"),
          eq(auditLogs.entityType, "adviser_fee_deduction"),
          eq(auditLogs.entityId, String(s.deductionId)),
        ),
      )
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(skipAudit).toBeDefined();
    const skipMeta = skipAudit.metadata as Record<string, any>;
    expect(skipMeta.reason).toBe("missing_split_config");

    // No gate-blocked audit row for the active scenario.
    const blockedRows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "adviser_fee_deduction"),
          eq(auditLogs.entityId, String(s.deductionId)),
          eq(auditLogs.action, "fee_deduction_gate_blocked"),
        ),
      );
    expect(blockedRows[0].n).toBe(0);
  });
});
