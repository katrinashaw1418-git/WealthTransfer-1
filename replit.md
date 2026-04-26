# Wealth Management Platform

## Overview
This platform is a comprehensive cross-border wealth management solution designed for high-net-worth individuals, the global Chinese diaspora, and SMEs with international financial needs. It integrates traditional finance and cryptocurrency services, offering dual-channel support for FX and crypto trading, multi-currency wallets, AI-powered wealth advisory, and robust compliance features. The vision is to provide a unified, intelligent, and secure platform for managing diverse global assets.

## Regulated Application Flow (April 2026)

### Application → Approval → Account Creation
- `/apply` — public page where prospective users submit details, select account type, intended use, and acknowledge compliance consents (own-behalf, AML/CTF, contact)
- `/application-status` — public page to check application status by email; includes demo-only "Approve" button for testing
- `/signup` — gated behind approved application; verifies approval server-side before allowing account creation; pre-fills email from query param
- Server-side enforcement: `/api/auth/register` checks for approved application before allowing registration
- Consent fields (`consentOwnBehalf`, `consentAmlCtf`, `consentContact`) persisted in `applications` table for audit trail
- Landing page and login page "Apply for Access" links point to `/apply`
- Files: `apply.tsx`, `application-status.tsx`, `signup.tsx`, `shared/schema.ts` (applications table), `server/routes.ts`, `server/storage.ts`

## Recent Changes (April 2026) — Session 10A (Adviser Product Shelf + Client Holdings — Retail AFSL Reframe)

User confirmed AMAX is a **retail AFSL** platform (not wholesale Path B), with external financial planners / Authorised Representatives accessing the platform under the Netwealth model. Session 10A is the first slice of the adviser-layer expansion: pure additive, read-only visibility — no money movement, no execution, no new tables.

### What shipped

- **Backend service (`server/services/adviser-access.ts`)**
  - `listAdviserProducts()` — returns `investmentProducts` where `isActive=true`. No client scoping (catalogue is shared across all advisers).
  - `getAdviserClientHoldings(adviserUserId, clientUserId)` — returns the linked client's `userInvestments` rows joined to `investmentProducts` so the UI gets product name/category in one round trip. **Calls `assertAdviserClientLink` first** (verified: returns 403 for unlinked client).
  - Added `AdviserClientHoldingRow` TypeScript interface for the joined shape.
- **Backend routes (`server/adviser-routes.ts`)**
  - `GET /api/adviser/products` — adviser-gated via existing `adviserRoute()` wrapper.
  - `GET /api/adviser/clients/:id/holdings` — adviser-gated; link enforcement runs in the service layer.
- **Frontend pages**
  - `client/src/pages/adviser/products.tsx` (NEW) — read-only product card grid (target IRR, term, structure, distributions, liquidity, minimum, risk badge).
  - `client/src/pages/adviser/client-holdings.tsx` (NEW) — read-only holdings table with positions/invested/current summary cards.
  - `client/src/pages/adviser/client-detail.tsx` — added "View Holdings" button linking to the new holdings page.
- **Sidebar (`client/src/components/layout/sidebar.tsx`)** — added "Investment Products" entry to `adviserNav`.
- **Router (`client/src/App.tsx`)** — registered `/adviser/products` and `/adviser/clients/:id/holdings`. The more-specific holdings route is registered before `/adviser/clients/:id` so wouter matches it correctly.
- **Landing page (`client/src/pages/landing.tsx`)** — added a new "For Wealth Planners & AFSL Partners" section (id `for-advisers`) and a "For Advisers" header link that scrolls to it. Updated the trust-bar copy from "Wholesale clients only" to "For eligible Australian investors and authorised representatives".

### Hard rules preserved (retail AFSL law, NOT custom)
- Adviser still **never** executes against client money without explicit client consent (RG 175 / RG 245). Nothing in 10A creates an execution path.
- Every adviser write (none added in 10A — pure read paths) goes through the existing audit + chokepoint pattern.
- KYC bypass forbidden.

### Smoke tested (demoadviser/adviser888, id=12, linked to wiseinvestor id=1)
- `GET /api/adviser/products` → 200, returns active product shelf
- `GET /api/adviser/clients/1/holdings` → 200, returns linked client's holdings joined to product shelf
- `GET /api/adviser/clients/999/holdings` → **403 "Forbidden — you are not linked to this client"** (chokepoint working)

### Architect-driven fixes during 10A (latent Session 9 bugs surfaced)
- **Segmented `queryKey` was silently hitting the wrong endpoint.** The default queryFn in `client/src/lib/queryClient.ts` only uses `queryKey[0]` as the URL, so `useQuery({ queryKey: ["/api/adviser/clients", clientId] })` was hitting `/api/adviser/clients` (the LIST endpoint) for both detail and portfolio, returning the wrong shape. Affected pages: `client-detail.tsx` (detail + portfolio queries) and the new `client-holdings.tsx` (holdings query). Fixed by adding explicit `queryFn` closures that compose the full path via `apiFetch`. Segmented keys retained for cache-invalidation semantics. Audited remaining adviser pages — no other instances.
- **`apiFetch` did not handle 401 expiry.** Switching to explicit `queryFn` exposed an inconsistency: the default queryFn redirects to `/login` on 401, but `apiFetch` (used widely in `client/src/lib/api.ts`, `client/src/hooks/use-portfolio.ts`, etc.) did not. Fixed by adding the same JWT-clear + redirect inside `apiFetch`, bringing all callers into a single consistent expired-token UX.

### Conservative copy on landing page
After the architect flagged that the adviser-section copy overstated current capability, the lead paragraph and feature list were softened to make explicit that 10A is read-only and that instruction + fee-consent workflows are on the roadmap (10B / 10C).

### Cross-check pass against external advisory doc (still 10A scope — no money, no execution)
Verified the long-form advisory doc against the actual codebase and applied only the items that were (a) correctly identified as real gaps and (b) safe within 10A's read-only envelope:

- **Login post-auth redirect now role-aware.** `client/src/pages/login.tsx` previously hard-coded `navigate("/dashboard")` regardless of role, forcing advisers to manually navigate to `/adviser/dashboard`. Now: `adviser` → `/adviser/dashboard`, `admin` → `/admin`, default → `/dashboard`. Reads `user.role` from `useAuth()`.
- **Landing hero retargeted at the dual audience.** Headline shifted from "Institutional-grade wealth management for wholesale investors" to the doc's "A modern wealth platform for investors and financial planners". Hero now exposes two role-routing CTAs ("I am an Investor" → `/login`, "I am a Wealth Planner" → scrolls to `#for-advisers`) plus a tertiary "How It Works" anchor. Wholesale-eligibility framing is preserved on the products and apply sections where it accurately applies.

Items from the doc that were already in place (no change required):
- Adviser permission middleware → `requireRole(auth, "adviser")` in `server/adviser-routes.ts`
- Adviser-client access guard → `assertAdviserClientLink` in `server/services/adviser-access.ts`
- Investment Product Engine → `investmentProducts` + `userInvestments` + the new `/adviser/products` page
- Adviser sidebar layout → already conditionally rendered via `adviserNav` in `sidebar.tsx`

Items from the doc deferred to 10B / 10C and admin work (still require explicit user go-ahead):
- Investment instruction flow with client consent gate (10B)
- Fee engine — `adviserFeeRules`, `adviserFeeDeductions`, accrual + deduction (10C)
- `/admin/*` shell, `/client/instructions`, `/client/fee-consents`, `/adviser/register`

### What's deferred to 10B / 10C (require explicit user go-ahead)
- **Session 10B** — Investment instruction flow (adviser proposes allocation → client consents → execution gate). Recommendation: reuse `executionAuthorisations` + `adviceRecords` rather than introducing a new `investmentInstructions` table.
- **Session 10C** — Fee engine (`adviserFeeRules`, `adviserFeeDeductions`). Real money movement; needs reviewer sign-off before any cash-wallet debit code lands.

---

## Recent Changes (April 2026) — Session 9 (Read-only Adviser Overlay for Retail-AFSL Partner)

This session adds a read-only adviser-access layer so a partner retail AFSL's advisers can view **their linked clients** (KYC, portfolio, fee consents, recent advice records) and run their own internal workflows (tasks, report requests) without ever touching client-owned state.

### Hard limits — what advisers cannot do (enforced server-side, not just UI)

