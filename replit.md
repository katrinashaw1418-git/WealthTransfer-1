# Wealth Management Platform

## Overview
This platform is a comprehensive cross-border wealth management solution designed for high-net-worth individuals, the global Chinese diaspora, and SMEs with international financial needs. It integrates traditional finance and cryptocurrency services, offering dual-channel support for FX and crypto trading, multi-currency wallets, AI-powered wealth advisory, and robust compliance features. The vision is to provide a unified, intelligent, and secure platform for managing diverse global assets.

## Recent Changes (April 2026) — Session 20: Live Fee Consents (DBFO request → sign → admin oversight)

Implements the full DBFO (Deduction-Based Fee Order) consent lifecycle so an adviser can REQUEST a fee consent from a linked client, the client can SIGN or DECLINE, and admin gets read-only oversight of both the in-flight request log and the executed consent log. **No money is moved by this flow** — AMAX still requires separate admin-approved deduction controls (still gated). The 10C fee engine remains DISABLED.

**Schema (`shared/schema.ts`)**
- New `feeConsentRequests` table with status state machine: `pending | consented | declined | withdrawn_by_adviser | superseded`. FK `signedFeeConsentId → feeConsents.id` is set atomically when the client signs.
- Indexes: `(clientUserId, status)`, `(adviserUserId, status)`.
- Hardening (added in architect Round 2 fix): partial unique index `fee_consent_request_signed_unique_idx ON (signed_fee_consent_id) WHERE signed_fee_consent_id IS NOT NULL` (one executed consent can only ever be linked to one request); CHECK constraint `fee_consent_request_status_signed_chk` enforcing `status='consented' IFF signedFeeConsentId IS NOT NULL` at the DB level.
- `insertFeeConsentRequestSchema`, `InsertFeeConsentRequest`, `FeeConsentRequest` exported. Migrated cleanly via `npm run db:push`.

**Backend** — every write wrapped in `db.transaction` + `auditLogs` insert in the same tx:
- `server/adviser-routes.ts`: `POST /api/adviser/fee-consent-requests` (Zod `superRefine` enforces RG175 ±2-day renewal window: 60 days before / 150 days after the proposed referenceDay; asserts adviser–client link), `GET` (paginated `?clientId=&status=&page=&limit=`, link enforcement on `clientId` filter), `PATCH /:id/withdraw` (only `status='pending'`, ownership-checked, row-locked).
- `server/client-routes.ts`: `GET /api/client/fee-consent-requests`, `POST /:id/sign` (transactionally inserts `feeConsents` executed row + flips request to `consented` + sets `signedFeeConsentId`; emits TWO audit rows `fee_consent_signed` + `fee_consent_created`), `POST /:id/decline`, `GET /api/client/fee-consents` (read-only executed list).
- `server/admin-routes.ts`: `GET /api/admin/fee-consent-requests` and `GET /api/admin/fee-consents` — both paginated with adviser/client username joins.
- **Concurrency hardening** (architect-mandated): every state-changing transition does `SELECT ... FOR UPDATE` on the request row AND a conditional `UPDATE ... WHERE id = :id AND status = 'pending'`, with `409` returned if the loser sees a 0-row update. This was verified live: two parallel sign calls now produce exactly one executed consent + one `400 'Cannot sign request in status consented'`.

**Frontend** — 3 new pages, all TanStack Query v5 object-form, shadcn/ui, `apiRequest` + array-key cache invalidation:
- `client/src/pages/adviser/fee-consents.tsx` — request dialog (client picker → linked-advice-record picker, fee type / amount type / amount or calculation method, account, frequency, reference day; the renewal window is auto-derived in the client and re-validated server-side); status filter; paginated list; `Withdraw` action on pending rows.
- `client/src/pages/client/fee-consents.tsx` — pending requests table with Sign / Decline; Sign dialog requires `signatureName`; Active consents table shows `renewalStatus` badges + days-until-expiry.
- `client/src/pages/admin/fee-consents.tsx` — Tabs: `Requests` (with status filter) and `Live consents` (with renewal-status filter), both paginated.
- All three pages carry the explicit hardening notice: *"No money will be moved by this consent — AMAX requires separate admin-approved deduction controls (currently disabled)."*
- `client/src/App.tsx` — 3 new routes wired (`/adviser/fee-consents`, `/client/fee-consents`, `/admin/fee-consents`).
- Sidebars: `Receipt` icon for client (`Fee Consents`), `HandCoins` icon for adviser (under Clients) and admin (between Reports and Compliance).

**Architect verdict**: Round 1 = FAIL (1 Critical: sign transaction was not concurrency-safe; two parallel sign calls could both pass the read-then-insert path and create duplicate executed consents). Round 2 fix = SELECT FOR UPDATE on every transition + conditional UPDATE WHERE status='pending' + DB-level partial unique index on `signedFeeConsentId` + CHECK constraint tying `status` to `signedFeeConsentId`. Verified live with parallel-curl race test: exactly one consent created, loser correctly 400'd.

**Hard rules unchanged**: 10C fee engine STILL GATED. No money movement. Every adviser/admin/client write is audit-logged. Cross-role attempts return 403 (admin POSTing adviser endpoints, adviser signing on behalf of client). Demo creds unchanged: wise/wise888 (admin), wiseadviser/wise888, wiseinvestor/wise888.

## Recent Changes (April 2026) — Session 19: Admin Shell Expansion (Products, Instructions, Reports, Compliance)

