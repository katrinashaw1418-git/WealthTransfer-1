// =============================================================================
// TASK #307 — Runtime consent-integrity gate at execution chokepoints
// =============================================================================
// The fee engine has historically embedded a per-rule consent gate ladder
// inside `runDailyAccruals` (consent_missing | consent_withdrawn |
// consent_expired | consent_renewal_inactive). That gate ladder runs AT
// ACCRUAL TIME — but the same legal pre-conditions also have to hold the
// moment a deduction is approved (the chokepoint that posts to the ledger
// in Gate B) or a paused rule is resumed back into the active set.
//
// Lifting the ladder into a single helper means there is exactly one
// definition of "is this consent legally valid for execution right now?".
// All three callsites (accrual, deduction-approve, rule-resume) share the
// same vocabulary, so a regulator following an audit row can cross-reference
// the gate reason without translating between dialects.
//
// Also exports the cross-table parameter-equality check used by createFeeRule
// (and the equivalent DB trigger installer below) — a fee rule's monetary
// parameter MUST match the consent it claims to derive from, otherwise the
// $150-vs-$495 drift bug becomes possible.
// =============================================================================

import { sql, eq } from "drizzle-orm";
import { db } from "../db";
import { feeConsents, type AdviserFeeRule, type FeeConsent } from "@shared/schema";
import type { GateReason } from "./fee-engine";

// Subset of gate reasons that this helper is allowed to return. The four
// consent-related reasons are the only ones whose legal basis is "the
// signed consent on file is no longer sufficient to deduct money". The
// remaining reasons in `GateReason` (link_inactive, rule_paused,
// splits_invalid) describe the rule itself — those gates stay in the
// accrual loop because they are not a property of the consent.
//
// Vocabulary mapping for cross-referencing the original Task #307/#476
// spec (which used product-team vocabulary) against this codebase's
// schema-aligned vocabulary:
//
//   spec term                      ↔   codebase term (this enum)
//   ──────────────────────────────────────────────────────────────────
//   consent_not_signed             ↔   consent_missing
//                                       (no fee_consents row exists for the
//                                        rule; the signed-consent lifecycle
//                                        lives on fee_consent_requests and a
//                                        row only lands in fee_consents
//                                        once it has been signed)
//   consent_revoked                ↔   consent_withdrawn
//                                       (fee_consents.withdrawn_at IS NOT
//                                        NULL — the column the operator UI
//                                        sets on a regulator-driven revoke)
//   consent_expired                ↔   consent_expired (no rename)
//   consent_superseded             ↔   consent_renewal_inactive
//                                       (fee_consents.renewal_status IN
//                                        ('superseded', 'expired') — this
//                                        enum subsumes both because the
//                                        regulator-facing legal-basis
//                                        question is the same: there is a
//                                        newer consent or none at all)
//
// The codebase vocabulary is preferred at every layer because it maps
// 1-to-1 to the actual schema columns the gate inspects, which keeps
// the audit trail self-documenting and avoids translation errors when
// a regulator follows an audit row back to the row that triggered it.
export type ConsentGateReason = Extract<
  GateReason,
  | "consent_missing"
  | "consent_withdrawn"
  | "consent_expired"
  | "consent_renewal_inactive"
>;

export type ConsentIntegrityResult =
  | { ok: true; consent: FeeConsent }
  | { ok: false; reason: ConsentGateReason; consent: FeeConsent | null };

// Stable audit action verbs the consent-integrity gate ladder writes
// across the three execution chokepoints. Centralising them here gives
// regulators / dashboards a single source of truth for the queryable
// surface and makes future drift impossible to introduce silently —
// every caller imports from this object rather than a string literal.
// Order: chokepoint name → verb that fires when the consent gate
// REFUSES at that chokepoint. The shapes are intentionally not
// uniformly camelCase / dotted because they preserve the historical
// verbs already present in the audit_log column for backward query
// compatibility (renaming would require a regulator-visible migration
// of historical rows, which is out of scope).
export const CONSENT_GATE_AUDIT_ACTIONS = {
  // Operator clicked "Activate" on a fee_rule but the linked consent
  // is no longer valid — the route refused with 409 + this verb.
  ruleActivate: "fee_rule_activate.blocked",
  // runDailyAccruals saw an invalid consent for a rule and wrote a
  // skipped accrual row + this audit verb. One row per refusal.
  accrual: "fee_accrual_consent_blocked",
  // Operator clicked "Approve" on a fee_deduction but at least one
  // backing rule's consent is no longer valid — the route refused
  // with 409 + this verb. Pre-tx fast-fail.
  deductionApproveRoute: "deduction.approve.blocked",
  // The in-tx defense inside settleApprovedDeduction caught a consent
  // that became invalid AFTER the route's pre-check (TOCTOU window).
  // Same shape as Gate B's rule-status refusal — they share the verb
  // and disambiguate via metadata.gate ('consent' vs 'rule_status').
  deductionApproveSettleTx: "fee_deduction_gate_blocked",
} as const;
export type ConsentGateAuditAction =
  (typeof CONSENT_GATE_AUDIT_ACTIONS)[keyof typeof CONSENT_GATE_AUDIT_ACTIONS];

