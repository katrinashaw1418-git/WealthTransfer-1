// =============================================================================
// Task #356 — Post-merge auto-trigger for the portfolio-snapshot re-anchor.
// -----------------------------------------------------------------------------
// Why this exists:
//   Task #351 added `scripts/refresh-portfolio-snapshots-aud.ts` plus a
//   runbook describing when to invoke it (after any FX-routing or
//   valuation-rule change). That left a human in the loop: forget the
//   step and the dashboard shows a misleading ~30-day P&L spike because
//   stale snapshot rows are compared against fresh true-AUD totals.
//
//   This runner closes that gap. It hashes the live content of the
//   valuation code path AND the inline FX seed block in
//   `server/routes.ts`, compares the resulting fingerprint against the
//   one recorded on the previous successful run, and re-runs the
//   re-anchor (`--apply`) automatically whenever the fingerprint
//   changes. The fingerprint is persisted in the same `_post_merge_state`
//   table that `scripts/post-merge.sh` already uses for one-shot
//   backfills, so the trigger survives across deploys without any
//   external state.
//
// Trigger inputs (any change to either rewrites the fingerprint):
//   1. `server/services/portfolio-valuation.ts` — owns `convertToAud`
//      and `calculatePortfolioTotalsAtDate`, the two helpers that
//      decide how a wallet/transaction balance becomes an AUD figure.
//   2. The inline `const missingRates = [...]` FX-seed block in
//      `server/routes.ts` — the seed values themselves are part of the
//      valuation contract because every chain-via-USD lookup in
//      `convertToAud` reads them directly.
//
// Why hash content, not git diff:
//   Post-deploy environments don't always have a git history available
//   (slim deploy images, squash-merge containers, etc.). A pure-content
//   fingerprint Just Works regardless: identical bytes → identical
//   fingerprint → no re-run; any change → new fingerprint → one re-run.
//
// What it does on each invocation:
//   1. Read both inputs from disk and compute a 16-char SHA-256
//      fingerprint over their concatenation (with a NUL separator so a
//      content shift across files cannot collide).
//   2. CREATE TABLE IF NOT EXISTS `_post_merge_state` (defensively —
//      `scripts/post-merge.sh` also creates it; either order works).
//   3. If `_post_merge_state` already has a row keyed
//      `task_356_snapshot_reanchor:<fingerprint>` → the current
//      valuation/FX-seed has already been re-anchored against; print a
//      short skip line and exit 0.
//   4. Otherwise spawn `npx tsx scripts/refresh-portfolio-snapshots-aud.ts
//      --apply`, mirror its stdout/stderr to this process's streams, and
//      parse its summary line ("Applied — rewrote N snapshot row(s)
//      across M user(s).") so the deploy log records concretely how
//      much data was rewritten.
//   5. On success (exit 0) record the fingerprint in
//      `_post_merge_state` so the next deploy with the same valuation
//      contract is a no-op. On failure DO NOT record the fingerprint —
//      the next deploy will retry, which is the safer default than
//      silently swallowing a failed re-anchor.
//
// Idempotency / safety:
//   * The underlying refresh script is itself idempotent — it
//     delete-and-rewrites the affected window so re-runs converge on
//     the same result. Running it once per fingerprint change is the
//     correct cadence.
//   * No money moves. Only `portfolio_snapshots` (a derived cache) is
//     touched.
//   * On the very first invocation against any database (no fingerprint
//     ever recorded) the runner will always do one re-anchor pass. That
//     is the desired bootstrap behaviour: it guarantees the snapshot
//     cache is consistent with the currently deployed valuation code,
//     even if this runner ships in the same merge as a valuation
//     change.
//
// Out of scope (intentional):
//   * Detecting changes to `fx_rates` rows that the application updates
//     at runtime (live FX-quote refreshes from the price feed). Those
//     are real performance, not a measurement artefact, and explicitly
//     called out in the runbook as a non-trigger.
//   * Re-anchoring after a code-only refactor that does not change
//     valuation output. The fingerprint is on file CONTENT, so a
//     comment-only edit will trigger one extra (no-op) re-anchor; the
//     refresh script handles that gracefully.
// =============================================================================

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import { sql } from "drizzle-orm";

import { db } from "../server/db";

const VALUATION_PATH = path.resolve(
  process.cwd(),
  "server/services/portfolio-valuation.ts",
);
const ROUTES_PATH = path.resolve(process.cwd(), "server/routes.ts");

