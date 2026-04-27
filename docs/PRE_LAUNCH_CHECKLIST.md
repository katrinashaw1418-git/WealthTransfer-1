# Pre-launch safety checklist

A single command — `npx tsx scripts/pre-launch-safety.ts` — runs every
mandatory go/no-go gate this codebase ships. The script exits non-zero
on any failure; a red light here MUST block deploy.

## What this script proves

### Existing safety scripts (re-run end-to-end)
| Gate | What it proves |
| --- | --- |
| `scripts/test-transaction-safety.ts` | Idempotency on money-moving routes; pending transactions never touch the ledger; `postLedgerEntries()` survives the concurrent double-post race; the `ledger_postings` receipt PK enforces one-receipt-per-transaction. |
| `scripts/test-fee-deduction-gate-b.ts` | Adviser fee deductions can only be approved by an admin; settled deductions post exactly one balanced ledger pair; reversal posts the inverse pair under a deterministic idempotency key; consent gates (missing / expired / withdrawn) block accrual; full reconciliation pass leaves both sides clean. |
| `scripts/test-wealth-planner-compliance.ts` | Wealth-planner notes are append-only (no PATCH/DELETE handlers registered); disclaimer-acknowledgement capture is non-erasable; advice-record snapshots are immutable on transition; client/adviser money isolation holds across the full handler surface. |
| `scripts/test-task-35-suppression.ts` | Wallet/ledger drift acknowledgements suppress duplicate operator pages until the underlying drift moves by more than `MATCH_EPSILON`; sign-flips and re-acks reset the suppression window. |

### New end-to-end lifecycle scenarios
| Scenario | What it proves |
| --- | --- |
| **Happy-path lifecycle** | Signup → KYC verified → AUD deposit (real `/api/deposit` handler) → simulated buy crypto → simulated sell crypto → AUD withdrawal (real `/api/withdraw` handler) → wallet cache equals `SUM(ledger_entries)` per currency, to the cent, including the AUD wire-fee leg. |
| **Idempotency under concurrency** | Two parallel `POST /api/deposit` calls with the same `Idempotency-Key` produce exactly one `transactions` row, one balanced ledger pair (two entries), one `ledger_postings` receipt, and one `idempotency_keys` row. |
| **Reversal symmetry** | Posting a forward transaction and then a reversal (opposite direction, equal magnitude) leaves `wallets.balance` and `SUM(ledger_entries)` at exactly the pre-state, while both audit rows remain visible in the `transactions` table. |

### Operator-alert clean room
The script snapshots `MAX(operator_alerts.id)` before and runs the three
reconciliation services in-process:

1. `runWalletLedgerReconciliation()` — wallets table vs ledger sum, per (user, currency).
2. `runLedgerReconciliation()` — ledger sum vs custodian balance (currently a
   deterministic stub; see "What this does NOT prove" below).
3. `runPostingReceiptInvariantCheck()` — every transaction with ledger
   entries also has its `ledger_postings` receipt row.

Then it asserts **zero new rows of severity `critical` or `alert`** were
emitted over the snapshot baseline. Pre-existing operator pages are not
counted (they are someone else's open ticket); only fresh pages caused
by this run fail the gate.

## What this script does NOT prove

The following are deliberately out of scope for this rollup and need
their own validation track before go-live:

- **Real custodian / bank SDK integration.** The ledger-vs-custodian
  reconciliation currently runs against a deterministic stub.
  Wiring real correspondent banking + crypto custodian APIs is its
  own task and lands separately.
- **Real-payment-rail load tests.** This script asserts correctness
  under low concurrency (one or two parallel callers per scenario). It
  does NOT exercise the `ledger_postings` PK lock or the wallet
  `FOR UPDATE` row lock under sustained burst load. That requires a
  dedicated load-test rig (k6 / artillery) and should run in the
  staging environment with realistic connection-pool sizing.
- **External dead-man's-switch on the Node process.** Whether the
  application is alive at all is an operational concern (Pingdom /
  better-uptime / a load balancer health check). This script only
  validates internal invariants when the process IS running.
- **JWT secret / API key rotation.** Out of scope; tracked as a
  separate operational task.
- **Frontend / UX.** This script makes no claims about the React
  client, browser flows, or end-user experience. It only validates the
  server's money-handling primitives.

## Operating procedure

```sh
# From project root, with DATABASE_URL pointed at the env you want to validate.
npx tsx scripts/pre-launch-safety.ts
echo "exit code: $?"
```

A green run prints `PRE-LAUNCH SAFETY: ALL GATES PASSED ✅` and exits 0.
Any failure prints `PRE-LAUNCH SAFETY: FAIL — one or more gates failed. Do not deploy.` and exits 1.

The script is idempotent across re-runs: every fixture row is
prefixed `__prelaunch_` and the cleanup phase deletes only rows whose
primary keys were captured during this run.

## Post-merge rechecks

Each line below records one auto-run of `scripts/post-merge-safety-recheck.ts`
after a merge that was gated on `scripts/pre-launch-safety.ts --strict` (the
go-live rollup). The runner appends a new line per invocation; nothing is
overwritten so prior verdicts stay visible in version control.
- 2026-04-27T02:35:02.380Z — 🔴 RED (9 passed, 1 failed, 0 skipped, exit=1) — commit `07f3d14f86fe` — [`post-merge-safety-recheck-2026-04-27T02-35-02-380Z.md`](./golive/post-merge-safety-recheck-2026-04-27T02-35-02-380Z.md)
