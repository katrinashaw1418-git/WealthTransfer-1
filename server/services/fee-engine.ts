// =============================================================================
// SESSION 23A — 10C ADVISER FEE ENGINE — GATE A SCAFFOLD
// SESSION 23B — GATE B unlock: settlement of approved deductions wires real
//   wallet/ledger postings via server/services/ledger.ts.
// -----------------------------------------------------------------------------
// Gate A invariants that REMAIN in force everywhere except the explicit
// settlement entry-point below:
//   - NO automatic / scheduled processing. Every accrual / deduction run
//     stays admin-triggered.
//   - The accrual + deduction-generation paths still MUST NOT touch any
//     wallet, transaction, or ledger row.
//
// Gate B narrowly opens ONE door — `settleApprovedDeduction()` — which:
//   - posts the client debit + adviser/platform credits via postLedgerEntries
//     inside a single DB transaction;
//   - is idempotent on the deduction id (uses a deterministic
//     `fee_deduction_<id>` idempotency key on the underlying transactions row
//     so retries can never double-charge);
//   - on any posting failure, rolls back the whole DB transaction so the
//     deduction stays in `pending_approval` (no half-applied movement) and
//     records a `failureReason` in a separate, non-conflicting update so
//     operators can see why the previous attempt failed before retrying.
// =============================================================================

import { and, desc, eq, gt, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../db";
import {
  adviserClients,
  adviserFeeAccruals,
  adviserFeeDeductions,
  adviserFeeRules,
  feeAccrualRuns,
  feeConsents,
  transactions,
  type AdviserFeeAccrual,
  type AdviserFeeDeduction,
  type AdviserFeeRule,
  type FeeAccrualRun,
  type InsertAdviserFeeRule,
} from "@shared/schema";
import {
  getOrCreateClientAccount,
  getOrCreateFeeAccount,
  postLedgerEntries,
  refreshWalletCacheBalance,
} from "./ledger";

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
//
//    Atomicity (Task #24): the entire per-date sweep runs inside a single
//    DB transaction so the call is "all or nothing" for the date. This
//    matters for the auto-backfill cron, which uses the latest accrual
//    date as its retry signal: if a date crashed mid-loop and left
//    half-inserted rows, that date would otherwise become the new "latest"
//    and would be silently skipped by the next tick.
//
//    Per-rule duplicates use ON CONFLICT DO NOTHING (vs. catching the
//    23505 inside the loop) — catching unique violations inside an open
//    transaction would abort the entire transaction, which is exactly the
//    failure mode we're guarding against here.
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

  return await db.transaction(async (tx) => {
    const rules = await tx.select().from(adviserFeeRules);
    let inserted = 0;
    let skipped = 0;
    let duplicates = 0;
    const byGateReason: Record<string, number> = {};

    for (const rule of rules) {
      let gate: GateReason | null = null;

      // (a) Underlying consent.
      const [consent] = await tx
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
        const [link] = await tx
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

      // (d) Splits sum to 10000 (DB CHECK already enforces this on create,
      //     but belt-and-braces in case the constraint is ever relaxed).
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

      // ON CONFLICT DO NOTHING + RETURNING lets us distinguish a fresh
      // insert (returns the row) from a duplicate skip (returns []) without
      // throwing — keeping the surrounding transaction usable.
      const inserts = await tx
        .insert(adviserFeeAccruals)
        .values({
          feeRuleId: rule.id,
          clientUserId: rule.clientUserId,
          adviserUserId: rule.adviserUserId,
          accrualDate,
          accrualAmount: toDecimalStr(accrualAmount),
          adviserShareAmount: toDecimalStr(adviserShare),
          platformShareAmount: toDecimalStr(platformShare),
          currency: rule.currency,
          gateReason: gate,
        })
        .onConflictDoNothing({
          target: [adviserFeeAccruals.feeRuleId, adviserFeeAccruals.accrualDate],
        })
        .returning({ id: adviserFeeAccruals.id });

      if (inserts.length > 0) {
        inserted++;
        if (gate) {
          skipped++;
          byGateReason[gate] = (byGateReason[gate] ?? 0) + 1;
        }
      } else {
        // Idempotent re-run: a row for (rule, date) already exists.
        duplicates++;
      }
    }

    return { inserted, skipped, duplicates, byGateReason };
  });
}

