// =============================================================================
// TASK #347 — Recurring cleanup of fixture-pattern adviser_clients links
// =============================================================================
// Background:
//   Task #308 added a defence-in-depth READ-time filter in
//   `server/services/adviser-access.ts` that hides fixture-pattern client
//   accounts (e.g. `adviser-race-…@example.com`, `okadv-…@…`) from any
//   adviser surface. The contaminating rows still sat in `adviser_clients`
//   though — every page load paid the filter cost, and any future surface
//   added without going through `adviser-access.ts` could re-leak them.
//
//   `scripts/deactivate-fixture-adviser-client-links.ts` already had a
//   one-shot cleanup that shares the same matcher as the live filter
//   (`server/services/test-fixture-emails.ts`). What was missing was a
//   recurring run.
//
// What this service provides:
//   - `findFixtureAdviserClientLinks()` — pure read; returns every active
//     adviser_clients row whose CLIENT email matches `isTestFixtureEmail`
//     and whose ADVISER email does NOT (so legitimate fixture-on-fixture
//     test links are preserved).
//   - `deactivateFixtureAdviserClientLinks({ dryRun })` — runs the read,
//     and (when `dryRun` is false) flips `is_active=false` and stamps
//     `unlinked_at=NOW()` ONE LINK AT A TIME inside a transaction that
//     also writes a `writeAuditLog` row per (adviserUserId, clientUserId)
//     pair. One row per link gives ops a traceable "why did this link
//     turn inactive" record without a join across the runs table.
//
// Used by:
//   - `scripts/deactivate-fixture-adviser-client-links.ts` (CLI, dry-run
//     by default, `--apply` to write).
//   - The nightly cron registered in `server/index.ts` under the
//     `fixture-adviser-clients-cleanup` job name.
// =============================================================================

import { and, eq, inArray } from "drizzle-orm";

import { db } from "../db";
import { adviserClients, users } from "@shared/schema";
import {
  isTestFixtureEmail,
  matchTestFixtureEmail,
} from "./test-fixture-emails";
import { writeAuditLog } from "./audit";

export interface FixtureAdviserClientLink {
  linkId: number;
  adviserUserId: number;
  adviserEmail: string;
  clientUserId: number;
  clientEmail: string;
  matchedPattern: string;
}

/**
 * Find every active adviser_clients row whose CLIENT email matches
 * `isTestFixtureEmail` AND whose ADVISER email does NOT (so legitimate
 * fixture-on-fixture test scripts are left alone).
 *
 * Pure read — does not mutate the DB.
 */
export async function findFixtureAdviserClientLinks(): Promise<
  FixtureAdviserClientLink[]
