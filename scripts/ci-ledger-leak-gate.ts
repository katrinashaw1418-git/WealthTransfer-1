// ---------------------------------------------------------------------------
// CI Ledger-Leak Gate (Task #193)
//
// Self-policing CI check that fails if any `scripts/test-*.ts` script
// silently accumulates ledger entries on the platform user (the user_id
// resolved via PLATFORM_USER_ID; historically user 11 in dev) — or on any
// deterministic `__`-prefixed test-user fixture — between runs.
//
// Why this exists:
//   Tasks #158 and #187 each fixed a different test script that was
//   leaking platform-side ledger postings between runs. Both fixes were
//   the same pattern: wrap the test body in try/finally and call the
//   per-user cleanup at end-of-script. Today there is no automated check
//   that would catch a NEW (or future) test script regressing back to
//   that same leak; the next one would only be discovered by manually
//   inspecting the platform user's ledger sum after a release.
//
// What this does:
//   For every `scripts/test-*.ts`:
//     1. Snapshot the platform user's per-currency ledger (SUM + COUNT).
//     2. Snapshot every deterministic `__`-prefixed test user's per-
//        currency ledger (SUM + COUNT). Excludes the shared
//        `__prelaunch_platform` user, which IS the platform user and is
//        captured separately above.
//     3. Snapshot the platform user's COUNT(*) of `transactions` and
//        `accounts` (Task #198). The ledger snapshots above only catch
//        leaks that touch `ledger_entries`; a script that creates a
//        `transactions` row or `accounts` row owned by the platform
//        user but writes no ledger entries (or writes balanced entries
//        that net to zero with the same row count) would otherwise slip
//        through. A POSITIVE count delta on either of these tables fails
//        the gate too — naming the offending script AND the table.
//     4. spawn the script via `npx tsx <script>` (inheriting stdio so
//        the operator sees its normal output).
//     5. Snapshot all three again.
//     6. If anything drifted (per-currency net OR row count on either
//        ledger snapshot, OR a positive count delta on the platform
//        user's `transactions` / `accounts`), the script LEAKED — fail
//        with a clear diff naming the script and the offending
//        currency / table.
//     7. If the script's own exit code is non-zero, fail it too (the
//        leak gate is also a hard reminder that the script must pass).
//
// SUM/COUNT shape mirrors the wallet-ledger reconciliation in
// `server/services/ledger.ts` (getUserCurrencyBalance), so a leak that
// trips this gate is the same shape that would trip the operator-alert
// clean-room gate in `scripts/pre-launch-safety.ts`.
//
// Exit code:
//   - 0 only if every script ran (exit 0) AND every snapshot matched.
//   - 1 on any leak, sub-script failure, or unhandled error.
//
// Usage:
//   npx tsx scripts/ci-ledger-leak-gate.ts
//   npx tsx scripts/ci-ledger-leak-gate.ts \
//       --scripts scripts/test-fee-insufficient-funds.ts,scripts/test-transaction-safety.ts
// ---------------------------------------------------------------------------

import "./_bootstrap-test-env";

import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

import { eq, inArray, sql } from "drizzle-orm";
import Decimal from "decimal.js";

import { db } from "../server/db";
import {
  users,
  ledgerEntries,
  transactions,
  accounts,
} from "../shared/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// `__prelaunch_platform` is the deterministic platform user that
// `scripts/pre-launch-safety.ts` mints when PLATFORM_USER_ID isn't already
// set. Reusing the same username here means a developer running the leak
// gate locally and then pre-launch sees the SAME platform user across
// both, so neither script's snapshot picks up rows the other introduced.
const PRELAUNCH_PLATFORM_USERNAME = "__prelaunch_platform";

// Discover scripts/test-*.ts. We exclude this file by virtue of the
// `test-` prefix on the regex (this file is `ci-ledger-leak-gate.ts`).
const SCRIPTS_DIR = path.join(process.cwd(), "scripts");
const TEST_SCRIPT_RE = /^test-.*\.ts$/;

