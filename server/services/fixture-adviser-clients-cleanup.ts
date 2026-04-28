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
import {
  notifyOperator as defaultNotifyOperator,
  type OperatorAlert,
  type OperatorAlertResult,
} from "./operator-alerts";

// =============================================================================
// TASK #400 — burst-alert thresholds
// =============================================================================
// Default burst thresholds. Tunable via env so ops can dial them in once
// real-world fixture-on-real counts settle.
//
//   FIXTURE_ADVISER_CLIENTS_CLEANUP_ALERT_MIN_COUNT
//     Absolute number of links the cron is allowed to deactivate in a
//     single tick before paging on-call. Default 25 — well above the
//     typical zero/low-single-digit nightly cleanup, low enough to catch
//     a matcher pattern that has accidentally broadened.
//
//   FIXTURE_ADVISER_CLIENTS_CLEANUP_ALERT_MIN_PERCENT
//     Fraction (in PERCENT, 0..100) of TOTAL active adviser_clients links
//     the cron is allowed to deactivate before paging on-call. Default 5
//     i.e. anything that nukes ≥5% of all live adviser↔client edges in
//     a single sweep is treated as a real-looking link being collateral
//     damage.
//
// EITHER threshold trips the alert (OR semantics). Set the count to a very
// large number to disable the count check; set the percent to 100 to
// disable the percent check. Set both high to silence the alert entirely.
// =============================================================================
export const FIXTURE_ADVISER_CLIENTS_CLEANUP_ALERT_SOURCE =
  "fixture-adviser-clients-cleanup-burst";
const DEFAULT_ALERT_MIN_COUNT = 25;
const DEFAULT_ALERT_MIN_PERCENT = 5;

function readEnvNumber(
  name: string,
  fallback: number,
  validate: (n: number) => boolean,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !validate(n)) return fallback;
  return n;
}

export function getFixtureCleanupAlertMinCount(): number {
  return Math.floor(
    readEnvNumber(
      "FIXTURE_ADVISER_CLIENTS_CLEANUP_ALERT_MIN_COUNT",
      DEFAULT_ALERT_MIN_COUNT,
      (n) => n >= 0,
    ),
  );
}

export function getFixtureCleanupAlertMinPercent(): number {
  return readEnvNumber(
    "FIXTURE_ADVISER_CLIENTS_CLEANUP_ALERT_MIN_PERCENT",
    DEFAULT_ALERT_MIN_PERCENT,
    (n) => n >= 0 && n <= 100,
  );
}

export interface FixtureCleanupAlertDecision {
  /** True iff at least one configured threshold was breached. */
  shouldAlert: boolean;
  /** deactivated / totalActiveLinks * 100, or 0 when total is 0. */
  percent: number;
  /** Human-readable reason(s) the threshold tripped, joined with "; ". */
  reason: string | null;
  /** Resolved threshold values used for the decision. */
  minCount: number;
  minPercent: number;
}

/**
 * Pure threshold check. Trips when EITHER the absolute count OR the
 * fraction-of-total exceeds the configured threshold. Exported so tests
 * can drive the decision logic without touching the dispatcher or DB.
 *
 * Semantics:
 *   - `deactivated >= minCount` trips the count rule.
 *   - `(deactivated/totalActiveLinks)*100 >= minPercent` trips the
 *     percent rule. When `totalActiveLinks` is 0 the percent rule is
 *     skipped to avoid a division-by-zero false-positive on an empty DB.
 *   - `deactivated === 0` never alerts regardless of thresholds — a
 *     no-op sweep is the boring/expected case.
 */
export function evaluateFixtureCleanupBurstAlert(
  deactivated: number,
  totalActiveLinks: number,
  thresholds?: { minCount?: number; minPercent?: number },
): FixtureCleanupAlertDecision {
  const minCount = thresholds?.minCount ?? getFixtureCleanupAlertMinCount();
  const minPercent =
    thresholds?.minPercent ?? getFixtureCleanupAlertMinPercent();
  const percent =
    totalActiveLinks > 0 ? (deactivated / totalActiveLinks) * 100 : 0;
  if (deactivated <= 0) {
    return { shouldAlert: false, percent, reason: null, minCount, minPercent };
  }
  const reasons: string[] = [];
  if (deactivated >= minCount) {
    reasons.push(`deactivated=${deactivated} >= minCount=${minCount}`);
  }
  if (totalActiveLinks > 0 && percent >= minPercent) {
    reasons.push(
      `percent=${percent.toFixed(2)}% >= minPercent=${minPercent}% ` +
        `(deactivated=${deactivated} / total=${totalActiveLinks})`,
    );
  }
  return {
    shouldAlert: reasons.length > 0,
    percent,
    reason: reasons.length > 0 ? reasons.join("; ") : null,
    minCount,
    minPercent,
  };
}

