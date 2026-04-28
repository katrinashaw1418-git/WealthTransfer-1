// =============================================================================
// SESSION 23A — 10C ADVISER FEE ENGINE — GATE A SCAFFOLD
// SESSION 23B — GATE B unlock: settlement of approved deductions wires real
//   wallet/ledger postings via server/services/ledger.ts.
// TASK #33 — REVERSAL: an admin-initiated unwind of a settled deduction. Posts
//   the OPPOSITE balanced ledger triple against a NEW transactions row using a
//   deterministic `fee_deduction_<id>_reversal` idempotency key. The original
//   settled_* fields on the deduction are NEVER edited — history is append-
//   only; the reversal pointer lives in `reversal_transaction_id`.
// -----------------------------------------------------------------------------
// Gate A invariants that REMAIN in force everywhere except the explicit
// settlement / reversal entry-points below:
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

import { and, desc, eq, gt, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
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
  getAccountBalance,
  getOrCreateClientAccount,
  getOrCreateFeeAccount,
  postLedgerEntries,
  refreshWalletCacheBalance,
} from "./ledger";
import { assertKillSwitchOff } from "./kill-switch";
import { writeAuditLog } from "./audit";
// Task #307 — single source of truth for "is this consent legally valid for
// execution right now?". Lifted out of the inline gate ladder below so the
// deduction-approve and rule-resume execution chokepoints share the same
// definition (and the same gateReason vocabulary) as the daily accrual job.
import {
  assertConsentValidForExecution,
  validateRuleAmountAgainstConsent,
} from "./consent-integrity";

// Task #294 — terminal lifecycle states a rule can land in. Any rule already
// in one of these states is invisible to createFeeRule (the supersede pass
// only flips active rules) and to reconcileRuleConsentState (idempotent — a
// terminal row is left alone). Kept as a Set so call sites can `.has()` in
// O(1) instead of array `.includes()` traversal in hot loops.
const TERMINAL_RULE_STATUSES = new Set(["superseded", "expired"]);
export const NON_TERMINAL_RULE_STATUSES = ["draft", "active", "paused"] as const;

// ---------------------------------------------------------------------------
// Task #34 — Insufficient funds guard.
// Thrown by `settleApprovedDeduction` when the client's available balance in
// the deduction's currency cannot cover `totalAccrued`. Carries the required
// vs available figures so the admin UI / audit trail can surface the gap
// without re-querying. The named class lets the catch block branch on the
// failure mode and flip the deduction to its own `insufficient_funds` status
// (rather than the generic pending_approval+failureReason recovery state),
// so admins can filter for "client can't pay" separately from "settlement
// crashed for some other reason".
// ---------------------------------------------------------------------------
export class InsufficientFundsError extends Error {
  readonly status = 409;
  readonly userId: number;
  readonly currency: string;
  readonly required: string;
  readonly available: string;
  constructor(
    userId: number,
    currency: string,
    required: string,
    available: string,
  ) {
    super(
      `Insufficient ${currency} balance for client #${userId}: ` +
        `required ${required}, available ${available}`,
    );
    this.name = "InsufficientFundsError";
    this.userId = userId;
    this.currency = currency;
    this.required = required;
    this.available = available;
  }
}

export type GateReason =
  | "consent_missing"
  | "consent_withdrawn"
  | "consent_expired"
  | "consent_renewal_inactive"
  | "link_inactive"
  | "rule_paused"
  | "rule_superseded"
  | "rule_expired"
  | "rule_draft"
  | "splits_invalid";

// ---------------------------------------------------------------------------
// Task #325 — Gate B per-rule status guard.
// Thrown by `settleApprovedDeduction` when at least one rule that contributed
// accruals to the deduction is no longer in 'active' status (typically because
// reconcileRuleConsentState paused it for consent_withdrawn or expired it).
// Carries the offending rule's id, current status, and a stable gateReason
// string so the catch block can record both an audit row and a clear
// failureReason without re-fetching. The 409 status mirrors the
// "deduction in unexpected state" siblings already raised by this function.
// ---------------------------------------------------------------------------
export class RuleNotActiveError extends Error {
  readonly status = 409;
  readonly ruleId: number;
  readonly ruleStatus: string;
  readonly gateReason: GateReason;
  constructor(ruleId: number, ruleStatus: string, gateReason: GateReason) {
    super(
      `Cannot settle deduction: contributing rule #${ruleId} is in status ` +
        `'${ruleStatus}' (gateReason='${gateReason}')`,
    );
    this.name = "RuleNotActiveError";
    this.ruleId = ruleId;
    this.ruleStatus = ruleStatus;
    this.gateReason = gateReason;
  }
}

