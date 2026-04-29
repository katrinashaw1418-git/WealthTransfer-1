// =============================================================================
// Task #476 — Consent integrity runtime gate at all three call sites
// =============================================================================
// Locks the contract that `assertConsentValidForExecution` (the single
// shared definition of "is this consent legally valid for execution right
// now?") is invoked at — and refuses — at every chokepoint that can move
// money (or transition a rule into a state that can):
//
//   1. Rule activation         POST /api/admin/fee-rules/:id/activate
//   2. Accrual creation        runDailyAccruals (per-rule loop)
//   3. Deduction approval      POST /api/admin/fee-deductions/:id/approve
//
// For every reachable failure reason (consent_withdrawn, consent_expired,
// consent_renewal_inactive) and the happy path, this suite asserts:
//   - the right ConsentGateReason surfaces (helper-level);
//   - the route layer returns 409 with the typed `code` and writes a
//     `.blocked` audit row carrying the same reason;
//   - the accrual loop produces a skipped accrual row with
//     `gateReason` populated (NOT throwing, NOT aborting the batch);
//   - settled state never advances when the gate refuses (no transactions
//     row, no ledger entries, no flip out of pending_approval);
//   - happy path actually completes the action.
//
// Two extra scenarios pin the implementation against real-world bugs:
//   - Multi-rule deduction: when generatePendingDeductions groups two
//     different rules' accruals into ONE deduction, the route checks
//     EVERY backing rule's consent (not just the first accrual's).
//     Without this guard, a withdrawn consent on rule #2 would slip
//     past while the route only ever inspected rule #1.
//   - End-to-end: a consent that is healthy at accrual time and then
//     withdrawn between accrual and approval still refuses approval —
//     the gate is point-in-time, not snapshotted.
//
// The `consent_missing` reason is exercised at the helper level only —
// the FK constraint on adviser_fee_rules.fee_consent_id makes it
// unreachable at the service / route layer without orphaning the rule.
// =============================================================================

import "../../scripts/_bootstrap-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

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
  transactions,
  users,
  wallets,
} from "@shared/schema";
import { signToken } from "../auth";
import { registerAdminRoutes } from "../admin-routes";
import {
  ConsentNotValidError,
  runDailyAccruals,
  settleApprovedDeduction,
} from "./fee-engine";
import { assertConsentValidForExecution } from "./consent-integrity";
import {
  getOrCreateClientAccount,
  getOrCreateSuspenseAccount,
  postLedgerEntries,
  refreshWalletCacheBalance,
} from "./ledger";

const TAG = `t476-${Date.now()}`;
const CURRENCY = "AUD";

let server: http.Server;
let baseUrl: string;
let adminToken: string;
let clientUserId: number;
let adviserUserId: number;
let adminUserId: number;
let adviceRecordId: number;

interface RuleScenario {
  acctNumber: string;
  consentId: number;
  ruleId: number;
}

const reasons = ["withdrawn", "expired", "renewal_inactive", "happy"] as const;
type ReasonKey = (typeof reasons)[number];

// One scenario per (call_site, reason) pair so they cannot interfere with
// each other. We seed everything healthy first; per-test consent mutations
// are applied just before the assertion and reverted in afterAll cleanup.
// Scenarios are populated in beforeAll; tests run after, so by the time any
// test reads them every key is present. We declare them as Partial to keep
// the build honest about the seeding sequence.
const accrualScenarios: Partial<Record<ReasonKey, RuleScenario>> = {};
const activationScenarios: Partial<Record<ReasonKey, RuleScenario>> = {};
const approvalScenarios: Partial<
  Record<ReasonKey, RuleScenario & { accrualId: number; deductionId: number }>
> = {};

type MultiRuleScenario = {
  ruleA: RuleScenario;
  ruleB: RuleScenario; // the one with a withdrawn consent
  deductionId: number;
};
type E2eScenario = RuleScenario & {
  accrualId: number;
  deductionId: number;
};

// Multi-rule + e2e use their own scenarios to keep the assertions readable.
// Initialised in beforeAll; tests assert non-null before use.
let multiRuleScenario: MultiRuleScenario | null = null;
let e2eScenario: E2eScenario | null = null;

// Tiny non-null guard so reads of beforeAll-populated scenarios stay
// readable in the test bodies without leaking `!` everywhere. Throws a
// useful message if the seeding step missed a key.
function requireScenario<T>(value: T | null | undefined, label: string): T {
  if (value == null) {
    throw new Error(
      `[t476-test] expected scenario "${label}" to be seeded by beforeAll, got ${value === null ? "null" : "undefined"}`,
    );
  }
  return value;
}

// --- helpers ---------------------------------------------------------------

function future(daysFromNow = 365): Date {
  return new Date(Date.now() + daysFromNow * 24 * 3600 * 1000);
}