export interface FixtureAdviserClientLink {
  linkId: number;
  adviserUserId: number;
  adviserEmail: string;
  clientUserId: number;
  clientEmail: string;
  matchedPattern: string;
}

export interface FixtureAdviserClientLinkScan {
  /** Total number of active rows in `adviser_clients` at scan time. */
  totalActiveLinks: number;
  /** Active rows whose CLIENT email matches `isTestFixtureEmail` and whose
   * ADVISER email does NOT (i.e. the rows the cleanup would flip). */
  offending: FixtureAdviserClientLink[];
}

/**
 * Scan every active adviser_clients row and split into a total count and
 * the offending subset (CLIENT email matches `isTestFixtureEmail` AND
 * ADVISER email does NOT — so legitimate fixture-on-fixture test scripts
 * are left alone).
 *
 * The total count is what the burst-alert threshold check (Task #400)
 * needs to compute "X% of total active links", and falls naturally out of
 * the same scan we already pay for. Returning both keeps the math
 * accurate (offending PLUS untouched real links) without a second query.
 *
 * Pure read — does not mutate the DB.
 */
export async function scanFixtureAdviserClientLinks(): Promise<FixtureAdviserClientLinkScan> {
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

  const totalActiveLinks = rows.length;
  const fixtureLinks = rows.filter((r) => isTestFixtureEmail(r.clientEmail));
  if (fixtureLinks.length === 0) {
    return { totalActiveLinks, offending: [] };
  }

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
  return { totalActiveLinks, offending };
}

/**
 * Backwards-compatible wrapper around `scanFixtureAdviserClientLinks` that
 * returns just the offending rows. Predates Task #400; kept so the CLI
 * `scripts/deactivate-fixture-adviser-client-links.ts` and the existing
 * test suite continue to import the same name.
 */
export async function findFixtureAdviserClientLinks(): Promise<
  FixtureAdviserClientLink[]
