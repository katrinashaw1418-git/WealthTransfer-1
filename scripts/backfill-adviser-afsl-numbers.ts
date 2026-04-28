// =============================================================================
// Task #333 — One-off backfill: populate `adviser_profiles.afsl_number` for
// every active adviser whose row currently has a NULL or empty value.
// -----------------------------------------------------------------------------
// Why
//   Task #315 introduced the per-page AFSL line on generated reports. The
//   field falls back to the env-driven `AMAX_LICENSEE_AFSL` when the
//   per-adviser column is empty, but a per-adviser value is required so
//   that an adviser writing under a different licensee number is rendered
//   correctly. Task #333 wires the real licensee copy into the PDF; this
//   script ensures every active adviser_profiles row carries a concrete
//   AFSL number (defaulting to the licensee value from env) so the
//   header line, the disclosure page, and the PDF Author metadata field
//   never display the synthetic "AFSL [PLACEHOLDER]" sentinel for an
//   active adviser.
//
// Idempotency / safety
//   * Only updates rows where (status='active') AND (afsl_number IS NULL
//     OR afsl_number = ''). Re-running the script never overwrites a
//     value that has already been populated by the operator/admin UI.
//   * Refuses to apply when the resolved licensee value is itself a
//     PLACEHOLDER sentinel (i.e. AMAX_LICENSEE_AFSL env var hasn't been
//     configured for the running environment) — running this in dev/demo
//     would otherwise stamp every adviser with the placeholder string,
//     which is exactly what Task #333 is trying to prevent.
//   * Marker row in `_post_merge_state` (key
//     `task_333_adviser_afsl_backfill`) records when the script ran
//     successfully. The script does NOT short-circuit on the marker —
//     its WHERE clause is the real idempotency guard so future advisers
//     onboarded without an AFSL value will be picked up on a later run.
//   * No money moves. Only `adviser_profiles.afsl_number` is touched.
//
// Usage
//   tsx scripts/backfill-adviser-afsl-numbers.ts            # dry-run
//   tsx scripts/backfill-adviser-afsl-numbers.ts --apply    # commit
// =============================================================================

import { sql } from "drizzle-orm";
import { db } from "../server/db";

const APPLY = process.argv.includes("--apply");
const STATE_KEY = "task_333_adviser_afsl_backfill";

const LICENSEE_AFSL =
  process.env.AMAX_LICENSEE_AFSL?.trim() || "AFSL [PLACEHOLDER]";

interface CandidateRow {
  id: number;
  user_id: number;
  status: string | null;
  current_afsl: string | null;
}

async function ensureStateTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS _post_merge_state (
      key text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function loadCandidates(): Promise<CandidateRow[]> {
  const result = await db.execute<CandidateRow>(sql`
    SELECT
      ap.id           AS id,
      ap.user_id      AS user_id,
      ap.status       AS status,
      ap.afsl_number  AS current_afsl
    FROM adviser_profiles ap
    WHERE ap.status = 'active'
      AND (ap.afsl_number IS NULL OR length(trim(ap.afsl_number)) = 0)
    ORDER BY ap.id
  `);
  return result.rows as unknown as CandidateRow[];
}

async function recordStateMarker(): Promise<void> {
  await db.execute(sql`
    INSERT INTO _post_merge_state(key) VALUES (${STATE_KEY})
    ON CONFLICT (key) DO NOTHING
  `);
}

async function main(): Promise<void> {
  console.log(
    `[backfill-adviser-afsl] mode=${APPLY ? "APPLY" : "DRY-RUN"}`,
  );
  console.log(`[backfill-adviser-afsl] licensee_value=${LICENSEE_AFSL}`);

  if (LICENSEE_AFSL.includes("PLACEHOLDER")) {
    // No-op (and DON'T fail CI) when the env var hasn't been configured.
    // dev/demo environments routinely run post-merge with no licensee
    // value set; failing here would gate every merge on operator action
    // that hasn't happened yet. Production deploys WILL have the env var
    // set, so the real backfill happens there.
    console.log(
      "[backfill-adviser-afsl] AMAX_LICENSEE_AFSL is still a [PLACEHOLDER] " +
        "value — skipping backfill. Configure the env var with the " +
        "compliance-approved AFSL number to enable the backfill on the " +
        "next run.",
    );
    return;
  }

  await ensureStateTable();

  const candidates = await loadCandidates();
  console.log(
    `[backfill-adviser-afsl] active adviser_profiles needing backfill=${candidates.length}`,
  );
  for (const c of candidates) {
    console.log(
      `  adviser_profile_id=${c.id} user_id=${c.user_id} status=${c.status} current=${c.current_afsl ?? "NULL"} -> ${LICENSEE_AFSL}`,
    );
  }

  if (!APPLY) {
    console.log(
      `\nDRY-RUN — would update ${candidates.length} row(s). ` +
        `Re-run with --apply to commit.`,
    );
    return;
  }

  if (candidates.length === 0) {
    console.log("Nothing to do — all active advisers already have an AFSL.");
    await recordStateMarker();
    return;
  }

  // Single set-based UPDATE. The WHERE clause re-applies the empty/null
  // predicate so a concurrent admin write that landed BETWEEN
  // loadCandidates() and this UPDATE cannot be clobbered.
  const realUpdate = await db.execute<{ id: number }>(sql`
    UPDATE adviser_profiles
       SET afsl_number = ${LICENSEE_AFSL}
     WHERE status = 'active'
       AND (afsl_number IS NULL OR length(trim(afsl_number)) = 0)
    RETURNING id
  `);

  console.log(
    `[backfill-adviser-afsl] updated ${realUpdate.rows.length} row(s).`,
  );

  await recordStateMarker();
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[backfill-adviser-afsl] failed:", err);
    process.exit(1);
  });