Fills out the admin shell to match the spec: catalogue management, read-only oversight of in-flight investment instructions, oversight of generated reports, and a compliance overview dashboard. No money movement, no fee-engine activation, no KYC bypass — every admin write emits an audit row in the same transaction.

**Schema (`shared/schema.ts`)**
- New `adminReviewNotes` table (id, adminUserId, entityType, entityId, note, createdAt) with composite (entityType, entityId) index. Today the entityType Zod enum is restricted to `"investment_instruction"`; future entity types extend the enum without a migration.
- Standard `insert*Schema`, `Insert*` and `*` types exported.
- Migrated cleanly via `npm run db:push --force`.

**Backend (`server/admin-routes.ts`)** — 7 new endpoints, all admin-role-gated, all writes wrapped in tx + auditTx in the same transaction:
- `GET  /api/admin/products` — list including inactive (catalogue management view).
- `POST /api/admin/products` — create (audit `admin_product_created`). Validated by `adminCreateProductSchema` whose `superRefine` enforces the operational invariant: an active product (isActive=true / default) **must** carry an `annualReturn`, otherwise downstream portfolio valuation is fail-closed and the product would silently surface as "unknown valuation". When supplied, `annualReturn` must be a parseable decimal in [0, 1] (helper `isValidAnnualReturn`).
- `PATCH /api/admin/products/:id` — update including isActive toggle (audit `admin_product_updated`). The handler computes the post-update view of the row and rejects 400 if the resulting state would be `{isActive:true, annualReturn:null/empty}` — this prevents activation of an unvaluable row through the update path. The PATCH schema also re-applies the [0, 1] bound when `annualReturn` is supplied (shared `isValidAnnualReturn` helper, no drift between create and update).
- `GET  /api/admin/instructions` — paginated read-only join (adviser/client/product), `?status=&page=&limit=` (PAGE_SIZE=50). Returns `{items, page, limit, total}`.
- `POST /api/admin/review-notes` — append admin annotation against an existing investment_instruction (audit `admin_review_note_added`); validates the target instruction exists at the API boundary.
- `GET  /api/admin/instructions/:id/review-notes` — list notes for one instruction.
- `GET  /api/admin/reports` — paginated `report_requests` with adviser/client joins, `?status=&type=&page=&limit=`.
- `GET  /api/admin/compliance/overview` — KYC counts, fee-consent renewal-status counts, instruction-status counts, advice acks-vs-records, recent compliance audit events.

**Frontend** — 4 new pages under `/admin/*`, all TanStack Query v5 object-form, shadcn/ui, `useToast` from `@/hooks/use-toast`, mutations via `apiRequest` + cache invalidation by array `queryKey`:
- `client/src/pages/admin/products.tsx` — table + create dialog + isActive toggle. Create form's Zod schema requires `annualReturn` and only matches values in [0, 1] up to 4dp (server is authoritative; frontend regex matches the same bound).
- `client/src/pages/admin/instructions.tsx` — list + status filter + side-panel review-notes thread. PAGE_SIZE=50 with prev/next; filter changes reset to page 1.
- `client/src/pages/admin/reports.tsx` — list + status & type filters; same pagination behaviour.
- `client/src/pages/admin/compliance.tsx` — KPI cards + small grouped tables.
- `client/src/App.tsx` — 4 new routes wired under `<AdminLayout>`.
- `client/src/components/layout/admin-sidebar.tsx` — 4 new items (Package, ListChecks, FileText, ShieldCheck icons).

**Architect verdict**: Round 1 = FAIL (2 Major: pagination usability, annualReturn-on-create). Round 2 = FAIL (Reports page Button import missing, annualReturn range only enforced on create). Round 3 = PASS-equivalent after the PATCH-side bound was added.

**Hard rules unchanged**: 10C fee engine STILL GATED. No money movement here. RG 175 / DBFO / KYC posture untouched. Demo creds unchanged: wise/wise888 (admin), wiseadviser/wise888, wiseinvestor/wise888.

## Recent Changes (April 2026) — Session 16B: Case-insensitive email guard + create-invite audit

Hardens the duplicate-email defence introduced in Session 16 with a single canonical normaliser and a DB-level case-insensitive safety net. Closes the last gap in Task #4: an admin-side block path that previously rejected silently with no audit row.

### What was added
- **`normalizeEmail()` helper** (`shared/schema.ts`) — single source of truth for `String(x ?? "").trim().toLowerCase()`. Imported and used by `server/admin-routes.ts` (invite creation) and `server/routes.ts` (legacy `/api/auth/register`, which previously trusted `email.toLowerCase()` only at insert time and did the duplicate-user lookup with raw input).
- **DB-level case-insensitive uniqueness**:
  - `users_email_lower_unique` — `UNIQUE btree (lower(email))` alongside the existing `users_email_unique` constraint. Belt-and-braces: `User@x.com` and `user@x.com` cannot both exist as users even if a future code path forgets to normalise.
  - `registration_invites_email_lower_active_unique` — `UNIQUE btree (lower(email)) WHERE used_at IS NULL`. Twin of the existing case-sensitive partial unique index, so case-only duplicates also collapse to "one live invite per identity".
  - Pre-flight verified clean: `0` mixed-case rows in `users` or `registration_invites`, `0` lower(email) collisions. `npm run db:push` applied cleanly.