function ruleStatusToGateReason(status: string): GateReason {
  switch (status) {
    case "paused":
      return "rule_paused";
    case "superseded":
      return "rule_superseded";
    case "expired":
      return "rule_expired";
    case "draft":
      return "rule_draft";
    default:
      // Defensive: any unknown non-active status collapses to rule_paused so
      // the gate still blocks (and the audit trail still carries a value the
      // admin UI knows how to render).
      return "rule_paused";
  }
}

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
//
// Task #294 — auto-supersede chain.
//    A new rule for the same (clientUserId, feeType, accountNumber)
//    atomically supersedes any existing draft/active rule for that tuple
//    inside ONE DB transaction. The previous row's status flips to
//    'superseded', supersededByRuleId points at the new row, and an audit
//    line is written for the transition. The DB partial unique index
//    (`adviser_fee_rules_supersede_uniq`) is the hard backstop — if the
//    application path is ever bypassed, the index blocks the second insert
//    rather than letting two concurrent active rules ever coexist.
// ---------------------------------------------------------------------------
export interface CreateFeeRuleOpts {
  // Override the wall clock — used by tests so the supersededAt /
  // effectiveDate stamps land on a deterministic instant. Defaults to "now".
  now?: Date;
  // The user performing the create — used as the actor on the audit row for
  // any rule(s) auto-superseded by this insert. Pass `null` for system /
  // backfill paths (the audit line will record `userId=null`).
  actorUserId?: number | null;
  // Optional explicit effectiveDate for back-dating a rule. Defaults to `now`.
  effectiveDate?: Date | null;
  // Optional reason recorded against any superseded rules. Defaults to
  // `"replaced_by_new_rule"` so the audit trail explains the transition
  // without forcing every caller to invent a string.
  supersedeReason?: string;
}