// The inline FX-seed block lives inside `server/routes.ts` as a
// `const missingRates = [ ... ];` literal. Hashing the whole file would
// fire the trigger on every routes.ts change (which is far too noisy);
// extracting just this literal keeps the fingerprint tight to the
// values that actually feed `convertToAud`'s chain-via-USD lookup.
//
// The regex is non-greedy so it stops at the first `];` and matches
// across newlines. If the seed block is moved or renamed, this runner
// will fail loud (exit 2) rather than silently skipping — which is the
// correct behaviour because a missing trigger source means the gate is
// broken, not that no re-anchor is needed.
const FX_SEED_REGEX = /const\s+missingRates\s*=\s*\[[\s\S]*?\];/;

const FINGERPRINT_KEY_PREFIX = "task_356_snapshot_reanchor:";

interface RefreshSummary {
  rowsRewritten: number | null;
  usersAffected: number | null;
  perUserFailures: string[];
}

interface AppliedAtRow {
  applied_at?: unknown;
  appliedAt?: unknown;
}

// `db.execute(sql`...`)` is typed loosely by drizzle-neon-serverless —
// some shapes hand back `{ rows: [...] }`, others hand back the array
// directly depending on the underlying driver. Mirrors the typed
// extraction helper used in `scripts/test-fee-deduction-gate-b.ts` and
// `server/services/posting-receipt-invariant.ts` so we never need an
// `as any` cast against the loose result shape.
function extractAppliedAtRows(result: unknown): AppliedAtRow[] {
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as AppliedAtRow[];
  }
  if (Array.isArray(result)) return result as AppliedAtRow[];
  return [];
}

function computeFingerprint(): string {
  const valuationSrc = readFileSync(VALUATION_PATH, "utf8");
  const routesSrc = readFileSync(ROUTES_PATH, "utf8");
  const fxSeedMatch = routesSrc.match(FX_SEED_REGEX);
  if (!fxSeedMatch) {
    throw new Error(
      `[post-merge:snapshot-reanchor] could not locate 'const missingRates = [...]' in ${ROUTES_PATH}. ` +
        `The trigger source has moved or been renamed. Update FX_SEED_REGEX in ` +
        `scripts/post-merge-portfolio-snapshot-reanchor.ts so the fingerprint stays tied to the FX seed.`,
    );
  }
  return createHash("sha256")
    .update(valuationSrc, "utf8")
    .update("\0", "utf8")
    .update(fxSeedMatch[0], "utf8")
    .digest("hex")
    .slice(0, 16);
}

