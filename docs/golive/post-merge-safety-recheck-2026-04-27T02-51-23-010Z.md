# Post-merge pre-launch strict safety recheck

**Verdict:** 🟢 GREEN

* Started: 2026-04-27T02:51:23.010Z
* Finished: 2026-04-27T02:51:45.232Z
* Wall-clock duration: 22179ms (22.2s)
* Command: `npx tsx scripts/pre-launch-safety.ts --strict`
* Exit code: `0`
* Git commit SHA: `52cb3172f230223348cc5e60571fb020c573ff04`
* Gating tasks (now merged into main):
  - #168 (kill-switch end-to-end automated test coverage)
  - #150 (final go/no-go pre-launch verification)
* Complements latest go/no-go report: _none found in `docs/golive/`. The `go-no-go-*.md` files are gitignored — re-run `npx tsx scripts/go-no-go.ts` if you want a fresh evidence pair alongside this recheck._

## Summary

```
Summary: 14 passed, 0 failed, 0 skipped (--strict mode: SKIP fails)
PRE-LAUNCH SAFETY: ALL GATES PASSED ✅
```

## Per-gate results

| Gate | Result | Details |
| --- | --- | --- |
| existing: test-transaction-safety | PASS | exit=0 |
| existing: test-fee-deduction-gate-b | PASS | exit=0 |
| existing: test-wealth-planner-compliance | PASS | exit=0 |
| existing: test-task-35-suppression | PASS | exit=0 |
| lifecycle: happy-path wallet matches ledger | PASS | AUD wallet=765.00000000, ledger=765.00000000, expected=765.00; BTC wallet=0.00000000, ledger=0.00000000, expected=0 |
| lifecycle: idempotency under concurrency | PASS | parallel deposits: tx=1, entries=2, receipts=1, idem rows=1, http=[200,200] |
| lifecycle: idempotency under concurrency (withdraw) | PASS | parallel withdrawals: new tx=1, entries=2, receipts=1, idem rows=1, http=[200,200] |
| lifecycle: idempotency under concurrency (fx-exchange) | PASS | parallel fx-exchange: new tx=1, idem rows=1, http=[200,200] |
| lifecycle: idempotency under concurrency (wallets/transfer) | PASS | parallel wallets/transfer: new tx=1, idem rows=1, http=[200,200] |
| lifecycle: idempotency under concurrency (investments) | PASS | parallel investments: new tx=1, user_investments=1, idem rows=1, http=[200,200] |
| lifecycle: reversal symmetry | PASS | pre wallet=0.00000000 ledger=0; mid wallet=250.00000000 ledger=250.00000000; post wallet=0.00000000 ledger=0.00000000; audit rows visible=2/2 (forward=1518, reversal=1519) |
| reconciliation: wallet-ledger clean-room | PASS | pairs=17, baseline max_id=2602, 0 new critical/alert rows |
| reconciliation: ledger-vs-custodian clean-room | PASS | pairs=13, externalUnavailable=13, baseline max_id=2602, 0 new critical/alert rows |
| reconciliation: posting-receipt invariant clean-room | PASS | txWithEntries=16, receipts=16, baseline max_id=2602, 0 new critical/alert rows |

## Raw script output

<details><summary>stdout (11323 bytes)</summary>