function past(daysAgo = 1): Date {
  return new Date(Date.now() - daysAgo * 24 * 3600 * 1000);
}

async function ensurePlatformUser(): Promise<void> {
  if (process.env.PLATFORM_USER_ID) return;
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.username, "__t476_platform__"));
  if (existing) {
    process.env.PLATFORM_USER_ID = String(existing.id);
    return;
  }
  const [created] = await db
    .insert(users)
    .values({
      username: "__t476_platform__",
      email: "t476-platform@test.invalid",
      password: "x",
      firstName: "T476",
      lastName: "Platform",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  process.env.PLATFORM_USER_ID = String(created.id);
}

async function makeConsent(suffix: string): Promise<number> {
  const [c] = await db
    .insert(feeConsents)
    .values({
      adviceRecordId,
      clientId: clientUserId,
      adviserId: adviserUserId,
      feeType: "ongoing_service_fee",
      amountType: "fixed",
      amount: "10.0000",
      deductionFrequency: "monthly",
      referenceDay: new Date(),
      renewalWindowStart: new Date(),
      renewalWindowEnd: future(),
      consentExpiryDate: future(),
      renewalStatus: "active",
      clientSignatureName: "T476 Client",
      accountNumber: `${TAG}-${suffix}`,
    })
    .returning();
  return c.id;
}

async function makeRule(opts: {
  consentId: number;
  acctNumber: string;
  status: "active" | "paused";
  feeType?: string;
}): Promise<number> {
  const [r] = await db
    .insert(adviserFeeRules)
    .values({
      feeConsentId: opts.consentId,
      clientUserId,
      adviserUserId,
      feeType: opts.feeType ?? "ongoing_service_fee",
      accountNumber: opts.acctNumber,
      amountType: "fixed",
      fixedAmount: "10.0000",
      adviserSplitBps: 8000,
      platformSplitBps: 2000,
      status: opts.status,
      pausedAt: opts.status === "paused" ? new Date() : null,
      pausedReason: opts.status === "paused" ? "operator_paused" : null,
    })
    .returning();
  return r.id;
}

async function buildRuleScenario(
  callSite: string,
  reason: ReasonKey,
  ruleStatus: "active" | "paused" = "active",
): Promise<RuleScenario> {
  const acctNumber = `${TAG}-${callSite}-${reason}`;
  const consentId = await makeConsent(`${callSite}-${reason}`);
  const ruleId = await makeRule({
    consentId,
    acctNumber,
    status: ruleStatus,
  });
  return { acctNumber, consentId, ruleId };
}

async function buildApprovalScenario(
  reason: ReasonKey,
): Promise<RuleScenario & { accrualId: number; deductionId: number }> {
  const base = await buildRuleScenario("approve", reason, "active");
  const [accrual] = await db
    .insert(adviserFeeAccruals)
    .values({
      feeRuleId: base.ruleId,
      clientUserId,
      adviserUserId,
      accrualDate: new Date(Date.UTC(2026, 1, 1)),
      accrualAmount: "1.0000",
      adviserShareAmount: "0.8000",
      platformShareAmount: "0.2000",
      currency: CURRENCY,
      gateReason: null,
    })
    .returning();
  const [deduction] = await db
    .insert(adviserFeeDeductions)
    .values({
      clientUserId,
      adviserUserId,
      periodStart: new Date(Date.UTC(2026, 1, 1)),
      periodEnd: new Date(Date.UTC(2026, 2, 1)),
      totalAccrued: "1.0000",
      adviserShareAmount: "0.8000",
      platformShareAmount: "0.2000",
      currency: CURRENCY,
      accrualIds: [accrual.id] as number[],
      status: "pending_approval",
    })
    .returning();
  return { ...base, accrualId: accrual.id, deductionId: deduction.id };
}

async function applyConsentMutation(
  consentId: number,
  reason: ReasonKey,
): Promise<void> {
  if (reason === "happy") return;
  if (reason === "withdrawn") {
    await db
      .update(feeConsents)
      .set({ withdrawnAt: new Date() })
      .where(eq(feeConsents.id, consentId));
  } else if (reason === "expired") {
    await db
      .update(feeConsents)
      .set({ consentExpiryDate: past() })
      .where(eq(feeConsents.id, consentId));
  } else if (reason === "renewal_inactive") {
    // Anything other than 'active' triggers the consent_renewal_inactive
    // gate. 'expired' is the most realistic non-active value (set by the
    // renewal-window cron) but we use 'superseded' here so the test does
    // NOT also satisfy the consentExpiryDate <= now branch — that would
    // make it ambiguous which gate fired.
    await db
      .update(feeConsents)
      .set({ renewalStatus: "superseded" })
      .where(eq(feeConsents.id, consentId));
  }
}

const expectedReason = (reason: ReasonKey): string => {
  switch (reason) {
    case "withdrawn":
      return "consent_withdrawn";
    case "expired":
      return "consent_expired";
    case "renewal_inactive":
      return "consent_renewal_inactive";
    default:
      throw new Error(`No expectedReason for happy path`);
  }
};

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
  await db.transaction(async (tx) => {
    const [txRow] = await tx
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

async function POST(
  path: string,
  token: string,
  body: unknown = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const respBody = await res.json().catch(() => ({}));
  return { status: res.status, body: respBody };
}

// --- setup / teardown ------------------------------------------------------

beforeAll(async () => {
  await ensurePlatformUser();

  // Mount admin routes on a fresh express app — same pattern as
  // admin-routes-consent-reconcile-runs.test.ts.
  const app = express();
  app.use(express.json());
  registerAdminRoutes(app);
  server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Real admin user — adminRoute requires a users-table row with
  // role='admin' (the JWT claim alone isn't enough; the wrapper double-
  // checks the DB to defend against stale tokens).
  const [admin] = await db
    .insert(users)
    .values({
      username: `${TAG}-admin`,
      email: `${TAG}-admin@test.local`,
      password: "x",
      firstName: "T476",
      lastName: "Admin",
      role: "admin",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  adminUserId = admin.id;
  adminToken = signToken({
    userId: admin.id,
    username: admin.username,
    email: admin.email,
    role: "admin",
  });

  const [client] = await db
    .insert(users)
    .values({
      username: `${TAG}-client`,
      email: `${TAG}-client@test.local`,
      password: "x",
      firstName: "T476",
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
      firstName: "T476",
      lastName: "A",
      role: "adviser",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  clientUserId = client.id;
  adviserUserId = adviser.id;

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
    })
    .returning();
  adviceRecordId = advice.id;

  // Build per-call-site scenarios.
  for (const reason of reasons) {
    accrualScenarios[reason] = await buildRuleScenario("accrual", reason, "active");
    activationScenarios[reason] = await buildRuleScenario(
      "activate",
      reason,
      "paused", // activation route requires status='paused' or 'draft'
    );
    approvalScenarios[reason] = await buildApprovalScenario(reason);
  }

  // Multi-rule deduction: two rules under two different consents (different
  // fee_types so the partial-unique index is satisfied), one accrual each,
  // both rolled into ONE deduction (allowed because group key is
  // client+adviser+currency).
  const ruleA = await buildRuleScenario("multiA", "happy", "active");
  // Reuse the same buildRuleScenario shape for the SECOND rule but force a
  // different feeType so the supersede unique index doesn't trip.
  const acctB = `${TAG}-multiB-withdrawn`;
  const consentB = await makeConsent("multiB-withdrawn");
  const ruleBId = await makeRule({
    consentId: consentB,
    acctNumber: acctB,
    status: "active",
    feeType: "advice_fee",
  });
  const ruleB: RuleScenario = { acctNumber: acctB, consentId: consentB, ruleId: ruleBId };

  const [aA] = await db
    .insert(adviserFeeAccruals)
    .values({
      feeRuleId: ruleA.ruleId,
      clientUserId,
      adviserUserId,
      accrualDate: new Date(Date.UTC(2026, 0, 5)),
      accrualAmount: "0.5000",
      adviserShareAmount: "0.4000",
      platformShareAmount: "0.1000",
      currency: CURRENCY,
      gateReason: null,
    })
    .returning();
  const [aB] = await db
    .insert(adviserFeeAccruals)
    .values({
      feeRuleId: ruleB.ruleId,
      clientUserId,
      adviserUserId,
      accrualDate: new Date(Date.UTC(2026, 0, 6)),
      accrualAmount: "0.5000",
      adviserShareAmount: "0.4000",
      platformShareAmount: "0.1000",
      currency: CURRENCY,
      gateReason: null,
    })
    .returning();
  const [multiDeduction] = await db
    .insert(adviserFeeDeductions)
    .values({
      clientUserId,
      adviserUserId,
      periodStart: new Date(Date.UTC(2026, 0, 1)),
      periodEnd: new Date(Date.UTC(2026, 1, 1)),
      totalAccrued: "1.0000",
      adviserShareAmount: "0.8000",
      platformShareAmount: "0.2000",
      currency: CURRENCY,
      accrualIds: [aA.id, aB.id] as number[],
      status: "pending_approval",
    })
    .returning();
  multiRuleScenario = {
    ruleA,
    ruleB,
    deductionId: multiDeduction.id,
  };

  // E2E scenario: separate consent + rule + accrual + deduction so we can
  // mutate it independently of the others.
  const e2eBase = await buildRuleScenario("e2e", "happy", "active");
  const [e2eAccrual] = await db
    .insert(adviserFeeAccruals)
    .values({
      feeRuleId: e2eBase.ruleId,
      clientUserId,
      adviserUserId,
      accrualDate: new Date(Date.UTC(2026, 2, 10)),
      accrualAmount: "1.0000",
      adviserShareAmount: "0.8000",
      platformShareAmount: "0.2000",
      currency: CURRENCY,
      gateReason: null,
    })
    .returning();
  const [e2eDeduction] = await db
    .insert(adviserFeeDeductions)
    .values({
      clientUserId,
      adviserUserId,
      periodStart: new Date(Date.UTC(2026, 2, 1)),
      periodEnd: new Date(Date.UTC(2026, 3, 1)),
      totalAccrued: "1.0000",
      adviserShareAmount: "0.8000",
      platformShareAmount: "0.2000",
      currency: CURRENCY,
      accrualIds: [e2eAccrual.id] as number[],
      status: "pending_approval",
    })
    .returning();
  e2eScenario = {
    ...e2eBase,
    accrualId: e2eAccrual.id,
    deductionId: e2eDeduction.id,
  };

  // Fund the client so the happy-path approval has the funds to settle.
  // Without this the positive control would fail with InsufficientFundsError
  // and could mask a regression in the gate.
  await seedClientWalletWith("100.00");
});

afterAll(async () => {
  // FK-respecting cleanup. Failures are tolerated because the suite tags
  // every row with a unique TAG; leftovers cannot pollute meaningful
  // queries even if a delete fails.
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
        SELECT id FROM accounts WHERE user_id IN (${clientUserId}, ${adviserUserId})
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
    await db
      .delete(accounts)
      .where(sql`user_id IN (${clientUserId}, ${adviserUserId})`);
  } catch {}
  try {
    await db.delete(adviceRecords).where(eq(adviceRecords.id, adviceRecordId));
  } catch {}
  try {
    await db.delete(users).where(eq(users.id, clientUserId));
    await db.delete(users).where(eq(users.id, adviserUserId));
    await db.delete(users).where(eq(users.id, adminUserId));
  } catch {}
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

// =============================================================================
// 1. Helper-level — assertConsentValidForExecution
// =============================================================================
describe("assertConsentValidForExecution (Task #476 helper contract)", () => {
  it("returns ok=true on a healthy consent (happy path)", async () => {
    const s = requireScenario(activationScenarios.happy, "activationScenarios.happy");
    const res = await assertConsentValidForExecution(s.consentId);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.consent.id).toBe(s.consentId);
    }
  });

  it("returns consent_missing for a non-existent consent id", async () => {
    // Use an obviously-impossible id; we reserve room above the natural
    // serial sequence so we can be confident no real row collides.
    const res = await assertConsentValidForExecution(2_000_000_000);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("consent_missing");
      expect(res.consent).toBeNull();
    }
  });

  it("returns consent_withdrawn when withdrawnAt is set", async () => {
    const consentId = await makeConsent("helper-withdrawn");
    await db
      .update(feeConsents)
      .set({ withdrawnAt: new Date() })
      .where(eq(feeConsents.id, consentId));
    const res = await assertConsentValidForExecution(consentId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("consent_withdrawn");
  });

  it("returns consent_expired when consentExpiryDate is in the past", async () => {
    const consentId = await makeConsent("helper-expired");
    await db
      .update(feeConsents)
      .set({ consentExpiryDate: past() })
      .where(eq(feeConsents.id, consentId));
    const res = await assertConsentValidForExecution(consentId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("consent_expired");
  });

  it("returns consent_renewal_inactive when renewalStatus is not 'active'", async () => {
    const consentId = await makeConsent("helper-renewal");
    await db
      .update(feeConsents)
      .set({ renewalStatus: "superseded" })
      .where(eq(feeConsents.id, consentId));
    const res = await assertConsentValidForExecution(consentId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("consent_renewal_inactive");
  });

  it("prefers the more specific consent_withdrawn over consent_expired when both apply", async () => {
    // Order in the gate ladder: withdrawn → expired → renewal_inactive.
    // This test pins the order so an audit row records the operator
    // action that caused the block, not the secondary date-based expiry.
    const consentId = await makeConsent("helper-double");
    await db
      .update(feeConsents)
      .set({ withdrawnAt: new Date(), consentExpiryDate: past() })
      .where(eq(feeConsents.id, consentId));
    const res = await assertConsentValidForExecution(consentId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("consent_withdrawn");
  });
});

// =============================================================================
// 2. Accrual call site — runDailyAccruals per-rule loop
// =============================================================================
describe("runDailyAccruals consent integrity gate (Task #476)", () => {
  // Each test uses a DIFFERENT accrualDate. runDailyAccruals walks every
  // rule in the table for the given date and inserts ON CONFLICT DO
  // NOTHING — meaning the very first run "fixes" the row for every other
  // scenario at that date. Using a distinct date per test guarantees each
  // assertion sees a row generated AFTER its consent mutation, not a
  // pre-existing row from the previous test's batch.
  const dateFor = (offsetDays: number): Date =>
    new Date(Date.UTC(2026, 5, 1 + offsetDays));

  it("skips the rule (no accrual row written) and writes the consent_withdrawn audit row + structured log line (Task #514: no row, was 'placeholder row' under #476)", async () => {
    const s = requireScenario(accrualScenarios.withdrawn, "accrualScenarios.withdrawn");
    const accrualDate = dateFor(0);
    await applyConsentMutation(s.consentId, "withdrawn");
    const result = await runDailyAccruals({ accrualDate });
    expect(result.byGateReason["consent_withdrawn"] ?? 0).toBeGreaterThan(0);

    // Task #514 — no accrual row is written for a consent-failed rule.
    const rows = await db
      .select()
      .from(adviserFeeAccruals)
      .where(
        and(
          eq(adviserFeeAccruals.feeRuleId, s.ruleId),
          eq(adviserFeeAccruals.accrualDate, accrualDate),
        ),
      );
    expect(rows).toHaveLength(0);

    // The regulator-facing audit row is still written (carried over
    // from #476). The umbrella reasonCode CONSENT_INVALID_AT_EXECUTION
    // is added by #514 so log aggregators can fan out a single alert
    // across all four consent failure modes.
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "fee_accrual_consent_blocked"),
          eq(auditLogs.entityType, "adviser_fee_rule"),
          eq(auditLogs.entityId, String(s.ruleId)),
        ),
      )
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(audit).toBeDefined();
    const meta = audit.metadata as Record<string, unknown>;
    expect(meta.gate).toBe("consent");
    expect(meta.gateReason).toBe("consent_withdrawn");
    expect(meta.reasonCode).toBe("CONSENT_INVALID_AT_EXECUTION");
    expect(meta.source).toBe("run_daily_accruals");
    expect(meta.consentId).toBe(s.consentId);
    expect(meta.ruleId).toBe(s.ruleId);
  });

  it("skips the rule (no accrual row) for consent_expired (Task #514)", async () => {
    const s = requireScenario(accrualScenarios.expired, "accrualScenarios.expired");
    const accrualDate = dateFor(1);
    await applyConsentMutation(s.consentId, "expired");
    await runDailyAccruals({ accrualDate });
    const rows = await db
      .select()
      .from(adviserFeeAccruals)
      .where(
        and(
          eq(adviserFeeAccruals.feeRuleId, s.ruleId),
          eq(adviserFeeAccruals.accrualDate, accrualDate),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it("skips the rule (no accrual row) for consent_renewal_inactive (Task #514)", async () => {
    const s = requireScenario(accrualScenarios.renewal_inactive, "accrualScenarios.renewal_inactive");
    const accrualDate = dateFor(2);
    await applyConsentMutation(s.consentId, "renewal_inactive");
    await runDailyAccruals({ accrualDate });
    const rows = await db
      .select()
      .from(adviserFeeAccruals)
      .where(
        and(
          eq(adviserFeeAccruals.feeRuleId, s.ruleId),
          eq(adviserFeeAccruals.accrualDate, accrualDate),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it("produces a normal accrual row (no gateReason) for a healthy consent", async () => {
    const s = requireScenario(accrualScenarios.happy, "accrualScenarios.happy");
    const accrualDate = dateFor(3);
    // No mutation applied — consent stays healthy.
    await runDailyAccruals({ accrualDate });
    const [row] = await db
      .select()
      .from(adviserFeeAccruals)
      .where(
        and(
          eq(adviserFeeAccruals.feeRuleId, s.ruleId),
          eq(adviserFeeAccruals.accrualDate, accrualDate),
        ),
      );
    expect(row).toBeDefined();
    expect(row.gateReason).toBeNull();
    // Fixed $10/month → naive daily = 10/30 ≈ 0.3333 (per
    // computeAccrualForRule).
    expect(Number(row.accrualAmount)).toBeCloseTo(10 / 30, 4);
  });
});

// =============================================================================
// 3. Rule activation call site — POST /api/admin/fee-rules/:id/activate
// =============================================================================
describe("Rule activation consent integrity gate (Task #476)", () => {
  for (const reason of ["withdrawn", "expired", "renewal_inactive"] as const) {
    it(`refuses with 409 + code=${expectedReason(reason)} and writes a fee_rule_activate.blocked audit row`, async () => {
      const s = requireScenario(activationScenarios[reason], `activationScenarios[${reason}]`);
      await applyConsentMutation(s.consentId, reason);
      const { status, body } = await POST(
        `/api/admin/fee-rules/${s.ruleId}/activate`,
        adminToken,
      );
      expect(status).toBe(409);
      expect(body.code).toBe(expectedReason(reason));
      expect(body.consentId).toBe(s.consentId);
      expect(body.ruleId).toBe(s.ruleId);

      // Rule status untouched — still 'paused'.
      const [rule] = await db
        .select()
        .from(adviserFeeRules)
        .where(eq(adviserFeeRules.id, s.ruleId));
      expect(rule.status).toBe("paused");

      // Audit row recorded with the typed reason.
      const [audit] = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "fee_rule_activate.blocked"),
            eq(auditLogs.entityType, "adviser_fee_rule"),
            eq(auditLogs.entityId, String(s.ruleId)),
          ),
        )
        .orderBy(desc(auditLogs.id))
        .limit(1);
      expect(audit).toBeDefined();
      const meta = audit.metadata as Record<string, any>;
      expect(meta.reason).toBe(expectedReason(reason));
      expect(meta.consentId).toBe(s.consentId);
    });
  }

  it("activates a paused rule whose consent is healthy (happy path)", async () => {
    const s = requireScenario(activationScenarios.happy, "activationScenarios.happy");
    const { status, body } = await POST(
      `/api/admin/fee-rules/${s.ruleId}/activate`,
      adminToken,
    );
    expect(status).toBe(200);
    expect(body.status).toBe("active");
    expect(body.pausedAt).toBeNull();
    // Audit row shows the success transition.
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "fee_rule_activated"),
          eq(auditLogs.entityType, "adviser_fee_rule"),
          eq(auditLogs.entityId, String(s.ruleId)),
        ),
      )
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(audit).toBeDefined();
  });
});

// =============================================================================
// 4. Deduction approval call site — POST /api/admin/fee-deductions/:id/approve
// =============================================================================
describe("Deduction approval consent integrity gate (Task #476)", () => {
  for (const reason of ["withdrawn", "expired", "renewal_inactive"] as const) {
    it(`refuses with 409 + code=${expectedReason(reason)} and writes a deduction.approve.blocked audit row`, async () => {
      const s = requireScenario(approvalScenarios[reason], `approvalScenarios[${reason}]`);
      await applyConsentMutation(s.consentId, reason);
      const { status, body } = await POST(
        `/api/admin/fee-deductions/${s.deductionId}/approve`,
        adminToken,
      );
      expect(status).toBe(409);
      expect(body.code).toBe(expectedReason(reason));
      expect(body.consentId).toBe(s.consentId);
      expect(body.ruleId).toBe(s.ruleId);

      // Deduction state untouched — still pending_approval, no
      // settledTransactionId, no approvedAt.
      const [d] = await db
        .select()
        .from(adviserFeeDeductions)
        .where(eq(adviserFeeDeductions.id, s.deductionId));
      expect(d.status).toBe("pending_approval");
      expect(d.settledTransactionId).toBeNull();
      expect(d.approvedAt).toBeNull();

      // Audit row recorded.
      const [audit] = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "deduction.approve.blocked"),
            eq(auditLogs.entityType, "adviser_fee_deduction"),
            eq(auditLogs.entityId, String(s.deductionId)),
          ),
        )
        .orderBy(desc(auditLogs.id))
        .limit(1);
      expect(audit).toBeDefined();
      const meta = audit.metadata as Record<string, any>;
      expect(meta.reason).toBe(expectedReason(reason));
      expect(meta.ruleId).toBe(s.ruleId);
    });
  }

  it("settles a deduction whose consent is healthy (happy path)", async () => {
    const s = requireScenario(approvalScenarios.happy, "approvalScenarios.happy");
    const { status, body } = await POST(
      `/api/admin/fee-deductions/${s.deductionId}/approve`,
      adminToken,
    );
    expect(status).toBe(200);
    expect(body.status).toBe("settled");
    expect(body.settledTransactionId).not.toBeNull();
    // Ledger pair was actually written.
    const entries = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, body.settledTransactionId));
    expect(entries.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// 5. Multi-rule deduction — every backing rule is checked, not just the first
// =============================================================================
describe("Deduction approval consent integrity gate — multi-rule (Task #476)", () => {
  it("refuses when ANY backing rule's consent is invalid (gap previously masked by 'first accrual only' check)", async () => {
    const m = requireScenario(multiRuleScenario, "multiRuleScenario");
    // ruleA's consent stays healthy. ruleB's consent is withdrawn. The
    // pre-fix code path inspected ONLY the first accrual's rule (ruleA)
    // and would have approved this deduction; the fixed path iterates
    // all distinct rules and refuses on ruleB.
    await applyConsentMutation(m.ruleB.consentId, "withdrawn");
    const { status, body } = await POST(
      `/api/admin/fee-deductions/${m.deductionId}/approve`,
      adminToken,
    );
    expect(status).toBe(409);
    expect(body.code).toBe("consent_withdrawn");
    expect(body.ruleId).toBe(m.ruleB.ruleId);

    const [d] = await db
      .select()
      .from(adviserFeeDeductions)
      .where(eq(adviserFeeDeductions.id, m.deductionId));
    expect(d.status).toBe("pending_approval");

    // The audit row records `rulesChecked` so an operator can see how many
    // backing rules were examined before the gate fired.
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "deduction.approve.blocked"),
          eq(auditLogs.entityType, "adviser_fee_deduction"),
          eq(auditLogs.entityId, String(m.deductionId)),
        ),
      )
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(audit).toBeDefined();
    const meta = audit.metadata as Record<string, unknown>;
    expect(meta.rulesChecked).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// 6. TOCTOU race — settleApprovedDeduction re-checks consent inside the tx
// -----------------------------------------------------------------------------
// The route layer's pre-check is the UX-friendly fast-fail. The race window
// it leaves open (consent withdrawn between pre-check and the start of the
// settle tx) is closed by an in-tx re-check inside settleApprovedDeduction.
// We exercise that path directly here: we never call the route, so the
// pre-check is skipped entirely. The consent is invalid by the time
// settleApprovedDeduction starts its tx — and it MUST refuse with
// ConsentNotValidError, leaving no transactions row, no ledger entries,
// no status flip.
// =============================================================================
describe("settleApprovedDeduction in-tx consent gate (Task #476 TOCTOU defense)", () => {
  it("throws ConsentNotValidError when the consent has been withdrawn since approval was clicked", async () => {
    // Build an isolated scenario with its OWN consent + rule + accrual +
    // deduction so this test cannot collide with the approval-route
    // scenarios above (the partial unique index
    // fee_consent_active_unique_idx forbids two active consents for the
    // same (client, adviser, fee_type, account_number)).
    const acctNumber = `${TAG}-toctou-race`;
    const consentId = await makeConsent("toctou-race");
    const ruleId = await makeRule({
      consentId,
      acctNumber,
      status: "active",
    });
    const [accrual] = await db
      .insert(adviserFeeAccruals)
      .values({
        feeRuleId: ruleId,
        clientUserId,
        adviserUserId,
        accrualDate: new Date(Date.UTC(2026, 6, 1)),
        accrualAmount: "1.0000",
        adviserShareAmount: "0.8000",
        platformShareAmount: "0.2000",
        currency: CURRENCY,
        gateReason: null,
      })
      .returning();
    const [deduction] = await db
      .insert(adviserFeeDeductions)
      .values({
        clientUserId,
        adviserUserId,
        periodStart: new Date(Date.UTC(2026, 6, 1)),
        periodEnd: new Date(Date.UTC(2026, 7, 1)),
        totalAccrued: "1.0000",
        adviserShareAmount: "0.8000",
        platformShareAmount: "0.2000",
        currency: CURRENCY,
        accrualIds: [accrual.id] as number[],
        status: "pending_approval",
      })
      .returning();
    const scenario = { consentId, ruleId, deductionId: deduction.id };
    // Withdraw the consent AFTER the deduction is staged but BEFORE the
    // settle entry-point runs — exactly mirrors the race the gate must
    // close.
    await db
      .update(feeConsents)
      .set({ withdrawnAt: new Date() })
      .where(eq(feeConsents.id, scenario.consentId));

    let caught: unknown = null;
    try {
      await settleApprovedDeduction({
        deductionId: scenario.deductionId,
        approverUserId: adminUserId,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConsentNotValidError);
    const e = caught as ConsentNotValidError;
    expect(e.gateReason).toBe("consent_withdrawn");
    expect(e.ruleId).toBe(scenario.ruleId);
    expect(e.consentId).toBe(scenario.consentId);

    // Deduction state untouched (failureReason got stamped but status
    // stays pending_approval, no settledTransactionId).
    const [d] = await db
      .select()
      .from(adviserFeeDeductions)
      .where(eq(adviserFeeDeductions.id, scenario.deductionId));
    expect(d.status).toBe("pending_approval");
    expect(d.settledTransactionId).toBeNull();

    // No transactions row exists for this deduction's deterministic
    // idempotency key — proves the rolled-back tx wrote nothing.
    const idemKey = `fee_deduction_${scenario.deductionId}`;
    const [txRow] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.idempotencyKey, idemKey));
    expect(txRow).toBeUndefined();

    // Audit row was written by the catch block with gate='consent' so
    // a regulator can find consent-driven refusals alongside Gate B.
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "fee_deduction_gate_blocked"),
          eq(auditLogs.entityType, "adviser_fee_deduction"),
          eq(auditLogs.entityId, String(scenario.deductionId)),
        ),
      )
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(audit).toBeDefined();
    const meta = audit.metadata as Record<string, any>;
    expect(meta.gate).toBe("consent");
    expect(meta.gateReason).toBe("consent_withdrawn");
    expect(meta.consentId).toBe(scenario.consentId);
    expect(meta.ruleId).toBe(scenario.ruleId);
  });
});

// =============================================================================
// 7a. Concurrency — the in-tx FOR UPDATE lock blocks a competing withdrawal
// =============================================================================
// Architect re-review surfaced that even with the in-tx consent re-check,
// READ COMMITTED leaves a race window: a concurrent UPDATE on
// fee_consents could commit AFTER our gate SELECT but BEFORE our ledger
// commit, posting money against a now-withdrawn consent. The
// assertConsentValidForExecution helper now accepts `lockForUpdate:true`
// which emits `SELECT ... FOR UPDATE` so the row is locked for the rest
// of the calling transaction. This test pins that contract: while one
// transaction holds the lock, a competing UPDATE blocks. Released only
// when the lock-holder commits/rolls back. Without the lock the
// competing UPDATE would return immediately.
// =============================================================================
describe("assertConsentValidForExecution lockForUpdate (Task #476 race closure)", () => {
  it("blocks a concurrent fee_consents UPDATE until the lock-holding tx commits", async () => {
    const consentId = await makeConsent("lock-race");

    // Drive the race by hand: tx1 acquires the row lock, then we kick
    // off tx2 (a competing withdrawal) WITHOUT awaiting it, prove tx2
    // is still pending after a short delay, then commit tx1 and prove
    // tx2 now resolves. We use an explicit "lock acquired" barrier
    // (signalLockAcquired) instead of a fixed sleep so the test can't
    // race past the lock acquisition under CI load.
    let releaseTx1: () => void = () => {};
    let signalLockAcquired: () => void = () => {};
    const tx1Held = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });
    const lockAcquired = new Promise<void>((resolve) => {
      signalLockAcquired = resolve;
    });
    const tx1Done = db.transaction(async (tx1) => {
      const result = await assertConsentValidForExecution(consentId, {
        executor: tx1,
        lockForUpdate: true,
      });
      expect(result.ok).toBe(true);
      // Lock is now held by tx1 — signal the test, then wait for the
      // explicit release before returning so the lock outlasts tx2's
      // competing UPDATE attempt.
      signalLockAcquired();
      await tx1Held;
    });

    // Wait until tx1 has actually acquired the lock (deterministic; not
    // a fixed sleep) before kicking off the racing tx2.
    await lockAcquired;

    let tx2Resolved = false;
    const tx2Done = db
      .transaction(async (tx2) => {
        await tx2
          .update(feeConsents)
          .set({ withdrawnAt: new Date() })
          .where(eq(feeConsents.id, consentId));
      })
      .then(() => {
        tx2Resolved = true;
      });

    // Wait long enough that, were the lock NOT held, tx2 would have
    // completed many times over. It must still be pending.
    await new Promise((r) => setTimeout(r, 400));
    expect(tx2Resolved).toBe(false);

    // Release tx1 → its commit drops the lock → tx2 unblocks and
    // commits its withdrawal.
    releaseTx1();
    await tx1Done;
    await tx2Done;
    expect(tx2Resolved).toBe(true);

    // And the withdrawal landed once the lock was released — proving
    // that without the lock it would have landed during tx1.
    const [c] = await db
      .select()
      .from(feeConsents)
      .where(eq(feeConsents.id, consentId));
    expect(c.withdrawnAt).not.toBeNull();
  }, 15000);
});

// =============================================================================
// 7. End-to-end — consent revoked between accrual and approval still refuses
// =============================================================================
describe("End-to-end: consent revoked AFTER accrual is still refused at approval (Task #476)", () => {
  it("refuses the approval even though the accrual was generated when the consent was healthy", async () => {
    const e = requireScenario(e2eScenario, "e2eScenario");
    // The accrual for e2eScenario was inserted with gateReason=null at
    // setup time (consent was healthy then). Now we withdraw the consent
    // — mirroring a regulator-triggered revocation — and the approval
    // chokepoint must still refuse rather than relying on the stale
    // accrual-time snapshot.
    await applyConsentMutation(e.consentId, "withdrawn");
    const { status, body } = await POST(
      `/api/admin/fee-deductions/${e.deductionId}/approve`,
      adminToken,
    );
    expect(status).toBe(409);
    expect(body.code).toBe("consent_withdrawn");

    // No transactions row was created against this deduction's
    // idempotency key (deterministic: fee_deduction_<id>).
    const idemKey = `fee_deduction_${e.deductionId}`;
    const [txRow] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.idempotencyKey, idemKey));
    expect(txRow).toBeUndefined();

    // Deduction stays in pending_approval.
    const [d] = await db
      .select()
      .from(adviserFeeDeductions)
      .where(eq(adviserFeeDeductions.id, e.deductionId));
    expect(d.status).toBe("pending_approval");
  });
});