async function ensureStateTable(): Promise<void> {
  // Mirrors the table shape created at the top of
  // `scripts/post-merge.sh`. Both creators are idempotent so the
  // execution order between them does not matter.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS _post_merge_state (
      key text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function fingerprintAlreadyApplied(
  fingerprint: string,
): Promise<{ appliedAt: string } | null> {
  const key = `${FINGERPRINT_KEY_PREFIX}${fingerprint}`;
  const result = await db.execute(sql`
    SELECT applied_at FROM _post_merge_state WHERE key = ${key}
  `);
  const rows = extractAppliedAtRows(result);
  if (rows.length === 0) return null;
  const raw = rows[0].applied_at ?? rows[0].appliedAt ?? null;
  return { appliedAt: raw ? String(raw) : "(unknown timestamp)" };
}

async function recordFingerprint(fingerprint: string): Promise<void> {
  const key = `${FINGERPRINT_KEY_PREFIX}${fingerprint}`;
  // ON CONFLICT DO NOTHING because two concurrent post-merges (e.g. a
  // CI retry firing while a manual run is in flight) should converge
  // on the same recorded state instead of one of them crashing.
  await db.execute(sql`
    INSERT INTO _post_merge_state(key) VALUES (${key})
    ON CONFLICT (key) DO NOTHING
  `);
}

function parseRefreshSummary(combined: string): RefreshSummary {
  // The refresh script's success line is shaped exactly:
  //   "Applied — rewrote 1234 snapshot row(s) across 56 user(s)."
  // We tolerate localised digit groupings just in case.
  const m = combined.match(
    /Applied\s+—\s+rewrote\s+([\d,]+)\s+snapshot row\(s\)\s+across\s+([\d,]+)\s+user\(s\)/,
  );
  const rowsRewritten = m ? Number(m[1].replace(/,/g, "")) : null;
  const usersAffected = m ? Number(m[2].replace(/,/g, "")) : null;

  // The refresh script swallows per-user errors (try/catch around
  // `rebuildForUser`) and still exits 0, but it logs each one as
  //   `  user=<id>  FAILED: <message>`
  // We harvest those so the runner can refuse to record the
  // fingerprint when even one user did not converge — otherwise a
  // partial re-anchor would silently mark the deploy as "done" and
  // the next deploy with the same fingerprint would not retry.
  const perUserFailures: string[] = [];
  const failureRe = /^\s*user=(\S+)\s+FAILED:\s*(.*)$/gm;
  let f: RegExpExecArray | null;
  while ((f = failureRe.exec(combined)) !== null) {
    perUserFailures.push(`user=${f[1]}: ${f[2].trim()}`);
  }

  return {
    rowsRewritten: rowsRewritten !== null && Number.isFinite(rowsRewritten)
      ? rowsRewritten
      : null,
    usersAffected: usersAffected !== null && Number.isFinite(usersAffected)
      ? usersAffected
      : null,
    perUserFailures,
  };
}

function runRefreshScript(): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync(
    "npx",
    ["tsx", "scripts/refresh-portfolio-snapshots-aud.ts", "--apply"],
    {
      env: process.env,
      encoding: "utf8",
      // Generous buffer — the refresh script logs one short line per
      // user, so even a five-figure user base fits comfortably.
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  // Mirror live output to the deploy log so an operator tailing the
  // post-merge run sees per-user progress, not just the final summary.
  if (stdout.length > 0) process.stdout.write(stdout);
  if (stderr.length > 0) process.stderr.write(stderr);
  const exitCode = r.error || r.signal ? -1 : (r.status ?? -1);
  return { exitCode, stdout, stderr };
}

async function main(): Promise<void> {
  const fingerprint = computeFingerprint();
  console.log(
    `[post-merge:snapshot-reanchor] valuation+FX-seed fingerprint = ${fingerprint}`,
  );

  await ensureStateTable();

  const already = await fingerprintAlreadyApplied(fingerprint);
  if (already) {
    console.log(
      `[post-merge:snapshot-reanchor] fingerprint already applied at ${already.appliedAt}; ` +
        `no valuation-affecting change since the last re-anchor — skipping.`,
    );
    return;
  }

  console.log(
    `[post-merge:snapshot-reanchor] new fingerprint detected — running ` +
      `'npx tsx scripts/refresh-portfolio-snapshots-aud.ts --apply' ...`,
  );

  const { exitCode, stdout, stderr } = runRefreshScript();

  // Parse stdout AND stderr — `user=<id> FAILED:` lines from the
  // try/catch inside the refresh script are written to stderr.
  const summary = parseRefreshSummary(`${stdout}\n${stderr}`);

  if (exitCode !== 0) {
    console.error(
      `[post-merge:snapshot-reanchor] refresh script exited ${exitCode}; ` +
        `NOT recording fingerprint so the next deploy retries.`,
    );
    process.exit(exitCode === 0 ? 1 : exitCode);
  }

  if (summary.perUserFailures.length > 0) {
    // The refresh script wraps each user in try/catch and still exits
    // 0 even when some users fail. If we recorded the fingerprint
    // here, the next deploy with the same valuation+FX-seed contract
    // would short-circuit and the failed users would be left with
    // half-rewritten history forever. Surface the failures and exit
    // non-zero so the next post-merge retries — by then the operator
    // either fixed the underlying error or has enough signal in the
    // deploy log to act.
    console.error(
      `[post-merge:snapshot-reanchor] refresh script reported ${summary.perUserFailures.length} ` +
        `per-user failure(s); NOT recording fingerprint so the next deploy retries:`,
    );
    for (const f of summary.perUserFailures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }

  await recordFingerprint(fingerprint);

  const rowsStr =
    summary.rowsRewritten === null ? "?" : String(summary.rowsRewritten);
  const usersStr =
    summary.usersAffected === null ? "?" : String(summary.usersAffected);
  console.log(
    `[post-merge:snapshot-reanchor] DONE — rewrote ${rowsStr} snapshot row(s) ` +
      `across ${usersStr} user(s); fingerprint ${fingerprint} recorded in ` +
      `_post_merge_state. The dashboard's monthly P&L card and Performance ` +
      `by Period chart are now consistent with the deployed valuation contract.`,
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[post-merge:snapshot-reanchor] FAILED:", err);
    process.exit(1);
  },
);