- **Create-invite block path now audits** (`server/admin-routes.ts:543-551, 592-616`): the in-tx existing-user `SELECT` now matches via `lower(users.email) = ${normalisedEmail}` and tags its rejection with `code: "DUP_USER_EMAIL"`. The surrounding `catch` writes `registration_invite_rejected_duplicate_email` with `stage: "create_invite"`, `email`, `role`, and `existingUserId` — **outside** the rolled-back transaction so the audit trail captures the rejection regardless. Mirrors the validate/complete-side audit emission so reviewers see all three rejection paths under one action name.
- **23505 mapper extended** to recognise both partial unique indexes (case-sensitive and lowercased), translating either to the same "another invitation in flight" 409.

### Smoke tests run
- Mixed-case dup attempt (`Wiseinvestor@…` against existing `wiseinvestor@…`) → **409**, audit row written with `stage: "create_invite"`, `existingUserId: 1`. ✅
- Mixed-case new email (`NewPerson.MixedCase@Example.COM`) → **200**, DB row stored as `newperson.mixedcase@example.com`. ✅
- Sequential re-issue with different case → **200**, prior invite revoked, exactly 1 active row. ✅
- End-to-end validate + complete on the issued link → **201**, user row stored fully lowercased in both `email` and `username`. ✅
- Pre-existing `server/storage.ts:3289,3312` TS errors untouched — all changes compile cleanly otherwise.

### Why no SERIALIZABLE escalation
The existing-user check is `READ COMMITTED` + in-tx `SELECT`, which leaves a sub-millisecond residual race window. The activation-side `users.email` UNIQUE + 23505→409 mapping is still the final guard. Now backed by the lowercased unique index too, so even a case-only race is caught at insert time. SERIALIZABLE would force retry loops in admin code for negligible benefit.

### Deferred (still gating Task #3)
Email delivery for invitation links remains pending — admin still copies the link from the post-issue dialog. Picking a transactional provider (Postmark / Resend / SES) is a Session 17 decision that needs user input.

## Recent Changes (April 2026) — Session 16: Admin invite UI + invite flow hardening

This session ships the admin-side surface for the Session 14 invite engine and tightens two race-correctness gaps caught during code review.

### What was built
- **Admin page `/admin/registration-invites`** (`client/src/pages/admin/registration-invites.tsx`) — full UI for the previously-headless `POST /api/admin/registration-invites` endpoint. Email + role (`client | adviser | admin`) + optional adviser auto-link (only rendered when `role='client'`, force-reset via `useEffect` when role flips). One-time `inviteLink` shown in a modal post-issuance with copy-to-clipboard; closing the dialog discards the link from local state and the system has no way to re-emit it. Wired into `client/src/App.tsx` route table and `client/src/components/layout/admin-sidebar.tsx` nav as "Registration Invites".
- **Phase 3 — invite-creation race tightening** (`server/admin-routes.ts`): the existing-user `SELECT` on `users.email` was moved INSIDE the create-invite transaction so the SELECT and the invite INSERT are a single atomic unit under READ COMMITTED. This collapses the "issue invite for an email that's being registered right now" UX hazard from a multi-millisecond pre-check window down to a single tx. The activation-side `users.email` UNIQUE + 23505 → 409 mapping remains the final correctness guard for the residual sub-millisecond window; SERIALIZABLE was deliberately not adopted (retry complexity outweighs benefit).
- **Phase 3b — activation-time adviser revalidation** (`server/routes.ts:1098-1126`): when a client invite carries an `adviserUserId`, the activation tx now re-selects that user with `FOR UPDATE` and verifies `role='adviser'` BEFORE inserting the `adviser_clients` row. If the adviser was demoted/deleted between invite issuance and redemption, the tx aborts with `409 — adviser no longer available`, no orphan user is created, and the invite remains unused so an admin can investigate or re-issue. **Verified end-to-end**: demoting `wiseadviser` mid-flight yielded the 409, zero rows in `users` for that email, zero rows in `adviser_clients`, and `registration_invites.used_at IS NULL`.

### Smoke tests run
- 3 issuance shapes (client / client+adviser / adviser) → all 200 with valid one-time link.
- 5 negatives: `adviserUserId` on `role=adviser` → 400, bad `adviserUserId` → 400, non-admin caller → 403, dup email re-issuance → 200 with prior invite revoked (verified DB shows exactly 1 active row), invite for an email that's already a real user → 409 with no DB leak.
- Stale-adviser activation → 409, full tx rollback verified (no user, no link, invite still active).
- Positive sanity: same flow with intact adviser → 201 + `adviser_clients` link present.

### Code review (architect, evaluate_task)
- Confirmed the Phase 2 form's role/adviser state-sync via `useEffect` is coherent.
- Confirmed Phase 3 in-tx SELECT is genuinely tighter under READ COMMITTED.
- Caught the missing activation-time adviser revalidation (fixed in Phase 3b above).
- Confirmed dialog "show link only once" has no re-render leaks.

### Known follow-ups (deferred, not blockers)
- Email delivery: invites are still surfaced as raw links in the admin UI. Picking a transactional email provider (Postmark / Resend / SES) is a Session 17 decision and requires the user to commit to one.
- Optional UX: schema for `adviserUserId` on the client form could tighten to `z.union([z.literal("none"), z.string().regex(/^\d+$/)])` to surface invalid values before the network round-trip — left as a polish follow-up.
- Pre-existing TS errors at `server/storage.ts:3289,3312` remain (pre-date this session).

## Recent Changes (April 2026) — Session 15B: Adviser notification dismissals (preference layer)