// ---------------------------------------------------------------------------
// Snapshot shape
// ---------------------------------------------------------------------------
type CurrencyStat = {
  // Net = SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END).
  // Stored as a string to preserve the 18,8 decimal precision the
  // ledger uses; comparisons go through decimal.js for correctness.
  net: string;
  // Row count for this (user, currency). A leak that nets to zero per
  // currency but leaves orphan entries (e.g. a debit without its
  // matching credit) still trips the count check.
  count: number;
};
type Snapshot = Map<string, CurrencyStat>;

// Task #198 — orphan-row counts for the platform user. Snapshotted in
// addition to the ledger snapshot above. The ledger snapshot only
// catches leaks that touch `ledger_entries`; a script that creates a
// `transactions` row or `accounts` row owned by the platform user but
// writes no ledger entries (or writes balanced entries that net to
// zero with the same row count) would otherwise slip through. We
// track raw COUNT(*) per table — the platform user is a long-lived
// fixture, not a per-test fixture, so absolute counts here are stable
// across runs and the meaningful signal is the BEFORE/AFTER delta.
type OrphanCounts = {
  transactions: number;
  accounts: number;
};

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]): { scriptFilter: string[] | null } {
  let scriptFilter: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scripts" && i + 1 < argv.length) {
      scriptFilter = argv[i + 1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      i += 1;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: npx tsx scripts/ci-ledger-leak-gate.ts [--scripts a.ts,b.ts]",
      );
      process.exit(0);
    } else {
      console.error(`ci-ledger-leak-gate: unknown arg '${a}'`);
      process.exit(2);
    }
  }
  return { scriptFilter };
}

function discoverTestScripts(filter: string[] | null): string[] {
  if (filter && filter.length > 0) {
    for (const f of filter) {
      if (!fs.existsSync(f)) {
        throw new Error(
          `--scripts referenced '${f}' which does not exist on disk`,
        );
      }
    }
    return filter;
  }
  if (!fs.existsSync(SCRIPTS_DIR)) {
    throw new Error(`scripts dir not found: ${SCRIPTS_DIR}`);
  }
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => TEST_SCRIPT_RE.test(f))
    .sort()
    .map((f) => path.join("scripts", f));
}

// ---------------------------------------------------------------------------
// Platform user resolution
// ---------------------------------------------------------------------------
// If PLATFORM_USER_ID is already pinned by the parent process (e.g.
// pre-launch-safety.ts has set it), we use that. Otherwise we mint /
// reuse the same `__prelaunch_platform` user pre-launch uses, and pin
// it for both this driver AND every subprocess test script we spawn.
// Pinning before the spawn means every sub-test posts platform-side
// suspense / fee legs against the SAME user, which is what makes the
// before/after snapshot meaningful (otherwise each script could mint
// its own platform user, and the leak would never show up here).
async function ensurePlatformUserId(): Promise<number> {
  const env = process.env.PLATFORM_USER_ID;
  if (env) {
    const id = parseInt(env, 10);
    if (Number.isInteger(id) && id > 0) return id;
  }
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.username, PRELAUNCH_PLATFORM_USERNAME));
  let platformId: number;
  if (existing) {
    if (existing.kycStatus !== "verified" || !existing.emailVerified) {
      await db
        .update(users)
        .set({ kycStatus: "verified", emailVerified: true })
        .where(eq(users.id, existing.id));
    }
    platformId = existing.id;
  } else {
    const [row] = await db
      .insert(users)
      .values({
        username: PRELAUNCH_PLATFORM_USERNAME,
        email: "prelaunch-platform@test.invalid",
        password: "not-a-real-password",
        firstName: "PreLaunch",
        lastName: "Platform",
        role: "admin",
        kycStatus: "verified",
        emailVerified: true,
      })
      .returning();
    platformId = row.id;
  }
  process.env.PLATFORM_USER_ID = String(platformId);
  return platformId;
}

// ---------------------------------------------------------------------------
// Snapshot queries
// ---------------------------------------------------------------------------
// Single user — same SUM(CASE WHEN credit/-debit) shape as
// getUserCurrencyBalance() in server/services/ledger.ts so a leak this
// gate detects is the same shape the wallet-ledger reconciliation flags.
async function snapshotForUser(userId: number): Promise<Snapshot> {
  const rows = await db
    .select({
      currency: ledgerEntries.currency,
      net: sql<string>`COALESCE(SUM(CASE WHEN ${ledgerEntries.direction} = 'credit' THEN ${ledgerEntries.amount} ELSE -${ledgerEntries.amount} END), 0)`,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.userId, userId))
    .groupBy(ledgerEntries.currency);
  const out: Snapshot = new Map();
  for (const r of rows) {
    out.set(r.currency, { net: String(r.net), count: Number(r.count) });
  }
  return out;
}