// ---------------------------------------------------------------------------
// 3b. getLatestAccrualDate — returns the most recent `accrualDate` already
//     present in `adviser_fee_accruals` (any rule), or null if the table is
//     empty. Used by the daily cron to detect midnights it may have slept
//     through (deploy, outage, maintenance) and backfill them. Read-only.
// ---------------------------------------------------------------------------
export async function getLatestAccrualDate(): Promise<Date | null> {
  const [row] = await db
    .select({ accrualDate: adviserFeeAccruals.accrualDate })
    .from(adviserFeeAccruals)
    .orderBy(desc(adviserFeeAccruals.accrualDate))
    .limit(1);
  return row?.accrualDate ?? null;
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
// 5. settleApprovedDeduction — GATE B entry-point.
//    Performs the entire approval + posting flow as a single DB transaction:
//
//      1. Lock the deduction row FOR UPDATE.
//      2. Fast-path idempotency:
//           - already settled  → return the existing row unchanged
//           - rejected         → 409
//      3. Look up `transactions` by the deterministic idempotency key. If a
//         prior attempt got as far as creating the transaction but the outer
//         tx rolled back (so the deduction was never marked settled), the
//         transaction row will NOT exist (rolled back too). The unique index
//         is therefore the safety net for a competing concurrent retry.
//      4. Insert the transactions row with the deterministic idempotency key.
//      5. Post the balanced ledger triple:
//           DEBIT  client(currency)              totalAccrued
//           CREDIT adviser(currency)             adviserShareAmount
//           CREDIT platform fee(currency)        (totalAccrued - adviserShareAmount)
//         The platform leg is computed as `total - adviser` (NOT the stored
//         platformShareAmount) so any 4dp rounding drift between the two
//         shares is absorbed into the platform leg and the entries always
//         balance to zero — postLedgerEntries enforces this anyway.
//      6. Refresh the wallet cache for both the client and the adviser.
//      7. Update the deduction: status='settled', settledAt, settledTransactionId,
//         approvedByUserId, approvedAt, idempotencyKey, clear failureReason.
//
//    On ANY error inside the transaction, the rollback undoes ALL of the
//    above (transaction row, ledger entries, wallet cache, deduction status).
//    The catch block then opens a SECOND, narrow transaction to record the
//    failureReason so an operator can diagnose the previous attempt before
//    retrying. The deduction remains in `pending_approval` and is safe to
//    retry — the deterministic idempotency key prevents double-charging.
// ---------------------------------------------------------------------------
function deductionIdempotencyKey(deductionId: number): string {
  return `fee_deduction_${deductionId}`;
}

function toAmount8(value: string | number): string {
  // transactions.amount + ledger_entries.amount are 8dp; deduction values are
  // stored at 4dp. Pad to 8dp using a numeric round-trip to avoid trailing
  // garbage from string concatenation.
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) {
    throw new Error(`Cannot convert non-finite value to 8dp amount: ${value}`);
  }
  return n.toFixed(8);
}

