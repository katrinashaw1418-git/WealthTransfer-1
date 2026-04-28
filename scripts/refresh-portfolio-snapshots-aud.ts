// =============================================================================
// Task #351 — One-shot: re-anchor historical portfolio snapshots after the
// Task #336 FX-routing fix (crypto + stablecoin balances are now valued in
// true AUD instead of USD-labelled-as-AUD).
// -----------------------------------------------------------------------------
// Why this exists:
//   `portfolio_snapshots` rows written *before* the FX fix landed still hold
//   the old (under-valued) AUD totals. The dashboard's "monthly P&L" card
//   and the Performance by Period chart compare today's true-AUD figure
//   against those stale rows, which produces a sharp artificial spike for
//   ~30 days until the bad rows roll off the comparison window. Recomputing
//   the affected snapshots from the live wallet/transaction history (using
//   the new `convertToAud` chain inside `calculatePortfolioTotalsAtDate`)
//   restores a coherent series.
//
// Strategy:
//   1. For each user (or just the one passed via --user-id):
//      a. Delete every snapshot row whose date falls in the affected
//         window [today - N, today]. N defaults to 30; bump with --days.
//      b. Recompute one snapshot per day in that window using the same
//         `calculatePortfolioTotalsAtDate` helper that powers the live API
//         and the daily snapshot writer, so the rebuilt history is exactly
//         what a fresh user would see today.
//      c. Mark each rebuilt row as `historical_estimate` except for the
//         row whose date == today, which is marked `actual` (matches the
//         convention used by `backfillPortfolioHistory` in routes.ts).
//   2. Print a per-user before/after total so the operator can sanity-check
//      that the deltas look reasonable (typically a small uplift for users
//      who hold BTC/ETH/USDT/USDC).
//
// Idempotency:
//   The script always deletes-then-rewrites in the window, so re-running
//   produces the same result. It is safe (and expected) to dry-run first.
//
// Safety:
//   * No money moves. Only the read-only `portfolio_snapshots` cache is
//     touched — wallet balances, ledger postings, transactions, and
//     investments are untouched.
//   * Default mode is dry-run. Pass `--apply` to commit the rewrites.
//
// Usage:
//   tsx scripts/refresh-portfolio-snapshots-aud.ts                 # dry-run, all users, 30-day window
//   tsx scripts/refresh-portfolio-snapshots-aud.ts --apply         # commit
//   tsx scripts/refresh-portfolio-snapshots-aud.ts --days 60       # widen the window
//   tsx scripts/refresh-portfolio-snapshots-aud.ts --user-id 42    # target one user
// =============================================================================

import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { portfolioSnapshots, users } from "../shared/schema";
import { storage } from "../server/storage";
import { calculatePortfolioTotalsAtDate } from "../server/services/portfolio-valuation";

function parseFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

const APPLY = process.argv.includes("--apply");
const DAYS = Number(parseFlag("--days") ?? "30");
const ONLY_USER = parseFlag("--user-id");

if (!Number.isFinite(DAYS) || DAYS <= 0 || DAYS > 365) {
  console.error(`[refresh-portfolio-snapshots-aud] --days must be 1..365 (got ${DAYS})`);
  process.exit(2);
}

interface UserResult {
  userId: number;
  daysRebuilt: number;
  oldTodayTotal: number | null;
  newTodayTotal: number;
}

async function listTargetUsers(): Promise<{ id: number }[]> {
  if (ONLY_USER) {
    const id = Number(ONLY_USER);
    if (!Number.isFinite(id)) {
      throw new Error(`--user-id must be numeric (got '${ONLY_USER}')`);
    }
    return [{ id }];
  }
  return await db.select({ id: users.id }).from(users);
}

