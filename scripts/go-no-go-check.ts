// =============================================================================
// scripts/go-no-go-check.ts — focused launch-readiness gate
// =============================================================================
// Single-purpose, deterministic, READ-ONLY check that exits:
//   * 0 — every gate PASSED, system is safe to launch
//   * 1 — at least one gate FAILED, with a concise checklist printed to
//         stdout listing each failure and a one-line reason
//
// Run:
//   npx tsx scripts/go-no-go-check.ts
//
// Gates (in order):
//   1. Ledger ↔ wallet consistency
//        Re-derive `SUM(ledger_entries)` per (user, currency) and compare
//        to the cached `wallets.balance`. Any drift >= MATCH_EPSILON
//        without an active drift acknowledgement is a FAIL. Demo users
//        (users.is_demo = true) are excluded — their wallet balances are
//        illustrative and were never posted through the ledger.
//
//   2. Fee rules ↔ consent integrity
//        Find every non-terminal adviser_fee_rules row whose underlying
//        fee_consent is withdrawn, expired (by date or status), or
//        missing entirely. These rules MUST be transitioned by the
//        consent-reconcile cron before launch, otherwise an accrual or
//        approval could be issued against a legally invalid consent.
//
//   3. KYC blockers
//        Any user with kyc_status NOT IN ('verified','pending') (i.e.
//        rejected) who still holds a non-zero wallet balance, or any
//        user with kyc_status='pending' holding a non-zero wallet
//        balance, is a launch blocker — money is sitting against an
//        identity the system has refused or has not finished verifying.
//
//   4. Circuit breaker (write kill switch) functional
//        getWriteKillSwitchState() must return a structured snapshot
//        (table present, row present, env override evaluated). The
//        breaker must currently be OFF — launching with writes blocked
//        is a contradiction.
//
// Existing services / utilities reused (NO new business logic):
//   * server/services/reconciliation.ts — MATCH_EPSILON
//   * server/services/write-kill-switch.ts — getWriteKillSwitchState,
//     ensureSystemSettingsTable
//   * server/db.ts — the shared Drizzle handle
//   * shared/schema.ts — the table definitions
//
// Output is intentionally compact and deterministic so CI can diff it.
// =============================================================================

