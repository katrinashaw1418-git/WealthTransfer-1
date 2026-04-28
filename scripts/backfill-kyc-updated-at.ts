// =============================================================================
// Task #311 — One-off backfill: anchor `users.kycUpdatedAt` on the most recent
// real KYC status change for each existing client (or, when no audit trail is
// available, on the user's account-creation date).
// -----------------------------------------------------------------------------
// Why
//   Task #285 added `users.kyc_updated_at` with a `defaultNow()` so the
//   adviser-task automation cron could anchor KYC follow-up due dates on a
//   per-client signal (`kycUpdatedAt + 30d`). When the column was first
//   added, every existing row received "the moment the schema push ran"
//   instead of the user's actual last status change. The Task #285 inline
//   block in `scripts/post-merge.sh` already runs a fallback that copies
//   `created_at` into the column for every legacy row.
//
//   This script extends that backfill: it walks `audit_logs` for any entry
//   that records a real KYC status change (action containing "kyc", or
//   metadata containing a `kycStatus` field — the contract used by past
//   and future writeAuditLog() callers), and for each user uses the most
//   recent such timestamp instead of `created_at`. When no audit-log
//   evidence exists for a user, the existing fallback to `created_at`
//   stands.
//
//   The current `audit_logs` table contains no KYC-named actions, so on
//   today's database this script is a no-op for legacy rows (their
//   `kyc_updated_at` already equals `created_at` from the earlier Task
//   #285 backfill). Its real value is forward-looking: once writeAuditLog
//   callers start emitting KYC change events, re-running the script (or
//   merely letting it run on a fresh deploy) re-anchors the column on the
//   actual change instant.
//
// Idempotency / safety
//   * Monotonic-only: a row's `kyc_updated_at` is updated ONLY when the
//     newly-computed value (= GREATEST(created_at, latest KYC audit-log
//     timestamp for that user)) is strictly NEWER than the value already
//     stored. Real updates written through `storage.updateUser()` (which
//     stamps `new Date()` whenever `kycStatus` changes) therefore survive
//     a re-run of this script — we will never DECREASE the timestamp.
//   * Marker row in `_post_merge_state` (key
//     `task_311_kyc_updated_at_audit_walk_backfill`) records when the
//     script ran successfully so an operator inspecting the table can see
//     the backfill was applied. The script does NOT short-circuit on the
//     marker — its update predicate (`new > current`) is the real
//     idempotency guard, so the script is safe to re-run after future
//     KYC audit-log entries land.
//   * No money moves. Only the `kyc_updated_at` column on `users` is
//     touched.
//
// Usage
//   tsx scripts/backfill-kyc-updated-at.ts            # dry-run
//   tsx scripts/backfill-kyc-updated-at.ts --apply    # commit
// =============================================================================

import { sql } from "drizzle-orm";
import { db } from "../server/db";

const APPLY = process.argv.includes("--apply");
const STATE_KEY = "task_311_kyc_updated_at_audit_walk_backfill";

interface CandidateRow {
  id: number;
  current_kyc_updated_at: Date | null;
  created_at: Date | null;
  latest_kyc_audit: Date | null;
  candidate: Date | null;
  needs_update: boolean;
}