export async function createFeeRule(
  input: InsertAdviserFeeRule,
  opts: CreateFeeRuleOpts = {},
): Promise<AdviserFeeRule> {
  const now = opts.now ?? new Date();
  const actorUserId = opts.actorUserId ?? null;
  const supersedeReason = opts.supersedeReason ?? "replaced_by_new_rule";

  return await db.transaction(async (tx) => {
    const [consent] = await tx
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

    // Task #307 — parameter equality between rule and consent. Closes the
    // class of bug where a $150 ongoing-fee consent shipped with a $495
    // adviser_fee_rule attached. The DB trigger installed by
    // installFeeRuleAmountEqualityTrigger is the hard backstop — this
    // service-layer call produces the friendly 400 message before the
    // trigger fires its check_violation.
    validateRuleAmountAgainstConsent(
      {
        amountType: input.amountType,
        fixedAmount: (input.fixedAmount as string | number | null | undefined) ?? null,
        rateBps: (input.rateBps as number | null | undefined) ?? null,
      },
      consent,
    );

    // Account number always comes from the consent — never trusted from the
    // client / route input. This is the field the partial unique index
    // is keyed on, so taking it from the consent guarantees the supersede
    // pass below catches the right historical row.
    const accountNumber = consent.accountNumber;

    // Find any existing non-terminal rule for the same (client, feeType,
    // accountNumber). FOR UPDATE locks the row(s) so a concurrent createFeeRule
    // cannot race past us between SELECT and UPDATE — without the lock two
    // simultaneous creates could both see "no existing rule", both insert,
    // and the second insert would only fail at the DB unique-index level
    // with a confusing 23505. Locking turns the race into a serial wait.
    const existing = await tx
      .select()
      .from(adviserFeeRules)
      .where(
        and(
          eq(adviserFeeRules.clientUserId, input.clientUserId),
          eq(adviserFeeRules.feeType, input.feeType),
          eq(adviserFeeRules.accountNumber, accountNumber),
          inArray(adviserFeeRules.status, ["draft", "active", "paused"]),
        ),
      )
      .for("update");

    // We must flip the predecessors out of the partial unique index's
    // predicate (status IN ('draft','active')) BEFORE inserting the new row,
    // otherwise the insert collides with the still-active predecessor at
    // statement-end. Postgres partial unique indexes are not deferrable,
    // so the only safe path is: (1) set the predecessor to 'superseded'
    // with a temporary self-pointer for supersededByRuleId so the
    // supersede_chain_chk (status='superseded' ⇒ supersededByRuleId IS NOT
    // NULL) stays satisfied, (2) insert the new row, (3) re-point each
    // predecessor's supersededByRuleId at the new row's id. All three
    // happen inside the same tx so an outside reader never observes the
    // self-pointer state.
    for (const prev of existing) {
      await tx
        .update(adviserFeeRules)
        .set({
          status: "superseded",
          supersededByRuleId: prev.id, // temp self-pointer; fixed in step 3
          supersededAt: now,
          supersededReason: supersedeReason,
          updatedAt: now,
        })
        .where(eq(adviserFeeRules.id, prev.id));
    }

    const [inserted] = await tx
      .insert(adviserFeeRules)
      .values({
        ...input,
        accountNumber,
        effectiveDate: opts.effectiveDate ?? now,
        // status defaults to 'active' from the schema column default.
      })
      .returning();

    // Step 3: re-point each predecessor at the new row and write the audit
    // line. The audit's `before` reflects the state observed in step 0
    // (the original `prev` row before any of our writes touched it) so the
    // self-pointer transient never appears in the audit trail.
    for (const prev of existing) {
      const [updated] = await tx
        .update(adviserFeeRules)
        .set({ supersededByRuleId: inserted.id, updatedAt: now })
        .where(eq(adviserFeeRules.id, prev.id))
        .returning();

      await writeAuditLog({
        executor: tx,
        userId: actorUserId,
        action: "fee_rule_superseded",
        entityType: "adviser_fee_rule",
        entityId: String(prev.id),
        before: {
          status: prev.status,
          supersededByRuleId: prev.supersededByRuleId,
          supersededAt: prev.supersededAt,
          supersededReason: prev.supersededReason,
        },
        after: {
          status: updated.status,
          supersededByRuleId: updated.supersededByRuleId,
          supersededAt: updated.supersededAt,
          supersededReason: updated.supersededReason,
        },
        extra: {
          replacedByRuleId: inserted.id,
          clientUserId: prev.clientUserId,
          feeType: prev.feeType,
          accountNumber: prev.accountNumber,
        },
      });
    }

    return inserted;
  });
}

// ---------------------------------------------------------------------------
// Task #294 — reconcileRuleConsentState
// ---------------------------------------------------------------------------
// Walks every non-terminal fee rule and aligns its lifecycle state with the
// underlying consent row:
//
//   * consent.withdrawnAt set, rule still non-paused →
//       PAUSE the rule with pausedReason='consent_withdrawn'.
//
//   * consent.renewalStatus = 'expired' OR consentExpiryDate <= now →
//       EXPIRE the rule (terminal). A future renewal will require a fresh
//       consent + fresh createFeeRule call — we deliberately don't auto-
//       resurrect, because expiry is a legal event, not a transient state.
//
// Idempotent — a rule already in the target state is left alone (no audit
// row, no UPDATE). Each transition writes one audit line so a regulator can
// trace the system action that touched the rule. Returns a summary so the
// daily cron / admin button can surface "checked X, expired Y, paused Z".
// ---------------------------------------------------------------------------
export interface ReconcileRuleConsentStateOpts {
  now?: Date;
  // The user performing the reconcile — typically `null` for the daily cron
  // (system-driven) or the admin's userId when triggered manually.
  actorUserId?: number | null;
}

