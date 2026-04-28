# Portfolio Snapshot Re-Anchor Runbook

> **Audience:** the on-call platform engineer.
> **Time budget:** ~5 minutes.
> **What it does:** Recomputes recent rows in `portfolio_snapshots` from
> the live wallet/transaction history so the dashboard's "monthly P&L"
> card and Performance by Period chart compare apples to apples after a
> valuation rule change.

---

## 1. When to run

Run this **once** after any change that alters how live portfolio totals
are computed. Concretely:

* FX-routing changes (e.g. Task #336, which switched crypto and
  stablecoin valuation from "USD labelled as AUD" to true AUD via a
  `currency → USD → AUD` chain).
* Adding or removing an asset class from the bucket totals
  (`fiatValue`, `cryptoValue`, `stablecoinValue`, `investmentValue`).
* Repricing logic changes inside `convertToAud` /
  `calculatePortfolioTotalsAtDate`.

Symptoms that confirm the re-anchor is needed:

* Dashboard "monthly P&L" card shows an artificial spike or dip on the
  day the change shipped, then drifts back toward normal over ~30 days.
* Performance by Period chart has a visible step-change at the deploy
  timestamp.

You do **not** need to run this for ordinary FX rate movements — those
are real performance, not a measurement artefact.

---

## 2. How to run

> **Heads-up — usually you don't need to.** Since Task #356, the
> post-merge step (`scripts/post-merge.sh`) hashes
> `server/services/portfolio-valuation.ts` together with the inline
> `const missingRates = [...]` FX seed in `server/routes.ts` and
> auto-runs `scripts/refresh-portfolio-snapshots-aud.ts --apply` whenever
> that fingerprint changes between deploys. The fingerprint is recorded
> in the `_post_merge_state` table so the same content is never
> re-anchored twice. Look for a line in the deploy log like:
>
> ```
> [post-merge:snapshot-reanchor] DONE — rewrote 1234 snapshot row(s) across 56 user(s); fingerprint <hex> recorded
> ```
>
> See section 5 below for when you'd still want to invoke it manually.

The script lives at `scripts/refresh-portfolio-snapshots-aud.ts` and
defaults to dry-run.

```bash
# 1. Dry-run first — prints per-user before/after totals, no DB writes.
npx tsx scripts/refresh-portfolio-snapshots-aud.ts

# 2. Sanity-check the output. A small uplift on users who hold BTC/ETH/
#    USDT/USDC is expected after Task #336. Large unexpected deltas
#    mean something else has changed and you should investigate before
#    committing.

# 3. Commit the rewrite.
npx tsx scripts/refresh-portfolio-snapshots-aud.ts --apply
```

### Useful flags

| Flag                | Default | Purpose                                                                |
| ------------------- | ------- | ---------------------------------------------------------------------- |
| `--apply`           | off     | Commit the rewrite. Without this, nothing is written.                  |
| `--days N`          | `30`    | Width of the rebuild window in calendar days, **inclusive of today** (so `--days 30` rewrites today + the 29 days before it). Bump if the affected period is longer than the dashboard's 30-day comparison. |
| `--user-id N`       | all     | Target a single user — useful for spot-checking before a global apply. |

---

## 3. What it touches

* **Reads:** `wallets`, `transactions`, `user_investments`,
  `investment_products`, `fx_rates` — same inputs as the live
  `/api/portfolio` endpoint.
* **Writes:** `portfolio_snapshots` only. One row per day per user in
  the window. The day matching today is written with `source='actual'`;
  every other day is `source='historical_estimate'` (matches the
  convention of `backfillPortfolioHistory` in `server/routes.ts`).
* **Does not touch:** wallet balances, ledger postings, transactions,
  investments, fee consents. No money moves.

The script is idempotent — running it twice in a row produces the same
result.

---

## 4. After running

1. Reload the client dashboard for an affected user. The "monthly P&L"
   card should now show a smooth value with no artificial spike, and
   the Performance by Period chart's step-change at the deploy time
   should be gone.
2. If a user's "today" total reads `(none)` in the dry-run output, that
   user had no `portfolio_snapshots` row for today *before* the run.
   Under `--apply` the script writes a fresh row for them anyway, so
   no further action is required either way.
3. Note the run in the deploy ticket alongside the change that
   triggered it (e.g. "Task #336 shipped + ran
   `refresh-portfolio-snapshots-aud --apply` to re-anchor 30 days").
   When the post-merge runner did the work for you (Task #356), the
   deploy log line is the audit trail — you don't need to add a manual
   note as well.

---

## 5. When the auto-trigger isn't enough

`scripts/post-merge-portfolio-snapshot-reanchor.ts` only fingerprints
the two inputs that the dashboard's monthly comparison can be
artificially perturbed by:

1. `server/services/portfolio-valuation.ts` (the `convertToAud` and
   `calculatePortfolioTotalsAtDate` helpers).
2. The inline `const missingRates = [...]` FX seed in
   `server/routes.ts`.

Run the script manually (per section 2) when:

* You changed a valuation input that lives **outside** those two
  files — for example a new currency added to
  `shared/schema.ts`'s currency union, a price-feed cutover that
  changes which `fx_rates` row is selected, or a backfill helper that
  rewrites historical wallet balances.
* You need a **wider window** than the default 30 days. The
  auto-trigger always uses the script's defaults; pass `--days N`
  yourself if the affected period is longer.
* You need to **target a single user** for spot-checking. The
  auto-trigger runs across every user; use `--user-id N` to scope.
* You suspect the auto-trigger was **suppressed in error** — e.g. the
  `_post_merge_state` row already records the current fingerprint but
  you have evidence the snapshot cache is wrong. In that case, delete
  the offending row (`DELETE FROM _post_merge_state WHERE key LIKE
  'task_356_snapshot_reanchor:%'`) before the next deploy, or just run
  the script manually and let the next post-merge pass record the
  fingerprint.
