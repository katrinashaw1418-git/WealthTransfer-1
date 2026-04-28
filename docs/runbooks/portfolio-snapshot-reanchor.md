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
