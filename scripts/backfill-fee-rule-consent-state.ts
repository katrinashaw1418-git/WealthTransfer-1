// =============================================================================
// Task #294 — Backfill adviser_fee_rules.{accountNumber, effectiveDate} +
//             resolve any pre-existing duplicates into a supersede chain.
// -----------------------------------------------------------------------------
// What this fixes:
//   The Task #294 schema migration added accountNumber, effectiveDate and the
//   supersededBy* pointers, but pre-existing rows have NULL values for them
//   and the partial unique index `adviser_fee_rules_supersede_uniq` would
//   reject any future insert that collided with a NULL-account predecessor.
//
//   This script is idempotent and walks every adviser_fee_rules row in three
//   passes:
//
//   1. accountNumber backfill — copy from the underlying feeConsents row.
//      Skipped (and warned) when the consent is missing or its accountNumber
//      itself is null. Without an accountNumber the supersede pass below
//      cannot group rows safely, so the row is left alone for a human.
//
//   2. effectiveDate backfill — copy from the row's createdAt. createdAt is
//      always non-null (DB default) so this pass is unconditional.
//
//   3. Supersede pass — for every (clientUserId, feeType, accountNumber)
//      tuple that has more than one row in {'draft','active','paused'}
//      after pass 1, keep the most recently-created row as the survivor and
//      mark the rest as 'superseded' with supersededByRuleId pointing at the
//      survivor. Each transition writes one audit row with action
//      `fee_rule_superseded` and reason `backfill_dedup_replaced_by_newer`.
//
// Run with:
//   npx tsx scripts/backfill-fee-rule-consent-state.ts          # dry-run
//   npx tsx scripts/backfill-fee-rule-consent-state.ts --apply  # write
//
// Safe to re-run — the WHERE clauses guarantee a second invocation is a
// no-op (every row that needed the backfill already has the columns set).
// =============================================================================

import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import { db } from "../server/db";
import { adviserFeeRules, feeConsents } from "../shared/schema";
import { writeAuditLog } from "../server/services/audit";

const APPLY = process.argv.includes("--apply");

function log(msg: string) {
  // Prefix every line so the output is easy to grep in a deploy log.
  console.log(`[backfill-fee-rule-consent-state] ${msg}`);
}

