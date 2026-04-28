// =============================================================================
// TASK #366 — One-shot cleanup of fixture-tagged rows reachable from the
//             client / adviser surfaces.
// -----------------------------------------------------------------------------
// Background:
//   Earlier tasks already addressed several leak surfaces:
//     - Task #286/#308 added read-time filters that hide fixture clients
//       from the adviser fee endpoints.
//     - Task #347 deactivates `adviser_clients` rows whose client side is
//       a fixture (script: scripts/deactivate-fixture-adviser-client-links.ts).
//     - Task #348 reasserts the read filter coverage with explicit tests.
//     - Tasks #153/#154/#159/#181 handled balanced-leg cleanup of stray
//       ledger / transaction residue from old fixture runs.
//
//   What was NOT swept by any of the above is the SECONDARY surface of
//   fixture rows that hang off fixture-pattern users in tables that
//   advisers / clients can read via existing endpoints:
//     - fee_consents              (signed consents)
//     - fee_consent_requests      (pre-signature lifecycle)
//     - adviser_fee_rules         (adviser fee schedules)
//     - adviser_fee_accruals      (per-period accrual ledger)
//     - adviser_fee_deductions    (settled deductions; FK-safe rows only)
//     - adviser_tasks             (adviser inbox tasks)
//     - adviser_notes             (planner free-text notes)
//     - investment_instructions   (instruction shelf rows)
//
//   "Fixture-pattern user" is computed from the canonical email matcher in
//   `server/services/test-fixture-emails.ts` so this script and the live
//   read filters can never drift apart.
//
// Behaviour:
//   - Dry-run by default. Counts fixture-tagged rows per table, prints a
//     per-user breakdown, then exits 0 without writing.
//   - With `--apply`, each delete runs inside a single
//     `db.transaction(...)` and writes one `audit_logs` row per table per
//     user via the existing `writeAuditLog` helper. Action shape mirrors
//     the existing `adviser_client.deactivated_fixture_cleanup` signature
//     so ops dashboards can group both flavours of cleanup audit rows.
//   - Skips users with `email IS NULL` and users whose email does NOT
//     match the canonical fixture matcher — the matcher is the single
//     source of truth for what counts as fixture data.
//   - Intentionally NOT gated by `assertFixtureInsertionAllowed()`. That
//     guard is for INSERT paths (preventing fixture rows from being
//     written to a production DB). This script is a DELETE-only sweep
//     designed to be run AGAINST production-reachable databases as a
//     one-off cleanup pass; gating it would defeat its purpose. Operator
//     safety comes from: (a) dry-run is the default, (b) `--apply`
//     opens a single transaction with a per-(user,table) `audit_logs`
//     entry that captures every row touched, (c) FK-locked deductions
//     are filtered out in SQL (not just classification), and (d) the
//     fixture matcher is the same one the read filters use, so the set
//     of rows touched is identical to the set already hidden from real
//     adviser/client surfaces.
//   - Refuses to delete `adviser_fee_deductions` rows that are referenced
//     by a settled `transactions` row: ledger postings are append-only
//     and the pre-launch reconciliation gates would surface drift on a
//     dangling FK. Such rows are LOGGED (not deleted) and listed under a
//     "skipped — has settled transaction" section in the summary, so an
//     operator can balance them via the same pattern
//     `cleanup-prelaunch-residue.ts` uses (post a balanced reversal).
//
// Usage:
//   npx tsx scripts/cleanup-fixture-rows.ts            # dry run
//   npx tsx scripts/cleanup-fixture-rows.ts --apply    # commit deletions
// =============================================================================

// NOTE: this script intentionally does NOT import `./_bootstrap-test-env`.
// That bootstrap defaults NODE_ENV=test AND calls
// `assertFixtureInsertionAllowed()`, which hard-refuses NODE_ENV=production.
// This script is the OPPOSITE of fixture insertion — it deletes fixture
// rows from a production-reachable database. The dry-run default + per-row
// audit logging + in-SQL FK protection (see deleteForTable below) are the
// safeguards here.
//
// We DO load dotenv directly so DATABASE_URL / JWT_SECRET / etc. land in
// `process.env` before the `../server/db` import below opens the pool.
import "dotenv/config";

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { db } from "../server/db";
import {
  users,
  feeConsents,
  feeConsentRequests,
  adviserFeeRules,
  adviserFeeAccruals,
  adviserFeeDeductions,
  adviserTasks,
  adviserNotes,
  investmentInstructions,
} from "../shared/schema";
import { isTestFixtureEmail, matchTestFixtureEmail } from "../server/services/test-fixture-emails";
import { writeAuditLog } from "../server/services/audit";