> {
  const { offending } = await scanFixtureAdviserClientLinks();
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
  /**
   * Optional override for the burst-alert thresholds (Task #400). When
   * omitted, the env-driven defaults are used. Tests inject this to keep
   * the threshold check deterministic without mutating process.env.
   */
  alertThresholds?: { minCount?: number; minPercent?: number };
  /**
   * Optional override for the operator-alert dispatcher (Task #400). The
   * production path uses `notifyOperator` from `./operator-alerts`; tests
   * inject a stub so they can assert what would have been paged without
   * writing to `operator_alerts`. Setting `null` disables the alert
   * channel entirely (used by the CLI's `--no-alert` mode if added).
   */
  notifyOperator?:
    | ((alert: OperatorAlert) => Promise<OperatorAlertResult>)
    | null;
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
  /**
   * Total number of active adviser_clients rows at scan time (Task #400).
   * Used by the burst-alert percent rule and surfaced for log readers.
   */
  totalActiveLinks: number;
  /** Burst-alert decision for this tick (Task #400). */
  burstAlert: FixtureCleanupAlertDecision;
  /** True if a burst alert was dispatched (false in dry-run or below threshold). */
  burstAlertDispatched: boolean;
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
  const notify =
    options.notifyOperator === undefined
      ? defaultNotifyOperator
      : options.notifyOperator;

  const { totalActiveLinks, offending } = await scanFixtureAdviserClientLinks();
  // Compute the burst-alert decision once, against the offending count
  // BEFORE the sweep. This is intentionally pre-sweep: the threshold check
  // describes "what the cron is about to do", and we want a dry-run to be
  // able to surface the same decision the cron would page on. The
  // `burstAlertDispatched` flag below tracks whether we ACTUALLY paged
  // (always false in dry-run, even if `shouldAlert` is true).
  const preSweepDecision = evaluateFixtureCleanupBurstAlert(
    offending.length,
    totalActiveLinks,
    options.alertThresholds,
  );
  const summary: DeactivateFixtureLinksSummary = {
    scanned: offending.length,
    deactivated: 0,
    alreadyInactive: 0,
    errors: 0,
    dryRun,
    offending,
    totalActiveLinks,
    burstAlert: preSweepDecision,
    burstAlertDispatched: false,
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

  // Re-evaluate against what we ACTUALLY deactivated (after collapsing
  // already-inactive races and per-link errors) so the page reflects the
  // real-world impact, not the pre-sweep intention. We OR the two
  // decisions so an alert fires if either the planned or the realised
  // count breached the threshold — the worst case is the operationally
  // interesting one.
  const postSweepDecision = evaluateFixtureCleanupBurstAlert(
    summary.deactivated,
    totalActiveLinks,
    options.alertThresholds,
  );
  const finalDecision: FixtureCleanupAlertDecision = postSweepDecision.shouldAlert
    ? postSweepDecision
    : preSweepDecision;
  summary.burstAlert = finalDecision;

  if (finalDecision.shouldAlert && notify) {
    try {
      const tickUtcDate = now.toISOString().slice(0, 10);
      await notify({
        source: FIXTURE_ADVISER_CLIENTS_CLEANUP_ALERT_SOURCE,
        severity: "alert",
        title:
          `Fixture cleanup deactivated ${summary.deactivated} adviser↔client ` +
          `link(s) in a single tick (≥ configured threshold)`,
        details: {
          deactivated: summary.deactivated,
          scanned: summary.scanned,
          alreadyInactive: summary.alreadyInactive,
          errors: summary.errors,
          totalActiveLinks: summary.totalActiveLinks,
          percentOfTotal: Number(finalDecision.percent.toFixed(2)),
          minCountThreshold: finalDecision.minCount,
          minPercentThreshold: finalDecision.minPercent,
          reason: finalDecision.reason,
          trigger,
          tickUtcDate,
          // First few link ids so the on-call can pivot straight into the
          // audit log without re-running the scan. Cap at 25 to keep the
          // payload (and any downstream Slack message) bounded.
          sampleLinkIds: offending.slice(0, 25).map((o) => o.linkId),
          remediation:
            "Inspect `audit_logs` for action=adviser_client.deactivated_fixture_cleanup " +
            "in the last hour. If the matcher unexpectedly broadened, set " +
            "FIXTURE_ADVISER_CLIENTS_CLEANUP_DISABLED=1 and revert any change " +
            "to server/services/test-fixture-emails.ts before the next tick.",
        },
        // Explicit dedupe identity (kind/subjectType/subjectId) anchors
        // the alert to today's tick. Note that `notifyOperator` ALSO
        // hashes `details` into the coalescing key, so two ticks on the
        // same UTC date only collapse onto a single operator_alerts row
        // when the surrounding payload (deactivated/scanned/sampleLinkIds
        // etc.) is byte-identical — i.e. when nothing changed between
        // the runs. A tick that finds NEW offending links will quite
        // legitimately page again; that's the desired behaviour for an
        // ongoing matcher regression. The UTC-date subject is still
        // useful for downstream routers grouping alerts by incident day.
        kind: FIXTURE_ADVISER_CLIENTS_CLEANUP_ALERT_SOURCE,
        subjectType: "cron-tick-utc-date",
        subjectId: tickUtcDate,
      });
      summary.burstAlertDispatched = true;
    } catch (err) {
      // notifyOperator already swallows its own channel failures; this
      // catch is belt-and-braces so a hypothetical synchronous throw can
      // never cause the cron to look like it crashed AFTER the writes
      // already landed. The summary still records the breach.
      console.error(
        "[fixture-adviser-clients-cleanup] notifyOperator threw unexpectedly for burst alert",
        (err as Error)?.message ?? err,
      );
    }
  }

  return summary;
}

/**
 * Compose a one-line summary suitable for the `background_job_runs.summary`
 * column and the cron's stdout log line.
 *
 * Task #400: also surfaces `total_active`, the resolved `percent`, and a
 * `BURST_ALERT` tag when either configured threshold tripped — so a log
 * scrape can locate breached ticks without re-querying `operator_alerts`.
 */
export function formatDeactivateSummary(
  s: DeactivateFixtureLinksSummary,
): string {
  if (s.dryRun) {
    const burstHint = s.burstAlert.shouldAlert
      ? ` BURST_ALERT_WOULD_FIRE(${s.burstAlert.reason})`
      : "";
    return (
      `DRY RUN — scanned=${s.scanned}, would deactivate ${s.scanned} link(s) ` +
      `(total_active=${s.totalActiveLinks}, ` +
      `percent=${s.burstAlert.percent.toFixed(2)}%)${burstHint}`
    );
  }
  const burstHint = s.burstAlert.shouldAlert
    ? ` BURST_ALERT_${s.burstAlertDispatched ? "DISPATCHED" : "TRIPPED"}(${s.burstAlert.reason})`
    : "";
  return (
    `scanned=${s.scanned}, deactivated=${s.deactivated}, ` +
    `already_inactive=${s.alreadyInactive}, errors=${s.errors}, ` +
    `total_active=${s.totalActiveLinks}, ` +
    `percent=${s.burstAlert.percent.toFixed(2)}%${burstHint}`
  );
}
