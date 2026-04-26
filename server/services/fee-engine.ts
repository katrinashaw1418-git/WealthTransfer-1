// =============================================================================
// SESSION 23A — 10C ADVISER FEE ENGINE — GATE A SCAFFOLD
// -----------------------------------------------------------------------------
// HARD STOP. This service file is GATE A only:
//   - NO wallet debit, NO adviser credit, NO ledger posting,
//     NO transaction insert, NO reversal, NO investment execution.
//   - NO automatic / scheduled processing — every accrual / deduction run
//     in this layer is admin-triggered.
//
// Forbidden imports (enforced by code review):
//   * server/services/wallet*
//   * anything that calls insert(transactions) / insert(ledgerEntries)
//   * any cron / setInterval / scheduler
//
// What this file IS:
//   - Pure CRUD around adviserFeeRules / adviserFeeAccruals /
//     adviserFeeDeductions, with consent + link gating baked in.
//   - The single source of truth for "can this rule accrue today?"
// =============================================================================

import { and, eq, gt, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../db";
import {
  adviserClients,
  adviserFeeAccruals,
  adviserFeeDeductions,
  adviserFeeRules,
  feeAccrualRuns,
  feeConsents,
  type AdviserFeeAccrual,
  type AdviserFeeDeduction,
  type AdviserFeeRule,
  type FeeAccrualRun,
  type InsertAdviserFeeRule,
} from "@shared/schema";

export type GateReason =
  | "consent_missing"
  | "consent_withdrawn"
  | "consent_expired"
  | "link_inactive"
  | "rule_paused"
  | "splits_invalid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDecimalStr(n: number): string {
  // 4dp matches the schema column scale; we round-half-up to avoid silent
  // drift between accruals and the deduction roll-up.
  return n.toFixed(4);
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ---------------------------------------------------------------------------
// Daily accrual amount calculation (Gate A: simplified placeholder).
//
// In Gate A we ONLY model the per-rule daily amount and split. We do NOT
// touch any portfolio valuation source (no FUM lookup, no balance read).
// This is deliberate — Gate B will plug a real valuation provider in here.
// ---------------------------------------------------------------------------
export function computeAccrualForRule(rule: AdviserFeeRule): {
  accrualAmount: number;
  adviserShare: number;
  platformShare: number;
} {
  let dailyAmount = 0;
  if (rule.amountType === "fixed") {
    // Fixed monthly amount → naive daily = monthly / 30. Acceptable for the
    // scaffold; Gate B will use exact period-end roll-ups.
    const monthly = Number(rule.fixedAmount ?? 0);
    dailyAmount = monthly / 30;
  } else if (rule.amountType === "percentage") {
    // Without a portfolio balance feed in Gate A, percentage rules accrue 0.
    // The row is still inserted (with gateReason=null and amount=0) so the
    // rule's daily presence is audit-visible.
    dailyAmount = 0;
  }
  const adviserShare = (dailyAmount * rule.adviserSplitBps) / 10000;
  const platformShare = (dailyAmount * rule.platformSplitBps) / 10000;
  return {
    accrualAmount: Number(dailyAmount.toFixed(4)),
    adviserShare: Number(adviserShare.toFixed(4)),
    platformShare: Number(platformShare.toFixed(4)),
  };
}

// ---------------------------------------------------------------------------
// 1. createFeeRule — admin-only at the route layer.
//    Verifies the underlying feeConsent exists, is for the same
//    (adviser, client) pair, and is not withdrawn at create time.
//    DB CHECK enforces splits_total = 10000.
// ---------------------------------------------------------------------------
export async function createFeeRule(
  input: InsertAdviserFeeRule,
): Promise<AdviserFeeRule> {
  const [consent] = await db
    .select()
    .from(feeConsents)
    .where(eq(feeConsents.id, input.feeConsentId))
    .limit(1);
  if (!consent) {
    throw Object.assign(new Error("Fee consent not found"), { status: 404 });
  }
  if (consent.clientId !== input.clientUserId) {
    throw Object.assign(
      new Error("Consent client does not match rule clientUserId"),
      { status: 400 },
    );
  }
  if (consent.adviserId !== null && consent.adviserId !== input.adviserUserId) {
    throw Object.assign(
      new Error("Consent adviser does not match rule adviserUserId"),
      { status: 400 },
    );
  }
  if (consent.withdrawnAt) {
    throw Object.assign(
      new Error("Cannot create rule on a withdrawn consent"),
      { status: 400 },
    );
  }
  // Sanity: amountType payload alignment.
  if (input.amountType === "fixed") {
    const v = Number(input.fixedAmount ?? 0);
    if (!(v > 0)) {
      throw Object.assign(
        new Error("fixedAmount must be > 0 for amountType=fixed"),
        { status: 400 },
      );
    }
  } else if (input.amountType === "percentage") {
    const v = Number(input.rateBps ?? 0);
    if (!(v > 0 && v <= 10000)) {
      throw Object.assign(
        new Error("rateBps must be in (0, 10000] for amountType=percentage"),
        { status: 400 },
      );
    }
  } else {
    throw Object.assign(
      new Error(`Unsupported amountType '${input.amountType}'`),
      { status: 400 },
    );
  }

  const [row] = await db.insert(adviserFeeRules).values(input).returning();
  return row;
}

// ---------------------------------------------------------------------------
// 2. pauseFeeRule — admin-only. Idempotent: pausing a paused rule no-ops.
// ---------------------------------------------------------------------------
export async function pauseFeeRule(opts: {
  ruleId: number;
  reason: string | null;
}): Promise<AdviserFeeRule> {
  const [updated] = await db
    .update(adviserFeeRules)
    .set({
      status: "paused",
      pausedAt: new Date(),
      pausedReason: opts.reason ?? null,
      updatedAt: new Date(),
    })
    .where(eq(adviserFeeRules.id, opts.ruleId))
    .returning();
  if (!updated) {
    throw Object.assign(new Error("Fee rule not found"), { status: 404 });
  }
  return updated;
}

// ---------------------------------------------------------------------------
// 3. runDailyAccruals(date) — admin-triggered. For every rule (active OR
//    paused — paused still emits a zero/skip row so the audit trail is
//    continuous), evaluate the gate ladder and insert exactly one accrual
//    row per (rule, date). The unique index gives idempotency.
// ---------------------------------------------------------------------------
export async function runDailyAccruals(opts: {
  accrualDate: Date;
}): Promise<{
  inserted: number;
  skipped: number;
  duplicates: number;
  byGateReason: Record<string, number>;
}> {
  const accrualDate = startOfUtcDay(opts.accrualDate);

  const rules = await db.select().from(adviserFeeRules);
  let inserted = 0;
  let skipped = 0;
  let duplicates = 0;
  const byGateReason: Record<string, number> = {};

  for (const rule of rules) {
    let gate: GateReason | null = null;

    // (a) Underlying consent.
    const [consent] = await db
      .select()
      .from(feeConsents)
      .where(eq(feeConsents.id, rule.feeConsentId))
      .limit(1);
    if (!consent) {
      gate = "consent_missing";
    } else if (consent.withdrawnAt) {
      gate = "consent_withdrawn";
    } else if (
      consent.consentExpiryDate &&
      new Date(consent.consentExpiryDate).getTime() <= accrualDate.getTime()
    ) {
      gate = "consent_expired";
    }

    // (b) Adviser-client link still active.
    if (!gate) {
      const [link] = await db
        .select()
        .from(adviserClients)
        .where(
          and(
            eq(adviserClients.adviserUserId, rule.adviserUserId),
            eq(adviserClients.clientUserId, rule.clientUserId),
            eq(adviserClients.isActive, true),
          ),
        )
        .limit(1);
      if (!link) gate = "link_inactive";
    }

    // (c) Rule itself active.
    if (!gate && rule.status !== "active") gate = "rule_paused";

    // (d) Splits sum to 10000 (DB CHECK already enforces this on create, but
    //     belt-and-braces in case the constraint is ever relaxed).
    if (
      !gate &&
      Number(rule.adviserSplitBps) + Number(rule.platformSplitBps) !== 10000
    ) {
      gate = "splits_invalid";
    }

    let accrualAmount = 0;
    let adviserShare = 0;
    let platformShare = 0;
    if (!gate) {
      const c = computeAccrualForRule(rule);
      accrualAmount = c.accrualAmount;
      adviserShare = c.adviserShare;
      platformShare = c.platformShare;
    }

    try {
      await db.insert(adviserFeeAccruals).values({
        feeRuleId: rule.id,
        clientUserId: rule.clientUserId,
        adviserUserId: rule.adviserUserId,
        accrualDate,
        accrualAmount: toDecimalStr(accrualAmount),
        adviserShareAmount: toDecimalStr(adviserShare),
        platformShareAmount: toDecimalStr(platformShare),
        currency: rule.currency,
        gateReason: gate,
      });
      inserted++;
      if (gate) {
        skipped++;
        byGateReason[gate] = (byGateReason[gate] ?? 0) + 1;
      }
    } catch (err: any) {
      // Unique-violation on (rule, date) is the idempotency guarantee. The
      // re-run is a no-op — DON'T treat as inserted.
      if (
        String(err?.code) === "23505" ||
        /unique/i.test(String(err?.message ?? ""))
      ) {
        // Idempotent re-run: a row for (rule, date) already exists. Count it
        // separately from `inserted` / `skipped` so the cron / admin trigger
        // can surface "we re-ran today and N rows were already there".
        duplicates++;
      } else {
        throw err;
      }
    }
  }

  return { inserted, skipped, duplicates, byGateReason };
}

// ---------------------------------------------------------------------------
// 4. generatePendingDeductions(periodStart, periodEnd) — admin-triggered.
//    Rolls up all NON-skipped accruals in the half-open [start, end) window
//    by (clientUserId, adviserUserId) into deduction batches.
//
//    Idempotency: an accrual id can only roll up into ONE deduction. The
//    function therefore filters out accrual ids already referenced by an
//    existing deduction before grouping.
//
//    Status of every batch produced here is `pending_approval`. Approval is
//    a separate admin action — and even approval does NOT move money.
// ---------------------------------------------------------------------------
export async function generatePendingDeductions(opts: {
  periodStart: Date;
  periodEnd: Date;
}): Promise<{ batches: number; rolledUpAccruals: number }> {
  const start = startOfUtcDay(opts.periodStart);
  const end = startOfUtcDay(opts.periodEnd);
  if (!(end.getTime() > start.getTime())) {
    throw Object.assign(
      new Error("periodEnd must be after periodStart"),
      { status: 400 },
    );
  }

  // Pull existing accrualIds from any previous deduction so we never roll
  // the same accrual into a second batch.
  const existing = await db
    .select({ accrualIds: adviserFeeDeductions.accrualIds })
    .from(adviserFeeDeductions);
  const usedIds = new Set<number>();
  for (const row of existing) {
    const arr = (row.accrualIds as number[] | null) ?? [];
    for (const id of arr) usedIds.add(id);
  }

  // Window: [start, end). Skip gateReason rows — they represent zero-value
  // skips and have no money to roll up.
  const candidates = await db
    .select()
    .from(adviserFeeAccruals)
    .where(
      and(
        gte(adviserFeeAccruals.accrualDate, start),
        lte(adviserFeeAccruals.accrualDate, end),
        isNull(adviserFeeAccruals.gateReason),
      ),
    );

  // Group by (clientUserId, adviserUserId) — separate batch per pair.
  type Group = {
    clientUserId: number;
    adviserUserId: number;
    currency: string;
    accrualIds: number[];
    totalAccrued: number;
    adviserShare: number;
    platformShare: number;
  };
  const groups = new Map<string, Group>();
  let rolledUpAccruals = 0;

  for (const a of candidates) {
    if (usedIds.has(a.id)) continue;
    if (Number(a.accrualAmount) <= 0) continue;
    const k = `${a.clientUserId}|${a.adviserUserId}|${a.currency}`;
    let g = groups.get(k);
    if (!g) {
      g = {
        clientUserId: a.clientUserId,
        adviserUserId: a.adviserUserId,
        currency: a.currency,
        accrualIds: [],
        totalAccrued: 0,
        adviserShare: 0,
        platformShare: 0,
      };
      groups.set(k, g);
    }
    g.accrualIds.push(a.id);
    g.totalAccrued += Number(a.accrualAmount);
    g.adviserShare += Number(a.adviserShareAmount);
    g.platformShare += Number(a.platformShareAmount);
    rolledUpAccruals++;
  }

  let batches = 0;
  for (const g of Array.from(groups.values())) {
    await db.insert(adviserFeeDeductions).values({
      clientUserId: g.clientUserId,
      adviserUserId: g.adviserUserId,
      periodStart: start,
      periodEnd: end,
      totalAccrued: toDecimalStr(g.totalAccrued),
      adviserShareAmount: toDecimalStr(g.adviserShare),
      platformShareAmount: toDecimalStr(g.platformShare),
      currency: g.currency,
      accrualIds: g.accrualIds as any,
    });
    batches++;
  }
  return { batches, rolledUpAccruals };
}

// ---------------------------------------------------------------------------
// 5. approvePendingDeduction — STATUS FLIP + AUDIT ONLY.
//    Returning the updated row so the caller can write the audit entry in
//    the same outer transaction.
// ---------------------------------------------------------------------------
export async function approvePendingDeduction(opts: {
  deductionId: number;
  approverUserId: number;
}): Promise<AdviserFeeDeduction> {
  const updatedRows = await db
    .update(adviserFeeDeductions)
    .set({
      status: "approved",
      approvedByUserId: opts.approverUserId,
      approvedAt: new Date(),
    })
    .where(
      and(
        eq(adviserFeeDeductions.id, opts.deductionId),
        eq(adviserFeeDeductions.status, "pending_approval"),
      ),
    )
    .returning();
  if (!updatedRows[0]) {
    throw Object.assign(
      new Error("Deduction not found or not in pending_approval"),
      { status: 409 },
    );
  }
  return updatedRows[0];
}

// Re-export accrual type for convenience in route handlers that just need
// the select shape.
export type { AdviserFeeAccrual };

// ---------------------------------------------------------------------------
// 6. runDailyAccrualsAndRecord — wraps `runDailyAccruals` and writes one row
//    to `fee_accrual_runs` per invocation so admins can see the latest run
//    in the UI without scanning server logs.
//
// The recording happens whether the underlying run succeeded OR threw:
//   - On success: counts populated, errorMessage NULL, finishedAt set.
//   - On failure: counts all 0, errorMessage = err.message, finishedAt set,
//     and the original error is re-thrown so the caller's existing error
//     handling / logging continues to work.
//
// This is a thin wrapper on top of the gated CRUD primitive — it does not
// move money, schedule itself, or interact with wallets / ledger.
// ---------------------------------------------------------------------------
export async function runDailyAccrualsAndRecord(opts: {
  accrualDate: Date;
  trigger: "cron" | "manual";
  triggeredByUserId: number | null;
}): Promise<{
  run: FeeAccrualRun;
  inserted: number;
  skipped: number;
  duplicates: number;
  byGateReason: Record<string, number>;
}> {
  const accrualDate = startOfUtcDay(opts.accrualDate);
  try {
    const summary = await runDailyAccruals({ accrualDate });
    const [row] = await db
      .insert(feeAccrualRuns)
      .values({
        accrualDate,
        trigger: opts.trigger,
        triggeredByUserId: opts.triggeredByUserId,
        inserted: summary.inserted,
        skipped: summary.skipped,
        duplicates: summary.duplicates,
        byGateReason: summary.byGateReason as any,
        errorMessage: null,
        finishedAt: new Date(),
      })
      .returning();
    return { run: row, ...summary };
  } catch (err: any) {
    // Best-effort record of the failure. If THIS insert also fails we let it
    // bubble up alongside the original error — silent failure here would
    // defeat the whole point of the table.
    await db.insert(feeAccrualRuns).values({
      accrualDate,
      trigger: opts.trigger,
      triggeredByUserId: opts.triggeredByUserId,
      inserted: 0,
      skipped: 0,
      duplicates: 0,
      byGateReason: {} as any,
      errorMessage: String(err?.message ?? err),
      finishedAt: new Date(),
    });
    throw err;
  }
}