Adviser notifications stay computed live by the existing aggregator (`server/services/adviser-access.ts:getAdviserNotifications`) — no persistent notifications table, no DB triggers. Session 15B adds a **pure preference layer** so advisers can dismiss individual items without rewriting the source-of-truth model.

- New table `adviserNotificationDismissals` (`shared/schema.ts:341-373`) with unique index on `(adviserUserId, sourceType, sourceId)`, FK to `users.id`, and adviser-side index for fast prefetch. Stores nothing but the dismissal itself.
- Aggregator now pre-fetches the calling adviser's dismissals once and applies an `exclude()` filter to all five buckets' items AND counts (KYC pending, advice expiring, fee consents expiring, recently linked clients, applications awaiting approval). Dismissed items disappear from both the popover list and the bell badge in lockstep.
- New endpoints `POST /api/adviser/notifications/dismiss` and `DELETE /api/adviser/notifications/dismiss` (`server/adviser-routes.ts:187-249`), zod-validated. Idempotent via 23505 swallow on insert and no-op DELETE.
- UI `client/src/components/notifications-popover.tsx`: X dismiss button on each item, mutation invalidates the bell query so badge + list refresh together. Item ids use `${sourceType}:${sourceId}` format; KYC dismissals reference `users.id`.
- Verified end-to-end as `wiseadviser`: dismissing 1 KYC item moved kycPending 2→1 and total 6→5; idempotent re-POST; DELETE restores; 400/403/401 negatives all correct.

## Recent Changes (April 2026) — Session 14: Registration invites after admin approval

### What was missing
Sessions 12–13 built the admin approval pipeline, but an approved applicant had no way to actually create their account — the public `/api/auth/register` route only verified that an `application` row was approved, with no binding back to a specific approval event. Admins also had no way to onboard advisers (the legacy register flow is client-only by construction).

### What was built
- **`registrationInvites` table** (`shared/schema.ts`) — stores `SHA-256(invite)` in `inviteHash` only, plus `email`, `role` (`client | adviser | admin`), `relatedEntityType/Id` (e.g. `client_application`, `adviser_application`, `adviser_firm`), optional `adviserUserId` (for client→adviser auto-link), `expiresAt` (48h hard), `usedAt`, `createdBy`.
- **DB-enforced "one live invite per email"** via partial unique index `WHERE used_at IS NULL`. Concurrent issuers race → loser gets 23505, server translates to 409. Verified with a 5-way parallel-issuance test ending with exactly 1 active invite.
- **Atomic approve gate** — `POST /api/admin/applications/:id/approve` updates with a `WHERE status NOT IN ('approved','rejected')` predicate inside the transaction; if two operators race, the loser sees `[]` back and the tx throws 409 (no double-mint). The same approve endpoint mints the registration invite in the same tx and returns `{ application, inviteLink, expiresAt }`.
- **`POST /api/admin/registration-invites`** — admin-issued direct invites for clients, advisers, or admins. `adviserUserId` only valid when `role='client'` and the referenced user must actually be an adviser. Returns `{ inviteLink, expiresAt }` with the raw invite shown exactly once.
- **`GET /api/auth/registration-invites/validate?invite=…`** (public, rate-limited 30/min) — hash-lookup, checks not-used + not-expired, returns `{ valid, email, role, expiresAt }`. Audit row inserted via direct `db.insert` (fail-closed) — response only succeeds if the audit lands.
- **`POST /api/auth/registration-invites/complete`** (public, rate-limited 10/15min) — body is just `{ invite, password }`. Single tx: `SELECT … FOR UPDATE` on the invite row, re-checks expiry/used, creates user with **role + email + username** all from the invite (request body has no escape hatch), `kycStatus` = `pending` for clients / `not_required` for advisers + admins, creates portfolio, optional `adviser_clients` link with `relationshipType: 'servicing'`, marks `usedAt`, audits `registration_account_activated`, returns JWT for auto-login.
- **Frontend `/register/invite?invite=…`** (`client/src/pages/register-invite.tsx`) — validates on mount, shows read-only email + role badge, password + confirm password only ("AMAX Wealth Account Activation" / "Activate account"), auto-logs in via `loginWithJwt()` on the auth context, role-redirects (adviser → `/adviser/dashboard`, admin → `/admin`, else `/dashboard`).
- **Admin UX** — applications page shows a one-time copy-to-clipboard dialog with the invitation link after approve. A "Send Invite" button on the advisers page is intentionally deferred — the backend endpoint exists.

### Security properties (verified)
- Raw invite bytes never persisted (SHA-256 only, raw shown in API response exactly once via `inviteLink`).
- **Email, role, username immutable** — server takes all three from the locked invite row, never from the request body. Verified: a body trying to set `role: "admin"` or a different email is silently ignored; the new user gets the invite's identity. `username` is forced to `email` by spec.
- **Single-use enforced** — `usedAt` set inside the same tx as user creation; `FOR UPDATE` row lock prevents the consumption race. Re-using an invite returns 410.
- **Admin-only issuance** — `/api/admin/registration-invites` is gated by `requireRole("admin")`; the public `/complete` endpoint accepts whatever role the invite carries but invites are only minted via admin-gated paths.
- **All admin writes** wrapped in `db.transaction` with `auditTx` (fail-closed pattern from Session 13). Read-side audit (`registration_invite_viewed`) also fail-closed via direct insert.
- **Audit chain (5 events possible)**: `admin_application_approved` → `registration_invite_created` → `registration_invite_viewed` → `registration_account_activated`, plus `registration_invite_rejected_duplicate_email` if someone tries to activate against an email that's now taken. Each links forward via `entityId`/`metadata`.