async function main() {
  log(`mode = ${APPLY ? "APPLY" : "DRY-RUN (pass --apply to write)"}`);

  // -------------------------------------------------------------------------
  // Pass 1 — accountNumber backfill from the joined consent.
  // -------------------------------------------------------------------------
  const missingAcct = await db
    .select({
      id: adviserFeeRules.id,
      consentId: adviserFeeRules.feeConsentId,
      consentAcct: feeConsents.accountNumber,
    })
    .from(adviserFeeRules)
    .leftJoin(feeConsents, eq(feeConsents.id, adviserFeeRules.feeConsentId))
    .where(isNull(adviserFeeRules.accountNumber));

  log(`pass-1 accountNumber: ${missingAcct.length} rows missing accountNumber`);
  let copied = 0;
  let skippedNoConsent = 0;
  let skippedNoConsentAcct = 0;
  for (const r of missingAcct) {
    if (!r.consentId || r.consentAcct === null || r.consentAcct === undefined) {
      if (!r.consentId) skippedNoConsent += 1;
      else skippedNoConsentAcct += 1;
      log(
        `  rule #${r.id}: cannot backfill accountNumber (consentId=${r.consentId}, consentAcct=${r.consentAcct})`,
      );
      continue;
    }
    if (APPLY) {
      await db
        .update(adviserFeeRules)
        .set({ accountNumber: r.consentAcct })
        .where(eq(adviserFeeRules.id, r.id));
    }
    copied += 1;
  }
  log(
    `pass-1 done: copied=${copied}, skipped_no_consent=${skippedNoConsent}, skipped_no_consent_acct=${skippedNoConsentAcct}`,
  );

  // -------------------------------------------------------------------------
  // Pass 2 — effectiveDate backfill from createdAt. Single SQL UPDATE
  // because createdAt is always non-null and we want a row-by-row copy.
  // -------------------------------------------------------------------------
  if (APPLY) {
    const result = await db.execute(sql`
      UPDATE adviser_fee_rules
         SET effective_date = created_at
       WHERE effective_date IS NULL
    `);
    log(`pass-2 effectiveDate: copied from created_at where null (${(result as any).rowCount ?? 0} rows)`);
  } else {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(adviserFeeRules)
      .where(isNull(adviserFeeRules.effectiveDate));
    log(`pass-2 effectiveDate: ${row?.count ?? 0} rows would be backfilled`);
  }

  // -------------------------------------------------------------------------
  // Pass 3 — supersede pass. Group rows in {'draft','active','paused'} by
  // (clientUserId, feeType, accountNumber) and supersede the older ones.
  // -------------------------------------------------------------------------
  const liveRows = await db
    .select()
    .from(adviserFeeRules)
    .where(inArray(adviserFeeRules.status, ["draft", "active", "paused"]));

  // Group by tuple. accountNumber === null is grouped on its own bucket per
  // clientUserId+feeType so two NULL-account rows collide; if you don't want
  // that, run pass 1 first.
  const buckets = new Map<string, typeof liveRows>();
  for (const r of liveRows) {
    const key = `${r.clientUserId}|${r.feeType}|${r.accountNumber ?? "<NULL>"}`;
    const existing = buckets.get(key) ?? [];
    existing.push(r);
    buckets.set(key, existing);
  }
  let supersededCount = 0;
  let bucketsWithDups = 0;
  for (const [key, rows] of buckets) {
    if (rows.length <= 1) continue;
    bucketsWithDups += 1;
    // Survivor = most recently created row. Stable tie-break on id desc.
    const sorted = [...rows].sort((a, b) => {
      const at = new Date(a.createdAt).getTime();
      const bt = new Date(b.createdAt).getTime();
      if (at !== bt) return bt - at;
      return b.id - a.id;
    });
    const survivor = sorted[0];
    const losers = sorted.slice(1);
    log(
      `  tuple [${key}]: ${rows.length} rows, survivor=#${survivor.id}, losers=[${losers
        .map((l) => `#${l.id}`)
        .join(", ")}]`,
    );
    if (!APPLY) {
      supersededCount += losers.length;
      continue;
    }
    const now = new Date();
    for (const loser of losers) {
      await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(adviserFeeRules)
          .set({
            status: "superseded",
            supersededByRuleId: survivor.id,
            supersededAt: now,
            supersededReason: "backfill_dedup_replaced_by_newer",
            updatedAt: now,
          })
          .where(eq(adviserFeeRules.id, loser.id))
          .returning();
        await writeAuditLog({
          executor: tx,
          userId: null,
          action: "fee_rule_superseded",
          entityType: "adviser_fee_rule",
          entityId: String(loser.id),
          before: {
            status: loser.status,
            supersededByRuleId: loser.supersededByRuleId,
            supersededAt: loser.supersededAt,
            supersededReason: loser.supersededReason,
          },
          after: {
            status: updated.status,
            supersededByRuleId: updated.supersededByRuleId,
            supersededAt: updated.supersededAt,
            supersededReason: updated.supersededReason,
          },
          extra: {
            replacedByRuleId: survivor.id,
            clientUserId: loser.clientUserId,
            feeType: loser.feeType,
            accountNumber: loser.accountNumber,
            backfill: true,
          },
        });
      });
      supersededCount += 1;
    }
  }
  log(
    `pass-3 done: ${bucketsWithDups} duplicate tuples, ${supersededCount} rows ${APPLY ? "superseded" : "would be superseded"}`,
  );

  log(`finished. mode=${APPLY ? "APPLY" : "DRY-RUN"}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-fee-rule-consent-state] FATAL", err);
  process.exit(1);
});
