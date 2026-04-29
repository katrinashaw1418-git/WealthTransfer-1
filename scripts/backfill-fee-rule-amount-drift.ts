// =============================================================================
// Task #475 — Backfill mismatched adviser_fee_rules amounts vs fee_consents.
// -----------------------------------------------------------------------------
// What this fixes:
//   The Task #307 service-layer check + the Task #475 DB trigger both enforce
//   "rule.amount MUST equal consent.amount" for every adviser_fee_rules row
//   in the live lifecycle states (draft | active | paused). Any rule that
//   pre-dates those guards may carry a drifted amount — without this
//   backfill, the trigger would reject every future UPDATE against the
//   row (status flip, supersede, anything), wedging the operational paths.
//
//   This script walks every non-terminal rule, joins it against its source
//   consent, runs the same parameter-equality check the trigger applies,
//   and for every mismatch it ALIGNS the rule's monetary parameter to the
//   consent's amount (the consent is the legal source of truth — the
//   rule must follow). Each fix is wrapped in a transaction with exactly
//   one audit_logs entry (`fee_rule_consent_amount_backfilled`,
//   severity=critical) so the audit trail records the drift and its
//   reconciliation.
//
//   Cases the script DOES NOT auto-fix (logged + skipped, never silenced):
//     - Consent missing or NULL amount but rule expects fixed/percentage
//       → cannot derive a target value. Operator must investigate the
//       consent record itself.
//     - amountType mismatch (e.g. fixed rule against percentage consent)
//       → flipping the rule's amountType is a structural change, not a
//       value change; surface for human review.
//
// Run with:
//   npx tsx scripts/backfill-fee-rule-amount-drift.ts          # dry-run
//   npx tsx scripts/backfill-fee-rule-amount-drift.ts --apply  # write
//
// Safe to re-run — the WHERE filter and the per-row equality check
// guarantee a second invocation against an aligned table is a no-op.
//
// Production-safe: this script intentionally does NOT import
// scripts/_bootstrap-test-env (which refuses to run when NODE_ENV is
// "production"). It is a real operational tool that must execute in
// every environment. We only `dotenv/config` so the same DATABASE_URL
// the server uses is picked up.
// =============================================================================

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { db } from "../server/db";
import { adviserFeeRules, feeConsents } from "../shared/schema";
import {
  FeeRuleConsentDriftError,
  validateRuleAmountAgainstConsent,
} from "../server/services/consent-integrity";
import { writeAuditLog } from "../server/services/audit";
import { NON_TERMINAL_RULE_STATUSES } from "../server/services/fee-engine";

const APPLY = process.argv.includes("--apply");

function log(msg: string) {
  console.log(`[backfill-fee-rule-amount-drift] ${msg}`);
}

type Plan =
  | { kind: "fix-fixed"; ruleId: number; from: string | null; to: string }
  | { kind: "fix-percentage"; ruleId: number; from: number | null; to: number }
  | { kind: "skip"; ruleId: number; reason: string };

function planFix(
  rule: typeof adviserFeeRules.$inferSelect,
  consent: typeof feeConsents.$inferSelect | null,
): Plan | null {
  if (!consent) {
    return { kind: "skip", ruleId: rule.id, reason: "consent_missing" };
  }
  try {
    validateRuleAmountAgainstConsent(
      {
        amountType: rule.amountType,
        fixedAmount: rule.fixedAmount,
        rateBps: rule.rateBps,
      },
      { amountType: consent.amountType, amount: consent.amount },
    );
    return null;
  } catch (e) {
    if (!(e instanceof FeeRuleConsentDriftError)) throw e;
  }

  if (consent.amountType === "calculation_method") {
    // The service-layer check exempts calculation_method consents — if we
    // got here despite that, treat it as already-passing. Belt-and-braces.
    return null;
  }
  if (consent.amount === null) {
    return {
      kind: "skip",
      ruleId: rule.id,
      reason: "consent_amount_null_cannot_derive_target",
    };
  }
  if (rule.amountType !== consent.amountType) {
    return {
      kind: "skip",
      ruleId: rule.id,
      reason: `amount_type_mismatch_rule=${rule.amountType}_consent=${consent.amountType}`,
    };
  }
  if (consent.amountType === "fixed") {
    return {
      kind: "fix-fixed",
      ruleId: rule.id,
      from: rule.fixedAmount === null ? null : String(rule.fixedAmount),
      to: String(consent.amount),
    };
  }
  if (consent.amountType === "percentage") {
    // consent.amount is e.g. "1.5000" (percent); rate_bps is the int 150.
    const targetBps = Math.round(Number(consent.amount) * 100);
    if (!Number.isFinite(targetBps)) {
      return {
        kind: "skip",
        ruleId: rule.id,
        reason: `consent_percentage_unparseable=${consent.amount}`,
      };
    }
    return {
      kind: "fix-percentage",
      ruleId: rule.id,
      from: rule.rateBps,
      to: targetBps,
    };
  }
  return {
    kind: "skip",
    ruleId: rule.id,
    reason: `unhandled_consent_amount_type=${consent.amountType}`,
  };
}