// Task #198 — platform-user orphan-row counts for `transactions` and
// `accounts`. Mirrors snapshotForUser() in shape (BEFORE/AFTER + diff)
// but tracks plain row counts since neither table carries the same
// per-currency signed-sum shape that ledger_entries does. We snapshot
// these for the PLATFORM USER ONLY — the per-test `__`-prefixed
// fixture users can legitimately own transactions / accounts as part
// of their scenario, but the platform user is a long-lived
// suspense / fee bucket that no test script should ever leave new
// rows on once it cleans up.
async function snapshotPlatformOrphanCounts(
  platformUserId: number,
): Promise<OrphanCounts> {
  const [txRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(transactions)
    .where(eq(transactions.userId, platformUserId));
  const [acctRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(accounts)
    .where(eq(accounts.userId, platformUserId));
  return {
    transactions: Number(txRow?.count ?? 0),
    accounts: Number(acctRow?.count ?? 0),
  };
}

// Every `__`-prefixed test user's per-currency ledger.
// This catches leaks against deterministic test fixtures the way it
// would catch leaks against the platform user (e.g. `__feegate_test_*`,
// `__txsafety_*`, `__gateb_test_*`). We deliberately exclude the
// `__prelaunch_platform` user — that's the platform user, captured
// separately by snapshotForUser() above, and we don't want to
// double-report drift on it.
//
// Implementation note: we resolve the user-id list app-side first and
// then narrow the ledger aggregation by `userId IN (...)`. Doing the
// filter via a SQL `LIKE '\_\_%'` would force us to escape Postgres'
// `_` single-char wildcard (and also pick the right ESCAPE clause
// across env modes), and would cost an `INNER JOIN users` against the
// full ledger table. Resolving ids first keeps the heavy aggregation
// keyed off the indexed `userId` column.
async function snapshotByUsernamePrefix(
  prefix: string,
): Promise<Map<string, Snapshot>> {
  const allUsers = await db
    .select({ id: users.id, username: users.username })
    .from(users);
  const matched = allUsers.filter(
    (u) =>
      u.username.startsWith(prefix) &&
      u.username !== PRELAUNCH_PLATFORM_USERNAME,
  );
  if (matched.length === 0) return new Map();
  const ids = matched.map((u) => u.id);
  const rows = await db
    .select({
      userId: ledgerEntries.userId,
      currency: ledgerEntries.currency,
      net: sql<string>`COALESCE(SUM(CASE WHEN ${ledgerEntries.direction} = 'credit' THEN ${ledgerEntries.amount} ELSE -${ledgerEntries.amount} END), 0)`,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(ledgerEntries)
    .where(inArray(ledgerEntries.userId, ids))
    .groupBy(ledgerEntries.userId, ledgerEntries.currency);
  const usernameById = new Map(matched.map((u) => [u.id, u.username]));
  const out = new Map<string, Snapshot>();
  for (const r of rows) {
    const username = usernameById.get(r.userId);
    if (!username) continue;
    let inner = out.get(username);
    if (!inner) {
      inner = new Map();
      out.set(username, inner);
    }
    inner.set(r.currency, { net: String(r.net), count: Number(r.count) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------
// Strict leak definition per task spec: fail on ANY per-currency drift in
// either net OR row count. A clean script that wraps its body in
// try/finally with end-of-script per-user cleanup leaves both unchanged.
//
//   - net delta != 0   => un-balanced posting left on the snapshotted user
//   - count delta != 0 => rows added (positive) or removed (negative)
//                          relative to baseline; either is drift
//
// Note for dev / pre-launch envs with historical leftovers from before
// this gate existed: a script's own start-of-run cleanup may legitimately
// remove those leftovers, producing a NEGATIVE count delta on the first
// run after the gate is introduced. That is reported as a leak under
// strict count-invariance — operators normalize state once (e.g. by
// running each script once with the gate, then re-baselining) and
// subsequent runs are clean. CI starts from a clean DB, so this is a
// one-time dev-env consideration only.
// Task #198 — orphan-count diff. Unlike diffSnapshot() above, this only
// fails on a POSITIVE delta. Rationale per the task spec: the failure
// we care about is rows ADDED to the platform user that the script
// forgot to clean up. A negative delta means a script's start-of-run
// cleanup legitimately reaped leftover rows from a previous (pre-gate)
// run, which is desirable behaviour and would generate noisy false
// failures here on the first run after this gate is introduced. The
// per-table label is included in every drift line so the FAIL message
// satisfies the spec's "naming the script and the table" requirement.
function diffOrphanCounts(
  before: OrphanCounts,
  after: OrphanCounts,
): string[] {
  const drift: string[] = [];
  const dTx = after.transactions - before.transactions;
  if (dTx > 0) {
    drift.push(
      `transactions: ${before.transactions} -> ${after.transactions} ` +
        `(delta +${dTx})`,
    );
  }
  const dAcct = after.accounts - before.accounts;
  if (dAcct > 0) {
    drift.push(
      `accounts: ${before.accounts} -> ${after.accounts} ` +
        `(delta +${dAcct})`,
    );
  }
  return drift;
}

function diffSnapshot(before: Snapshot, after: Snapshot): string[] {
  const drift: string[] = [];
  const currencies = new Set<string>([...before.keys(), ...after.keys()]);
  for (const cur of Array.from(currencies).sort()) {
    const b = before.get(cur) ?? { net: "0", count: 0 };
    const a = after.get(cur) ?? { net: "0", count: 0 };
    const bNet = new Decimal(b.net);
    const aNet = new Decimal(a.net);
    const netEqual = aNet.eq(bNet);
    const dCount = a.count - b.count;
    const countEqual = dCount === 0;
    if (netEqual && countEqual) continue;
    const dNet = aNet.minus(bNet);
    const netSign = dNet.gte(0) ? "+" : "";
    const countSign = dCount >= 0 ? "+" : "";
    drift.push(
      `${cur}: net ${bNet.toString()} -> ${aNet.toString()} ` +
        `(delta ${netSign}${dNet.toString()}), ` +
        `count ${b.count} -> ${a.count} (delta ${countSign}${dCount})`,
    );
  }
  return drift;
}

// ---------------------------------------------------------------------------
// Sub-script driver
// ---------------------------------------------------------------------------
type SpawnResult = {
  code: number;
  signal: NodeJS.Signals | null;
  error: string | null;
};
function runScript(scriptPath: string): SpawnResult {
  const r = spawnSync("npx", ["tsx", scriptPath], {
    stdio: "inherit",
    env: process.env,
    encoding: "utf8",
  });
  if (r.error) return { code: -1, signal: null, error: r.error.message };
  if (r.signal) return { code: -1, signal: r.signal, error: null };
  return { code: r.status ?? -1, signal: null, error: null };
}

// ---------------------------------------------------------------------------
// Per-script result
// ---------------------------------------------------------------------------
type TestUserDrift = { username: string; lines: string[] };
type ScriptResult = {
  script: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  spawnError: string | null;
  platformDrift: string[];
  // Task #198 — orphan transactions/accounts drift on the platform user.
  // Reported alongside platformDrift but kept in its own field so the
  // FAIL message can label the table that leaked, per spec.
  platformOrphanDrift: string[];
  testUserDrift: TestUserDrift[];
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const { scriptFilter } = parseArgs(process.argv.slice(2));

  let platformUserId: number;
  let scripts: string[];
  try {
    platformUserId = await ensurePlatformUserId();
    scripts = discoverTestScripts(scriptFilter);
  } catch (err: any) {
    console.error("ci-ledger-leak-gate setup failed:", err?.message ?? err);
    process.exit(1);
  }
  if (scripts.length === 0) {
    console.error("ci-ledger-leak-gate: no scripts matched.");
    process.exit(1);
  }

  console.log("=== CI Ledger-Leak Gate (Task #193) ===");
  console.log(`Platform user id: ${platformUserId}`);
  console.log(`Scripts to gate (${scripts.length}):`);
  for (const s of scripts) console.log(`  - ${s}`);
  console.log("");

  const results: ScriptResult[] = [];
  for (const script of scripts) {
    console.log(`--- ledger-leak gate: ${script} ---`);
    const platformBefore = await snapshotForUser(platformUserId);
    const testUsersBefore = await snapshotByUsernamePrefix("__");
    const platformOrphansBefore =
      await snapshotPlatformOrphanCounts(platformUserId);

    const r = runScript(script);

    const platformAfter = await snapshotForUser(platformUserId);
    const testUsersAfter = await snapshotByUsernamePrefix("__");
    const platformOrphansAfter =
      await snapshotPlatformOrphanCounts(platformUserId);

    const platformDrift = diffSnapshot(platformBefore, platformAfter);
    const platformOrphanDrift = diffOrphanCounts(
      platformOrphansBefore,
      platformOrphansAfter,
    );
    const testUserDrift: TestUserDrift[] = [];
    const allUsernames = new Set<string>([
      ...testUsersBefore.keys(),
      ...testUsersAfter.keys(),
    ]);
    for (const name of Array.from(allUsernames).sort()) {
      const lines = diffSnapshot(
        testUsersBefore.get(name) ?? new Map(),
        testUsersAfter.get(name) ?? new Map(),
      );
      if (lines.length > 0) testUserDrift.push({ username: name, lines });
    }

    results.push({
      script,
      exitCode: r.code,
      signal: r.signal,
      spawnError: r.error,
      platformDrift,
      platformOrphanDrift,
      testUserDrift,
    });
  }

  console.log("");
  console.log("=== ci-ledger-leak-gate: per-script summary ===");
  let failures = 0;
  for (const r of results) {
    const leaked = r.platformDrift.length > 0 || r.testUserDrift.length > 0;
    const orphaned = r.platformOrphanDrift.length > 0;
    const subFailed = r.exitCode !== 0;
    if (subFailed) {
      failures += 1;
      const tail = r.spawnError
        ? ` spawn-error=${r.spawnError}`
        : r.signal
          ? ` signal=${r.signal}`
          : ` exit=${r.exitCode}`;
      console.error(`FAIL ${r.script} — sub-script did not exit 0;${tail}`);
    }
    if (leaked) {
      failures += 1;
      console.error(`FAIL ${r.script} — leaked ledger entries:`);
      if (r.platformDrift.length > 0) {
        console.error(`  platform user (id=${platformUserId}):`);
        for (const line of r.platformDrift) console.error(`    ${line}`);
      }
      for (const u of r.testUserDrift) {
        console.error(`  test user '${u.username}':`);
        for (const line of u.lines) console.error(`    ${line}`);
      }
      console.error(
        `  HINT: wrap the test body in try/finally and call the per-user ` +
          `cleanup at end-of-script (see scripts/test-fee-insufficient-funds.ts ` +
          `for the Task #187 reference fix, and scripts/test-transaction-safety.ts ` +
          `for the Task #158 reference fix).`,
      );
    }
    // Task #198 — orphan transactions/accounts on the platform user.
    // Reported as its own FAIL line so the message names the script
    // AND the offending table(s), per spec.
    if (orphaned) {
      failures += 1;
      console.error(
        `FAIL ${r.script} — leaked orphan rows on platform user ` +
          `(id=${platformUserId}):`,
      );
      for (const line of r.platformOrphanDrift) {
        console.error(`    ${line}`);
      }
      console.error(
        `  HINT: the script created a transaction or account row owned by ` +
          `the platform user and did not clean it up. Wrap the test body in ` +
          `try/finally and DELETE the offending rows by primary key at ` +
          `end-of-script (do NOT delete by user_id alone — that risks ` +
          `wiping platform rows owned by other test scripts).`,
      );
    }
    if (!subFailed && !leaked && !orphaned) {
      console.log(`PASS ${r.script}`);
    }
  }

  console.log("");
  if (failures > 0) {
    console.error(
      `CI LEDGER-LEAK GATE: FAIL — ${failures} issue(s) across ${results.length} script(s). ` +
        `Do not merge / deploy.`,
    );
    process.exit(1);
  }
  console.log(
    `CI LEDGER-LEAK GATE: ALL ${results.length} SCRIPTS PASSED \u2705`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("ci-ledger-leak-gate crashed:", err);
  process.exit(1);
});