// Drizzle-style executor — top-level db OR a tx handle. Callers inside
// `db.transaction(async (tx) => …)` should pass `tx` so the consent read
// observes the same snapshot as the rest of the transaction.
type DbHandle = Pick<typeof db, "select" | "execute">;

export interface AssertConsentValidOpts {
  // Optional executor (defaults to top-level db).
  executor?: DbHandle;
  // The instant the gate is evaluated against. Defaults to "now". Tests
  // override this so date-based expiry assertions land on a deterministic
  // boundary; the deduction-approve and rule-resume callsites pass the
  // wall clock at the moment of the operator action.
  now?: Date;
  // Task #476 — when true, the consent SELECT acquires `FOR UPDATE` on
  // the row. ONLY meaningful when `executor` is a transaction handle —
  // the lock is released at tx commit/rollback. Use this from the
  // in-transaction settlement gate so a concurrent withdrawal cannot
  // commit between our gate read and the ledger posting (closes the
  // residual TOCTOU window READ COMMITTED would otherwise leave open).
  // Read-only callers (UX pre-checks, the accrual loop, the rule
  // activation route, the helper unit tests) leave this off so the
  // lock isn't held longer than necessary.
  lockForUpdate?: boolean;
}

/**
 * Run the consent-integrity gate ladder for a single fee_consents row.
 *
 * Returns `{ ok: true, consent }` when the consent is currently valid as
 * the legal basis for an execution-time action. Returns `{ ok: false,
 * reason }` otherwise — never throws.
 *
 * Order matters: a withdrawn consent that is also expired is reported as
 * `consent_withdrawn` (the more specific signal) so the audit trail
 * captures the operator action that withdrew it rather than the
 * downstream date-based expiry.
 */
export async function assertConsentValidForExecution(
  consentId: number,
  opts: AssertConsentValidOpts = {},
): Promise<ConsentIntegrityResult> {
  const handle: DbHandle = opts.executor ?? db;
  const now = opts.now ?? new Date();

  // Task #476 — when called from inside the settlement transaction we
  // take a row lock so a concurrent withdrawal cannot land between this
  // SELECT and the eventual ledger commit. `.for("update")` is a no-op
  // outside a transaction (still emits the SQL but releases on auto-
  // commit), so we deliberately gate it behind the explicit opt-in flag
  // to avoid surprising callers that didn't ask to lock. We use FOR
  // UPDATE rather than FOR KEY SHARE because a withdrawal is a non-key
  // UPDATE on fee_consents.withdrawn_at — FOR KEY SHARE would let it
  // proceed concurrently and re-open the very race this lock is here
  // to close. FOR UPDATE blocks all UPDATEs on the row.
  const baseQuery = (handle as typeof db)
    .select()
    .from(feeConsents)
    .where(eq(feeConsents.id, consentId))
    .limit(1);
  const [consent] = await (opts.lockForUpdate
    ? baseQuery.for("update")
    : baseQuery);

  if (!consent) {
    return { ok: false, reason: "consent_missing", consent: null };
  }

  if (consent.withdrawnAt) {
    return { ok: false, reason: "consent_withdrawn", consent };
  }

  if (
    consent.consentExpiryDate &&
    new Date(consent.consentExpiryDate).getTime() <= now.getTime()
  ) {
    return { ok: false, reason: "consent_expired", consent };
  }

  if (consent.renewalStatus !== "active") {
    return { ok: false, reason: "consent_renewal_inactive", consent };
  }

  return { ok: true, consent };
}