async function ensureStateTable(): Promise<void> {
  // Mirrors the table shape created at the top of `scripts/post-merge.sh`
  // and `scripts/post-merge-portfolio-snapshot-reanchor.ts`. All creators
  // are idempotent so the execution order between them does not matter.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS _post_merge_state (
      key text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

// ---------------------------------------------------------------------------
// Per-user candidate computation.
//
// A row in `audit_logs` counts as a "KYC status change" event for a given
// user when BOTH:
//   1. it is attributable to the user — either via `audit_logs.user_id`
//      OR via `entity_type='user' AND entity_id::int = users.id`; and
//   2. it carries KYC-change semantics — either the `action` contains the
//      substring "kyc" (case-insensitive) OR the JSON metadata contains
//      a `kycStatus` field (also covers `before.kycStatus` /
//      `after.kycStatus`, the shape used by the standard
//      writeAuditLog({ before, after }) helper).
//
// `entity_id` is `text` (so it can hold emails for invite-flow events),
// hence the `~ '^[0-9]+$'` digit-only guard before the `::int` cast.
// ---------------------------------------------------------------------------
async function loadCandidates(): Promise<CandidateRow[]> {
  const result = await db.execute<CandidateRow>(sql`
    WITH kyc_events AS (
      SELECT
        COALESCE(
          CASE
            WHEN al.entity_type = 'user' AND al.entity_id ~ '^[0-9]+$'
              THEN al.entity_id::int
            ELSE NULL
          END,
          al.user_id
        ) AS uid,
        al.created_at AS at
      FROM audit_logs al
      WHERE
        al.action ILIKE '%kyc%'
        OR al.metadata::text ILIKE '%"kycStatus"%'
    ),
    per_user AS (
      SELECT uid, MAX(at) AS latest_kyc_audit
      FROM kyc_events
      WHERE uid IS NOT NULL
      GROUP BY uid
    )
    SELECT
      u.id                                                  AS id,
      u.kyc_updated_at                                      AS current_kyc_updated_at,
      u.created_at                                          AS created_at,
      pu.latest_kyc_audit                                   AS latest_kyc_audit,
      GREATEST(
        u.created_at,
        COALESCE(pu.latest_kyc_audit, u.created_at)
      )                                                     AS candidate,
      (
        GREATEST(
          u.created_at,
          COALESCE(pu.latest_kyc_audit, u.created_at)
        ) IS NOT NULL
        AND (
          u.kyc_updated_at IS NULL
          OR GREATEST(
               u.created_at,
               COALESCE(pu.latest_kyc_audit, u.created_at)
             ) > u.kyc_updated_at
        )
      )                                                     AS needs_update
    FROM users u
    LEFT JOIN per_user pu ON pu.uid = u.id
    ORDER BY u.id
  `);
  return result.rows as unknown as CandidateRow[];
}

async function recordStateMarker(): Promise<void> {
  // ON CONFLICT DO NOTHING: a re-run after an earlier successful pass
  // should not crash on the unique-key collision, it should simply leave
  // the original applied_at intact (that's the moment the backfill was
  // first verified to have run cleanly).
  await db.execute(sql`
    INSERT INTO _post_merge_state(key) VALUES (${STATE_KEY})
    ON CONFLICT (key) DO NOTHING
  `);
}

async function main(): Promise<void> {
  console.log(
    `[backfill-kyc-updated-at] mode=${APPLY ? "APPLY" : "DRY-RUN"}`,
  );

  await ensureStateTable();

  const candidates = await loadCandidates();
  const total = candidates.length;
  const withAuditEvidence = candidates.filter(
    (c) => c.latest_kyc_audit !== null,
  ).length;
  const toUpdate = candidates.filter((c) => c.needs_update);
  const fallbackOnly = candidates.filter(
    (c) => c.latest_kyc_audit === null,
  ).length;

  console.log(
    `  scanned=${total} users, ` +
      `with_audit_evidence=${withAuditEvidence}, ` +
      `fallback_to_created_at=${fallbackOnly}, ` +
      `needs_update=${toUpdate.length}`,
  );

  for (const c of toUpdate) {
    const fromIso = c.current_kyc_updated_at
      ? new Date(c.current_kyc_updated_at).toISOString()
      : "NULL";
    const toIso = c.candidate ? new Date(c.candidate).toISOString() : "NULL";
    const source = c.latest_kyc_audit ? "audit_log" : "created_at";
    console.log(`  user=${c.id}  ${fromIso}  ->  ${toIso}  (source=${source})`);
  }

  if (!APPLY) {
    console.log(
      `\nDRY-RUN — would update ${toUpdate.length} user row(s). ` +
        `Re-run with --apply to commit.`,
    );
    return;
  }

  if (toUpdate.length === 0) {
    console.log("Nothing to do — all rows already converged.");
    await recordStateMarker();
    return;
  }

  // Single set-based UPDATE. The WHERE clause re-applies the
  // monotonic-only predicate so a concurrent storage.updateUser() that
  // landed BETWEEN loadCandidates() and this UPDATE cannot be clobbered.
  const realUpdate = await db.execute<{ id: number }>(sql`
    WITH kyc_events AS (
      SELECT
        COALESCE(
          CASE
            WHEN al.entity_type = 'user' AND al.entity_id ~ '^[0-9]+$'
              THEN al.entity_id::int
            ELSE NULL
          END,
          al.user_id
        ) AS uid,
        al.created_at AS at
      FROM audit_logs al
      WHERE
        al.action ILIKE '%kyc%'
        OR al.metadata::text ILIKE '%"kycStatus"%'
    ),
    per_user AS (
      SELECT uid, MAX(at) AS latest_kyc_audit
      FROM kyc_events
      WHERE uid IS NOT NULL
      GROUP BY uid
    ),
    target AS (
      SELECT
        u.id,
        GREATEST(
          u.created_at,
          COALESCE(pu.latest_kyc_audit, u.created_at)
        ) AS candidate
      FROM users u
      LEFT JOIN per_user pu ON pu.uid = u.id
    )
    UPDATE users u
       SET kyc_updated_at = t.candidate
      FROM target t
     WHERE u.id = t.id
       AND t.candidate IS NOT NULL
       AND (
         u.kyc_updated_at IS NULL
         OR t.candidate > u.kyc_updated_at
       )
    RETURNING u.id
  `);

  const updatedIds = (realUpdate.rows as Array<{ id: number }>).map((r) => r.id);
  console.log(
    `\nApplied — updated ${updatedIds.length} user row(s)` +
      (updatedIds.length > 0 ? `: ids=[${updatedIds.join(", ")}]` : ""),
  );

  await recordStateMarker();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[backfill-kyc-updated-at] FAILED:", err);
    process.exit(1);
  },
);