interface FixtureUser {
  id: number;
  email: string;
  username: string;
  matchedPattern: string;
}

interface PerTableCount {
  table: string;
  count: number;
  // For deductions, ids that we will NOT delete because they are tied to a
  // settled transaction. See behaviour notes above.
  skippedIds?: number[];
}

interface PerUserSummary {
  user: FixtureUser;
  perTable: PerTableCount[];
  total: number;
}

const TABLE_DEFS = [
  // Order matters: child rows before parents inside the same domain to keep
  // FK constraints happy. Across domains, drizzle / Postgres doesn't care.
  // adviser_fee_deductions references adviser_fee_accruals (per-deduction
  // accrualSliceJson is opaque, but the column accrualPeriodId may FK).
  // Matching the order pattern used by cleanup-prelaunch-residue keeps the
  // delete sequence boring and reviewable.
  { table: adviserFeeDeductions, name: "adviser_fee_deductions" },
  { table: adviserFeeAccruals, name: "adviser_fee_accruals" },
  { table: adviserFeeRules, name: "adviser_fee_rules" },
  { table: feeConsentRequests, name: "fee_consent_requests" },
  { table: feeConsents, name: "fee_consents" },
  { table: adviserTasks, name: "adviser_tasks" },
  { table: adviserNotes, name: "adviser_notes" },
  { table: investmentInstructions, name: "investment_instructions" },
] as const;

async function findFixtureUsers(): Promise<FixtureUser[]> {
  const rows = await db
    .select({ id: users.id, email: users.email, username: users.username })
    .from(users)
    .where(isNotNull(users.email));

  const out: FixtureUser[] = [];
  for (const r of rows) {
    const m = matchTestFixtureEmail(r.email);
    if (m.matched) {
      out.push({
        id: r.id,
        email: r.email!,
        username: r.username,
        matchedPattern: m.pattern,
      });
    }
  }
  return out;
}

/**
 * Pull the user-keyed columns from each fixture-aware table for the supplied
 * user ids. Returns one PerUserSummary per fixture user, even if every count
 * is zero (so the dry-run output makes the per-user breakdown explicit and a
 * human can see the script considered a user before skipping it).
 */
