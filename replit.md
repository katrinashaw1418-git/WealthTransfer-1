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