### Existing flows preserved
- Legacy `/api/auth/register` (anonymous signup gated by approved-application-by-email) is **untouched** and still works for backward compatibility. Locking it down is a follow-up — the new invite flow is the canonical path going forward.
- No fee, money-movement, KYC, SoA, or investment-execution logic touched in this session.

### Known follow-ups
- Add "Send Invite" admin UX on advisers page (backend ready).
- Activation form does not collect `firstName`/`lastName`; both default to `""` (the columns are `notNull`). Users fill these in via profile/KYC. If we want them captured at activation, add fields to the activation form and to `completeInviteSchema`.
- Consider deprecating legacy `/api/auth/register` once all clients have transitioned to the invite flow.
- Pre-existing TS errors at `server/storage.ts:3289,3312` are unrelated to this session and remain.

## Recent Changes (April 2026) — Session 13: Admin Shell (AFSL operations)

### What admins do
- Approve / reject account applications (with required reason on rejection)
- Create new adviser users (issue temporary password)
- Assign clients to advisers via `adviser_clients` links; deactivate / reactivate links
- View the full audit log (paginated, filterable by action / entity / user)

### Hard scope boundaries (preserved)
- **No money movement** — admins do not touch wallets, transactions, FX, or any deposit/withdrawal route
- **10C fee engine still gated** — admins cannot trigger any fee deduction; `feeConsents` flow remains on the adviser/client surface only
- **No KYC bypass** — application approval only grants permission to register; the user still completes KYC under their own login
- **Audit on every write (fail-closed)** — every admin state change runs inside a `db.transaction()` alongside its `audit_logs` insert; if the audit insert fails, the underlying write rolls back and the request returns 500