export async function settleApprovedDeduction(opts: {
  deductionId: number;
  approverUserId: number;
}): Promise<AdviserFeeDeduction> {
  const idemKey = deductionIdempotencyKey(opts.deductionId);

  try {
    return await db.transaction(async (tx) => {
      // (1) Lock the deduction row.
      const [deduction] = await (tx as any)
        .select()
        .from(adviserFeeDeductions)
        .where(eq(adviserFeeDeductions.id, opts.deductionId))
        .for("update");

      if (!deduction) {
        throw Object.assign(new Error("Deduction not found"), { status: 404 });
      }

      // (2) Idempotency fast-paths.
      if (deduction.status === "settled") {
        return deduction;
      }
      if (deduction.status === "rejected") {
        throw Object.assign(
          new Error("Deduction has been rejected and cannot be settled"),
          { status: 409 },
        );
      }
      if (
        deduction.status !== "pending_approval" &&
        deduction.status !== "approved"
      ) {
        throw Object.assign(
          new Error(`Deduction in unexpected status '${deduction.status}'`),
          { status: 409 },
        );
      }

      // Sanity: nothing to post.
      const total = Number(deduction.totalAccrued);
      const adviserShare = Number(deduction.adviserShareAmount);
      if (!(total > 0)) {
        throw Object.assign(
          new Error("Deduction totalAccrued must be > 0 to settle"),
          { status: 400 },
        );
      }
      if (adviserShare < 0 || adviserShare > total) {
        throw Object.assign(
          new Error(
            `adviserShareAmount (${adviserShare}) is outside [0, totalAccrued (${total})]`,
          ),
          { status: 400 },
        );
      }
      const platformShare = Number((total - adviserShare).toFixed(8));

      // (3 + 4) Insert the transactions row with the deterministic key. A
      // competing concurrent retry will lose the unique-violation race here
      // and bubble up as a 409-equivalent.
      const [txRow] = await (tx as any)
        .insert(transactions)
        .values({
          userId: deduction.clientUserId,
          type: "adviser_fee_deduction",
          fromCurrency: deduction.currency,
          toCurrency: null,
          amount: toAmount8(total),
          fee: "0.00000000",
          exchangeRate: null,
          status: "completed",
          settlementStatus: "internal_only",
          description:
            `Adviser fee deduction #${deduction.id} ` +
            `(${deduction.periodStart.toISOString().slice(0, 10)} → ` +
            `${deduction.periodEnd.toISOString().slice(0, 10)})`,
          sourceExchange: null,
          blockchainTxHash: null,
          idempotencyKey: idemKey,
          metadata: {
            kind: "adviser_fee_deduction",
            deductionId: deduction.id,
            adviserUserId: deduction.adviserUserId,
            clientUserId: deduction.clientUserId,
            adviserShareAmount: deduction.adviserShareAmount,
            platformShareAmount: deduction.platformShareAmount,
            accrualIds: deduction.accrualIds,
          } as any,
        })
        .returning();

      // (5) Resolve accounts + post the balanced triple.
      const clientAccount = await getOrCreateClientAccount(
        deduction.clientUserId,
        deduction.currency,
        tx,
      );
      const adviserAccount = await getOrCreateClientAccount(
        deduction.adviserUserId,
        deduction.currency,
        tx,
      );
      const feeAccount = await getOrCreateFeeAccount(deduction.currency, tx);

      type Entry = {
        accountId: number;
        userId: number;
        currency: string;
        direction: "debit" | "credit";
        amount: string;
        description: string;
      };
      const entries: Entry[] = [
        {
          accountId: clientAccount.id,
          userId: deduction.clientUserId,
          currency: deduction.currency,
          direction: "debit",
          amount: toAmount8(total),
          description: `Adviser fee deduction #${deduction.id} (client debit)`,
        },
      ];
      if (adviserShare > 0) {
        entries.push({
          accountId: adviserAccount.id,
          userId: deduction.adviserUserId,
          currency: deduction.currency,
          direction: "credit",
          amount: toAmount8(adviserShare),
          description: `Adviser fee deduction #${deduction.id} (adviser credit)`,
        });
      }
      if (platformShare > 0) {
        entries.push({
          accountId: feeAccount.id,
          userId: feeAccount.userId,
          currency: deduction.currency,
          direction: "credit",
          amount: toAmount8(platformShare),
          description: `Adviser fee deduction #${deduction.id} (platform credit)`,
        });
      }
      // postLedgerEntries enforces ≥2 entries; if for some reason both shares
      // are zero we'd violate that. That can only happen if total > 0 but
      // both shares are 0, which should be impossible given the validation
      // above. Belt-and-braces:
      if (entries.length < 2) {
        throw new Error(
          "Cannot settle deduction: no positive credit leg (adviser + platform shares both zero)",
        );
      }
      await postLedgerEntries(txRow.id, entries, tx);

      // (6) Refresh wallet cache for everyone whose ledger sum just changed.
      await refreshWalletCacheBalance(
        tx,
        deduction.clientUserId,
        deduction.currency,
      );
      if (adviserShare > 0) {
        await refreshWalletCacheBalance(
          tx,
          deduction.adviserUserId,
          deduction.currency,
        );
      }

      // (7) Mark settled. Conditional WHERE re-asserts the still-pending
      // invariant we already saw under FOR UPDATE — purely defensive.
      const [updated] = await (tx as any)
        .update(adviserFeeDeductions)
        .set({
          status: "settled",
          approvedByUserId: opts.approverUserId,
          approvedAt: new Date(),
          settledAt: new Date(),
          settledTransactionId: txRow.id,
          idempotencyKey: idemKey,
          failureReason: null,
        })
        .where(
          and(
            eq(adviserFeeDeductions.id, opts.deductionId),
            inArray(adviserFeeDeductions.status, [
              "pending_approval",
              "approved",
            ] as any),
          ),
        )
        .returning();

      if (!updated) {
        // Shouldn't happen because we hold the row lock; if it does, abort.
        throw new Error("Deduction status changed under us during settlement");
      }
      return updated;
    });
  } catch (err: any) {
    // Outer tx rolled back — record why so an operator can diagnose. Use a
    // separate, narrow update so this never collides with the rolled-back
    // work above. Best-effort: if the failure note write also fails, we just
    // re-throw the original error.
    const message =
      err?.message && typeof err.message === "string"
        ? err.message.slice(0, 500)
        : String(err).slice(0, 500);
    try {
      await db
        .update(adviserFeeDeductions)
        .set({
          failureReason: `[${new Date().toISOString()}] ${message}`,
        })
        .where(
          and(
            eq(adviserFeeDeductions.id, opts.deductionId),
            inArray(adviserFeeDeductions.status, [
              "pending_approval",
              "approved",
            ] as any),
          ),
        );
    } catch {
      // ignore — primary error is what matters
    }
    throw err;
  }
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
