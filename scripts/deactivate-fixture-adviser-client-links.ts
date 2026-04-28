// =============================================================================
// CLEANUP — deactivate fixture-pattern adviser_clients links pointing at
// real (non-fixture) advisers. (Originally Task #286 step 4; rewired by
// Task #347 to share the runner used by the nightly cron.)
// =============================================================================
//
// Background:
//   The adviser Business page started surfacing automated test fixtures
//   (e.g. adviser-race-…@example.com, __prelaunch_x@…, okadv-…@…) as real
//   linked clients in real advisers' books. The CI gates already block
//   write-time fixture leaks, and Task #286 added a defence-in-depth
//   read-path filter so even pre-existing contamination can never render
//   to a real adviser. This script closes the loop by deactivating the
//   underlying `adviser_clients` rows so the database itself stops
//   claiming the link exists.
//
// Task #347 turned the one-shot logic into the
// `fixture-adviser-clients-cleanup` service so the same code can run
// nightly via a cron in `server/index.ts` AND from this CLI on demand.
// Each deactivation now writes a `writeAuditLog` row keyed by
// (adviserUserId, clientUserId) so ops can trace why a row went inactive.
//
// Behaviour:
//   - Dry-run by default: prints every offending link and exits.
//   - With `--apply`, flips is_active=false and unlinkedAt=NOW() per link
//     inside a transaction that also writes one
//     `adviser_client.deactivated_fixture_cleanup` audit row.
//
// Usage:
//   npx tsx scripts/deactivate-fixture-adviser-client-links.ts          # dry run
//   npx tsx scripts/deactivate-fixture-adviser-client-links.ts --apply  # commit
// =============================================================================

import "dotenv/config";

import {
  deactivateFixtureAdviserClientLinks,
  formatDeactivateSummary,
} from "../server/services/fixture-adviser-clients-cleanup";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const summary = await deactivateFixtureAdviserClientLinks({
    dryRun: !apply,
    trigger: "cli:deactivate-fixture-adviser-client-links",
  });

  if (summary.scanned === 0) {
    console.log(
      "[cleanup] no fixture-on-real adviser_clients links found — nothing to do.",
    );
    return;
  }

  console.log(
    `[cleanup] found ${summary.scanned} fixture-pattern client link(s) attached to real adviser(s):`,
  );
  for (const o of summary.offending) {
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

  console.log(`\n[cleanup] ${formatDeactivateSummary(summary)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[cleanup] failed:", err);
    process.exit(1);
  });