// ---------------------------------------------------------------------------
// Parameter equality between rule and consent.
// ---------------------------------------------------------------------------
// fee_consents.amount is stored as a decimal(14,4). The semantics depend on
// fee_consents.amount_type:
//
//   fixed              — raw monetary amount in `currency`. Must match
//                        rule.fixed_amount exactly.
//   percentage         — annual rate expressed as a percentage (e.g.
//                        "1.5000" means 1.5%). Must match
//                        ROUND(rule.rate_bps / 100, 4).
//   calculation_method — free-text basis. The dollar/bps figure on the
//                        rule is set by the operator following the agreed
//                        method; we cannot mechanically equate them, so
//                        no equality check is enforced.
//
// This service-layer check produces a friendly 400 with a clear message
// (and is what unit tests assert against). The DB trigger installed by
// `installFeeRuleAmountEqualityTrigger` is the hard backstop for any path
// that bypasses the service (raw psql, future scripts, etc).
// ---------------------------------------------------------------------------

export interface RuleAmountFields {
  amountType: string;
  fixedAmount: string | number | null;
  rateBps: number | null;
}

export class FeeRuleConsentDriftError extends Error {
  readonly status = 400;
  readonly code = "rule_consent_amount_drift";
  readonly ruleAmountType: string;
  readonly consentAmountType: string;
  readonly ruleAmount: string | number | null;
  readonly consentAmount: string | number | null;
  constructor(
    message: string,
    detail: {
      ruleAmountType: string;
      consentAmountType: string;
      ruleAmount: string | number | null;
      consentAmount: string | number | null;
    },
  ) {
    super(message);
    this.name = "FeeRuleConsentDriftError";
    this.ruleAmountType = detail.ruleAmountType;
    this.consentAmountType = detail.consentAmountType;
    this.ruleAmount = detail.ruleAmount;
    this.consentAmount = detail.consentAmount;
  }
}

function toNumberOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * Throws FeeRuleConsentDriftError when the rule's monetary parameter does
 * not equal the consent's. Calculation_method consents are exempt — the
 * caller is responsible for setting a sensible amount per the agreed
 * method, and the rule's amount is the regulator-reviewed figure that
 * carries the consent's blessing.
 */
export function validateRuleAmountAgainstConsent(
  rule: RuleAmountFields,
  consent: Pick<FeeConsent, "amountType" | "amount">,
): void {
  if (consent.amountType === "calculation_method") {
    return;
  }

  if (rule.amountType !== consent.amountType) {
    throw new FeeRuleConsentDriftError(
      `Rule amountType '${rule.amountType}' does not match consent amountType '${consent.amountType}'`,
      {
        ruleAmountType: rule.amountType,
        consentAmountType: consent.amountType,
        ruleAmount: rule.amountType === "fixed" ? rule.fixedAmount : rule.rateBps,
        consentAmount: consent.amount,
      },
    );
  }

  const consentAmount = toNumberOrNull(consent.amount);
  if (consentAmount === null) {
    throw new FeeRuleConsentDriftError(
      `Consent has no amount recorded but rule expects amountType '${rule.amountType}'`,
      {
        ruleAmountType: rule.amountType,
        consentAmountType: consent.amountType,
        ruleAmount: rule.amountType === "fixed" ? rule.fixedAmount : rule.rateBps,
        consentAmount: consent.amount,
      },
    );
  }

  if (rule.amountType === "fixed") {
    const ruleFixed = toNumberOrNull(rule.fixedAmount);
    if (ruleFixed === null) {
      throw new FeeRuleConsentDriftError(
        `Rule fixedAmount is missing but consent records a fixed amount of ${consentAmount}`,
        {
          ruleAmountType: rule.amountType,
          consentAmountType: consent.amountType,
          ruleAmount: rule.fixedAmount,
          consentAmount: consent.amount,
        },
      );
    }
    // 4dp tolerance — both columns are decimal(14,4) so any difference
    // beyond the 0.0001 floor is a real drift, not a rounding artefact.
    if (Math.abs(ruleFixed - consentAmount) > 0.00005) {
      throw new FeeRuleConsentDriftError(
        `Rule fixedAmount ${ruleFixed} does not match consent amount ${consentAmount}`,
        {
          ruleAmountType: rule.amountType,
          consentAmountType: consent.amountType,
          ruleAmount: ruleFixed,
          consentAmount,
        },
      );
    }
    return;
  }

  if (rule.amountType === "percentage") {
    if (rule.rateBps === null || rule.rateBps === undefined) {
      throw new FeeRuleConsentDriftError(
        `Rule rateBps is missing but consent records a percentage of ${consentAmount}`,
        {
          ruleAmountType: rule.amountType,
          consentAmountType: consent.amountType,
          ruleAmount: rule.rateBps,
          consentAmount,
        },
      );
    }
    // bps-to-percent equivalence: 150 bps = 1.5000%.
    const ruleAsPercent = Number(rule.rateBps) / 100;
    if (Math.abs(ruleAsPercent - consentAmount) > 0.00005) {
      throw new FeeRuleConsentDriftError(
        `Rule rateBps ${rule.rateBps} (= ${ruleAsPercent}%) does not match consent percentage ${consentAmount}`,
        {
          ruleAmountType: rule.amountType,
          consentAmountType: consent.amountType,
          ruleAmount: rule.rateBps,
          consentAmount,
        },
      );
    }
    return;
  }

  // Any other combination (e.g. a rule whose amountType is itself
  // calculation_method, which createFeeRule already rejects upstream) is
  // out of scope for the equality check and explicitly allowed through.
}