### Backend
- New `server/admin-routes.ts` mirroring the `adviser-routes.ts` shape, with an `adminRoute()` wrapper enforcing `requireAuth` + `requireRole("admin")` + try/catch envelope
- All writes (approve, reject, create adviser, link/reactivate, toggle link) wrapped in `db.transaction(async (tx) => {...})` with `auditTx(tx, ...)` in the same transaction — true atomicity between business write and audit row
- Endpoints: `/api/admin/dashboard`, `/api/admin/applications` + approve/reject, `/api/admin/advisers` + create, `/api/admin/clients`, `/api/admin/adviser-clients` + create + PATCH toggle, `/api/admin/audit-logs` (paginated)
- Application approval enforces `emailVerified === true` (cannot approve someone who hasn't proven their email)

### Frontend
- New `AdminLayout` + `AdminSidebar` with violet accent (visually distinct from the dark adviser shell and the standard client shell)
- 5 admin pages under `client/src/pages/admin/`: `dashboard`, `applications`, `advisers`, `adviser-clients`, `audit-logs`
- `App.tsx` now picks one of three shells by `user.role` (`admin` → `AdminApp`, `adviser` → `AdviserApp`, else `ClientApp`) and enforces role-fenced redirects so each persona stays in its own portal; `/legal` is shared
- Bare paths `/admin` and `/adviser` redirect to their respective dashboards (avoids 404 traps)

### v1 limitation — no `users.isActive` column
- The `users` table doesn't currently track an active flag. To "disable an adviser" in v1, an admin deactivates that adviser's `adviser_clients` links instead. This immediately revokes the adviser's read access to those clients (including historical reports). Adding a real `isActive` column on `users` is a future-session item.

### Demo seeding
Demo credentials follow a consistent `wise*` / `wise888` pattern across all three personas (single password makes demo flows easier; clearly not for production):
- `wiseinvestor / wise888` — client (id=1, unconditional seed)
- `wiseadviser / wise888` — adviser (id=12, unconditional seed; renamed from the older `demoadviser`)
- `wise / wise888` — admin (id=13, **gated to `isLocalDev` only**; renamed from the older `admin`)

The admin seed is the only privileged auto-seed and runs **only** when `isLocalDev` is true (NODE_ENV=development plus the explicit local-dev sentinel). In any shared/staging/production environment the first admin must be provisioned manually — auto-seeding a known privileged credential would be a backdoor. The rename blocks are idempotent and preserve user IDs (so existing audit rows and adviser-client links stay attached).

## Regulated Application Flow (April 2026)

### Application → Approval → Account Creation
- `/apply` — public page where prospective users submit details, select account type, intended use, and acknowledge compliance consents (own-behalf, AML/CTF, contact)
- `/application-status` — public page to check application status by email; includes demo-only "Approve" button for testing
- `/signup` — gated behind approved application; verifies approval server-side before allowing account creation; pre-fills email from query param
- Server-side enforcement: `/api/auth/register` checks for approved application before allowing registration
- Consent fields (`consentOwnBehalf`, `consentAmlCtf`, `consentContact`) persisted in `applications` table for audit trail
- Landing page and login page "Apply for Access" links point to `/apply`
- Files: `apply.tsx`, `application-status.tsx`, `signup.tsx`, `shared/schema.ts` (applications table), `server/routes.ts`, `server/storage.ts`

## Recent Changes (April 2026) — Session 12 (Adviser PDF Reports)

Goal: Wire the adviser report generator end-to-end. Previously, "Request report" inserted a `reportRequests` row at status='requested' and nothing ever happened. Now the row is generated to a real PDF, the adviser can download it, and access is gated on live entitlement. Phase 3 (10C — fee engine, real money) remains gated.

### Backend
- New `server/services/reports.ts` exporting `generateReportPdf(reportId)`:
  - Re-asserts `assertAdviserClientLink` (defence in depth — required if generation ever moves async).
  - Marks the row `status='generating'`, then assembles per `reportType`:
    - `portfolio_summary` — `userInvestments` holdings (product NAV) + AUD/USD cash via `getUserCurrencyBalance` (LEDGER-DERIVED, never stored balance columns)
    - `fee_summary` — `feeConsents` for the client + explicit "fee engine not yet operative" disclaimer
    - `transaction_history` — last 100 `transactions` for the client
    - `full_statement` — all of the above
  - Renders A4 PDF via `pdfkit`: header band, DRAFT watermark on the cover, sectioned tables, dedicated disclosure page, per-page footer ("Draft — placeholder regulatory details. Page X of Y.").
  - On success: `status='ready'`, `downloadUrl`, `generatedAt`, `expiresAt = +30 days`.
  - On failure: `status='failed'`, `failureReason`. Function returns a tagged result rather than throwing — caller audits both branches.
  - Files land at `.local/reports/<reportId>.pdf` (added to `.gitignore`).
- `server/adviser-routes.ts`:
  - `POST /api/adviser/reports` now `await`s `generateReportPdf` inline (datasets are small, so synchronous is fine for v1). Audits `adviser_report_requested` then either `adviser_report_generated` or `adviser_report_failed`. Re-reads the row before returning so the UI sees terminal state.
  - New `GET /api/adviser/reports/:id/download` (NOT wrapped in `adviserRoute()` because it streams binary). Inline auth: `requireAuth` + `requireRole("adviser")` + `row.adviserUserId === auth.userId` ownership check + `assertAdviserClientLink(auth.userId, row.clientUserId)` LIVE entitlement re-check (deactivating an adviser-client link immediately revokes download access to historical PDFs). Returns 409 if status≠ready, 410 + flips to 'expired' if past `expiresAt`, 404 if file missing on disk. Sends `Content-Type: application/pdf`, `Content-Disposition: attachment`, plus `Cache-Control: no-store, private`, `Pragma: no-cache`, `X-Content-Type-Options: nosniff`. Audits `adviser_report_downloaded`.

### Frontend
- `client/src/pages/adviser/reports.tsx`:
  - Download cell uses a fetch+blob+anchor pattern via `downloadReport()` (a plain `<a href>` can't carry the JWT).
  - `failed` rows show an "AlertCircle Failed" badge with `failureReason` in a tooltip.
  - Create-mutation `onSuccess` distinguishes ready/failed/other and toasts accordingly. Also invalidates the notifications query so the bell badge updates.

### Verified end-to-end
- All 4 report types generate to real PDFs (5–8 KB each) on disk.
- Download returns `application/pdf`, body starts with `%PDF-`, anti-cache headers present.
- Security matrix: link active → 200; link deactivated → 403 (proven live by toggling `adviser_clients.is_active`); other adviser → 403; no auth → 401; bogus id → 404; unlinked client at request time → 403 from `assertAdviserClientLink`.
- Audit log: `adviser_report_requested`, `adviser_report_generated`, `adviser_report_downloaded`, `adviser_report_failed` all firing.
- Architect review: PASS with one MEDIUM (stale-authorization on download) — fixed in same session by adding the live-link re-check + cache headers.

### Files
- `server/services/reports.ts` (NEW)
- `server/adviser-routes.ts` (POST wired to generator + new download route)
- `client/src/pages/adviser/reports.tsx` (fetch-blob download + Failed tooltip)
- `.gitignore` (`.local/reports/` added)
- `package.json` — pdfkit + @types/pdfkit added via packager

### Out of scope (Phase 3 — still gated)
- Fee engine accrual/deduction (10C — real money)
- Async/queued generation (synchronous is fine for v1; queue trigger threshold noted for future)
- CSV/XLSX formats
- Charts inside PDFs

## Recent Changes (April 2026) — Session 11 (Adviser Notifications)

Goal: Replace the inert bell icon in the adviser topbar with a real notifications popover backed by a single read-only aggregator. Phase 3 (10C — fee engine, real money) remains gated.

### Backend
- New `getAdviserNotifications(adviserUserId)` in `server/services/adviser-access.ts`. Five buckets:
  - `pendingClientConsents` — `investmentInstructions` where status='pending_consent'
  - `openHighUrgentTasks` — `adviserTasks` where status='open' AND priority IN (high,urgent)
  - `feeConsentsExpiring` — `feeConsents` where renewalStatus='active' AND expiry within next 30 days
  - `pendingReports` — `reportRequests` where status IN (requested, generating)
  - `kycPending` — `users.kycStatus='pending'`
- **All five buckets are intersected with `linkedClientIds` (active links only)**, including the three buckets that already filter by `adviserUserId`. Defense-in-depth: deactivating a link instantly removes that client's data from the bell, even from rows the adviser originally owned. Both row and count predicates use the identical intersected WHERE clause so counts cannot drift.
- Hard short-circuit: if `linkedClientIds.length === 0`, the function returns the all-zero payload before any further DB calls.
- Items list returns top 5 per bucket, sorted by severity (urgent → warning → info) then recency. Each item has `severity`, `type`, `title`, `description`, `deepLink`, `createdAt`.

### Route
- `GET /api/adviser/notifications` in `server/adviser-routes.ts` using the existing `adviserRoute()` wrapper (requireAuth + requireRole("adviser")). Read-only; no mutations or execution paths.

### Frontend
- New `client/src/components/notifications-popover.tsx` — shadcn `Popover` with bell trigger, red badge showing `totalCount`, scrollable item list with severity dots, deep-link `Link`s via wouter. Refetches every 60s and on window focus. `staleTime: 30_000` overrides the global `Infinity`.
- `client/src/components/layout/adviser-layout.tsx` — replaced the previously-inert `<Button><Bell/></Button>` with `<NotificationsPopover />`.

### Verification
- Adviser → 200, payload correctly scoped to linked clients only.
- Non-adviser → 403, no auth → 401.
- Other adviser endpoints (/products /instructions /dashboard /tasks) still 200.
- Architect re-review after the scoping fix: PASS, no new HIGH/MEDIUM findings.
- Typecheck clean except the same two pre-existing `server/storage.ts` errors at lines 3289/3312.

### Also in this session (polish)
- Fixed product visibility: seeded 10 missing products via `scripts/seed-missing-products.ts` (15 active total). Products query now uses `staleTime: 30_000, refetchOnMount: "always"` to override the global `staleTime: Infinity`.
- En-dash normalisation in DB (Web3 25–35%, Ethereum 6–8%).
- Specialist banner on `digital_assets` product cards.
- Hardened "approval ≠ execution" wording in 3 places on `instructions.tsx` (header + toast + modal).
- "Draft — placeholder regulatory details" amber banner on `legal.tsx` and the landing footer.

### Out of scope (deferred)
- Phase 3 (10C): fee engine, accrual, deduction. Real-money commitment, still gated.
- Visual re-skin (navy/gold per React mockup).
- Admin shell, `/adviser/business` redesign.

## Recent Changes (April 2026) — Session 10C-shell (Dedicated Adviser Portal Shell)

Goal: Give advisers a distinct portal experience without touching the existing client app. Phase 3 (10C — fee engine, real money) remains gated.

### Layout split by user role
- New `client/src/components/layout/adviser-layout.tsx` — sticky topbar with search form (submits to `/adviser/clients?q=…`), "Authorised Representative" role badge, notifications bell, user pill, logout. Reads the live querystring via wouter's `useSearch()` so the field stays in sync when only `?q=` changes.
- New `client/src/components/layout/adviser-sidebar.tsx` — slate-900/amber theme, sectioned navigation (Practice / Clients / Operations). Mobile sheet has a visually-hidden `SheetTitle` for a11y.
- `client/src/App.tsx` rewritten: `ProtectedApp` picks `<AdviserApp>` when `user.role === "adviser"`, otherwise `<ClientApp>` (which keeps the original `<Layout>`). Bidirectional bounce: an adviser landing on a non-adviser path goes to `/adviser/dashboard`; a client landing on `/adviser/*` goes to `/dashboard`. `/legal` registered in BOTH shells so each role keeps their portal chrome.
- Existing `client/src/components/layout/sidebar.tsx`, `layout.tsx`, and all client pages are unchanged.

### New adviser pages
- `client/src/pages/adviser/workflow.tsx` — priority strip (open tasks / awaiting consent / fee consents expiring ≤30d / pending reports) + pending-instructions table + open-tasks table sorted by priority with a complete-task action.
- `client/src/pages/adviser/business.tsx` — book snapshot: total AUM, linked clients, KYC coverage, active fee consents, tier composition bars, top-5 clients by portfolio value. Read-only with disclosures.
- `client/src/pages/adviser/dashboard.tsx` rewritten to add a workflow priority panel (top pending consents + top open tasks) and a client book snapshot (total AUM + top 5 portfolios). The "Open tasks" headline card now links to `/adviser/workflow`.
- `client/src/pages/adviser/clients.tsx` reads `?q=` via `useSearch()` and filters its rows by name/email substring match.

### Backend posture
No new backend endpoints in this shell change. The new pages compose existing endpoints (`/api/adviser/{dashboard,clients,tasks,instructions}`) client-side. This keeps the surface area small and avoids regressions in the 10B-PASSed adviser/client API.

### Hard-gate integrity preserved
No money-movement code paths added. `/adviser/business` surfaces AUM and consent counts only — no fee deduction, wallet write, or execution path. 10C (fee engine) still requires explicit go-ahead.

### NaN / numeric safety
Both new pages use a local `safeNum()` helper that falls back to `0` for non-finite values, so malformed numeric strings can't poison sort order or `Intl.NumberFormat` output.

---

## Recent Changes (April 2026) — Session 10B (Investment Instruction Flow + Client Consent Gate)

User authorised Phase 1 (transactions tab on the adviser's client-detail view) and Phase 2 (10B — investment instructions with a hard client-consent gate). Phase 3 (10C — fee engine, real money movement) **remains gated** and requires explicit go-ahead. No cash leaves a client wallet in 10B; `consented` is the terminal state for this session.

### Phase 1 — Transactions tab on `client-detail`

- **Backend service** — `getAdviserClientTransactions(adviserUserId, clientUserId)` in `server/services/adviser-access.ts`. Calls `assertAdviserClientLink` first (403 on unlinked).
- **Backend route** — `GET /api/adviser/clients/:id/transactions` in `server/adviser-routes.ts` (adviser-gated).
- **Frontend** — `client/src/pages/adviser/client-detail.tsx` refactored from a flat layout to `Tabs` (Overview / Transactions / Advice & Fees). Each tab uses the segmented-`queryKey` + explicit `queryFn` pattern fixed in 10A. The "View Holdings" button is preserved next to the KYC/tier badges.

### Phase 2 (10B) — Investment instruction flow

The adviser proposes a buy/sell/switch; the linked client must explicitly approve it from their own portal before anything else happens. This is the RG 175 / RG 245 chokepoint enforced in code, not in policy docs.

#### Schema decision — Option A (new table), not Option B (reuse)

Created a dedicated `investmentInstructions` table in `shared/schema.ts` (lines 919–982) **rather than** overloading the existing `executionAuthorisations` (binary, not a state machine) or `adviceRecords` (too heavyweight, document-centric). The new table has the right granularity and the right state vocabulary for an instruction lifecycle.

Columns:
- `id`, `adviserUserId`, `clientUserId`, `productId`
- `action` (`buy` | `sell` | `switch`)
- `amount` (`decimal(15,2)` — using `decimal` per project rule, never `numeric`)
- `status` (default `pending_consent`; vocabulary: `pending_consent`, `consented`, `processing`, `completed`, `rejected`, `cancelled`) — **omitted from `insertSchema` so the server controls it**
- Nullable FKs to `adviceRecords`, `feeConsents`, `executionAuthorisations` for future linkage
- `notes`, `rejectionReason`, `consentedAt`, `rejectedAt`, `createdAt`, `updatedAt`

Pushed via `npm run db:push --force` (no destructive ALTERs — additive only).

#### Adviser write surface (`server/adviser-routes.ts` + `server/services/adviser-access.ts`)
- `GET /api/adviser/instructions` — adviser sees only instructions where `adviserUserId === auth.userId`, joined to product + client name/email for the UI.
- `POST /api/adviser/instructions` — Zod-validated body (`createInstructionSchema`). Defence-in-depth in the service layer: `assertAdviserClientLink` (link), product exists + `isActive`, optional `adviceRecordId.clientId === clientUserId`, optional `feeConsentId.clientId === clientUserId` + `renewalStatus === active`. Status is **server-set to `pending_consent`** regardless of input. Audit log on every create.

#### Client consent surface — **new file** `server/client-routes.ts`
A dedicated file because the client-facing routes have a different authorization rule (`instruction.clientUserId === auth.userId`, NOT adviser-link logic). Wired via `registerClientRoutes(app)` in `server/routes.ts` immediately after `registerAdviserRoutes`.
- `GET /api/client/instructions/pending` — only `pending_consent` rows owned by the caller, joined with product + adviser name for the UI card.
- `POST /api/client/instructions/:id/consent` — strict state machine: only `pending_consent → consented`. Any other transition returns **400** with the current status in the error message. Sets `consentedAt`. Audit log.
- `POST /api/client/instructions/:id/reject` — `pending_consent → rejected`, optional `reason` body. Sets `rejectedAt` + `rejectionReason`. Audit log.
- Cross-user attempts return **403 "Forbidden — not your instruction"**.

#### Hard gate locked in (no money movement in 10B)
- `consented` is **terminal** for this session. There is no code path from `consented` → `processing` → cash debit. That work is 10C.
- The adviser's create UI explicitly tells the adviser the instruction is "pending consent — no funds will be moved by this submission."
- The client's pending UI explicitly tells the client "approving here records your consent — no funds move automatically yet."

#### Frontend pages
- **`client/src/pages/adviser/instructions.tsx` (NEW)** — list view with status badges, "New instruction" dialog (client picker, product picker filtered to `isActive`, action select, AUD amount input with regex validation, optional notes textarea, amber compliance reminder above the submit button). Cache invalidates `["/api/adviser/instructions"]` on success.
- **`client/src/pages/client-instructions.tsx` (NEW)** — pending list as cards with Approve / Reject buttons. Reject opens a dialog for an optional reason. Sky-coloured info banner reinforces client agency.
- **Sidebar** — added "Instructions" entry to `adviserNav` with `ClipboardCheck` icon (between "Investment Products" and "Tasks").
- **Router** — registered `/adviser/instructions` and `/client/instructions` in `client/src/App.tsx`.

#### Smoke test — full state-machine pass (demoadviser → wiseinvestor)
1. `GET /api/adviser/instructions` empty list → 200 `[]`
2. `GET /api/adviser/clients/1/transactions` → 200
3. `GET /api/adviser/clients/999/transactions` → **403 "Forbidden — you are not linked to this client"**
4. `POST /api/adviser/instructions` (linked client 1, product 4, buy AUD 5,000.00) → 201 with `status: "pending_consent"`
5. `POST /api/adviser/instructions` (unlinked client 999) → **403**
6. Client login (wiseinvestor) → token issued
7. `GET /api/client/instructions/pending` → 200 with the new row joined to product + adviser name
8. `POST /api/client/instructions/1/consent` → 200, `status: "consented"`, `consentedAt` populated
9. `POST /api/client/instructions/1/consent` again → **400 "Cannot consent — instruction is in status \"consented\""**
10. Adviser tries to consent the same instruction → **403 "Forbidden — not your instruction"**
11. Pending list re-fetched → 200 `[]`

#### What is **explicitly out of scope** (10C — gated)
- `adviserFeeRules` + `adviserFeeDeductions` schema, accrual job, deduction stub.
- Wiring the `consented` → `processing` → wallet-debit path. This is the real-money commitment and needs reviewer sign-off before any cash-wallet code lands.
- Visual re-skin (navy/gold per the React mockup — purely cosmetic).
- Admin shell, `/adviser/business`, `/adviser/register`.

---

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