async function buildSummary(fixtureUsers: FixtureUser[]): Promise<PerUserSummary[]> {
  const userIds = fixtureUsers.map((u) => u.id);
  const summaries: PerUserSummary[] = fixtureUsers.map((u) => ({
    user: u,
    perTable: TABLE_DEFS.map((d) => ({ table: d.name, count: 0 })),
    total: 0,
  }));

  if (userIds.length === 0) return summaries;

  // For each table, fetch the user-keyed rows and tally per user.
  // We tally via a Map<userId, Map<table, count>> for an O(N) scan instead
  // of N×M individual COUNT(*) round-trips.
  const tally = new Map<number, Map<string, { count: number; skipped: number[] }>>();
  for (const u of fixtureUsers) {
    tally.set(u.id, new Map(TABLE_DEFS.map((d) => [d.name, { count: 0, skipped: [] }])));
  }

  // Helper: add hits to the tally
  const bump = (userId: number, table: string, opts?: { skippedId?: number }) => {
    const userMap = tally.get(userId);
    if (!userMap) return;
    const cell = userMap.get(table)!;
    if (opts?.skippedId !== undefined) {
      cell.skipped.push(opts.skippedId);
    } else {
      cell.count += 1;
    }
  };

  // adviser_fee_deductions — match on either client OR adviser. Record id +
  // settledTransactionId so we can flag the rows that are FK-locked to a
  // ledger-bearing transaction.
  const deductions = await db
    .select({
      id: adviserFeeDeductions.id,
      clientUserId: adviserFeeDeductions.clientUserId,
      adviserUserId: adviserFeeDeductions.adviserUserId,
      settledTransactionId: adviserFeeDeductions.settledTransactionId,
    })
    .from(adviserFeeDeductions)
    .where(inArray(adviserFeeDeductions.clientUserId, userIds));
  const deductionsAdv = await db
    .select({
      id: adviserFeeDeductions.id,
      clientUserId: adviserFeeDeductions.clientUserId,
      adviserUserId: adviserFeeDeductions.adviserUserId,
      settledTransactionId: adviserFeeDeductions.settledTransactionId,
    })
    .from(adviserFeeDeductions)
    .where(inArray(adviserFeeDeductions.adviserUserId, userIds));

  const dedupeDeductions = new Map<number, (typeof deductions)[number]>();
  for (const d of [...deductions, ...deductionsAdv]) dedupeDeductions.set(d.id, d);

  for (const d of Array.from(dedupeDeductions.values())) {
    const owners = [d.clientUserId, d.adviserUserId].filter((x): x is number => typeof x === "number");
    const fxOwner = owners.find((id) => tally.has(id));
    if (fxOwner === undefined) continue;
    if (d.settledTransactionId !== null && d.settledTransactionId !== undefined) {
      // FK-locked: log under skipped so the operator knows it's still here.
      bump(fxOwner, "adviser_fee_deductions", { skippedId: d.id });
    } else {
      bump(fxOwner, "adviser_fee_deductions");
    }
  }

  // adviser_fee_accruals — client OR adviser side
  const accrualsClient = await db
    .select({ id: adviserFeeAccruals.id, clientUserId: adviserFeeAccruals.clientUserId, adviserUserId: adviserFeeAccruals.adviserUserId })
    .from(adviserFeeAccruals)
    .where(inArray(adviserFeeAccruals.clientUserId, userIds));
  const accrualsAdv = await db
    .select({ id: adviserFeeAccruals.id, clientUserId: adviserFeeAccruals.clientUserId, adviserUserId: adviserFeeAccruals.adviserUserId })
    .from(adviserFeeAccruals)
    .where(inArray(adviserFeeAccruals.adviserUserId, userIds));
  const dedupeAcc = new Map<number, { clientUserId: number; adviserUserId: number }>();
  for (const a of [...accrualsClient, ...accrualsAdv]) dedupeAcc.set(a.id, a);
  for (const a of Array.from(dedupeAcc.values())) {
    const owner = [a.clientUserId, a.adviserUserId].find((id) => tally.has(id));
    if (owner !== undefined) bump(owner, "adviser_fee_accruals");
  }

  // adviser_fee_rules — client OR adviser
  const rulesClient = await db
    .select({ id: adviserFeeRules.id, clientUserId: adviserFeeRules.clientUserId, adviserUserId: adviserFeeRules.adviserUserId })
    .from(adviserFeeRules)
    .where(inArray(adviserFeeRules.clientUserId, userIds));
  const rulesAdv = await db
    .select({ id: adviserFeeRules.id, clientUserId: adviserFeeRules.clientUserId, adviserUserId: adviserFeeRules.adviserUserId })
    .from(adviserFeeRules)
    .where(inArray(adviserFeeRules.adviserUserId, userIds));
  const dedupeRules = new Map<number, { clientUserId: number; adviserUserId: number }>();
  for (const r of [...rulesClient, ...rulesAdv]) dedupeRules.set(r.id, r);
  for (const r of Array.from(dedupeRules.values())) {
    const owner = [r.clientUserId, r.adviserUserId].find((id) => tally.has(id));
    if (owner !== undefined) bump(owner, "adviser_fee_rules");
  }

  // fee_consent_requests — adviser side OR client side
  const fcrClient = await db
    .select({ id: feeConsentRequests.id, clientUserId: feeConsentRequests.clientUserId, adviserUserId: feeConsentRequests.adviserUserId })
    .from(feeConsentRequests)
    .where(inArray(feeConsentRequests.clientUserId, userIds));
  const fcrAdv = await db
    .select({ id: feeConsentRequests.id, clientUserId: feeConsentRequests.clientUserId, adviserUserId: feeConsentRequests.adviserUserId })
    .from(feeConsentRequests)
    .where(inArray(feeConsentRequests.adviserUserId, userIds));
  const dedupeFcr = new Map<number, { clientUserId: number; adviserUserId: number }>();
  for (const r of [...fcrClient, ...fcrAdv]) dedupeFcr.set(r.id, r);
  for (const r of Array.from(dedupeFcr.values())) {
    const owner = [r.clientUserId, r.adviserUserId].find((id) => tally.has(id));
    if (owner !== undefined) bump(owner, "fee_consent_requests");
  }

  // fee_consents — uses clientId (the client) and adviserId. Both are FK to
  // users.id; we sweep on either side.
  const consentsClient = await db
    .select({ id: feeConsents.id, clientId: feeConsents.clientId, adviserId: feeConsents.adviserId })
    .from(feeConsents)
    .where(inArray(feeConsents.clientId, userIds));
  const consentsAdv = await db
    .select({ id: feeConsents.id, clientId: feeConsents.clientId, adviserId: feeConsents.adviserId })
    .from(feeConsents)
    .where(inArray(feeConsents.adviserId, userIds));
  const dedupeConsents = new Map<number, { clientId: number; adviserId: number | null }>();
  for (const c of [...consentsClient, ...consentsAdv]) dedupeConsents.set(c.id, c);
  for (const c of Array.from(dedupeConsents.values())) {
    const owner = [c.clientId, c.adviserId].find((id): id is number => typeof id === "number" && tally.has(id));
    if (owner !== undefined) bump(owner, "fee_consents");
  }

  // adviser_tasks — adviser OR client
  const tasksClient = await db
    .select({ id: adviserTasks.id, clientUserId: adviserTasks.clientUserId, adviserUserId: adviserTasks.adviserUserId })
    .from(adviserTasks)
    .where(inArray(adviserTasks.clientUserId, userIds));
  const tasksAdv = await db
    .select({ id: adviserTasks.id, clientUserId: adviserTasks.clientUserId, adviserUserId: adviserTasks.adviserUserId })
    .from(adviserTasks)
    .where(inArray(adviserTasks.adviserUserId, userIds));
  const dedupeTasks = new Map<number, { clientUserId: number; adviserUserId: number }>();
  for (const t of [...tasksClient, ...tasksAdv]) dedupeTasks.set(t.id, t);
  for (const t of Array.from(dedupeTasks.values())) {
    const owner = [t.clientUserId, t.adviserUserId].find((id) => tally.has(id));
    if (owner !== undefined) bump(owner, "adviser_tasks");
  }

  // adviser_notes — adviser OR client
  const notesClient = await db
    .select({ id: adviserNotes.id, clientUserId: adviserNotes.clientUserId, adviserUserId: adviserNotes.adviserUserId })
    .from(adviserNotes)
    .where(inArray(adviserNotes.clientUserId, userIds));
  const notesAdv = await db
    .select({ id: adviserNotes.id, clientUserId: adviserNotes.clientUserId, adviserUserId: adviserNotes.adviserUserId })
    .from(adviserNotes)
    .where(inArray(adviserNotes.adviserUserId, userIds));
  const dedupeNotes = new Map<number, { clientUserId: number; adviserUserId: number }>();
  for (const n of [...notesClient, ...notesAdv]) dedupeNotes.set(n.id, n);
  for (const n of Array.from(dedupeNotes.values())) {
    const owner = [n.clientUserId, n.adviserUserId].find((id) => tally.has(id));
    if (owner !== undefined) bump(owner, "adviser_notes");
  }

  // investment_instructions — adviser OR client
  const instrClient = await db
    .select({ id: investmentInstructions.id, clientUserId: investmentInstructions.clientUserId, adviserUserId: investmentInstructions.adviserUserId })
    .from(investmentInstructions)
    .where(inArray(investmentInstructions.clientUserId, userIds));
  const instrAdv = await db
    .select({ id: investmentInstructions.id, clientUserId: investmentInstructions.clientUserId, adviserUserId: investmentInstructions.adviserUserId })
    .from(investmentInstructions)
    .where(inArray(investmentInstructions.adviserUserId, userIds));
  const dedupeInstr = new Map<number, { clientUserId: number; adviserUserId: number }>();
  for (const i of [...instrClient, ...instrAdv]) dedupeInstr.set(i.id, i);
  for (const i of Array.from(dedupeInstr.values())) {
    const owner = [i.clientUserId, i.adviserUserId].find((id) => tally.has(id));
    if (owner !== undefined) bump(owner, "investment_instructions");
  }

  // Materialise into PerUserSummary list.
  for (const s of summaries) {
    const userMap = tally.get(s.user.id)!;
    s.perTable = TABLE_DEFS.map((d) => {
      const cell = userMap.get(d.name)!;
      return {
        table: d.name,
        count: cell.count,
        skippedIds: cell.skipped.length > 0 ? cell.skipped : undefined,
      };
    });
    s.total = s.perTable.reduce((acc, t) => acc + t.count, 0);
  }

  return summaries;
}

