// =============================================================================
// CLEANUP — deactivate fixture-pattern adviser_clients links pointing at
// real (non-fixture) advisers. (Task #286 step 4)
// =============================================================================
//
// Background:
//   The adviser Business page started surfacing automated test fixtures
//   (e.g. adviser-race-…@example.com, __prelaunch_x@…, okadv-…@…) as real
//   linked clients in real advisers' books. The CI gates already block
//   write-time fixture leaks, and Task #286 added a defence-in-depth
//   read-path filter so even pre-existing contamination can never render
//   to a real adviser. This script closes the loop: it deactivates the
//   underlying `adviser_clients` rows so the database itself stops claiming
//   the link exists.
//
// Root cause investigation:
//   The visible offenders (`adviser-race-…@example.com`, `adviser-ok-…`,
//   `okadv-…`) do not match any active script in the current codebase —
//   the patterns appear only in user-supplied bug reports under
//   attached_assets/. They were almost certainly created by older test
//   harnesses that have since been removed or refactored without scrubbing
//   their `adviser_clients` rows. Today's active test scripts
//   (scripts/test-planner.ts, scripts/test-fee-deduction-gate-b.ts) use
//   `@test.invalid` emails, which the fixture filter does NOT match — they
//   create fixture-on-fixture adviser_clients links, not fixture-on-real,
//   so they are not affected by this cleanup. Future contaminations are
//   prevented at write time by the existing CI fixture-leakage gates and
//   at read time by the Task #286 filter; this script is one-shot.
//
// Behaviour:
//   - SELECTs every adviser_clients row where:
//       1) is_active = true,
//       2) the client's email matches isTestFixtureEmail(),
//       3) the adviser's email does NOT match isTestFixtureEmail()
//          (so legitimate fixture-on-fixture test links are preserved).
//   - In dry-run mode (default), prints the rows that would be deactivated
//     and exits without writing.
//   - With --apply, sets is_active=false and unlinked_at=NOW() on each row,
//     in a single statement, and prints the affected count.
//
// Usage:
//   npx tsx scripts/deactivate-fixture-adviser-client-links.ts          # dry run
//   npx tsx scripts/deactivate-fixture-adviser-client-links.ts --apply  # commit
// =============================================================================

import "dotenv/config";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "../server/db";
import { adviserClients, users } from "../shared/schema";
import {
  isTestFixtureEmail,
  matchTestFixtureEmail,
} from "../server/services/test-fixture-emails";

interface OffendingRow {
  linkId: number;
  adviserUserId: number;
  adviserEmail: string;
  clientUserId: number;
  clientEmail: string;
  matchedPattern: string;
}

async function findOffendingLinks(): Promise<OffendingRow[]> {
  // Pull every active adviser_clients row plus both sides' emails. The
  // table is small (one row per adviser↔client relationship); a single
  // scan is fine and avoids a chained set of subqueries.
  const rows = await db
    .select({
      linkId: adviserClients.id,
      adviserUserId: adviserClients.adviserUserId,
      clientUserId: adviserClients.clientUserId,
      clientEmail: users.email,
    })
    .from(adviserClients)
    .innerJoin(users, eq(users.id, adviserClients.clientUserId))
    .where(eq(adviserClients.isActive, true));

  const fixtureLinks = rows.filter((r) => isTestFixtureEmail(r.clientEmail));
  if (fixtureLinks.length === 0) return [];

  // Look up adviser emails for the offending links so we can drop fixture-
  // on-fixture pairs (legitimate test scripts create those and the read-
  // path filter intentionally leaves them in place).
  const adviserIds = Array.from(new Set(fixtureLinks.map((r) => r.adviserUserId)));
  const adviserRows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.id, adviserIds));
  const adviserEmailById = new Map(adviserRows.map((u) => [u.id, u.email ?? ""]));

  const offending: OffendingRow[] = [];
  for (const r of fixtureLinks) {
    const adviserEmail = adviserEmailById.get(r.adviserUserId) ?? "";
    if (isTestFixtureEmail(adviserEmail)) continue; // fixture-on-fixture, leave alone
    const m = matchTestFixtureEmail(r.clientEmail);
    offending.push({
      linkId: r.linkId,
      adviserUserId: r.adviserUserId,
      adviserEmail,
      clientUserId: r.clientUserId,
      clientEmail: r.clientEmail,
      matchedPattern: m.matched ? m.pattern : "unknown",
    });
  }
  return offending;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const offending = await findOffendingLinks();
  if (offending.length === 0) {
    console.log(
      "[cleanup] no fixture-on-real adviser_clients links found — nothing to do.",
    );
    return;
  }

  console.log(
    `[cleanup] found ${offending.length} fixture-pattern client link(s) attached to real adviser(s):`,
  );
  for (const o of offending) {
    console.log(
      `  link#${o.linkId}  adviser#${o.adviserUserId} <${o.adviserEmail}>  ` +
        `→  client#${o.clientUserId} <${o.clientEmail}>  [${o.matchedPattern}]`,
    );
  }

  if (!apply) {
    console.log(
      "\n[cleanup] DRY RUN — re-run with --apply to deactivate these links " +
        "(sets is_active=false, unlinked_at=NOW()). No writes performed.",
    );
    return;
  }

  const now = new Date();
  const ids = offending.map((o) => o.linkId);
  const updated = await db
    .update(adviserClients)
    .set({ isActive: false, unlinkedAt: now })
    .where(
      and(
        inArray(adviserClients.id, ids),
        eq(adviserClients.isActive, true),
      ),
    )
    .returning({ id: adviserClients.id });

  console.log(
    `\n[cleanup] deactivated ${updated.length} adviser_clients row(s). ` +
      `Underlying user accounts left in place (this script only cuts the link).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[cleanup] failed:", err);
    process.exit(1);
  });