async function applyFix(plan: Plan, consentId: number): Promise<void> {
  if (plan.kind === "skip") return;
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(adviserFeeRules)
      .where(eq(adviserFeeRules.id, plan.ruleId));
    if (!before) return;

    const update: Partial<typeof adviserFeeRules.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (plan.kind === "fix-fixed") {
      update.fixedAmount = plan.to;
    } else {
      update.rateBps = plan.to;
    }

    const [after] = await tx
      .update(adviserFeeRules)
      .set(update)
      .where(eq(adviserFeeRules.id, plan.ruleId))
      .returning();

    await writeAuditLog({
      executor: tx,
      userId: null,
      action: "fee_rule_consent_amount_backfilled",
      entityType: "adviser_fee_rule",
      entityId: String(plan.ruleId),
      before: {
        amountType: before.amountType,
        fixedAmount: before.fixedAmount,
        rateBps: before.rateBps,
      },
      after: {
        amountType: after.amountType,
        fixedAmount: after.fixedAmount,
        rateBps: after.rateBps,
      },
      extra: {
        feeConsentId: consentId,
        backfill: true,
        task: "475",
        kind: plan.kind,
        severity: "critical",
      },
    });
  });
}

async function main() {
  log(`mode = ${APPLY ? "APPLY" : "DRY-RUN (pass --apply to write)"}`);

  const rows = await db
    .select({
      rule: adviserFeeRules,
      consent: feeConsents,
    })
    .from(adviserFeeRules)
    .leftJoin(feeConsents, eq(feeConsents.id, adviserFeeRules.feeConsentId))
    .where(
      inArray(adviserFeeRules.status, [...NON_TERMINAL_RULE_STATUSES]),
    );

  log(`scanned ${rows.length} non-terminal rules`);

  let aligned = 0;
  let alreadyOk = 0;
  let skipped = 0;
  const skips: Extract<Plan, { kind: "skip" }>[] = [];

  for (const { rule, consent } of rows) {
    const plan = planFix(rule, consent);
    if (plan === null) {
      alreadyOk += 1;
      continue;
    }
    if (plan.kind === "skip") {
      skipped += 1;
      skips.push(plan);
      log(`  rule #${plan.ruleId}: SKIP (${plan.reason})`);
      continue;
    }
    if (plan.kind === "fix-fixed") {
      log(
        `  rule #${plan.ruleId}: ${APPLY ? "ALIGN" : "WOULD ALIGN"} fixed_amount ${plan.from} → ${plan.to}`,
      );
    } else {
      log(
        `  rule #${plan.ruleId}: ${APPLY ? "ALIGN" : "WOULD ALIGN"} rate_bps ${plan.from} → ${plan.to}`,
      );
    }
    if (APPLY) {
      await applyFix(plan, rule.feeConsentId);
    }
    aligned += 1;
  }

  log(
    `done: aligned=${aligned} (${APPLY ? "applied" : "would apply"}), already_ok=${alreadyOk}, skipped=${skipped}`,
  );
  if (skipped > 0) {
    log(`skipped rules need human review:`);
    for (const s of skips) {
      log(`  rule #${s.ruleId}: ${s.reason}`);
    }
  }
  log(`finished. mode=${APPLY ? "APPLY" : "DRY-RUN"}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-fee-rule-amount-drift] FATAL", err);
  process.exit(1);
});