// ---------------------------------------------------------------------------
// DB-level backstop trigger.
// ---------------------------------------------------------------------------
// CHECK constraints cannot reference another table, so we install a
// BEFORE INSERT/UPDATE trigger on adviser_fee_rules that re-runs the
// equality check inside the database. Same idempotent pattern as
// installAuditLogsImmutabilityTriggers — safe to run on every boot.
//
// The trigger raises with SQLSTATE check_violation and a message starting
// with the literal "fee rule consent amount drift" so callers + tests can
// branch on the failure mode without parsing the full message.
// ---------------------------------------------------------------------------

type TriggerHandle = Pick<typeof db, "execute">;

export async function installFeeRuleAmountEqualityTrigger(
  handle: TriggerHandle,
): Promise<void> {
  await handle.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION adviser_fee_rules_amount_equality_check()
    RETURNS trigger AS $$
    DECLARE
      c_amount_type text;
      c_amount numeric(14,4);
      rule_pct numeric(14,4);
    BEGIN
      -- Task #475 — terminal-state rows are historical audit evidence and
      -- must remain immutable in shape: the supersede pass and the
      -- expiry sweep both UPDATE these rows to set lifecycle pointers
      -- WITHOUT touching the amount columns, and we must not block
      -- those updates just because a pre-trigger row has a drifted
      -- amount on file. The amount-equality invariant is enforced for
      -- the live lifecycle states (draft / active / paused) only —
      -- exactly the states from which an accrual can ever be posted.
      IF NEW.status IN ('superseded', 'expired') THEN
        RETURN NEW;
      END IF;

      SELECT amount_type, amount INTO c_amount_type, c_amount
      FROM fee_consents
      WHERE id = NEW.fee_consent_id;

      IF c_amount_type IS NULL THEN
        RAISE EXCEPTION 'fee rule consent amount drift: consent % not found', NEW.fee_consent_id
          USING ERRCODE = 'foreign_key_violation';
      END IF;

      -- calculation_method consents are free-text; no mechanical equality.
      IF c_amount_type = 'calculation_method' THEN
        RETURN NEW;
      END IF;

      IF NEW.amount_type <> c_amount_type THEN
        RAISE EXCEPTION 'fee rule consent amount drift: rule amount_type % differs from consent amount_type %',
          NEW.amount_type, c_amount_type
          USING ERRCODE = 'check_violation';
      END IF;

      IF NEW.amount_type = 'fixed' THEN
        IF c_amount IS NULL OR NEW.fixed_amount IS NULL OR NEW.fixed_amount <> c_amount THEN
          RAISE EXCEPTION 'fee rule consent amount drift: rule fixed_amount % differs from consent amount %',
            NEW.fixed_amount, c_amount
            USING ERRCODE = 'check_violation';
        END IF;
      ELSIF NEW.amount_type = 'percentage' THEN
        IF c_amount IS NULL OR NEW.rate_bps IS NULL THEN
          RAISE EXCEPTION 'fee rule consent amount drift: rule rate_bps % vs consent amount %',
            NEW.rate_bps, c_amount
            USING ERRCODE = 'check_violation';
        END IF;
        rule_pct := ROUND(NEW.rate_bps::numeric / 100, 4);
        IF rule_pct <> c_amount THEN
          RAISE EXCEPTION 'fee rule consent amount drift: rule rate_bps % (= %%%) differs from consent percentage %',
            NEW.rate_bps, rule_pct, c_amount
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `));

  await handle.execute(sql.raw(
    `DROP TRIGGER IF EXISTS adviser_fee_rules_amount_equality ON adviser_fee_rules;`,
  ));
  await handle.execute(sql.raw(`
    CREATE TRIGGER adviser_fee_rules_amount_equality
    BEFORE INSERT OR UPDATE ON adviser_fee_rules
    FOR EACH ROW EXECUTE FUNCTION adviser_fee_rules_amount_equality_check();
  `));
}