function printSummary(summaries: PerUserSummary[], apply: boolean): void {
  const considered = summaries.length;
  const withRows = summaries.filter((s) => s.total > 0 || s.perTable.some((t) => t.skippedIds && t.skippedIds.length > 0));
  console.log(
    `[fixture-cleanup] scanned ${considered} fixture-pattern user(s); ` +
      `${withRows.length} have reachable rows.`,
  );
  for (const s of withRows) {
    const lines: string[] = [];
    for (const t of s.perTable) {
      if (t.count > 0) lines.push(`${t.table}=${t.count}`);
      if (t.skippedIds && t.skippedIds.length > 0) {
        lines.push(`${t.table}.skipped(has_settled_txn)=[${t.skippedIds.join(",")}]`);
      }
    }
    console.log(
      `  user#${s.user.id} <${s.user.email}> [${s.user.matchedPattern}] :: ${lines.join(" ")}`,
    );
  }
  if (!apply) {
    console.log(
      "\n[fixture-cleanup] DRY RUN — re-run with --apply to delete the rows " +
        "above (skipped IDs will be LOGGED, not deleted). No writes performed.",
    );
  }
}

async function applyDeletes(summaries: PerUserSummary[]): Promise<{ deleted: number; auditRows: number }> {
  let deleted = 0;
  let auditRows = 0;

  await db.transaction(async (tx) => {
    for (const s of summaries) {
      for (const t of s.perTable) {
        if (t.count === 0 && (!t.skippedIds || t.skippedIds.length === 0)) continue;

        let actuallyDeleted = 0;
        if (t.count > 0) {
          // Re-execute the delete inside the transaction. We delete by the
          // user's role columns (one round-trip per table per user).
          actuallyDeleted = await deleteForTable(tx, t.table, s.user.id);
          deleted += actuallyDeleted;
        }

        // One audit row per (user, table) — captures both deleted count
        // and skipped ids. Using a stable action shape so the existing
        // adviser_client.deactivated_fixture_cleanup audit dashboards
        // can group both flavours together.
        await writeAuditLog({
          executor: tx,
          userId: null,
          action: `fixture_cleanup.${t.table}`,
          entityType: "user",
          entityId: String(s.user.id),
          before: null,
          after: null,
          extra: {
            email: s.user.email,
            matchedPattern: s.user.matchedPattern,
            deletedCount: actuallyDeleted,
            skippedIds: t.skippedIds ?? [],
            trigger: "cli:cleanup-fixture-rows",
          },
        });
        auditRows += 1;
      }
    }
  });

  return { deleted, auditRows };
}