export interface ReconcileRuleConsentStateSummary {
  checked: number;
  expired: number;
  pausedForWithdrawal: number;
  alreadyAligned: number;
  consentMissing: number;
  // Task #324 — ISO timestamp of the `now` value used for this run. Mirrors
  // the `triggeredAt` field stamped on each per-rule audit line so the
  // rollup audit row written by the cron / admin endpoint can carry the
  // same value, which is what the "consent reconciliation history" admin
  // UI uses to correlate a run row to its per-rule transitions.
  triggeredAt: string;
}

export async function reconcileRuleConsentState(
  opts: ReconcileRuleConsentStateOpts = {},
): Promise<ReconcileRuleConsentStateSummary> {
  const now = opts.now ?? new Date();
  const actorUserId = opts.actorUserId ?? null;

  return await db.transaction(async (tx) => {
    // Walk EVERY non-terminal rule. The rule volume is small (one row per
    // (client, feeType, account) tuple per renewal cycle) so a full scan
    // each tick is cheaper than maintaining a separate worklist table.
    const rules = await tx
      .select()
      .from(adviserFeeRules)
      .where(inArray(adviserFeeRules.status, ["draft", "active", "paused"]));

    let expired = 0;
    let pausedForWithdrawal = 0;
    let alreadyAligned = 0;
    let consentMissing = 0;

    for (const rule of rules) {
      const [consent] = await tx
        .select()
        .from(feeConsents)
        .where(eq(feeConsents.id, rule.feeConsentId))
        .limit(1);

      // A missing consent is a data-integrity bug — surface it in the
      // summary but do not transition the rule. Any later daily accrual
      // will gate the rule with consent_missing anyway, so the rule is
      // effectively dormant; we leave reconciliation of the orphan to a
      // human operator (could be a manual cleanup or a fix-forward script).
      if (!consent) {
        consentMissing += 1;
        continue;
      }

      const isExpiredByDate =
        consent.consentExpiryDate &&
        new Date(consent.consentExpiryDate).getTime() <= now.getTime();
      const isExpiredByStatus = consent.renewalStatus === "expired";
      const shouldExpire = isExpiredByDate || isExpiredByStatus;
      const shouldPauseForWithdrawal =
        !shouldExpire && consent.withdrawnAt !== null;

      // Expiry takes precedence over withdrawal — both are legitimate
      // signals, but expired is the more permanent legal state and is
      // terminal. A consent that is both withdrawn AND expired collapses
      // to expired so the rule cannot be silently revived by an unpause.
      if (shouldExpire) {
        if (rule.status === "expired") {
          alreadyAligned += 1;
          continue;
        }
        const [updated] = await tx
          .update(adviserFeeRules)
          .set({
            status: "expired",
            updatedAt: now,
          })
          .where(eq(adviserFeeRules.id, rule.id))
          .returning();
        await writeAuditLog({
          executor: tx,
          userId: actorUserId,
          action: "fee_rule_consent_reconciled",
          entityType: "adviser_fee_rule",
          entityId: String(rule.id),
          before: { status: rule.status },
          after: { status: updated.status },
          extra: {
            transition: "expired",
            consentId: consent.id,
            consentRenewalStatus: consent.renewalStatus,
            consentExpiryDate: consent.consentExpiryDate,
            consentWithdrawnAt: consent.withdrawnAt,
            triggeredAt: now.toISOString(),
          },
        });
        expired += 1;
        continue;
      }

      if (shouldPauseForWithdrawal) {
        if (rule.status === "paused" && rule.pausedReason === "consent_withdrawn") {
          alreadyAligned += 1;
          continue;
        }
        const [updated] = await tx
          .update(adviserFeeRules)
          .set({
            status: "paused",
            pausedAt: now,
            pausedReason: "consent_withdrawn",
            updatedAt: now,
          })
          .where(eq(adviserFeeRules.id, rule.id))
          .returning();
        await writeAuditLog({
          executor: tx,
          userId: actorUserId,
          action: "fee_rule_consent_reconciled",
          entityType: "adviser_fee_rule",
          entityId: String(rule.id),
          before: {
            status: rule.status,
            pausedAt: rule.pausedAt,
            pausedReason: rule.pausedReason,
          },
          after: {
            status: updated.status,
            pausedAt: updated.pausedAt,
            pausedReason: updated.pausedReason,
          },
          extra: {
            transition: "paused_consent_withdrawn",
            consentId: consent.id,
            consentRenewalStatus: consent.renewalStatus,
            consentExpiryDate: consent.consentExpiryDate,
            consentWithdrawnAt: consent.withdrawnAt,
            triggeredAt: now.toISOString(),
          },
        });
        pausedForWithdrawal += 1;
        continue;
      }

      alreadyAligned += 1;
    }

    return {
      checked: rules.length,
      expired,
      pausedForWithdrawal,
      alreadyAligned,
      consentMissing,
      triggeredAt: now.toISOString(),
    };
  });
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

      // (a) Underlying consent — Task #307 lifts the four consent gates into
      // the shared assertConsentValidForExecution helper so this loop, the
      // deduction-approve chokepoint and the rule-resume admin action all
      // produce the same gateReason vocabulary against the same definition.
      const consentCheck = await assertConsentValidForExecution(rule.feeConsentId, {
        executor: tx,
        now: accrualDate,
      });
      if (!consentCheck.ok) {
        gate = consentCheck.reason;
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
  // Task #146 — kill switch. Specific `fee_deductions` first, then the
  // master `transactions` switch (a settled deduction creates a
  // `transactions` row, so the master kill must also block it). Thrown
  // BEFORE the DB transaction so a hit produces no half-state.
  await assertKillSwitchOff("fee_deductions", "transactions");

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
      // `insufficient_funds` (Task #34) is treated as a retry-able starting
      // state alongside the regular pending/approved states — the admin can
      // top up the client and click Retry, and the catch-block flip below
      // will rewrite the failureReason on the next attempt.
      if (
        deduction.status !== "pending_approval" &&
        deduction.status !== "approved" &&
        deduction.status !== "insufficient_funds"
      ) {
        throw Object.assign(
          new Error(`Deduction in unexpected status '${deduction.status}'`),
          { status: 409 },
        );
      }

      // ---------------------------------------------------------------
      // Task #325 — Gate B: per-rule status guard.
      //
      // A deduction is rolled up from one or more `adviserFeeAccruals`
      // rows; each accrual carries a `feeRuleId` pointing back at the
      // rule that produced it. Between the moment the deduction was
      // generated and the moment we are now trying to settle it, the
      // upstream `reconcileRuleConsentState` cron (Task #294) — or an
      // admin pressing "Pause" — may have flipped one of those rules
      // out of 'active' (paused for consent_withdrawn, expired, or
      // superseded). Posting the wallet/ledger triple anyway would be
      // exactly the "real money charged on a rule whose consent was
      // withdrawn" failure this gate exists to prevent.
      //
      // We therefore look up every distinct rule referenced by this
      // deduction's accruals and refuse if any one of them is no longer
      // active. Throwing inside the tx means the transactions row, the
      // ledger pair, and the wallet cache refresh are all rolled back;
      // the catch block below records the gate hit in the audit log
      // and writes a clear failureReason on the deduction so admins
      // can see *why* settlement was refused without grepping logs.
      //
      // The check is positioned BEFORE the insufficient-funds check so
      // that a paused rule + zero balance produces a `gateReason` audit
      // line rather than an `InsufficientFundsError` — the rule status
      // is the more informative failure mode for an operator.
      // ---------------------------------------------------------------
      const accrualIdsRaw =
        (deduction.accrualIds as number[] | null) ?? [];
      if (accrualIdsRaw.length > 0) {
        const accrualRows = await tx
          .select({
            id: adviserFeeAccruals.id,
            feeRuleId: adviserFeeAccruals.feeRuleId,
          })
          .from(adviserFeeAccruals)
          .where(inArray(adviserFeeAccruals.id, accrualIdsRaw));
        const ruleIds = Array.from(
          new Set(accrualRows.map((a) => a.feeRuleId)),
        );
        if (ruleIds.length > 0) {
          const contributingRules = await tx
            .select({
              id: adviserFeeRules.id,
              status: adviserFeeRules.status,
            })
            .from(adviserFeeRules)
            .where(inArray(adviserFeeRules.id, ruleIds));
          for (const r of contributingRules) {
            if (r.status !== "active") {
              throw new RuleNotActiveError(
                r.id,
                r.status,
                ruleStatusToGateReason(r.status),
              );
            }
          }
        }
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

      // ---------------------------------------------------------------
      // Task #34 — Insufficient-funds gate.
      // The ledger does not enforce non-negative balances on its own, so
      // without this check `settleApprovedDeduction` would happily post a
      // debit larger than the client's balance and silently overdraw the
      // wallet cache (or, with the wallets check constraint in place,
      // crash with a confusing CHECK violation late in the transaction
      // AFTER the transactions/ledger rows have been written and rolled
      // back). We resolve the client account up-front and read its
      // ledger-derived balance inside this same tx so the snapshot is
      // consistent with what postLedgerEntries will see; if the balance
      // can't cover `total` we throw an InsufficientFundsError. The
      // outer catch block flips the deduction to `insufficient_funds`
      // with a clear failureReason — no transactions row, no ledger
      // entries, no wallet cache change.
      // ---------------------------------------------------------------
      const clientAccount = await getOrCreateClientAccount(
        deduction.clientUserId,
        deduction.currency,
        tx,
      );
      const balanceStr = await getAccountBalance(clientAccount.id, tx);
      const available = Number(balanceStr);
      // 1e-8 matches the smallest-unit epsilon postLedgerEntries uses for
      // its balance check; anything within that margin is treated as
      // numerically equal so we don't reject due to floating-point dust.
      const FUNDS_EPSILON = 1e-8;
      if (!Number.isFinite(available) || available + FUNDS_EPSILON < total) {
        throw new InsufficientFundsError(
          deduction.clientUserId,
          deduction.currency,
          toAmount8(total),
          toAmount8(Number.isFinite(available) && available > 0 ? available : 0),
        );
      }

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
      // `clientAccount` was already resolved above as part of the
      // insufficient-funds gate — reuse that handle so we don't issue a
      // redundant SELECT for the same row.
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
              "insufficient_funds",
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
    // Task #34: when the failure mode is specifically "client can't pay",
    // flip the deduction to its own `insufficient_funds` status so admins
    // can filter/triage these separately from generic settlement crashes.
    // The status flip is gated on the same retry-eligible starting states
    // the inner transaction permits, so we never overwrite a row that has
    // already moved on (e.g. settled by a competing retry).
    const isInsufficient = err instanceof InsufficientFundsError;
    try {
      await db
        .update(adviserFeeDeductions)
        .set({
          ...(isInsufficient ? { status: "insufficient_funds" as any } : {}),
          failureReason: `[${new Date().toISOString()}] ${message}`,
        })
        .where(
          and(
            eq(adviserFeeDeductions.id, opts.deductionId),
            inArray(adviserFeeDeductions.status, [
              "pending_approval",
              "approved",
              "insufficient_funds",
            ] as any),
          ),
        );
    } catch {
      // ignore — primary error is what matters
    }
    // Task #325 — Gate B: when the gate refused settlement, persist a
    // dedicated audit row so the regulator trail records the gate hit
    // (with its gateReason) independently of the generic
    // `fee_deduction_settle_failed` row the HTTP route layer writes. The
    // audit insert lives OUTSIDE the rolled-back transaction so the row
    // survives the rollback. Best-effort — if the audit write itself
    // fails, the operator-alert path inside writeAuditLog still pages,
    // and we still re-throw the original gate error below.
    if (err instanceof RuleNotActiveError) {
      try {
        await writeAuditLog({
          userId: opts.approverUserId,
          action: "fee_deduction_gate_blocked",
          entityType: "adviser_fee_deduction",
          entityId: String(opts.deductionId),
          before: null,
          after: null,
          extra: {
            gateReason: err.gateReason,
            ruleId: err.ruleId,
            ruleStatus: err.ruleStatus,
            gate: "B",
            approverUserId: opts.approverUserId,
            errorMessage: message,
          },
        });
      } catch {
        // ignore — primary error is what matters
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 5b. reverseSettledDeduction — TASK #33 entry-point.
//   Mirrors `settleApprovedDeduction` but posts the OPPOSITE balanced ledger
//   triple against a NEW transactions row. The original `settled_*` columns
//   on the deduction are NEVER edited — history is append-only. Reversal
//   metadata (reversedAt, reversedByUserId, reversedReason,
//   reversalTransactionId) is populated atomically inside the same DB
//   transaction as the reversing ledger pair.
//
//   Flow (single DB transaction):
//     1. Lock the deduction row FOR UPDATE.
//     2. Idempotency / state checks:
//          - already reversed → return existing row unchanged
//          - not currently 'settled' → 409
//          - missing settledTransactionId (defensive) → 500-shaped throw
//     3. Insert a NEW transactions row with the deterministic reversal key
//        `fee_deduction_<id>_reversal`. UNIQUE(idempotency_key) on
//        transactions is the safety net for a competing concurrent retry.
//     4. Resolve the same three accounts (client, adviser, fee).
//     5. Post the OPPOSITE balanced triple:
//          CREDIT client(currency)              totalAccrued
//          DEBIT  adviser(currency)             adviserShareAmount
//          DEBIT  platform fee(currency)        (totalAccrued - adviserShareAmount)
//        Platform leg is computed as `total - adviser` so any 4dp rounding
//        drift between the two stored shares is absorbed there and the
//        triple always balances; postLedgerEntries enforces this anyway.
//     6. Refresh the wallet cache for both the client and the adviser.
//     7. Update the deduction: status='reversed', reversedAt,
//        reversedByUserId, reversedReason, reversalTransactionId.
//        Conditional WHERE re-asserts status='settled' under the row lock.
//
//   On ANY error the transaction rolls back: no transactions row, no ledger
//   entries, no wallet cache change, no status flip — the deduction stays
//   `settled` and is safe to retry. The deterministic reversal idempotency
//   key prevents double-posting on retry.
// ---------------------------------------------------------------------------
function reversalIdempotencyKey(deductionId: number): string {
  return `fee_deduction_${deductionId}_reversal`;
}

export async function reverseSettledDeduction(opts: {
  deductionId: number;
  reverserUserId: number;
  reason: string;
}): Promise<AdviserFeeDeduction> {
  // Task #146 — kill switch. Reversal still posts ledger entries + a new
  // `transactions` row, so both `fee_deductions` and the master
  // `transactions` switch must allow it.
  await assertKillSwitchOff("fee_deductions", "transactions");

  const reason = (opts.reason ?? "").trim();
  if (!reason) {
    throw Object.assign(new Error("Reversal reason is required"), { status: 400 });
  }
  if (reason.length > 1000) {
    throw Object.assign(
      new Error("Reversal reason must be 1000 characters or fewer"),
      { status: 400 },
    );
  }

  const idemKey = reversalIdempotencyKey(opts.deductionId);

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

    // (2) Idempotency / state checks.
    if (deduction.status === "reversed") {
      return deduction;
    }
    if (deduction.status !== "settled") {
      throw Object.assign(
        new Error(
          `Only settled deductions can be reversed (current status: '${deduction.status}')`,
        ),
        { status: 409 },
      );
    }
    if (!deduction.settledTransactionId) {
      throw Object.assign(
        new Error(
          "Deduction is marked settled but has no settledTransactionId — refusing to reverse",
        ),
        { status: 500 },
      );
    }

    const total = Number(deduction.totalAccrued);
    const adviserShare = Number(deduction.adviserShareAmount);
    if (!(total > 0)) {
      throw Object.assign(
        new Error("Deduction totalAccrued must be > 0 to reverse"),
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

    // (3) Insert the reversal transactions row with the deterministic key.
    // A competing concurrent retry will lose the unique-violation race here
    // and surface as a 23505 / 5xx — the caller can simply re-fetch and see
    // the deduction in 'reversed' state.
    const [txRow] = await (tx as any)
      .insert(transactions)
      .values({
        userId: deduction.clientUserId,
        type: "adviser_fee_deduction_reversal",
        fromCurrency: deduction.currency,
        toCurrency: null,
        amount: toAmount8(total),
        fee: "0.00000000",
        exchangeRate: null,
        status: "completed",
        settlementStatus: "internal_only",
        description:
          `Reversal of adviser fee deduction #${deduction.id} ` +
          `(${deduction.periodStart.toISOString().slice(0, 10)} → ` +
          `${deduction.periodEnd.toISOString().slice(0, 10)})`,
        sourceExchange: null,
        blockchainTxHash: null,
        idempotencyKey: idemKey,
        metadata: {
          kind: "adviser_fee_deduction_reversal",
          deductionId: deduction.id,
          reversesTransactionId: deduction.settledTransactionId,
          adviserUserId: deduction.adviserUserId,
          clientUserId: deduction.clientUserId,
          adviserShareAmount: deduction.adviserShareAmount,
          platformShareAmount: deduction.platformShareAmount,
          accrualIds: deduction.accrualIds,
          reason,
        } as any,
      })
      .returning();

    // (4 + 5) Resolve accounts + post the OPPOSITE balanced triple.
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
        direction: "credit",
        amount: toAmount8(total),
        description: `Adviser fee deduction #${deduction.id} reversal (client credit)`,
      },
    ];
    if (adviserShare > 0) {
      entries.push({
        accountId: adviserAccount.id,
        userId: deduction.adviserUserId,
        currency: deduction.currency,
        direction: "debit",
        amount: toAmount8(adviserShare),
        description: `Adviser fee deduction #${deduction.id} reversal (adviser debit)`,
      });
    }
    if (platformShare > 0) {
      entries.push({
        accountId: feeAccount.id,
        userId: feeAccount.userId,
        currency: deduction.currency,
        direction: "debit",
        amount: toAmount8(platformShare),
        description: `Adviser fee deduction #${deduction.id} reversal (platform debit)`,
      });
    }
    if (entries.length < 2) {
      throw new Error(
        "Cannot reverse deduction: no positive debit leg (adviser + platform shares both zero)",
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

    // (7) Mark reversed. Conditional WHERE re-asserts status='settled' under
    // the row lock — purely defensive.
    const [updated] = await (tx as any)
      .update(adviserFeeDeductions)
      .set({
        status: "reversed",
        reversedAt: new Date(),
        reversedByUserId: opts.reverserUserId,
        reversedReason: reason,
        reversalTransactionId: txRow.id,
      })
      .where(
        and(
          eq(adviserFeeDeductions.id, opts.deductionId),
          eq(adviserFeeDeductions.status, "settled"),
        ),
      )
      .returning();

    if (!updated) {
      // Shouldn't happen because we hold the row lock; if it does, abort.
      throw new Error("Deduction status changed under us during reversal");
    }
    return updated;
  });
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
// Task #29 — shape of the optional "we clipped the auto-backfill window"
// annotation persisted alongside each run row. Populated by the cron when
// the actual gap exceeded FEE_ACCRUAL_BACKFILL_MAX_DAYS so the admin Fees
// page can warn that some UTC dates need a manual replay. NULL on every
// other call site (manual admin trigger, cleanly-caught-up cron tick).
export interface DroppedFromBackfill {
  start: string; // 'YYYY-MM-DD' (oldest dropped UTC date, inclusive)
  end: string; // 'YYYY-MM-DD' (newest dropped UTC date, inclusive)
  count: number;
}

export async function runDailyAccrualsAndRecord(opts: {
  accrualDate: Date;
  trigger: "cron" | "manual";
  triggeredByUserId: number | null;
  // Task #29 — when set, written verbatim to the run row so the admin UI
  // can render the "dropped older than the cap" warning. The cron sets the
  // SAME object on every per-date call within a single clipped tick.
  droppedFromBackfill?: DroppedFromBackfill | null;
}): Promise<{
  run: FeeAccrualRun;
  inserted: number;
  skipped: number;
  duplicates: number;
  byGateReason: Record<string, number>;
}> {
  const accrualDate = startOfUtcDay(opts.accrualDate);
  const droppedFromBackfill = opts.droppedFromBackfill ?? null;
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
        droppedFromBackfill: droppedFromBackfill as any,
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
      droppedFromBackfill: droppedFromBackfill as any,
      finishedAt: new Date(),
    });
    throw err;
  }
}