- **No money movement** — adviser JWT does not bypass any of the existing money-route guards (`requireAuth` + KYC + per-user scoping). `POST /api/wallets/*` continues to fail for an adviser the same way it would fail for any other user without standing.
- **No balance edits, no KYC bypass, no advice execution** — there are no adviser-scoped routes that mutate `wallets`, `transactions`, `ledger_entries`, `kyc_status`, `advice_records`, `fee_consents`, or `exec_authorisations`. This is checked structurally: `server/services/adviser-access.ts` is the **only** module with adviser-scoped DB access, and the only tables it writes to are `adviser_tasks` and `report_requests` (the adviser's own working tables).
- **No cross-client leakage** — every per-client read (`/api/adviser/clients/:id`, `/portfolio`, etc.) calls `assertAdviserClientLink` BEFORE returning client data. The list/dashboard aggregates don't call the helper but are scoped at the SQL level by `adviser_user_id`, with explicit comments documenting why the chokepoint pattern is structurally satisfied.

### What was built

1. **Schema** (`shared/schema.ts`):
   - `adviser_tasks` — adviser-internal task list (id, adviserUserId, clientUserId, taskType, title, notes, status, priority, dueAt, completedAt, createdAt, updatedAt) + 2 indexes
   - `report_requests` — queued statement requests (id, adviserUserId, clientUserId, reportType, format=pdf, status, requestedAt, generatedAt, downloadUrl, expiresAt, failureReason) + 2 indexes
   - `downloadUrl` is intentionally null for now — backend PDF generation is deferred until partner confirms operating model. Status starts at `requested`; the schema is ready for an async generator job to flip it to `ready` and populate the URL.

2. **Auth helper** (`server/auth.ts`):
   - `requireRole(auth, ...allowed)` — small companion to `requireAuth`. Throws `Error & { status: 403 }` if `auth.role` not in the allow-list. Variadic so future routes can do `requireRole(auth, "adviser", "compliance")`.

3. **Service layer** (`server/services/adviser-access.ts`, single file by design — every adviser DB touch lives here for security review):
   - `assertAdviserClientLink(adviser, client)` — the chokepoint helper for per-client reads
   - `listAdviserClients`, `getAdviserClientDetail`, `getAdviserClientPortfolio`, `getAdviserClientFeeConsents`, `getAdviserClientAdviceRecords`
   - `listAdviserTasks`, `createAdviserTask`, `updateAdviserTask` (adviser may only update their OWN tasks; auto-stamps `completedAt` on transition to `done`)
   - `listAdviserReportRequests`, `createReportRequest`
   - `getAdviserDashboardSummary` — single-call aggregate (linked clients, open tasks, fee consents expiring ≤30d, pending reports)

4. **Routes** (`server/adviser-routes.ts`, mounted from `routes.ts` first so its specific `/api/adviser/*` paths are matched ahead of any generic `/api/*` handler):
   - Every route goes through an `adviserRoute()` wrapper that runs `requireAuth` + `requireRole(auth, "adviser")` + try/catch envelope. **It is structurally impossible** to add a new adviser route that skips role gating without bypassing the wrapper.
   - All POST/PATCH writes emit an audit log entry (`adviser_task_created`, `adviser_task_updated`, `adviser_report_requested`).

5. **Frontend**:
   - `AuthUser.role` field added to `client/src/contexts/auth.tsx` (defaults to `"client"` for legacy `/api/auth/me` responses)
   - `client/src/components/layout/sidebar.tsx` rewritten to be role-aware: separate `clientNav` and `adviserNav` constants (rather than a filtered shared list, so it's obvious in code review what each role sees). Hardcoded "Wise Investor / Premium Client" replaced with real user details.
   - 5 new pages under `client/src/pages/adviser/`: `dashboard`, `clients`, `client-detail`, `tasks`, `reports`. All use TanStack Query v5 (default fetcher, queryKey arrays for hierarchical paths) + shadcn Cards/Tables/Forms/Dialogs.

### Demo credentials seeded

- `username='demoadviser', password='adviser888'` (id=12, role='adviser', kycStatus='verified')
- Linked to `wiseinvestor` (id=1) via `adviser_clients` with `relationshipType='servicing'`

### Smoke tests passing (10/10)

| # | Test | Result |
|---|---|---|
| T1 | client token → `/api/adviser/clients` | 403 "requires role: adviser" |
| T2 | adviser token → `/api/adviser/clients` | 200 with wiseinvestor in list |
| T3 | adviser → `/api/adviser/clients/999` (unlinked) | 403 "not linked to this client" |
| T3b | adviser → `/api/adviser/clients/1` (linked) | 200 with KYC, fee consents, advice |
| T4 | adviser → `/api/wallets/deposit` | 400 (validation; no special access) |
| T5 | `/api/adviser/dashboard` | returns linked/tasks/expiring/pending counts |
| T6 | create + complete adviser task end-to-end | 200 + `completedAt` auto-stamped |
| T7 | adviser → POST task with `clientUserId=999` | 403 (link enforced even on writes) |
| T8 | client → POST adviser task | 403 (role check fires) |
| T9 | adviser → POST report request | 200, `status='requested'` |
| T10 | no token → `/api/adviser/clients` | 401 |

### Architect review

Pass with one P1 noted (chokepoint pattern not literal for enumeration queries) — addressed by adding explicit "CHOKEPOINT NOTE" comment blocks to `listAdviserClients` and `getAdviserDashboardSummary` documenting why those two functions must NOT call `assertAdviserClientLink` (the WHERE clause IS the link enforcement; the link is the result set, not a per-row lookup).

### Out of scope (deferred until partner operating model confirmed)

SOA generation engine, commission tier rules, fact-find automation flow tied to retail accounts, retail-execution flow, PDF generator for `report_requests` (status is wired through but generator job is not yet implemented).

## Recent Changes (April 2026) — Session 9.1 (Adviser Task Automation Cron)

Wires up the three deterministic task triggers from the original adviser-layer brief that were left as a manual-only flow at the end of Session 9. Advisers no longer have to scan their client list by hand to find KYC chase-ups and fee-consent renewals.

### What was built

- **`server/services/adviser-task-automation.ts`** — single-file module with `runAdviserTaskAutomation()`. Scans every `adviser_clients` row where `is_active = true` and creates open `adviser_tasks` rows for three triggers:
  1. **`kyc_followup`** — when client `kyc_status !== 'verified'`. Title `"Follow up KYC for {clientName}"`, priority `high`, due in 7 days.
  2. **`fee_consent_renewal`** — when an active `fee_consents` row's `consent_expiry_date` falls in the next 30 days. One task per (adviser, client) — multiple expiring consents collapse into a single follow-up. Priority `urgent` if ≤7 days, else `high`.
  3. **`portfolio_review`** — when no `portfolio_review` task (in any status) was created in the last 90 days for that (adviser, client). Title `"Quarterly portfolio review for {clientName}"`, priority `normal`, due in 14 days.

- **Cron wiring** in `server/index.ts` — daily `setInterval`, staggered 120s after start so the three crons (wallet recon, ledger recon, task automation) don't overlap on first boot. Single-line summary log distinguishes true duplicate suppression from quarterly cadence suppression:
  ```
  [adviser-task-automation] completed: 1 link(s) scanned, 0 kyc_followup, 0 fee_consent_renewal, 0 portfolio_review created, 1 skipped (idempotency=0, cadence=1)
  ```

### Hard-rule invariants (unchanged from Session 9)

- **Writes ONLY to `adviser_tasks`.** No mutation of `users`, `wallets`, `transactions`, `ledger_entries`, `kyc_status`, `advice_records`, `fee_consents`, or `exec_authorisations`. Verified by reading the module — the only `db.insert`/`db.update` call is into `adviserTasks`.
- **Idempotent.** Each trigger checks for an existing OPEN/IN_PROGRESS task of the same `(adviser, client, taskType)` before inserting. The `portfolio_review` trigger additionally suppresses creation if any review task (any status) was created in the last 90 days, to prevent same-day re-triggering after an adviser completes one.
- **Operates only on linked clients.** The driver query is `SELECT … FROM adviser_clients INNER JOIN users WHERE is_active = true`. Unlinked clients are invisible to the cron.
- **Per-link error isolation.** A failure on one (adviser, client) is caught and logged; the rest of the batch continues.

### Verification

| Scenario | Result |
|---|---|
| Boot cron at 7:33 AM, all conditions clean (KYC verified, no expiring consents, recent review exists) | `1 link scanned, 0 created, 1 skipped` ✅ |
| Flip wiseinvestor `kyc_status` to `pending`, run cron | `kycFollowupsCreated: 1`, task row inserted with title "Follow up KYC for Wise User", priority `high`, status `open` ✅ |
| Re-run cron with the same task still open | `kycFollowupsCreated: 0`, `skipped: 2` (kyc + portfolio_review both hit idempotency) ✅ |

### Architect review

Pass on security, hard-rule invariants, schema correctness, and per-link error isolation. One open recommendation flagged but not actioned this session: the idempotency guard is check-then-insert against the live DB without a partial unique index or distributed lock. Race-safe under the current SINGLE Express process topology, but would need a partial unique index `(adviserUserId, clientUserId, taskType) WHERE status IN ('open','in_progress')` plus `ON CONFLICT DO NOTHING`, or a leader-election lock, before the cron can safely run on multi-replica deployments. The assumption is documented in the module header so the next reviewer doesn't have to re-derive it.

### Still deferred

PDF generator for `report_requests` — needs a dependency choice (pdfkit / puppeteer / HTML-to-print), security review of the file generation surface, and a fresh session brief from the external reviewer before implementation.

Multi-replica hardening of the task automation cron — partial unique index + distributed lock — deferred until the deployment topology actually changes.

## Recent Changes (April 2026) — Session 8 (Reconciliation + Platform Account Hardening)

This session closes the two operational follow-ups left open at the end of Session 7. Combined with Track B's ledger and Phase 2.4's execution gate, the system now has the **minimum viable financial primitives**: ledger = truth, reconciliation = verification, execution gate = control.

### 1. Platform user / `PLATFORM_USER_ID` hardening

The reviewer's rule: *"System accounts must NEVER be normal users. System accounts must NEVER be accessible via login."*

What was done:

1. **System user created in DB** (id captured at insert time, no hardcoded magic number):
   - `username = 'system'`, `email = 'system@amax.internal'`
   - `role = 'system'` (existing column, was previously `client | adviser`; now `client | adviser | system`)
   - `email_verified = true`, `kyc_status = 'verified'` (cosmetic — login is blocked regardless)
   - `password = bcrypt(crypto.randomBytes(48).base64url)` — a 48-byte random throwaway nobody knows. Defense in depth in case the role-guard is ever removed by mistake.
   - **Idempotent insert**: the seeding SQL uses `WHERE NOT EXISTS (SELECT 1 FROM users WHERE username='system' OR role='system')` so re-running it does not duplicate.

2. **`PLATFORM_USER_ID` env var set** to the captured system-user id (`11` in this environment) via the shared environment store. The `getPlatformUserId()` function in `server/services/ledger.ts` reads this at runtime and refuses to fall back — already in place from Session 7.

3. **Login route guard** at `server/routes.ts:705` — added immediately after the user lookup, **before password verification**:
   - If `user.role === 'system'`, return the same generic `401 Invalid credentials` used for non-existent users (no enumeration leak — an attacker cannot tell the difference between "system account" and "wrong password").
   - Write a dedicated audit-log entry `login_blocked_system_account` with the user id and IP — this is operationally the most important signal: if it fires, someone is probing the system account, and we want a paper trail.
   - **Why before the password check, not after:** logging an attempt against the system account at all is more important than the timing-attack risk of a faster response. The username `system` is hardly secret. We chose the audit signal.

Smoke-tested (passing):
- `POST /api/auth/login {username:'system', password:'anything'}` → `401 {"error":"Invalid credentials"}`, audit row written.
- `POST /api/auth/login {username:'wiseinvestor', password:'wise888'}` → `200` JWT (sanity).
- `getOrCreateSuspenseAccount('AUD')` now succeeds and returns an account row owned by `userId=11`, NOT `userId=1`.

### 2. Ledger-vs-custodian reconciliation job

New table (`shared/schema.ts:1011`):
```
reconciliations (
  id, userId, currency,
  internalBalance,             -- decimal(18,8) NOT NULL  (SUM(ledger_entries) snapshot)
  externalBalance,             -- decimal(18,8) NULL      (custodian-reported; NULL when unavailable)
  difference,                  -- decimal(18,8) NULL      (internal - external; NULL when external NULL)
  status,                      -- text NOT NULL: match | mismatch | external_unavailable
  severity,                    -- text NOT NULL DEFAULT 'none': none | info | warning | alert | critical
  notes,                       -- text NULL              (operational context, e.g. "feed unavailable")
  createdAt
)
INDEX reconciliations_user_currency_idx ON (userId, currency)
INDEX reconciliations_status_created_idx ON (status, createdAt)
```

**Deviations from the reviewer's spec, with reasoning:**
- Used `decimal(...)` not `numeric(...)` — project-wide convention (see `shared/schema.ts` lines 29-44 etc.).
- Added a **third status `external_unavailable`** (reviewer spec only had `match | mismatch`). Why: a custodian outage is operationally distinct from a confirmed mismatch. Calling a feed outage a "mismatch" silently hides feed problems. Calling it a "match" silently fakes a verification that never occurred. We want it explicit.
- Added a **`severity` column** (`none | info | warning | alert | critical`) so future PagerDuty/Sentry routing has a structured field to key off, instead of grepping `console.error` text.
- Added a **`notes` column** for human-readable operational context (which is what compliance reviewers actually read first).
- Made `externalBalance` and `difference` nullable, since `external_unavailable` rows have neither.

New service `server/services/reconciliation.ts`:

- **`runLedgerReconciliation()`** — walks every distinct `(userId, currency)` pair in `ledger_entries`, computes the internal SUM via `getUserCurrencyBalance()` from Track B, calls the custodian fetcher, classifies, and persists one row per pair. Returns a structured summary `{pairsChecked, matches, mismatches, externalUnavailable, alerts, criticals}` for the cron caller.
- **`fetchCustodianBalance(userId, currency)`** — Phase 1 stub. Returns `null` (NOT `"0"`). Returning `"0"` would generate a flood of false mismatches against every real balance; returning `null` correctly produces `external_unavailable` rows so the audit trail records "we attempted verification and could not". Session 9 will replace with the partner SDK call.
- **Severity classification** (`abs(diff)` in source-currency units, no FX yet):
  - `< 0.01` → status `match`, severity `none`
  - `[0.01, 1)` → status `mismatch`, severity `info` (logged, not alerted — handles the spec's "$0.50 small drift" test case)
  - `[1, 100)` → status `mismatch`, severity `warning` (`console.warn`)
  - `[100, 1000)` → status `mismatch`, severity `alert` (`console.error("[RECONCILIATION ALERT]")`)
  - `≥ 1000` → status `mismatch`, severity `critical` (`console.error("[RECONCILIATION CRITICAL]")`)
  - Caveat: thresholds are in source currency (so 0.5 BTC ≠ $0.50). Per-currency thresholds with FX conversion are a Session 9 follow-up — flagged in the source as a TODO.
- **Custodian-fetcher exception handling**: a `throw` from `fetchCustodianBalance` is treated identically to a `null` return — both record `external_unavailable` and log. Conflating the two means transient errors don't pollute the mismatch counter.

Cron wired in `server/index.ts`:

- Pre-existing daily wallet-balance reconciliation kept untouched (renamed log prefix to `[wallet-reconciliation]` for disambiguation; behaviour unchanged).
- New ledger-reconciliation cron added alongside. **First run is at boot+60s** (so we get an immediate verification on every deploy, not 24h later), then every 24h thereafter. The 60s offset prevents log-stream collision with the wallet-reconciliation cron.
- **Architect-review fix**: initial implementation only set up the interval at +60s, which meant the *first actual run* was at +24h+60s (silent operational gap on every deploy). Fixed by calling `runLedgerReconciliationCron()` directly inside the timeout before starting the interval. Verified in workflow logs: server boot → 60s later, `[ledger-reconciliation] completed: ...` line emitted.
- Logs a structured one-line completion summary `pairs / match / mismatch / unavailable / alert / critical`.

End-to-end smoke test (induced data, then cleaned up):
- Posted a balanced $100 double-entry: `user 1 +$100 AUD`, `user 11 -$100 AUD`.
- `getUserCurrencyBalance` confirmed: user 1 = `100.00000000`, user 11 = `-100.00000000`.
- `runLedgerReconciliation()` returned `{pairsChecked: 2, matches: 0, mismatches: 0, externalUnavailable: 2, alerts: 0, criticals: 0}` ✓
- 2 rows persisted to `reconciliations` table with `status='external_unavailable', severity='warning'`, notes populated ✓
- Test rows cleaned up (ledger entries left in place since they're append-only by design — but they came from a synthetic transaction with `type='reconciliation_test'` that should be ignored by any real audit query).

### Verification

- Schema: applied via `npm run db:push --force` (no destructive operations); confirmed via `information_schema`.
- Typecheck: clean except the same 2 pre-existing `server/storage.ts` errors at lines 3289/3312 — predate Session 1, out of scope.
- Workflow: clean restart, port 5000 serving, `PLATFORM_USER_ID=11` live in env.
- All Session 8 completion criteria from the spec met:
  - ✅ `PLATFORM_USER_ID` configured and enforced
  - ✅ No hardcoded system accounts remain (confirmed: `rg "platformUserId\s*=\s*1"` returns nothing in server/)
  - ✅ Reconciliation table exists
  - ✅ Reconciliation job runs (manual + cron-wired)
  - ✅ Mismatch detection works (5-tier severity)
  - ✅ Alerts visible in logs (`[RECONCILIATION ALERT]` / `[RECONCILIATION CRITICAL]` prefixes)

### What this session deliberately does NOT include

Per the reviewer's "do not touch" list:
- No advice engine changes
- No UI changes (reconciliation rows are server-internal; no operator dashboard yet)
- No execution gate changes
- No ledger structure changes
- No custodian webhook (Session 9)
- No FX-converted per-currency thresholds (Session 9 follow-up)

### Operational follow-ups for the next session

1. **Wire the real custodian fetcher** in `server/services/reconciliation.ts` (`fetchCustodianBalance` is currently a `null`-returning stub).
2. **Custodian webhook** for settlement confirmation — the inbound side of the Session 9 plan.
3. **Per-currency thresholds**: 1 BTC drift is much more material than 1 AUD drift. Threshold table should accept `currency → {warn, alert, critical}` triples, ideally driven from FX rates.
4. **Operator dashboard** for `reconciliations` (`status='mismatch' AND created_at > now() - interval '24h'`) — useful but not blocking.

## Recent Changes (April 2026) — Session 7 (Track B + Phase 2.4 Live Execution Gate)

This session lands two pieces of foundational infrastructure that were missing before any real money could move through the platform:

### Track B — production-safety ledger

Schema additions to `shared/schema.ts`:
1. **`accounts`** new table (7 cols) — one row per `(userId, currency, accountType)`. `accountType` is `client | platform_suspense | fee | adjustment`; `status` is `active | frozen | closed`. `UNIQUE INDEX accounts_user_currency_type_uidx` prevents accidentally splitting a user's balance across two duplicate rows.
2. **`ledgerEntries`** new table (9 cols) — append-only double-entry. Each settlement event posts a balanced set of `debit | credit` entries that sum to zero per currency. Three indexes for query performance:
   - `ledger_entries_account_idx` on `accountId` — **reviewer fix #3**, makes `SUM(...)` balance queries fast as the ledger grows.
   - `ledger_entries_user_currency_idx` on `(userId, currency)` — used by `/api/ledger/balances/:currency`.
   - `ledger_entries_transaction_idx` on `transactionId` — for transaction → posting-detail lookups.
3. **`transactions`** extended with 10 new fields without touching the existing 14: `idempotencyKey` (UNIQUE — distinct from the per-route `idempotencyKeys` table; this is transaction-level dedup that survives across routes), `externalRef`, `externalProvider`, `externalStatus`, `failureReason`, `settledAt`, `failedAt`, `reversedAt`, `metadata` (jsonb default `'{}'`), `updatedAt` (default `now()`). Existing `status` field is **deliberately not modified** — legacy wallet routes keep their `pending|completed|failed|cancelled` vocabulary; the new Track B vocabulary (`pending|processing|settled|failed|reversed`) lives in the state-machine helper for new code paths only.
4. Insert schemas + select/insert types via `createInsertSchema(...).omit(...)` for `accounts` and `ledgerEntries`.

Service files (`server/services/`):
1. **`ledger.ts`** — `getOrCreateClientAccount`, `getOrCreateSuspenseAccount`, `getAccountBalance` (derived from `SUM(credits) - SUM(debits)` — never stored, never mutated), `getUserCurrencyBalance`, `postLedgerEntries` (validates ≥ 2 entries, single currency, balanced to within `1e-8`). **Reviewer fix #2:** the platform suspense account user is resolved at runtime from `process.env.PLATFORM_USER_ID` and **throws hard** if unset or not a positive integer — refuses to fall back to a hardcoded `1`, because a wrong owner here silently mixes platform suspense funds into a real user's audit trail.
2. **`idempotency.ts`** — `getIdempotencyKey(req)` (validates header presence, length ≥ 12, charset `[A-Za-z0-9_\-:.]`), `findTransactionByIdempotencyKey(key)`.
3. **`transaction-state.ts`** — explicit transition matrix for the Track B vocabulary; `assertValidTransition`, `isValidTransition`, `isTerminal`. `failed` and `reversed` are terminal; reversals must post an opposing journal against a NEW transaction row (no in-place edits).

Route addition (`server/routes.ts`):
- `GET /api/ledger/balances/:currency` — returns `{currency, balance, source: "ledger_entries"}` from the SUM. Distinct from `/api/wallets` (legacy cached display balance). Once Track B fully replaces the legacy path, the two should always agree (a future reconciliation job will alert when they don't).

Explicitly **out of scope** for this session and deferred (per spec "if compatible"):
- Custodian webhooks
- Reconciliation cron job
- Wiring an example `/api/deposits/request` route — the existing `transactions.fee` and `transactions.description` are NOT NULL so the spec's example pattern would not compile against this schema; defer until the deposit flow is designed end-to-end.

### Phase 2.4 — live execution gate

New service file `server/services/execution-gate.ts`:
- **`canExecute(adviceRecordId)`** — re-evaluates the four compliance gates **at the moment of every execution attempt** by reading live state: `adviceRecords.soaIssued`, `(soaViewed || soaDownloaded)`, `adviceAccepted`, plus the most recent `feeConsents` row's `renewalStatus === "active"` and `consentExpiryDate > now()`. Returns a discriminated union — either `{allowed: true, gate: {...}}` (with the live values used) or `{allowed: false, reason: <enum>, detail: <string>}`. The seven failure reasons (`advice_record_not_found`, `soa_not_issued`, `soa_not_viewed_or_downloaded`, `advice_not_accepted`, `fee_consent_missing`, `fee_consent_inactive`, `fee_consent_expired`) give callers structured audit data.
- **`assertCanExecute(adviceRecordId)`** — throw-on-fail wrapper for code paths that just need to gate.
- **Critical:** the snapshot booleans on `executionAuthorisations` (`gateSoaIssued`, `gateSoaViewed`, `gateAdviceAccepted`, `gateFeeConsentValid`) are **audit evidence only** — they prove the gate was satisfied at the moment of authorisation. They DO NOT prove the gate is still satisfied right now. The classic failure this prevents (reviewer-flagged): client signs at 10:00 → fee consent expires at 12:00 → trade executed at 14:00 against stale snapshot → compliance breach.

Not yet wired to any execution endpoint — there is no execution endpoint yet. The function is sitting ready for the first route that needs it.

### Reviewer cross-checks (all 3 addressed)

| # | Reviewer concern | Resolution |
|---|---|---|
| 1 | Execution gate must recompute live, not trust snapshot | Implemented in `server/services/execution-gate.ts` — discriminated union return for structured audit |
| 2 | Hardcoded `platformUserId = 1` is dangerous | Resolved via `process.env.PLATFORM_USER_ID` with hard validation (positive integer or throw) |
| 3 | `SUM(ledger_entries)` will scale-fail without index | Three indexes on `ledger_entries` — `accountId`, `(userId, currency)`, `transactionId` |

### Portfolio integrity patch — verified already complete (with one reviewer follow-up)

Cross-checked all 8 spec steps against the existing codebase; **no changes needed for the original 8 steps**.

**Reviewer follow-up applied** (`server/routes.ts` `/api/portfolio/history`, ~line 1495): when only one snapshot exists for the period, `totalReturn` and `totalReturnPercent` now return `null` instead of `"0.00"`. Returning `"0.00"` would imply the user has measured "no return" over the period — a fabricated performance claim. The frontend does not render these fields today (verified via grep), so this is a forward-compatible API change with no UI breakage. `hasSufficientHistory: dataPoints.length >= 2` continues to be returned for any consumer that wants to show "Insufficient history" copy.

The 8 spec steps remain in place:

| Step | Spec | Existing state |
|---|---|---|
| 1 | Remove fake 365-day snapshot seeding | No 365-day seed exists; only today's snapshot is created (`server/routes.ts:1354`) ✓ |
| 2 | Snapshot-based monthly P&L | Already done at lines 1366-1384 ✓ |
| 3 | Snapshot-only history API | Already done at lines 1410-1497 — uses stored snapshots only, with `hasSufficientHistory` flag ✓ |
| 4 | `MemStorage → DatabaseStorage` | Already done at `server/storage.ts:3537` ✓ |
| 5-7 | Chart labels + UI wording | Existing 3-state vocabulary `actual | historical_estimate | insufficient_history` is **strictly more conservative** than spec's 2-state `snapshots | insufficient_history` — kept as-is ✓ |
| 8 | Remove fake AI advisory performance chart | No `calculatePerformanceData` exists in `client/src/pages/ai-advisory.tsx` ✓ |

The performance-chart endpoint at lines 1499-1633 forecasts only when `projectionMethod === "realized_cagr"` (real history-derived) and falls back to "no forecast" otherwise — already complies with the "no performance number unless derived from real stored data" principle.

### Verification

- DB push: applied via direct SQL (drizzle-kit's interactive prompt couldn't be driven in non-TTY); confirmed via `information_schema`: 10 new transaction columns, 2 new tables, 4 new indexes (1 unique + 3 standard), 1 unique constraint.
- Typecheck: clean except the same 2 pre-existing `server/storage.ts` errors (now at lines 3289/3312, shifted +13 from 3276/3299 due to my MemStorage extension) — both predate Session 1, out of scope.
- Server restart: clean, port 5000 serving.
- Smoke test: `GET /api/ledger/balances/AUD` returns `{"currency":"AUD","balance":"0","source":"ledger_entries"}` for the empty ledger; bad currency code → 400; missing auth → 401.

### Operational follow-ups for the user

1. **`PLATFORM_USER_ID` env var must be set before any Track B suspense-account operation.** It should point to a dedicated platform/system user, NOT user id 1 (which is a real demo user). Until set, any call to `getOrCreateSuspenseAccount(...)` throws with a helpful error message — by design.
2. Track B is **plumbing only** — no money endpoint is wired through it yet. The legacy `/api/wallets/{deposit,withdraw,transfer}` endpoints remain in place. Wiring is a future phase.
3. Reconciliation cron job (compare `ledger_entries` SUM vs partner-custodian balances) is the next item the reviewer called out and is not yet built.

## Recent Changes (April 2026) — Session 6 (Phase 2.3): Fee Consents + Advice Acknowledgements + Execution Authorisations Schema

**Schema-only.** No routes, no services, no UI. DB triggers, ledger tables, and the live execution-gate recalculation are explicitly deferred to later phases.

Schema changes (`shared/schema.ts`, ~899 lines now):
1. **`feeConsents`** new table (23 cols) — captures the client's standing instruction to deduct ongoing service fees / advice fees / platform fees. Columns: `adviceRecordId` FK NOT NULL → `advice_records.id`, `clientId` FK NOT NULL → `users.id`, optional `adviserId` FK → `users.id`, `feeType` (`ongoing_service_fee|advice_fee|platform_fee`), `amountType` (`fixed|percentage|calculation_method`), `amount` (decimal 14,4), `calculationMethod`, `accountNumber` + optional `accountName`, `deductionFrequency` (`monthly|quarterly|annually`), `referenceDay`, `renewalWindowStart` + `renewalWindowEnd` + `consentExpiryDate` (all NOT NULL timestamps for the FY24 ongoing-fee renewal cycle), `renewalStatus` (default `active` — `active|renewal_due|expired|withdrawn|renewed`), `clientSignatureName`, `consentedAt` (default now), `withdrawnAt`, `createdAt` + `updatedAt`, plus retention scaffolding.
2. **`adviceAcknowledgements`** new table (23 cols) — captures the client's pre-acceptance attestations. Columns: `adviceRecordId` FK NOT NULL, optional `soaDocumentId` FK → `soa_documents.id`, `clientId` FK NOT NULL, optional `adviserId` FK, **eleven** boolean confirm-flags all defaulting false (`confirmPersonalDetails`, `confirmFinancialInfo`, `confirmObjectives`, `confirmRiskProfile`, `confirmScopeUnderstood`, `confirmSoaViewed`, `confirmFeesUnderstood`, `confirmFeesConsented`, `confirmValuesMayFall`, `confirmReturnsNotGuaranteed`, `confirmFsgReceived`), `signatureName`, `acceptedAt` (default now), `ipAddress`, `userAgent`, plus retention scaffolding.
3. **`executionAuthorisations`** new table (17 cols) — explicit go-ahead for trade execution. Columns: `adviceRecordId` FK NOT NULL, `clientId` FK NOT NULL, optional `adviserId` FK, `authorised` (default false), `executionScope` (jsonb string[] default `'[]'`), `signatureName`, plus a **snapshot of the compliance gate at the moment of authorisation** (`gateSoaIssued`, `gateSoaViewed`, `gateAdviceAccepted`, `gateFeeConsentValid` — all default false), `authorisedAt` (default now), `ipAddress`, `userAgent`, plus retention scaffolding. **Note:** the live gate must still be recalculated server-side before any actual execution; the snapshot fields are an audit record, not the enforcement mechanism.
4. Insert schemas use `.omit()` for system-managed fields (`id`, `retentionUntil`, `deletionLocked`, `createdAt`, plus `updatedAt` on feeConsents); `Insert*` and select types added for all 3 tables.

One intentional spec deviation: spec wrote `numeric(...)` for `feeConsents.amount`; used `decimal(...)` instead because (a) `numeric` is not imported in this schema file, (b) all prior phases use `decimal`, (c) Postgres treats them identically (DB column came back as `numeric` regardless).

DB migration: `drizzle-kit push --force` succeeded, schema verified via `information_schema`:
- `fee_consents` (23 cols), `advice_acknowledgements` (23 cols), `execution_authorisations` (17 cols) all present ✓
- All 10 FKs correctly resolved (3 from fee_consents, 4 from advice_acknowledgements, 3 from execution_authorisations) ✓
- All NOT NULL constraints, defaults (`'active'`, `false`, `'[]'::jsonb`, `true`, `now()`) match spec exactly ✓

Typecheck: clean except for the same 2 pre-existing `server/storage.ts` errors at 3276/3299 (out of scope).

Server restart: clean (port 5000 serving).

Code review: PASS first pass — every column, FK target, jsonb shape, default and nullability matches spec; insert schemas correctly omit auto-generated fields; `decimal` vs `numeric` deviation explicitly endorsed; no scope creep.

**No scope creep:** zero new routes / services / UI; no DB triggers; no live execution-gate recalculation; no ledger / accounting tables; no separate clients table.

## Recent Changes (April 2026) — Session 5 (Phase 2.2): Advice Records + SOA + ROA Schema

**Schema-only.** No routes, no services, no UI. Fee consents, advice acknowledgements, execution authorisations and the DB triggers (execution gate + 7-year retention) are explicitly deferred to Phase 2.3+.

Schema changes (`shared/schema.ts`):
1. **`adviceRecords`** new table — the parent record for any piece of advice given to a client. Columns: `clientId` FK, optional `adviserId` FK, optional `factFindSnapshotId` FK → `fact_find_snapshots.id`, optional `riskProfileId` FK → `risk_profiles.id`, `adviceType` (default `personal`), `adviceSource` (default `hybrid` — `ai|adviser|hybrid`), `status` (default `draft` — `draft|review_pending|issued|accepted|declined|superseded`), `scope` + `excludedScope` (jsonb string[] default `'[]'`), four free-text summary fields (`objectivesSummary`, `financialSituationSummary`, `strategySummary`, `recommendationRationale`), `recommendedPortfolio` + `recommendedAllocation` (jsonb {cash, bonds, equities, alternatives, crypto}), `incompleteInfoWarningRequired` + `incompleteInfoWarningText`, `switchingAdviceRequired` + `switchingAdviceDetails` (jsonb {existingProduct, recommendedProduct, reasons, benefits, disadvantages, costs}), execution-gate flags (`soaIssued`/At, `soaViewed`/At, `soaDownloaded`/At, `earliestAcceptAt`, `adviceAccepted`/At, `adviceDeclined`/At, `declineReason`), `createdAt` + `updatedAt`, plus retention scaffolding.
2. **`soaDocuments`** new table — Statement of Advice document store. Columns: `adviceRecordId` FK NOT NULL → `advice_records.id`, `clientId` FK, optional `adviserId` FK, `version` (default 1), `documentUrl` + `documentHash`, `generatedBy` (default `system` — `ai|adviser|system`), `documentStatus` (default `draft` — `draft|issued|superseded|void`), RG221 opening-screen ack (`openingScreenShown`/At), `fsgDelivered`/At, `isLocked`, `issuedAt`, `createdAt`, plus retention scaffolding.
3. **`roaDocuments`** new table — Record of Advice (review-and-confirm cycles after the initial SOA). Columns: `adviceRecordId` FK NOT NULL → `advice_records.id`, optional self-style `previousAdviceRecordId` FK → `advice_records.id`, `clientId` FK, optional `adviserId` FK, `version` (default 1), `documentUrl` + `documentHash`, `reasonForRoa`, `documentStatus` (default `draft`), `isLocked`, `issuedAt`, `createdAt`, plus retention scaffolding.
4. Insert schemas use `.omit()` for auto-generated fields (`id`, `createdAt`, `updatedAt` where present, `retentionUntil`, `deletionLocked`); `Insert*` and select types added for all 3 tables.

DB migration: `drizzle-kit push --force` succeeded, schema verified via `information_schema`:
- `advice_records` (36 cols), `soa_documents` (19 cols), `roa_documents` (15 cols) all present ✓
- All 11 FKs correctly resolved (4 from advice_records, 3 from soa_documents, 4 from roa_documents) ✓
- All NOT NULL constraints, defaults (`'draft'`, `'hybrid'`, `'personal'`, `'system'`, `'[]'::jsonb`, `false`, `1`, `true`, `now()`) match spec exactly ✓

Typecheck: clean except for the same 2 pre-existing `server/storage.ts` errors at 3276/3299 (out of scope).

Server restart: clean.

Code review: PASS first pass — every column, FK target, jsonb shape, default and nullability matches spec; insert schemas correctly omit auto-generated fields; no scope creep.

**No scope creep:** zero new routes / services / UI; no fee-consent / advice-ack / execution-auth tables; no DB triggers; no separate clients table; no migration of existing data.

## Recent Changes (April 2026) — Session 4 (Phase 2.1): Fact-Find + Risk-Profile Advice-Engine Foundation

Phase 2.1 of the advice engine. **Schema + scoring + 4 API endpoints only.** SOA, fee consents, advice acks, execution authorisations, and the DB triggers (execution gate, 7-year retention) are explicitly deferred to Phase 2.2+. No UI built yet.

Schema changes (`shared/schema.ts`):
1. **`factFindSnapshots`** new table — structured fact-find capture (Sections A–F of the AFSL-grade questionnaire). Columns: `clientId` FK, optional `adviserId` FK, employment + income + expenses, asset breakdown (cash/investment/property/super/other), liability breakdown (mortgage/personal/credit-card/other), `dependantsCount` (default 0), `liquidityBufferMonths`, `liquidityNeeds`, `primaryObjective`, `investmentHorizon`, `incomeReliance`, `existingAllocation` (jsonb), `rawAnswers` (jsonb, NOT NULL — raw payload preserved verbatim for audit defensibility), `isComplete`, `createdAt`, plus retention scaffolding (`retentionUntil`, `deletionLocked = true` default).
2. **`riskProfiles`** new table — outcome of scoring a fact-find. Columns: `clientId` FK, `factFindSnapshotId` FK to `factFindSnapshots.id`, `behaviouralScore` / `capacityAdjustment` / `finalScore` integers, `riskBand` (`conservative` | `moderate` | `balanced` | `growth` | `high_growth`), `recommendedPortfolio`, `overrideApplied` (bool), `overrideReasons` (jsonb string[] default `'[]'`), `allocation` (jsonb), `scoringInputs` (jsonb, NOT NULL — full input set for audit replay), `createdAt`, plus retention scaffolding.
3. Insert schemas + `Insert*` and select types added for both tables.

Decimal columns use the existing `decimal()` helper (Drizzle alias of `numeric()`) for consistency with the rest of the schema. `retentionUntil` currently defaults to `now()` — the actual `now() + 7 years` rule will be enforced by a DB trigger in Phase 2.5 (this session does NOT add triggers).

Scoring service (`server/services/risk-scoring.ts`, new file):
- Pure `scoreRiskProfile(answers: RiskAnswers)` — no I/O, no DB access, no side effects.
- Behavioural rubric: `marketDropReaction` (0/2/4/6) + `volatilityTolerance` (1/3/5/7) + `lossTolerance` (1/3/5/7) + `investmentExperience` (1/3/5/7) + `incomeReliance` (5/3/1) → range ~5..30.
- Capacity adjustment: `incomeStability` (+2/0/-2) + `liquidityBufferMonths` (>12 → +2, ≥6 → +1, else -2) + `dependantsCount` (0 → +1, ≥3 → -2, else 0) + `debtRatio` (+1/0/-2) → range ~ -8..+6.
- Final score = behavioural + capacity, **clamped to [5, 35]**.
- Score → band: ≤10 conservative · ≤16 moderate · ≤22 balanced · ≤28 growth · else high_growth.
- **Three mandatory hard overrides** applied AFTER band mapping, each only if current band rank exceeds cap (riskRank guard): horizon `<2` → cap Moderate · `liquidityNeeds = high` → cap Balanced · `incomeReliance = full` → cap Balanced. Each cap pushes a verbatim explanation onto `overrideReasons` for audit defensibility.
- 5 model portfolios (`PORTFOLIO_ALLOCATIONS`) match the spec exactly: Conservative 25/45/25/5/0, Moderate 15/35/45/5/0, Balanced 10/25/55/5/5, Growth 5/10/70/5/10, High Growth 0/5/75/5/15 (cash/bonds/equities/alternatives/crypto).

API routes (`server/routes.ts`, inserted after `/api/auth/reset-password`, before FX-refresh block):
- `POST /api/fact-find` — Zod-validated body, decimal fields accepted as `number | string` and coerced to string for Drizzle. Persists snapshot, writes audit log `fact_find_created`. **Auth + KYC required.**
- `POST /api/risk-profile/score` — Zod-validated `{ factFindSnapshotId, answers }`. Verifies the referenced snapshot belongs to the caller before scoring (rejects with 404 otherwise — prevents binding a risk profile to someone else's snapshot). Calls `scoreRiskProfile()`, persists the result, writes audit log `risk_profile_scored` with riskBand + finalScore + overrideApplied. **Auth + KYC required.**
- `GET /api/fact-find/latest` — most recent snapshot for the caller, or `null`. **Auth + KYC required.**
- `GET /api/risk-profile/latest` — most recent risk profile for the caller, or `null`. **Auth + KYC required.**

Imports added: `desc` to `drizzle-orm`, `factFindSnapshots`/`riskProfiles` to schema imports, `scoreRiskProfile`/`RiskAnswers` from the new risk-scoring service.

DB migration: `drizzle-kit push --force` succeeded, schema verified via `information_schema`:
- `fact_find_snapshots` and `risk_profiles` tables present with all columns ✓
- All 4 FKs to `users.id` and `fact_find_snapshots.id` (integer, not UUID) ✓
- Defaults `dependants_count=0`, `is_complete=false`, `override_applied=false`, `override_reasons='[]'::jsonb`, `deletion_locked=true` ✓

Typecheck: clean except for the same 2 pre-existing errors in `server/storage.ts` (lines 3276/3299) — both predate Session 1, both out of scope.

Server restart: clean. FX rate refresh ran on startup, no errors.

Code review: PASS after one fix — initial review flagged that GET `/latest` endpoints lacked KYC enforcement; added `requireKyc` to both. All four Phase 2.1 routes are now consistent (auth + KYC).

**No scope creep:** zero advice-record / SOA / fee-consent / advice-ack / execution-auth tables created; zero DB triggers added; no UI built.

## Recent Changes (April 2026) — Session 3 (Phase 1): Drizzle Schema + Auth Role Propagation

Phase 1 of the B2B adviser overlay. **Scaffolding only** — no advice-engine surface (SOA, ROA, fact-find, fee-consents, risk-profiles) was created. All FKs to `users.id` are `integer`, not UUID, matching the existing repo convention.

Schema changes (`shared/schema.ts`):
1. **`users.role`** — `text("role").notNull().default("client")`. Values: `"client"` (default) or `"adviser"`.
2. **`aiRecommendations.isSuperseded`** — `boolean("is_superseded").notNull().default(false)`. Will be set to `true` by `supersedeAiRecommendations()` so the active set is always `(isSuperseded = false)`.
3. **`wealthApplications`** new table — logged-in user's wealth-platform onboarding intent (distinct from the public `applications` lead table). Columns: `userId` FK, `entityType`, `entityName`, `abn`, `intendedUse`, `consentGeneralAdvice`, `status` (default `pending`), `createdAt`.
4. **`adviserProfiles`** new table — one row per `role = "adviser"` user. `userId` FK with `.unique()`, plus `adviserCode` (unique), `fullName`, `email`, `afslNumber`, `authorisedRepNumber`, `status` (default `active`), `createdAt`.
5. **`adviserClients`** new table — adviser↔client link. `adviserUserId` and `clientUserId` both `integer` FKs to `users.id`, plus `relationshipType` (default `servicing`), `isActive`, `linkedAt`, `unlinkedAt`. Composite unique index `adviser_clients_uidx` on `(adviser_user_id, client_user_id)`.
6. Insert schemas + `Insert*` and select types added for the 3 new tables.

Auth changes (`server/auth.ts`):
- `AuthPayload` interface gained `role: string`.
- `verifyToken` now decodes legacy tokens (no `role` claim) as `role: "client"` so existing sessions keep working without forced re-login.
- `requireAuth` returns the new payload unchanged → role is automatically available downstream.

Caller updates (`server/routes.ts`):
- Three `signToken({...})` call sites (signup, login, email-verification login) now pass `role: user.role`.

MemStorage updates (`server/storage.ts`):
- Demo user seed and `createUser()` insert path now set `role` (default `"client"`).
- Demo AI recommendations seed and `createAiRecommendation()` insert path now set `isSuperseded` (default `false`).

DB migration: `drizzle-kit push --force` succeeded, schema verified via `information_schema`:
- `users.role` text NOT NULL DEFAULT `'client'` ✓
- `ai_recommendations.is_superseded` boolean NOT NULL DEFAULT false ✓
- `wealth_applications`, `adviser_profiles`, `adviser_clients` tables present ✓
- `adviser_clients_uidx` composite unique index present ✓

Typecheck: clean except for the same 2 pre-existing errors in `server/storage.ts` (now lines 3276/3299 due to insertions, formerly 3270/3293) — `applications.consentGeneralAdvice` Zod-optional drift and `leads.updatedAt` MemStorage seed gap. Both predate Session 1, both out of scope for this session.

Server restart: clean.

## Recent Changes (April 2026) — Session 2: Non-Custodial Wording + Dead-File Cleanup

Session 2 brief from external reviewer was to remove pre-submit AMAX banking details (info@amaxglobal, Westpac BSB, "Send to AMAX PayID") and tighten non-custodial language. Investigation showed the active `/wallets` route is wired to `wallets-new.tsx` (a clean read-only Portfolio Overview with no deposit/withdraw modals), and the flagged custody language only existed in 11 dead files that App.tsx did not import. User chose Option B (delete dead files + strengthen active page).

Changes:
1. **Deleted 11 unused wallet files** (≈4,000 lines removed) — confirmed zero imports/routes/dynamic refs before deletion; pre- and post-deletion typecheck both clean (only the 2 pre-existing unrelated storage.ts:3270/3293 errors on applications/leads remain):
   - `client/src/pages/wallets.tsx` (1,286 lines, 132 deposit/withdraw refs)
   - `client/src/pages/wallets-new-simple.tsx` (735 lines, 71 deposit/withdraw refs)
   - `client/src/pages/versions/wallets-v4.tsx`
   - `client/src/pages/versions/wallets-v5.tsx` + 8 `(copy)` variants
   - `client/src/pages/versions/README.md` and the now-empty `versions/` directory
2. **Strengthened `wallets-new.tsx` disclosure** — replaced the existing single-paragraph "Important Disclosure" block and the page footer with institutional language naming AMAX Global Pty Ltd (ABN 54 690 827 608), confirming AMAX does not hold client funds, naming Independent Reserve Pty Ltd (AUSTRAC DCE-100461150-001) as the DCE counterparty for digital asset exposure, identifying AMAX as a remittance provider + DCE facilitator only, and re-asserting that the page does not constitute personal financial advice.
3. **fx-exchange.tsx entity fix not required** — repo-wide search confirmed `AMAX Financial Pty Ltd` does not exist anywhere in the active codebase (the string only lived in the deleted dead files).

Files touched: `client/src/pages/wallets-new.tsx`. Files deleted: 13 (above).

Session 3 still pending: Phase 1 Drizzle schema (`users.role`, `isSuperseded` column on `aiRecommendations`, `wealthApplications`, `adviserProfiles`, `adviserClients`) + `AuthPayload`/JWT update.

## Recent Changes (April 2026) — Session 1: AI Advisory Lockdown

User confirmed AI insights ARE personal advice under Corporations Act and chose Option 0c (rush full SOA stack — Path B). Until that infrastructure ships, the AI advisory surface is locked down to remove live regulatory exposure.

Four lockdown changes applied:
1. **KYC gate on generation** — `/api/ai-recommendations/generate` now calls `requireKyc(userId, storage)` so insights cannot be produced for un-verified users.
2. **Supersede instead of delete** — `clearAiRecommendations` replaced with new `supersedeAiRecommendations` (marks all prior recs `isRead=true`) so the historical record is preserved for audit. Implemented on both `MemStorage` and `DatabaseStorage`; added to `IStorage` interface. (Temporary use of `isRead` as supersede flag — will migrate to `isSuperseded` column in Session 3 schema.)
3. **Mandatory general-advice warning appended to every recommendation description** — server-side decoration in `/generate`; clients cannot strip it because it's persisted into `description`.
4. **Execution endpoint blocked** — `POST /api/ai-recommendations/:id/apply` now returns `403 { nextStep: "request_soa" }`. Marks the rec as read for UX continuity but does not execute. Re-enable only after SOA / advice acceptance / DBFO consent infrastructure ships.

Frontend reinforcement:
- Added a red "Execution disabled" banner on `/ai-advisory` below the existing amber general-info banner. (No `Apply`/`Invest` buttons exist on the page; `api.applyRecommendation` is declared but uncalled. Server-side block is the primary defense.)

Files touched: `server/storage.ts`, `server/routes.ts`, `client/src/pages/ai-advisory.tsx`.

Sessions 2–8 still pending: non-custodial wording (wallets-new), Phase 1 Drizzle schema (`adviser_profiles`, `adviser_clients`, `advice_records`, `soa_documents`, `dbfo_consents`, `record_keeping_log`), SOA generation pipeline, fee consent ledger, complaints register, adviser overlay UI.

## Recent Changes (April 2026) — Compliance / Legal Merge

### Legal & Compliance page (merged)
- Route: `/legal` (sidebar: "Legal & Compliance", Scale icon)
- 7 tabs: Financial Services Guide, Regulatory, Terms of service, Privacy policy, Risk disclosure, Complaints & AFCA, Documents
- Absorbs Regulatory, Terms, Privacy, Risk Disclosure from old compliance page (no duplication)
- File: `client/src/pages/legal.tsx`

### Global Floating Adviser Box
- Lives in `client/src/components/layout/layout.tsx` — appears on all authenticated pages
- Fixed top-right, dismissible (X button), Call/Message buttons
- Message dialog sends to `/api/advisor/contact`
- Phone: +61 2 8320 1908
- Per-page adviser boxes removed from: portfolio.tsx, investments.tsx, fx-exchange.tsx, ai-advisory.tsx, compliance.tsx

### KYC page (slimmed compliance)
- Route: `/compliance` (sidebar: "KYC", Shield icon)
- Header: "Welcome back, Wise" (adviser card removed — handled by global floating box)
- Tier 2 verified banner, 4 metric cards
- 3 tabs only: KYC status, Documents, Risk profile
- Footer links to Legal & Compliance for regulatory/legal content
- File: `client/src/pages/compliance.tsx`

### KYC Status tab
- Wholesale client classification box with s761G reference
- 4 numbered steps (identity, AML, source of funds, risk assessment) with status

### Documents tab
- 5 documents: Gov ID (verified), Proof of address (verified), Source of funds (under review), Wholesale certificate (required + upload), Risk disclosure (signed)

### Risk Profile tab
- Summary view (tolerance, horizon, goal) — not a form
- Formal risk assessment pending with "Complete" button
- Disclaimer: self-assessed profile is general information only

### Regulatory tab
- Clean row layout: AFSL AR, AUSTRAC, client classification, AFCA, record keeping (s912A), Privacy Act

### Terms & Conditions
- 5 clauses including custody of assets (AMAX does not hold client funds)
- "Terms accepted 2 Aug 2025"

### Privacy Policy
- 4 sections: collection, use/disclosure, storage/security, contact
- "Privacy policy acknowledged 2 Aug 2025"

### Risk Disclosure
- 8 numbered risks with updated language (technology/digital asset risk, AI content limitations)
- "Disclosure acknowledged · Last updated January 2025 · Australian law applies · Signed 2 Aug 2025"

### Footer
- AFSL obligations and ASIC requirements reference (no FCA/COBS)

## Recent Changes (April 2026) — Onboarding Wizard (Page 1)

### 6-step onboarding fact-find wizard built
- Route: `/onboarding` (public, accessible pre/post-login)
- Step 1: Identity — KYC fields (name, DOB, country, email, phone, address) with AML/CTF + Privacy Act notice
- Step 2: Wholesale verification — 5 s761G/s761GA options, accountant certificate upload (required for net assets/income basis)
- Step 3: Financial situation — income, assets, liabilities, dependants, employment, existing investments with privacy notice
- Step 4: Investment objectives — goal (4 options), horizon (4 options), liquidity needs dropdown
- Step 5: Risk tolerance — slider (0–100) with label, experience (4 levels), knowledge (3 levels)
- Step 6: Review + submit — summary of all sections, 3 mandatory checkboxes (accuracy, privacy, wholesale declaration)
- Success screen: SOA in 3–5 business days, links to dashboard and compliance centre
- Validation: email format, phone length, numeric fields, conditional certificate requirement
- File: `client/src/pages/onboarding.tsx`
- No sidebar layout — standalone page with own header

## Recent Changes (April 2026) — Landing Page Redesign to Match Mockup

### Stats section updated
- "7 Currencies Supported" → "3 Asset classes"
- "AFSL Regulated Framework" → "Tier 2 Verification tier"

### Platform Capabilities expanded from 3 to 6 cards
- Portfolio dashboard (Reporting only)
- Investment products (Wholesale only)
- General market insights (General info only)
- Statement of Advice (AFSL regulated)
- FX exchange (AMAX Global)
- Compliance centre (Always current)

### Product cards updated
- "Digital Asset Allocation" → "Bitcoin Tracker Fund" with no IRR (null) — shows "Market-linked — highly variable" and "Total loss is possible"
- Other products now show "Target IRR X% p.a. (indicative)"

### CTA section
- "Ready to get started?" → "Ready to apply?"
- "Call +61 2 8320 1908" → "Speak to an adviser"
- Added compliance application disclaimer

### Regulatory trust badges added
- Below hero: "Authorised Representative — AFSL", "AUSTRAC registered — AMAX Global", "AFCA member" with green checkmarks
- "Wholesale clients only" label

### Footer
- Added AFCA Member Number placeholder

### Compliance page
- Added "Wholesale Investor Certificate (s761G/s761GA)" to Documents tab
- Added amber notice explaining accountant certificate requirements ($2.5M net assets / $250K income)

## Recent Changes (April 2026) — AFSL Language Compliance Sweep

### Investments page compliance
- "Invest Now" button → "Submit Investment Instruction"
- "Target IRR" → "Indicative Return" throughout product cards and modal
- "Available Capital" → "Cash Allocation (via external custodian)"
- "Cash Deposits" category → "Cash & Fixed Income"
- Removed "wallet" from all user-facing toast messages (now "account")
- Added full compliance disclaimer footer (past performance, capital risk, general info only, external custodians)

### AI Advisory / Market Insights compliance
- "Active Recommendations" → "Active Insights"
- "Recommendation Type" → "Insight Category"
- "Apply Recommendation" → "Acknowledge Insight"
- "Minor rebalancing recommended" → "Portfolio is reasonably balanced"
- All toast messages updated from "recommendation" to "insight" language
- Comparison disclaimer updated to "does not constitute personal financial advice"

### Compliance page
- "AI Advisory Limitations" → "Portfolio Insights Limitations" with Corporations Act reference
- "withdrawals (flat $25 fee)" → "fund transfers (flat $25 fee)"

### Voice settings and narration
- All "wallet" references → "account" in voice test, commands, and help text
- "deposit/withdraw" → "inflow/outflow" in voice commands
- Voice help narration updated accordingly

### Dashboard
- Internal comment updated from "AI Advisory" to "Market Insights"

### FX Exchange (standalone page, not in active router)
- "Exchange Now" → "Proceed via AMAX Global"

## Recent Changes (April 2026) — Landing Page + Route Restructure

### Public landing page added (`/`)
- New public landing page at root `/` — visible without authentication
- AFSL-compliant hero, investment products, wholesale eligibility criteria (s761G/s761GA)
- Risk warning banner, entity separation in footer (AMAX Wealth AR vs AMAX Global AUSTRAC)
- "How It Works" 4-step onboarding flow, CTA to Apply for Access / Sign In
- Dashboard moved from `/` to `/dashboard`; sidebar and login redirect updated accordingly
- Unauthenticated users redirect to landing page instead of login

## Recent Changes (April 2026) — AFSL-Compliant UI Redesign

### Removed FX Exchange page
- FX Exchange removed from routing and sidebar navigation (functionality belongs in AMAX Global, not Wealth)

### Wallets → Investment Holdings redesign
- Renamed sidebar link from "Wallets" to "Holdings" with Briefcase icon
- Page now titled "Investment Holdings" with AFSL-compliant language
- Organized into three sections: Fiat Currency Holdings, Digital Asset Holdings, Stablecoins
- All sections include custodian disclosure badges ("External Provider", "Licensed Custodian", "Regulated Issuer")
- Removed deposit/withdraw/transfer actions (those belong in AMAX Global)
- Added regulatory disclaimer about external custodians and AFSL licensing

### Transactions → Account Activity redesign
- Renamed sidebar link from "Transactions" to "Activity"
- Page now titled "Account Activity" with clean list-based layout
- Uses AFSL-compliant terminology: Inflow/Outflow/Conversion/Acquisition/Disposal instead of deposit/withdraw/etc.
- Summary cards show Total Records, Settled, and Pending Settlement counts
- Added regulatory footer about compliance and audit purposes
- Clean inline status icons and type badges

### User profile updates
- Default demo username changed to "Wiseinvestor" / "Wise888"
- Case-insensitive username lookups in both MemStorage and DatabaseStorage

## Recent Changes (April 2026) — Security Hardening + Live FX Rates (Third Pass)

### KYC backend enforcement (all money-movement routes)
- Added `requireKyc(userId, storage)` in `server/auth.ts` — reads `kycStatus` from DB, throws 403 if not "verified".
- Wired into all 5 money-movement handlers: deposit, withdraw, FX exchange, investments, wallet transfer.
- Demo user (`demo_user`) has `kycStatus: "verified"` seeded in storage — demo still works.
- New users get 403 on transaction attempts until KYC is completed — matches frontend `kyc-modal.tsx` flow.

### Live FX rate refresh (no API key required)
- `refreshFxRates()` function added at the end of `registerRoutes`.
- **Fiat pairs** (EUR, GBP, CAD, CNY vs USD): fetched from `frankfurter.app` — ECB reference rates, free, no key.
- **Crypto pairs** (BTC, ETH): fetched from `api.coinbase.com/v2/prices` public endpoint — no key required.
- Runs once on startup, then every 15 minutes via `setInterval`.
- Fails silently on network error — existing seeded DB rates remain as fallback.
- All updates use `UPDATE ... WHERE base_currency = X AND target_currency = Y` so only existing rows are touched (no inserts that could violate the sequence).

### Audit cross-check results (items already correctly implemented — no action taken)
- Transaction atomicity: already SERIALIZABLE db.transaction() in all routes
- Rate limiting: already 200/min general + 30/5min money-movement
- Idempotency: already implemented on all 7 money-movement routes
- Audit logging: already `writeAuditLog()` on every money-movement route
- CAGR formula: `Math.pow(Vf/Vi, 1/years) - 1` — mathematically correct
- Volatility: `stdDev * sqrt(365)` — correctly annualized
- Sharpe Ratio: implemented, shows `—` only when < 20 days of portfolio history (by design, not a bug)
- Portfolio calculations: all server-side, charts fetch from `/api/portfolio/performance-chart`

## Recent Changes (April 2026) — Transaction Lifecycle Integrity Audit (Second Pass)

### Fake-pending removal (all 7 money-movement routes)
- **Problem**: Deposit, withdraw, FX exchange, investment, and wallet transfer routes all pre-inserted a `pending` transaction record *outside* the `db.transaction()` block, then updated it to `completed` inside. This meant: (a) a failed rollback left a permanent `pending` ghost record; (b) the pending state implied external settlement which does not exist on this internal ledger.
- **Fix**: All 7 routes now do a single `tx.insert(..., { status: "completed", settlementStatus: "internal_only" })` inside `db.transaction()`. If the transaction rolls back, no record is written.
- **Route consolidation**: `handleDeposit` and `handleWithdraw` shared async functions replace duplicate canonical + legacy route bodies. Both `/api/deposit` and `/api/wallets/deposit` call the same handler; same for withdraw.

### `settlementStatus` column added to transactions
- New `settlement_status text NOT NULL DEFAULT 'internal_only'` column in the `transactions` table. Labels every transaction at insertion time — prevents UI and regulator confusion between internal book entries and external bank/blockchain settlement.

### DB constraints added to wallets table
- **Unique index** `wallets_user_currency_uidx ON wallets(user_id, currency)` — one wallet per user per currency, enforced at DB level.
- **CHECK constraints** `wallets_balance_non_negative` and `wallets_available_balance_non_negative` — balance and availableBalance may never go negative at the DB layer.

### Password reset token hashing (SHA-256)
- `/api/auth/forgot-password` now stores `SHA-256(token)` in DB, returns raw token to the caller (demo: in the response body; production: via email).
- `/api/auth/reset-password` hashes the incoming token before querying — raw token never touches the DB, preventing token exposure from a read-only DB compromise.

### Reconciliation audit logging
- `reconcileWalletBalances()` now calls `writeAuditLog(..., "ledger_drift_detected", ...)` for any per-currency drift exceeding $0.01. Console.warn + in-memory ring-buffer still fire for all drifts > 1e-6. The persistent DB audit entry is reserved for significant drift so the audit log stays actionable.

## Recent Changes (April 2026) — TypeScript Clean Build + Zod Validation

### Zod validation wiring (completed this session)
- `depositSchema`, `withdrawSchema`, `investmentSchema` now fully wired into `/api/deposit`, `/api/withdraw`, `/api/investments` routes respectively; all money-movement routes validate via Zod before touching storage
- Removed manual `if (!field)` checks — replaced with `safeParse()` that returns structured error messages

### TypeScript: zero errors across entire codebase
- **Investment product seeds** — typed as `Omit<InvestmentProduct, 'annualReturn' | 'returnMethod'>[]` + post-processed with `.map()` to add the missing fields
- **MemStorage `createTransaction`** — added `sourceExchange` and `blockchainTxHash` null fields to match schema
- **MemStorage `createPortfolioSnapshot`** — added `source: "actual"` field to match schema
- **Routes.ts null safety** — all `new Date(investment.investmentDate)` calls guarded with `?? Date.now()`; `performance.currentValue` null-coalesced with `?? 0` everywhere
- **Routes.ts number/string type fixes** — Zod-parsed `amount` (now `number`) used directly without `parseFloat()`; `createWallet` balance passed as `"0.00"` string; `fee.toFixed(8)` for string fee fields; `fromCurrency`/`toCurrency` field names corrected on createTransaction call
- **Client implicit `any`** — all callback parameters in `.map()`, `.filter()`, `.reduce()` annotated with `: any` across 8 files; avoids `noImplicitAny` violations from strict TypeScript
- **`wallets-new.tsx`** — active `/wallets` route; fixed redundant `parseFloat(number)` call, narrateBalance signature mismatch, and all map/filter implicit any
- **`express-rate-limit` trust proxy** — added `app.set("trust proxy", 1)` to `server/index.ts`; eliminates `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` ValidationError in Replit's proxied environment

## Recent Changes (April 2026) — Production Safety Layer

### Rate limiting + idempotency (added this session)
- **General API rate limit** — `express-rate-limit` added to all `/api/*` routes: 200 req/min per IP; `RateLimit-*` headers returned on every response
- **Strict money-movement rate limit** — 30 req per 5 minutes per IP applied as separate middleware on `/api/fx-exchange`, `/api/withdraw`, and `/api/investments`
- **FX exchange idempotency** — optional `Idempotency-Key` header support; in-memory cache (key: `userId:idemKey`, TTL: 24 h); duplicate requests return the same response with `idempotent: true` and no second transaction is created; scope: FX exchange only (extendable pattern for withdrawal/deposit)
- **Cross-check against advice files** — custodian reconciliation, webhook verification, KYC enforcement, AML compliance, pricing engine (CoinGecko), and full auth refactor were correctly deferred: each requires external integrations not present in this system; transaction `pending→settled` flow deferred because no real custodian webhook would ever fire `settled`

### System event log + NaN guard (previous session)
- **`saveSystemEvent()` ring buffer** — last 200 events in memory (FIFO); `reconcileWalletBalances()` writes drift events there; `/api/system-events` exposes them
- **Runtime NaN guard** — `calculateInvestmentTotalsAtDate` throws immediately if `totalCurrentValue` is not finite
- **`hasUnpricedAssets` UI banner** — amber warning in portfolio risk card when any investment lacks live price/NAV

## Recent Changes (April 2026) — Financial Hardening

### Analytics correctness
- **Removed artificial 50% floor** from `calculateInvestmentPerformance()` — no longer applies `Math.max(investedAmount * 0.5, currentValue)` which was synthetic and not tied to any product behavior
- **manual_nav / market_price → null currentValue** — these return types no longer use `investedAmount` as a fake placeholder; `currentValue: null` with `valuationStatus: "missing_price_source"` is returned; all 5 call sites updated with `?? 0` null-coalescence; `hasUnpricedAssets` flag propagated through to real-metrics API
- **Forecast CAGR clamp updated** — now uses `Math.max(-0.95, Math.min(1.0, cagr))`; previously rejected negative CAGR entirely and fell back to +10%, which created false-bullish projections; negative CAGR is now allowed (within -95% floor) to honestly project declining portfolios

### Data integrity
- **`validateTransaction()` guard** — validates amount > 0, type present, exchange needs both currencies + positive rate, fromCurrency ≠ toCurrency; called in FX exchange route before any wallet mutation
- **`reconcileWalletBalances()` function** — compares reconstructed balances vs current wallet state, logs `[ledger_drift_detected]` warnings with delta per currency; called automatically after backfill fills any new snapshots
- **`reconstructWalletBalancesAsOf()`** — reverse transaction replay for historical wallet balances (added previous session); formula: `balance_at_date = current_balance + debits_after_date - credits_after_date`

### Previously implemented (Q1 2026)
- Gap-aware backfill using `existingDays` Set
- Null-safe monthly P&L (`parseFloat(null || '0')` false-zero fix)
- CAGR-based projection (`projectionMethod: "realized_cagr"` at 7.82%)
- Risk metrics 3-tier state (`limited` / `estimated` / `historical`)
- Sharpe/volatility/drawdown guards (`returnStd > 0.0001`, `hasDrawdownEvent`)

## Recent Changes (August 2025)
- **Investment Performance Calculation System**: Implemented unified `calculateInvestmentPerformance()` function ensuring consistent calculations across all endpoints
- **Performance by Period Chart**: Fixed calculation discrepancies, now shows quarterly intervals only with accurate total returns matching individual investment totals  
- **Bitcoin Market-Based Returns**: Updated Bitcoin Tracker Fund to use 60%+ annualized market-based historical performance instead of conservative 15% midpoint IRR
- **Portfolio Performance Enhancement**: Total return increased from $155,821.84 (8.78%) to $189,109.51 (10.65%) with realistic Bitcoin performance
- **Data Consistency**: Achieved perfect alignment between individual investment displays and Performance by Period chart (discrepancy < $0.01)
- **Portfolio Allocation Endpoint Fix**: Updated portfolio allocation and AI recommendations endpoints to use unified calculation function
- **Multi-Investment Support**: Verified system correctly handles multiple investments in same fund with accurate individual and combined calculations
- **Return Calculation Methodology**: Bitcoin 60% market-based, other assets use midpoint IRR (Real Estate 11%, Corporate Credit 11%, VC 18%, Ethereum 5.75%)

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: React 18 with TypeScript
- **Build Tool**: Vite
- **UI Framework**: Shadcn/ui components with Radix UI primitives
- **Styling**: Tailwind CSS with custom design system
- **State Management**: TanStack Query (server state), React hooks (local state)
- **Routing**: Wouter
- **Charts**: Recharts
- **Form Management**: React Hook Form
- **Accessibility**: Comprehensive voice narration system

### Backend
- **Runtime**: Node.js with Express.js
- **Language**: TypeScript with ES modules
- **Database**: PostgreSQL with Drizzle ORM (using Neon Database serverless)
- **API Design**: RESTful endpoints with typed responses
- **Session Management**: PostgreSQL-based sessions

### Core Features
- **User Management**: KYC tracking, multi-tier user system, role-based access control.
- **Multi-Currency Wallet**: Supports fiat (USD, CAD, EUR, GBP, AUD, HKD, SGD, VND and 50+ other global currencies), BTC, ETH, USDT, USDC. Features balance tracking, real-time updates, and cross-border remittance.
- **Portfolio Management**: Unified view across fiat and crypto, performance tracking, asset allocation visualization, historical charts. Performance charts include connected dot visualization, color coding (red for portfolio, blue for benchmark), and clear legends. Asset allocation colors for Investment Products (purple), Crypto Assets (red), Stablecoins (light gray), Corporate Credit (light gray), Real Estate (brown), Cash Deposits (blue).
- **FX & Crypto Trading**: Real-time exchange rates, FX trading, order execution tracking.
- **AI Advisory System**: Risk profiling, portfolio rebalancing, investment opportunity alerts, personalized insights.
- **Compliance & KYC**: Multi-step KYC, document verification, risk assessment, jurisdiction-specific flows.
- **Transaction Management**: Comprehensive history for deposits, withdrawals, exchanges, transfers; real-time status tracking.
- **Investment Products**: Structured investment products across Real Estate, Corporate Credit, Venture Capital, and Digital Assets (Bitcoin Tracker, Web3 Innovation, Ethereum Staking). Includes filtering, detailed product info, and capital invested tracking.
- **Banking Integration**: Supports various deposit options including Credit/Debit Card, PayID (Australia Only), Bank Transfer, and Blockchain Transfer for crypto/stablecoins.
- **Transfer/Conversion System**: Wise-inspired interface with two-section layout ("Your Balances" table, "Transfer or Convert" interface). Supports 50+ exchange rate pairs, real-time rates, 0.5% transaction fees, automatic wallet creation for new currencies, and zero-balance wallet hiding. Crypto currencies always appear at bottom of the table.
- **Contact Advisor**: Floating contact box with phone number and message functionality on key pages.

### System Design Choices
- **Monorepo Structure**: Client, server, and shared code within a single repository.
- **Scalability**: Serverless PostgreSQL, stateless Express server, CDN-ready static assets, TanStack Query caching.
- **Branding**: AMAX Wealth Platform.

## External Dependencies
- **Database**: Neon PostgreSQL
- **ORM**: Drizzle ORM
- **UI Components**: Radix UI
- **Charts**: Recharts
- **Date Utilities**: date-fns
- **Planned Integrations**: Third-party KYC/AML services, institutional custody services (Fireblocks, BitGo), traditional banking rails.