> {
  // Pull every active adviser_clients row with the client email attached.
  // The table is small (one row per adviser↔client relationship); a single
  // scan is cheaper than chained subqueries and keeps the matcher logic in
  // one place.
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
  const adviserIds = Array.from(
    new Set(fixtureLinks.map((r) => r.adviserUserId)),
  );
  const adviserRows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.id, adviserIds));
  const adviserEmailById = new Map(
    adviserRows.map((u) => [u.id, u.email ?? ""]),
  );

  const offending: FixtureAdviserClientLink[] = [];
  for (const r of fixtureLinks) {
    const adviserEmail = adviserEmailById.get(r.adviserUserId) ?? "";
    if (isTestFixtureEmail(adviserEmail)) continue; // fixture-on-fixture
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

export interface DeactivateFixtureLinksOptions {
  /** When true, no DB writes are performed. Default false. */
  dryRun?: boolean;
  /**
   * Identifier of the trigger that ran the sweep. Recorded into the audit
   * row's `extra.trigger`, so ops can tell a CLI run from a cron tick.
   * Defaults to "fixture-adviser-clients-cleanup".
   */
  trigger?: string;
}

export interface DeactivateFixtureLinksSummary {
  /** Number of offending rows the read step found. */
  scanned: number;
  /** Number of rows actually flipped to inactive (zero in dry-run). */
  deactivated: number;
  /** Rows that races/concurrent updates left alone (already inactive). */
  alreadyInactive: number;
  /** Rows whose UPDATE+audit transaction threw. */
  errors: number;
  /** Whether this was a dry run (no writes performed). */
  dryRun: boolean;
  /** Snapshot of every offending link the read step found (for logs). */
  offending: FixtureAdviserClientLink[];
}

/**
 * Find and (unless dryRun) deactivate every fixture-pattern adviser_clients
 * link pointing at a real adviser. Each deactivation is performed inside a
 * transaction that also writes a `writeAuditLog` row keyed by
 * (adviserUserId, clientUserId) so ops can trace why a row went inactive.
 *
 * Idempotent: re-running on a clean DB is a no-op (scanned=0, deactivated=0).
 *
 * Per-link errors are caught and counted so a single bad row never aborts
 * the rest of the sweep. The summary is returned regardless.
 */
export async function deactivateFixtureAdviserClientLinks(
  options: DeactivateFixtureLinksOptions = {},
): Promise<DeactivateFixtureLinksSummary> {
  const dryRun = options.dryRun ?? false;
  const trigger = options.trigger ?? "fixture-adviser-clients-cleanup";

  const offending = await findFixtureAdviserClientLinks();
  const summary: DeactivateFixtureLinksSummary = {
    scanned: offending.length,
    deactivated: 0,
    alreadyInactive: 0,
    errors: 0,
    dryRun,
    offending,
  };
  if (offending.length === 0 || dryRun) {
    return summary;
  }

  const now = new Date();
  for (const link of offending) {
    try {
      // Per-link transaction: the UPDATE and the audit row land together,
      // so a failure on either side rolls both back. The audit insert is
      // also fail-closed inside `writeAuditLog`, so a stuck audit table
      // would surface as a per-link error rather than a silent skip.
      await db.transaction(async (tx) => {
        const updated = await tx
          .update(adviserClients)
          .set({ isActive: false, unlinkedAt: now })
          .where(
            and(
              eq(adviserClients.id, link.linkId),
              eq(adviserClients.isActive, true),
            ),
          )
          .returning({ id: adviserClients.id });

        if (updated.length === 0) {
          // Concurrent run / admin manual deactivation between read and
          // write — count it and skip the audit row (no state change to
          // record).
          summary.alreadyInactive++;
          return;
        }

        await writeAuditLog({
          executor: tx,
          userId: null,
          action: "adviser_client.deactivated_fixture_cleanup",
          entityType: "adviser_client",
          entityId: String(link.linkId),
          before: { isActive: true, unlinkedAt: null },
          after: { isActive: false, unlinkedAt: now.toISOString() },
          extra: {
            adviserUserId: link.adviserUserId,
            clientUserId: link.clientUserId,
            matchedPattern: link.matchedPattern,
            trigger,
          },
          ipAddress: null,
        });
        summary.deactivated++;
      });
    } catch (err) {
      summary.errors++;
      console.error(
        `[fixture-adviser-clients-cleanup] failed to deactivate link#${link.linkId} ` +
          `(adviser#${link.adviserUserId} → client#${link.clientUserId}):`,
        err,
      );
    }
  }

  return summary;
}

/**
 * Compose a one-line summary suitable for the `background_job_runs.summary`
 * column and the cron's stdout log line.
 */
export function formatDeactivateSummary(
  s: DeactivateFixtureLinksSummary,
): string {
  if (s.dryRun) {
    return `DRY RUN — scanned=${s.scanned}, would deactivate ${s.scanned} link(s)`;
  }
  return (
    `scanned=${s.scanned}, deactivated=${s.deactivated}, ` +
    `already_inactive=${s.alreadyInactive}, errors=${s.errors}`
  );
}