```

--- pre-launch: running scripts/test-transaction-safety.ts ---
=== Transaction Safety Test ===

[operator-alerts] suppressed duplicate for source=wallet-ledger-reconciliation (alertId=2598, occurrences=4)
[operator-alerts] suppressed duplicate for source=wallet-ledger-reconciliation (alertId=2597, occurrences=4)

PASS deposit idempotency — 3 attempts, 1 transaction (id=1481)
PASS deposit idempotency payload-hash guard — different payload with reused key would be rejected
PASS pending no ledger impact — tx#1482 has 0 ledger entries
PASS settlement single ledger entry — 2 entries on tx#1483; second post threw LedgerDoublePostError
PASS failure no ledger impact — tx#1484 has 0 ledger entries
PASS reversal offset — ledger sum 100.00 → 300.00 → 100.00
PASS reconciliation mismatch detection — status=mismatch, drift=50.00000000
PASS concurrent post race — tx#1487: 1 fulfilled, 1 LedgerDoublePostError, 2 entries
PASS reverseSettledDeduction unwinds ledger (status flip) — deduction#328 → reversed (reversalTx#1490)
PASS reverseSettledDeduction unwinds ledger (reversal tx row) — tx#1490 type=adviser_fee_deduction_reversal key=fee_deduction_328_reversal
PASS reverseSettledDeduction unwinds ledger (mirror entries) — 3 reversal legs exactly mirror 3 settle legs
PASS reverseSettledDeduction unwinds ledger (ledger sums restored) — all five sums back to pre-settle baseline
PASS reverseSettledDeduction unwinds ledger (wallet cache matches) — client 900.00000000 == 900, adviser 0.00000000 == 0
PASS reverseSettledDeduction is idempotent — 2nd call returned same row, +0 transactions, +0 ledger entries; exactly 1 row with idempotency_key 'fee_deduction_328_reversal'
PASS reverseSettledDeduction rejects non-settled (409) — threw status=409: Only settled deductions can be reversed (current status: 'pending_approval')

ALL TRANSACTION SAFETY TESTS PASSED ✅

--- pre-launch: running scripts/test-fee-deduction-gate-b.ts ---
PASS non-admin cannot deduct
PASS approved deduction posts once
PASS duplicate deduction blocked
PASS expired consent blocked
PASS withdrawn consent blocked
PASS insufficient ledger balance blocked
PASS ledger debit created
PASS reversal ledger credit created
PASS wallet balance not directly mutated
PASS reconciliation clean after post/reversal

ALL GATE B FEE DEDUCTION TESTS PASSED ✅

--- pre-launch: running scripts/test-wealth-planner-compliance.ts ---
=== Wealth Planner Compliance verification roll-up (Task #94) ===


PASS 1. retention defaults wired — 4/4 tables: deletionLocked=true and retentionUntil set on insert
PASS 2. adviceType default stays 'personal' — inserted advice record with no adviceType; column defaulted to 'personal' on insert and on re-read
PASS 3. cross-adviser link rejected (assertAdviserClientLink) — route returned 403 (assertAdviserClientLink); no leakage
PASS 4. cross-client read prevented (client A cannot read client B's advice) — client B got 403 reason='wrong_client' on client A's advice; no advice payload leaked
PASS 5. adviser CRUD writes both create AND read audit rows — audit rows present: client_document.create, client_document.read, client_objective.create, client_objective.read
PASS 6. append-only notes preserved AND no PATCH/DELETE route exists — v1 unchanged after v2 post; v2.previousNoteId=337 -> v1.id=337; scanned 45 routes, 0 PATCH/DELETE touch notes
PASS 7. viewing-ack gate blocks GET and returns adviceAcknowledgements shape — 403 reason='acknowledgement_missing'; payload absent; adviceAcknowledgements shape lists all 11 confirm_* fields + signatureName
PASS 8. ack row captures the full eleven-confirm disclaimer — ack row id=170 has 11/11 confirm flags=true and signatureName='WPC Test Client'; viewer gate returned 200
PASS 9. non-adviser (admin/client) rejected on adviser CRUD AND admin retains audit-log read access — admin observed 28 adviser audit rows (read OK); admin→objective:403, admin→note:403, client→note:403; 0 leakage
PASS 10. risk-profile and adviceType immutable via transition; snapshots written; no ledger drift — transition wrote v1='issued', v2='superseded'; status flipped; adviceType stayed 'personal'; riskProfileId stayed null; ledger Δ=0/0/0
PASS 11. review_pending blocks objective/document/transition writes; notes still allowed — objectives=423, documents=423, transition=423 (reason='record_locked_under_review'); note=200 (id=339); leakage Δ=0/0/0 (obj/doc/ver)
PASS 12. client-document upload+download round-trip via real object storage with cross-client gate — routes registered; bytes round-tripped (44B); storageKey='client-documents/37/3280bcd7a8c861bc16b25aed676a0ef9.bin' computed by system; download route 200+exact bytes; cross-client probe 404 at both service and route layers
PASS 13. blocked-write audit row recorded by the gate for every gated child write — 5/5 probes (2 route + 3 service) threw 423 with reason='record_locked_under_review'; 5 audit rows written with action='advice_record.write_blocked', entityId='396', userId=39, before/after=null, adviceRecordStatus='review_pending'; per-action counts = {client_objective.create:2, client_document.create:2, client_document.upload:1}

ALL WEALTH PLANNER COMPLIANCE TESTS PASSED ✅

--- pre-launch: running scripts/test-task-35-suppression.ts ---
MATCH_EPSILON = 0.01
Test user id: 45
[operator-alerts] suppressed duplicate for source=wallet-ledger-reconciliation (alertId=2594, occurrences=6)
[operator-alerts] suppressed duplicate for source=wallet-ledger-reconciliation (alertId=2600, occurrences=23)
[run1 summary] {
  pairsChecked: 6,
  matches: 4,
  mismatches: 2,
  alerts: 1,
  criticals: 0,
  operatorNotifications: 2,
  operatorNotificationsSuppressed: 0
}
✓ run1 dispatched at least one operator notification
✓ run1 suppressed zero notifications
✓ run1 wrote exactly one reconciliation row for the test pair
✓ acknowledge inserted a row
✓ ack snapshot drift ≈ 50 (got 50.00000000)
[wallet-ledger-reconciliation] operator alert suppressed (acknowledged) {
  userId: 45,
  currency: 'AUD',
  acknowledgementId: 118,
  acknowledgedAt: 2026-04-27T02:51:41.266Z,
  acknowledgedDriftAmount: '50.00000000',
  currentDriftAmount: '50.00000000'
}
[operator-alerts] suppressed duplicate for source=wallet-ledger-reconciliation (alertId=2600, occurrences=24)
[run2 summary] {
  pairsChecked: 6,
  matches: 4,
  mismatches: 2,
  alerts: 1,
  criticals: 0,
  operatorNotifications: 1,
  operatorNotificationsSuppressed: 1
}
✓ run2 suppressed at least one notification (acknowledged)
✓ run2 wrote a second reconciliation row (audit trail intact)
✓ latest recon row notes mention suppression (got: Wallet cache disagrees with ledger by 50.00000000 AUD. Operator alert suppressed: drift acknowledged on 2026-04-27 (snapshot 50.00000000 AUD, current 50.00000000 AUD).)
[operator-alerts] suppressed duplicate for source=wallet-ledger-reconciliation (alertId=2595, occurrences=6)
[operator-alerts] suppressed duplicate for source=wallet-ledger-reconciliation (alertId=2600, occurrences=25)
[run3 summary] {
  pairsChecked: 6,
  matches: 4,
  mismatches: 2,
  alerts: 2,
  criticals: 0,
  operatorNotifications: 2,
  operatorNotificationsSuppressed: 0
}
✓ run3 re-paged because drift moved beyond MATCH_EPSILON
✓ latest recon row notes mention re-paging (got: Wallet cache disagrees with ledger by 100.50000000 AUD. Drift moved beyond MATCH_EPSILON since acknowledgement on 2026-04-27 — re-paging.)
[wallet-ledger-reconciliation] operator alert suppressed (acknowledged) {
  userId: 45,
  currency: 'AUD',
  acknowledgementId: 119,
  acknowledgedAt: 2026-04-27T02:51:41.528Z,
  acknowledgedDriftAmount: '50.00000000',
  currentDriftAmount: '50.00500000'
}
[operator-alerts] suppressed duplicate for source=wallet-ledger-reconciliation (alertId=2600, occurrences=26)
[run4 summary] {
  pairsChecked: 6,
  matches: 4,
  mismatches: 2,
  alerts: 1,
  criticals: 0,
  operatorNotifications: 1,
  operatorNotificationsSuppressed: 1
}
✓ run4 suppressed (drift moved by < MATCH_EPSILON)
[operator-alerts] suppressed duplicate for source=wallet-ledger-reconciliation (alertId=2596, occurrences=6)
[operator-alerts] suppressed duplicate for source=wallet-ledger-reconciliation (alertId=2600, occurrences=27)
[run5 summary] {
  pairsChecked: 6,
  matches: 4,
  mismatches: 2,
  alerts: 1,
  criticals: 0,
  operatorNotifications: 2,
  operatorNotificationsSuppressed: 0
}
✓ run5 re-paged after acknowledgement was cleared
✓ acknowledge with no drift threw DriftAckNoMismatchError
✓ second active ack rejected with DriftAckConflictError

✓✓✓ ALL TASK #35 ASSERTIONS PASSED

--- pre-launch: capturing money routes ---

--- pre-launch: lifecycle 1 (happy path) ---

--- pre-launch: lifecycle 2 (idempotency under concurrency) ---

--- pre-launch: lifecycle 2b (idempotency: withdraw) ---

--- pre-launch: lifecycle 2c (idempotency: fx-exchange) ---
[fx-refresh] rates updated at 2026-04-27T02:51:44.285Z

--- pre-launch: lifecycle 2d (idempotency: wallets/transfer) ---

--- pre-launch: lifecycle 2e (idempotency: investments) ---

--- pre-launch: lifecycle 3 (reversal symmetry) ---

--- pre-launch: reconciliation: wallet-ledger clean room ---
[operator-alerts] suppressed duplicate for source=wallet-ledger-reconciliation (alertId=2601, occurrences=4)
[operator-alerts] suppressed duplicate for source=wallet-ledger-reconciliation (alertId=2602, occurrences=4)
[operator-alerts] suppressed duplicate for source=wallet-ledger-reconciliation (alertId=2600, occurrences=28)

--- pre-launch: reconciliation: ledger-vs-custodian clean room ---

--- pre-launch: reconciliation: posting-receipt invariant clean room ---

PASS existing: test-transaction-safety — exit=0
PASS existing: test-fee-deduction-gate-b — exit=0
PASS existing: test-wealth-planner-compliance — exit=0
PASS existing: test-task-35-suppression — exit=0
PASS lifecycle: happy-path wallet matches ledger — AUD wallet=765.00000000, ledger=765.00000000, expected=765.00; BTC wallet=0.00000000, ledger=0.00000000, expected=0
PASS lifecycle: idempotency under concurrency — parallel deposits: tx=1, entries=2, receipts=1, idem rows=1, http=[200,200]
PASS lifecycle: idempotency under concurrency (withdraw) — parallel withdrawals: new tx=1, entries=2, receipts=1, idem rows=1, http=[200,200]
PASS lifecycle: idempotency under concurrency (fx-exchange) — parallel fx-exchange: new tx=1, idem rows=1, http=[200,200]
PASS lifecycle: idempotency under concurrency (wallets/transfer) — parallel wallets/transfer: new tx=1, idem rows=1, http=[200,200]
PASS lifecycle: idempotency under concurrency (investments) — parallel investments: new tx=1, user_investments=1, idem rows=1, http=[200,200]
PASS lifecycle: reversal symmetry — pre wallet=0.00000000 ledger=0; mid wallet=250.00000000 ledger=250.00000000; post wallet=0.00000000 ledger=0.00000000; audit rows visible=2/2 (forward=1518, reversal=1519)
PASS reconciliation: wallet-ledger clean-room — pairs=17, baseline max_id=2602, 0 new critical/alert rows
PASS reconciliation: ledger-vs-custodian clean-room — pairs=13, externalUnavailable=13, baseline max_id=2602, 0 new critical/alert rows
PASS reconciliation: posting-receipt invariant clean-room — txWithEntries=16, receipts=16, baseline max_id=2602, 0 new critical/alert rows

Summary: 14 passed, 0 failed, 0 skipped (--strict mode: SKIP fails)

PRE-LAUNCH SAFETY: ALL GATES PASSED ✅
```