export async function rebuildForUser(
  userId: number,
  start: Date,
  end: Date,
  apply: boolean = APPLY,
): Promise<UserResult> {
  // Read the pre-rebuild "today" total so the operator can see the delta.
  const todayKey = end.toISOString().split("T")[0];
  const existingTodayRows = await storage.getPortfolioSnapshots(
    userId,
    new Date(`${todayKey}T00:00:00.000Z`),
    new Date(`${todayKey}T23:59:59.999Z`),
  );
  const oldTodayTotal = existingTodayRows.length
    ? parseFloat(existingTodayRows[existingTodayRows.length - 1].totalValue)
    : null;

  // Phase 1 — precompute every day's totals using the new AUD logic.
  // Doing all reads up-front means the per-user transaction in phase 2
  // only does fast, atomic writes; if phase 1 throws midway through, no
  // partial rewrites have hit the DB yet.
  interface PendingDay {
    dayKey: string;
    snapshotDate: Date;
    totalValue: number;
    fiatValue: number;
    cryptoValue: number;
    stablecoinValue: number;
    investmentValue: number;
  }
  const pending: PendingDay[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const dayKey = cursor.toISOString().split("T")[0];
    const snapshotDate = new Date(`${dayKey}T00:00:00.000Z`);
    const totals = await calculatePortfolioTotalsAtDate(userId, snapshotDate);
    pending.push({
      dayKey,
      snapshotDate,
      totalValue: totals.totalValue,
      fiatValue: totals.fiatValue,
      cryptoValue: totals.cryptoValue,
      stablecoinValue: totals.stablecoinValue,
      investmentValue: totals.investmentValue,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // Phase 2 — atomically delete-and-rewrite this user's window in one
  // DB transaction, so a mid-loop failure can never leave the user with
  // a half-rebuilt history that mixes old and new AUD figures.
  if (apply) {
    await db.transaction(async (tx) => {
      for (const day of pending) {
        await tx.execute(sql`
          DELETE FROM ${portfolioSnapshots}
          WHERE ${portfolioSnapshots.userId} = ${userId}
            AND DATE(${portfolioSnapshots.snapshotDate}) = ${day.dayKey}::date
        `);
        await tx.insert(portfolioSnapshots).values({
          userId,
          snapshotDate: day.snapshotDate,
          totalValue: day.totalValue.toFixed(2),
          fiatValue: day.fiatValue.toFixed(2),
          cryptoValue: day.cryptoValue.toFixed(2),
          stablecoinValue: day.stablecoinValue.toFixed(2),
          investmentValue: day.investmentValue.toFixed(2),
          source: day.dayKey === todayKey ? "actual" : "historical_estimate",
        });
      }
    });
  }

  const todayPending = pending.find((d) => d.dayKey === todayKey);
  return {
    userId,
    daysRebuilt: pending.length,
    oldTodayTotal,
    newTodayTotal: todayPending?.totalValue ?? 0,
  };
}

async function main() {
  console.log(
    `[refresh-portfolio-snapshots-aud] mode=${APPLY ? "APPLY" : "DRY-RUN"} ` +
      `window=${DAYS} day(s)` +
      (ONLY_USER ? ` user=${ONLY_USER}` : ""),
  );

  // Window spans exactly DAYS calendar days, inclusive of today. So
  // `--days 30` rebuilds today + the 29 days before it (30 rows per
  // user) — matching the dashboard's 30-day comparison window.
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (DAYS - 1));

  const targets = await listTargetUsers();
  console.log(`Targeting ${targets.length} user(s).`);

  const results: UserResult[] = [];
  for (const u of targets) {
    try {
      const r = await rebuildForUser(u.id, start, end);
      results.push(r);
      const oldStr = r.oldTodayTotal === null ? "(none)" : `$${r.oldTodayTotal.toFixed(2)}`;
      const newStr = `$${r.newTodayTotal.toFixed(2)}`;
      const delta =
        r.oldTodayTotal === null ? "n/a" : `Δ $${(r.newTodayTotal - r.oldTodayTotal).toFixed(2)}`;
      console.log(
        `  user=${r.userId}  days=${r.daysRebuilt}  today: ${oldStr} -> ${newStr}  ${delta}`,
      );
    } catch (err: any) {
      console.error(`  user=${u.id}  FAILED:`, err?.message ?? err);
    }
  }

  if (!APPLY) {
    console.log(
      `\nDRY-RUN — would rewrite ${results.reduce((n, r) => n + r.daysRebuilt, 0)} ` +
        `snapshot row(s) across ${results.length} user(s). Re-run with --apply to commit.`,
    );
    return;
  }
  console.log(
    `\nApplied — rewrote ${results.reduce((n, r) => n + r.daysRebuilt, 0)} ` +
      `snapshot row(s) across ${results.length} user(s).`,
  );
}

// Only run main() when this file is invoked directly (e.g. via tsx). Importing
// the module from a test must not kick off a real DB rebuild.
const isEntry = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isEntry) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error("[refresh-portfolio-snapshots-aud] FAILED:", err);
      process.exit(1);
    },
  );
}