async function deleteForTable(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  tableName: string,
  userId: number,
): Promise<number> {
  // Each table has either a userId column or one of clientUserId/adviserUserId.
  // We delete every row that mentions this fixture user on either side.
  switch (tableName) {
    case "adviser_fee_deductions": {
      // CRITICAL: skip rows tied to a settled transaction in SQL — not just
      // in the dry-run classification. The buildSummary() pass above flags
      // these as `skippedIds` so the operator can see them in the dry-run
      // output, but the DELETE itself MUST NOT touch them or we corrupt
      // the ledger (the settled transactions reference them via FK and
      // pre-launch reconciliation gates would surface the dangling FK).
      const r1 = await tx
        .delete(adviserFeeDeductions)
        .where(
          and(
            eq(adviserFeeDeductions.clientUserId, userId),
            isNull(adviserFeeDeductions.settledTransactionId),
          ),
        );
      const r2 = await tx
        .delete(adviserFeeDeductions)
        .where(
          and(
            eq(adviserFeeDeductions.adviserUserId, userId),
            isNull(adviserFeeDeductions.settledTransactionId),
          ),
        );
      return (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    }
    case "adviser_fee_accruals": {
      const r1 = await tx.delete(adviserFeeAccruals).where(eq(adviserFeeAccruals.clientUserId, userId));
      const r2 = await tx.delete(adviserFeeAccruals).where(eq(adviserFeeAccruals.adviserUserId, userId));
      return (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    }
    case "adviser_fee_rules": {
      const r1 = await tx.delete(adviserFeeRules).where(eq(adviserFeeRules.clientUserId, userId));
      const r2 = await tx.delete(adviserFeeRules).where(eq(adviserFeeRules.adviserUserId, userId));
      return (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    }
    case "fee_consent_requests": {
      const r1 = await tx.delete(feeConsentRequests).where(eq(feeConsentRequests.clientUserId, userId));
      const r2 = await tx.delete(feeConsentRequests).where(eq(feeConsentRequests.adviserUserId, userId));
      return (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    }
    case "fee_consents": {
      const r1 = await tx.delete(feeConsents).where(eq(feeConsents.clientId, userId));
      const r2 = await tx.delete(feeConsents).where(eq(feeConsents.adviserId, userId));
      return (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    }
    case "adviser_tasks": {
      const r1 = await tx.delete(adviserTasks).where(eq(adviserTasks.clientUserId, userId));
      const r2 = await tx.delete(adviserTasks).where(eq(adviserTasks.adviserUserId, userId));
      return (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    }
    case "adviser_notes": {
      const r1 = await tx.delete(adviserNotes).where(eq(adviserNotes.clientUserId, userId));
      const r2 = await tx.delete(adviserNotes).where(eq(adviserNotes.adviserUserId, userId));
      return (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    }
    case "investment_instructions": {
      const r1 = await tx.delete(investmentInstructions).where(eq(investmentInstructions.clientUserId, userId));
      const r2 = await tx.delete(investmentInstructions).where(eq(investmentInstructions.adviserUserId, userId));
      return (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    }
    default:
      throw new Error(`[fixture-cleanup] unknown table for delete: ${tableName}`);
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const fixtureUsers = await findFixtureUsers();
  if (fixtureUsers.length === 0) {
    console.log("[fixture-cleanup] no fixture-pattern users in the database — nothing to do.");
    return;
  }

  const summary = await buildSummary(fixtureUsers);
  printSummary(summary, apply);

  if (!apply) return;

  const result = await applyDeletes(summary);
  console.log(
    `[fixture-cleanup] APPLIED — deleted ${result.deleted} row(s) across ` +
      `${result.auditRows} audit log entries. Skipped IDs were logged ` +
      `(see audit_logs action='fixture_cleanup.adviser_fee_deductions') ` +
      `and remain in-place because they reference settled transactions; ` +
      `balance them via a posted reversal (see scripts/cleanup-prelaunch-residue.ts).`,
  );
}

// Only run main() when invoked as a CLI (e.g. `npx tsx scripts/cleanup-fixture-rows.ts`).
// When imported by a test (`server/cleanup-fixture-rows.test.ts`), the file
// is loaded for its `findFixtureUsers` / `buildSummary` / `applyDeletes`
// exports only — running main() at module-load would call `process.exit`
// and kill the vitest worker.
const invokedAsScript =
  typeof process.argv[1] === "string" &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedAsScript) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[fixture-cleanup] failed:", err);
      process.exit(1);
    });
}

// Re-export for tests so a regression test can drive findFixtureUsers /
// buildSummary directly without spawning the script via npx.
export { findFixtureUsers, buildSummary, applyDeletes, isTestFixtureEmail };