</details>

<details><summary>stderr (7424 bytes)</summary>

```
[wallet-ledger-reconciliation] mismatch {
  userId: 29,
  currency: 'AUD',
  walletCachedBalance: '150.00000000',
  ledgerSumBalance: '100.00000000',
  driftAmount: '50.00000000'
}
[OPERATOR ALERT] [wallet-ledger-reconciliation] [warning] Wallet cache drift detected for user 29 (AUD) {
  userId: 29,
  currency: 'AUD',
  walletCachedBalance: '150.00000000',
  ledgerSumBalance: '100.00000000',
  driftAmount: '50.00000000'
}
[WALLET-LEDGER RECONCILIATION ALERT] {
  userId: 11,
  currency: 'AUD',
  walletCachedBalance: '0',
  ledgerSumBalance: '-100.00000000',
  driftAmount: '100.00000000'
}
[OPERATOR ALERT] [wallet-ledger-reconciliation] [alert] Wallet cache drift detected for user 11 (AUD) {
  userId: 11,
  currency: 'AUD',
  walletCachedBalance: '0',
  ledgerSumBalance: '-100.00000000',
  driftAmount: '100.00000000'
}
[wallet-ledger-reconciliation] mismatch {
  userId: 45,
  currency: 'AUD',
  walletCachedBalance: '1050.00000000',
  ledgerSumBalance: '1000.00000000',
  driftAmount: '50.00000000'
}
[OPERATOR ALERT] [wallet-ledger-reconciliation] [warning] Wallet cache drift detected for user 45 (AUD) {
  userId: 45,
  currency: 'AUD',
  walletCachedBalance: '1050.00000000',
  ledgerSumBalance: '1000.00000000',
  driftAmount: '50.00000000'
}
[WALLET-LEDGER RECONCILIATION ALERT] {
  userId: 29,
  currency: 'AUD',
  walletCachedBalance: '900.00000000',
  ledgerSumBalance: '0',
  driftAmount: '900.00000000'
}
[OPERATOR ALERT] [wallet-ledger-reconciliation] [alert] Wallet cache drift detected for user 29 (AUD) {
  userId: 29,
  currency: 'AUD',
  walletCachedBalance: '900.00000000',
  ledgerSumBalance: '0',
  driftAmount: '900.00000000'
}
[wallet-ledger-reconciliation] mismatch {
  userId: 45,
  currency: 'AUD',
  walletCachedBalance: '1050.00000000',
  ledgerSumBalance: '1000.00000000',
  driftAmount: '50.00000000'
}
[WALLET-LEDGER RECONCILIATION ALERT] {
  userId: 29,
  currency: 'AUD',
  walletCachedBalance: '900.00000000',
  ledgerSumBalance: '0',
  driftAmount: '900.00000000'
}
[OPERATOR ALERT] [wallet-ledger-reconciliation] [alert] Wallet cache drift detected for user 29 (AUD) {
  userId: 29,
  currency: 'AUD',
  walletCachedBalance: '900.00000000',
  ledgerSumBalance: '0',
  driftAmount: '900.00000000'
}
[WALLET-LEDGER RECONCILIATION ALERT] {
  userId: 45,
  currency: 'AUD',
  walletCachedBalance: '1100.50000000',
  ledgerSumBalance: '1000.00000000',
  driftAmount: '100.50000000'
}
[wallet-ledger-reconciliation] re-paging despite acknowledgement (drift moved) {
  userId: 45,
  currency: 'AUD',
  acknowledgementId: 118,
  acknowledgedDriftAmount: '50.00000000',
  currentDriftAmount: '100.50000000',
  changeAbs: '50.50000000'
}
[OPERATOR ALERT] [wallet-ledger-reconciliation] [alert] Wallet cache drift detected for user 45 (AUD) {
  userId: 45,
  currency: 'AUD',
  walletCachedBalance: '1100.50000000',
  ledgerSumBalance: '1000.00000000',
  driftAmount: '100.50000000'
}
[WALLET-LEDGER RECONCILIATION ALERT] {
  userId: 29,
  currency: 'AUD',
  walletCachedBalance: '900.00000000',
  ledgerSumBalance: '0',
  driftAmount: '900.00000000'
}
[OPERATOR ALERT] [wallet-ledger-reconciliation] [alert] Wallet cache drift detected for user 29 (AUD) {
  userId: 29,
  currency: 'AUD',
  walletCachedBalance: '900.00000000',
  ledgerSumBalance: '0',
  driftAmount: '900.00000000'
}
[wallet-ledger-reconciliation] mismatch {
  userId: 45,
  currency: 'AUD',
  walletCachedBalance: '1050.00500000',
  ledgerSumBalance: '1000.00000000',
  driftAmount: '50.00500000'
}
[WALLET-LEDGER RECONCILIATION ALERT] {
  userId: 29,
  currency: 'AUD',
  walletCachedBalance: '900.00000000',
  ledgerSumBalance: '0',
  driftAmount: '900.00000000'
}
[OPERATOR ALERT] [wallet-ledger-reconciliation] [alert] Wallet cache drift detected for user 29 (AUD) {
  userId: 29,
  currency: 'AUD',
  walletCachedBalance: '900.00000000',
  ledgerSumBalance: '0',
  driftAmount: '900.00000000'
}
[wallet-ledger-reconciliation] mismatch {
  userId: 45,
  currency: 'AUD',
  walletCachedBalance: '1050.00500000',
  ledgerSumBalance: '1000.00000000',
  driftAmount: '50.00500000'
}
[OPERATOR ALERT] [wallet-ledger-reconciliation] [warning] Wallet cache drift detected for user 45 (AUD) {
  userId: 45,
  currency: 'AUD',
  walletCachedBalance: '1050.00500000',
  ledgerSumBalance: '1000.00000000',
  driftAmount: '50.00500000'
}
[WALLET-LEDGER RECONCILIATION ALERT] {
  userId: 29,
  currency: 'AUD',
  walletCachedBalance: '900.00000000',
  ledgerSumBalance: '0',
  driftAmount: '900.00000000'
}
[OPERATOR ALERT] [wallet-ledger-reconciliation] [alert] Wallet cache drift detected for user 29 (AUD) {
  userId: 29,
  currency: 'AUD',
  walletCachedBalance: '900.00000000',
  ledgerSumBalance: '0',
  driftAmount: '900.00000000'
}
[WALLET-LEDGER RECONCILIATION ALERT] {
  userId: 11,
  currency: 'USD',
  walletCachedBalance: '0',
  ledgerSumBalance: '-200.00000000',
  driftAmount: '200.00000000'
}
[OPERATOR ALERT] [wallet-ledger-reconciliation] [alert] Wallet cache drift detected for user 11 (USD) {
  userId: 11,
  currency: 'USD',
  walletCachedBalance: '0',
  ledgerSumBalance: '-200.00000000',
  driftAmount: '200.00000000'
}
[WALLET-LEDGER RECONCILIATION CRITICAL] *** LARGE WALLET-CACHE DRIFT *** {
  userId: 11,
  currency: 'AUD',
  walletCachedBalance: '0',
  ledgerSumBalance: '-3730.00000000',
  driftAmount: '3730.00000000'
}
[OPERATOR ALERT] [wallet-ledger-reconciliation] [critical] Wallet cache drift detected for user 11 (AUD) {
  userId: 11,
  currency: 'AUD',
  walletCachedBalance: '0',
  ledgerSumBalance: '-3730.00000000',
  driftAmount: '3730.00000000'
}
[WALLET-LEDGER RECONCILIATION ALERT] {
  userId: 29,
  currency: 'AUD',
  walletCachedBalance: '900.00000000',
  ledgerSumBalance: '0',
  driftAmount: '900.00000000'
}
[OPERATOR ALERT] [wallet-ledger-reconciliation] [alert] Wallet cache drift detected for user 29 (AUD) {
  userId: 29,
  currency: 'AUD',
  walletCachedBalance: '900.00000000',
  ledgerSumBalance: '0',
  driftAmount: '900.00000000'
}
[reconciliation] external balance unavailable { userId: 11, currency: 'AUD', internalBalance: '-3730.00000000' }
[reconciliation] external balance unavailable { userId: 11, currency: 'BTC', internalBalance: '0.00000000' }
[reconciliation] external balance unavailable { userId: 11, currency: 'USD', internalBalance: '-200.00000000' }
[reconciliation] external balance unavailable { userId: 43, currency: 'AUD', internalBalance: '0.00000000' }
[reconciliation] external balance unavailable { userId: 44, currency: 'AUD', internalBalance: '0.00000000' }
[reconciliation] external balance unavailable { userId: 46, currency: 'AUD', internalBalance: '765.00000000' }
[reconciliation] external balance unavailable { userId: 46, currency: 'BTC', internalBalance: '0.00000000' }
[reconciliation] external balance unavailable { userId: 47, currency: 'AUD', internalBalance: '100.00000000' }
[reconciliation] external balance unavailable { userId: 48, currency: 'AUD', internalBalance: '0.00000000' }
[reconciliation] external balance unavailable { userId: 49, currency: 'AUD', internalBalance: '865.00000000' }
[reconciliation] external balance unavailable { userId: 50, currency: 'AUD', internalBalance: '1000.00000000' }
[reconciliation] external balance unavailable { userId: 51, currency: 'AUD', internalBalance: '1000.00000000' }
[reconciliation] external balance unavailable { userId: 52, currency: 'USD', internalBalance: '200.00000000' }
```

</details>

---

Generated by `scripts/post-merge-safety-recheck.ts` (Task #184).