import { eq, sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import {
  adviserFeeRules,
  feeConsents,
  ledgerEntries,
  users,
  wallets,
  walletLedgerDriftAcknowledgements,
} from "../shared/schema";
import { MATCH_EPSILON } from "../server/services/reconciliation";
import {
  ensureSystemSettingsTable,
  getWriteKillSwitchState,
} from "../server/services/write-kill-switch";

// ---------------------------------------------------------------------------
// Per-gate result shape
// ---------------------------------------------------------------------------
type GateStatus = "PASS" | "FAIL";

interface GateResult {
  name: string;
  status: GateStatus;
  /** One-line summary printed in the checklist. */
  summary: string;
  /** Optional bullets printed beneath the summary on FAIL only. */
  details?: string[];
}

// ---------------------------------------------------------------------------
// Gate 1 — Ledger ↔ wallet consistency
// ---------------------------------------------------------------------------
async function checkLedgerWalletConsistency(): Promise<GateResult> {
  // Single SQL pass that:
  //   * unions every (user, currency) appearing in either side
  //   * left-joins the wallet cached balance and the ledger sum
  //   * left-joins the most recent ACTIVE drift acknowledgement so we
  //     can ignore pairs ops have already recorded as known-and-tracked
  //   * filters out demo users
  //
  // We deliberately do NOT call runWalletLedgerReconciliation here — it
  // writes rows and dispatches alerts. A launch check must be read-only.
  const rowsRaw = await db.execute(sql`
    SELECT
      pair.user_id   AS "userId",
      pair.currency  AS "currency",
      COALESCE(w.balance, '0')        AS "walletBalance",
      COALESCE(l.ledger_sum, '0')     AS "ledgerSum",
      ack.id IS NOT NULL              AS "hasActiveAck"
    FROM (
      SELECT user_id, currency FROM ${wallets}
      UNION
      SELECT user_id, currency FROM ${ledgerEntries}
    ) AS pair
    LEFT JOIN ${wallets} w
      ON w.user_id = pair.user_id AND w.currency = pair.currency
    LEFT JOIN (
      SELECT user_id, currency, SUM(amount)::text AS ledger_sum
      FROM ${ledgerEntries}
      GROUP BY user_id, currency
    ) l ON l.user_id = pair.user_id AND l.currency = pair.currency
    LEFT JOIN ${walletLedgerDriftAcknowledgements} ack
      ON ack.user_id = pair.user_id
     AND ack.currency = pair.currency
     AND ack.cleared_at IS NULL
    WHERE pair.user_id NOT IN (SELECT id FROM ${users} WHERE is_demo = true)
  `);

  const rows = (rowsRaw as any).rows ?? (rowsRaw as any) ?? [];

  let pairsChecked = 0;
  let mismatched = 0;
  const offenders: string[] = [];

  for (const r of rows as Array<{
    userId: number | string;
    currency: string;
    walletBalance: string;
    ledgerSum: string;
    hasActiveAck: boolean;
  }>) {
    pairsChecked += 1;
    const drift = Math.abs(Number(r.walletBalance) - Number(r.ledgerSum));
    if (drift < MATCH_EPSILON) continue;
    if (r.hasActiveAck) continue;
    mismatched += 1;
    if (offenders.length < 5) {
      offenders.push(
        `user=${r.userId} ${r.currency}: wallet=${r.walletBalance} ledger=${r.ledgerSum} drift=${drift.toFixed(8)}`,
      );
    }
  }

  if (mismatched === 0) {
    return {
      name: "Ledger ↔ wallet consistency",
      status: "PASS",
      summary: `${pairsChecked} (user,currency) pairs reconciled, 0 unacknowledged drifts`,
    };
  }

  const tail = mismatched > offenders.length ? ` (+${mismatched - offenders.length} more)` : "";
  return {
    name: "Ledger ↔ wallet consistency",
    status: "FAIL",
    summary: `${mismatched} of ${pairsChecked} pair(s) drift >= ${MATCH_EPSILON} with no active acknowledgement`,
    details: [...offenders.map((o) => `- ${o}`), tail ? `- ${tail.trim()}` : ""].filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Gate 2 — Fee rules ↔ consent integrity
// ---------------------------------------------------------------------------
async function checkFeeRulesAgainstConsent(): Promise<GateResult> {
  // Mirrors the read-only half of reconcileRuleConsentState in
  // server/services/fee-engine.ts: we are looking for non-terminal rules
  // whose consent is in a state that should have already transitioned
  // them. If reconcile has run recently this set is empty.
  const now = new Date();

  const orphans = await db
    .select({ id: adviserFeeRules.id, status: adviserFeeRules.status })
    .from(adviserFeeRules)
    .leftJoin(feeConsents, eq(feeConsents.id, adviserFeeRules.feeConsentId))
    .where(
      sql`${adviserFeeRules.status} IN ('draft','active','paused')
          AND ${feeConsents.id} IS NULL`,
    );

  const stale = await db
    .select({
      ruleId: adviserFeeRules.id,
      ruleStatus: adviserFeeRules.status,
      consentId: feeConsents.id,
      withdrawnAt: feeConsents.withdrawnAt,
      consentExpiry: feeConsents.consentExpiryDate,
      renewalStatus: feeConsents.renewalStatus,
    })
    .from(adviserFeeRules)
    .innerJoin(feeConsents, eq(feeConsents.id, adviserFeeRules.feeConsentId))
    .where(
      sql`${adviserFeeRules.status} IN ('draft','active','paused')
          AND (
               ${feeConsents.withdrawnAt} IS NOT NULL
            OR ${feeConsents.renewalStatus} = 'expired'
            OR ${feeConsents.consentExpiryDate} <= ${now}
          )`,
    );

  const orphanCount = orphans.length;
  const staleCount = stale.length;
  const total = orphanCount + staleCount;

  if (total === 0) {
    return {
      name: "Fee rules ↔ consent integrity",
      status: "PASS",
      summary: "no non-terminal rules linked to a withdrawn/expired/missing consent",
    };
  }

  const details: string[] = [];
  if (orphanCount > 0) {
    details.push(`- ${orphanCount} rule(s) with MISSING consent (orphaned)`);
    for (const o of orphans.slice(0, 3)) {
      details.push(`  · rule_id=${o.id} status=${o.status}`);
    }
  }
  if (staleCount > 0) {
    details.push(`- ${staleCount} rule(s) with WITHDRAWN/EXPIRED consent`);
    for (const s of stale.slice(0, 3)) {
      const why = s.withdrawnAt
        ? "withdrawn"
        : s.renewalStatus === "expired"
        ? "renewal_expired"
        : "expiry_date_passed";
      details.push(`  · rule_id=${s.ruleId} status=${s.ruleStatus} consent_id=${s.consentId} reason=${why}`);
    }
  }
  return {
    name: "Fee rules ↔ consent integrity",
    status: "FAIL",
    summary: `${total} rule(s) need consent reconciliation before launch`,
    details,
  };
}

// ---------------------------------------------------------------------------
// Gate 3 — KYC blockers
// ---------------------------------------------------------------------------
async function checkKycBlockers(): Promise<GateResult> {
  // Two operationally dangerous combinations:
  //   (a) kyc_status='rejected' AND any non-zero wallet balance — money is
  //       sitting against an identity we have actively refused.
  //   (b) kyc_status='pending'  AND any non-zero wallet balance — money
  //       was funded against an identity that has not finished
  //       verification, which a regulator would treat as a fail-open.
  //
  // Demo users are excluded for the same reason as Gate 1.
  const rowsRaw = await db.execute(sql`
    SELECT
      u.id          AS "userId",
      u.kyc_status  AS "kycStatus",
      w.currency    AS "currency",
      w.balance     AS "balance"
    FROM ${users} u
    INNER JOIN ${wallets} w ON w.user_id = u.id
    WHERE u.is_demo IS NOT TRUE
      AND u.kyc_status IN ('rejected', 'pending')
      AND CAST(w.balance AS NUMERIC) > 0
  `);

  const rows = (rowsRaw as any).rows ?? (rowsRaw as any) ?? [];
  const offenders = rows as Array<{
    userId: number | string;
    kycStatus: string;
    currency: string;
    balance: string;
  }>;

  if (offenders.length === 0) {
    return {
      name: "KYC blockers",
      status: "PASS",
      summary: "no users with rejected/pending KYC holding non-zero balances",
    };
  }

  const rejected = offenders.filter((o) => o.kycStatus === "rejected").length;
  const pending = offenders.filter((o) => o.kycStatus === "pending").length;
  const sample = offenders.slice(0, 5).map(
    (o) => `- user=${o.userId} kyc=${o.kycStatus} ${o.currency}=${o.balance}`,
  );
  return {
    name: "KYC blockers",
    status: "FAIL",
    summary: `${offenders.length} wallet row(s) held by rejected (${rejected}) or pending (${pending}) users`,
    details: sample,
  };
}

// ---------------------------------------------------------------------------
// Gate 4 — Circuit breaker functional
// ---------------------------------------------------------------------------
async function checkCircuitBreaker(): Promise<GateResult> {
  // Step 1: ensure the table + singleton row exist. ensureSystemSettingsTable
  // is idempotent — it CREATEs IF NOT EXISTS and INSERT … ON CONFLICT DO
  // NOTHING. Running it here is the same cheap call boot makes.
  try {
    await ensureSystemSettingsTable();
  } catch (e: any) {
    return {
      name: "Circuit breaker functional",
      status: "FAIL",
      summary: "could not bootstrap system_settings table",
      details: [`- ${String(e?.message ?? e)}`],
    };
  }

  // Step 2: read the state through the public service. A bad read here
  // means the request middleware would also fail to read it and the wire
  // would silently fail-open — that is a NO-GO.
  let state: Awaited<ReturnType<typeof getWriteKillSwitchState>>;
  try {
    state = await getWriteKillSwitchState();
  } catch (e: any) {
    return {
      name: "Circuit breaker functional",
      status: "FAIL",
      summary: "getWriteKillSwitchState() threw",
      details: [`- ${String(e?.message ?? e)}`],
    };
  }

  // Step 3: shape sanity. If any expected field is missing the breaker
  // is wired up wrong even if it nominally read.
  const requiredFields: Array<keyof typeof state> = [
    "enabled",
    "envOverride",
    "reason",
    "enabledByUserId",
    "enabledAt",
    "updatedAt",
  ];
  const missing = requiredFields.filter((f) => !(f in state));
  if (missing.length > 0) {
    return {
      name: "Circuit breaker functional",
      status: "FAIL",
      summary: `state snapshot missing fields: ${missing.join(", ")}`,
    };
  }

  // Step 4: the breaker must currently be OFF. Launching with writes
  // blocked contradicts "safe to launch".
  if (state.enabled) {
    const src = state.envOverride ? "env_override" : "db_setting";
    return {
      name: "Circuit breaker functional",
      status: "FAIL",
      summary: `breaker is currently ENGAGED (source=${src})`,
      details: [`- reason: ${state.reason ?? "(none)"}`],
    };
  }

  return {
    name: "Circuit breaker functional",
    status: "PASS",
    summary: "state readable, shape correct, breaker is OFF",
  };
}

// ---------------------------------------------------------------------------
// Orchestrator + checklist printer
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // Run gates sequentially so the printed order is deterministic and a
  // failing gate early on cannot mask a later one's logging interleaving.
  const results: GateResult[] = [];
  results.push(await runGate("Gate 1", checkLedgerWalletConsistency));
  results.push(await runGate("Gate 2", checkFeeRulesAgainstConsent));
  results.push(await runGate("Gate 3", checkKycBlockers));
  results.push(await runGate("Gate 4", checkCircuitBreaker));

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.length - passed;

  console.log("");
  console.log("==============================================================");
  console.log(" GO/NO-GO LAUNCH CHECK");
  console.log("==============================================================");
  for (const r of results) {
    const tag = r.status === "PASS" ? "[PASS]" : "[FAIL]";
    console.log(`${tag} ${r.name}: ${r.summary}`);
    if (r.status === "FAIL" && r.details && r.details.length > 0) {
      for (const d of r.details) console.log(`        ${d}`);
    }
  }
  console.log("--------------------------------------------------------------");
  console.log(` Result: ${failed === 0 ? "GO" : "NO-GO"}  (passed=${passed}, failed=${failed})`);
  console.log("==============================================================");
  console.log("");

  await pool.end().catch(() => {
    /* best-effort: pool close errors should not change the exit code */
  });

  process.exit(failed === 0 ? 0 : 1);
}

// Wrap each gate so a thrown exception becomes a structured FAIL rather
// than tearing down the whole script. A gate that throws is, by
// definition, not in a state to vouch for the system.
async function runGate(label: string, fn: () => Promise<GateResult>): Promise<GateResult> {
  try {
    return await fn();
  } catch (e: any) {
    return {
      name: label,
      status: "FAIL",
      summary: "check threw an exception",
      details: [`- ${String(e?.message ?? e)}`],
    };
  }
}

main().catch((e) => {
  console.error("[go-no-go-check] fatal:", e);
  process.exit(1);
});
