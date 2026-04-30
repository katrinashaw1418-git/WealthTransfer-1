# REDESIGN_READINESS

## 1) Local run check (`npm run dev`)

- Status: pass (server starts and serves on `http://0.0.0.0:5000`).
- Verified from active terminal logs: `serving on port 5000`.
- Note: there are background cron/env warnings in dev logs, but they do not block frontend startup.

## 2) Frontend entry area confirmation

Yes. Frontend entry is under `client/src`.

Primary entry chain:
- `client/index.html` -> `<script type="module" src="/src/main.tsx">`
- `client/src/main.tsx` -> mounts `App`
- `client/src/App.tsx` -> app router/shells (public, client, adviser, admin)
- `vite.config.ts` -> `root: client`, alias `@` => `client/src`

## 3) Main frontend files/pages/components (current UI)

Core app shell:
- `client/src/App.tsx`
- `client/src/contexts/auth.tsx`
- `client/src/lib/queryClient.ts`
- `client/src/components/layout/layout.tsx`
- `client/src/components/layout/adviser-layout.tsx`
- `client/src/components/layout/admin-layout.tsx`
- `client/src/components/layout/sidebar.tsx`
- `client/src/components/layout/adviser-sidebar.tsx`
- `client/src/components/layout/admin-sidebar.tsx`
- `client/src/components/layout/header.tsx`
- `client/src/index.css`

Main pages:
- Public/auth: `client/src/pages/landing.tsx`, `login.tsx`, `signup.tsx`, `apply.tsx`, `verify-email.tsx`, `forgot-password.tsx`, `reset-password.tsx`, `onboarding.tsx`
- Client: `client/src/pages/dashboard.tsx`, `wallets-new.tsx`, `portfolio.tsx`, `transactions.tsx`, `investments.tsx`, `compliance.tsx`, `risk-assessment.tsx`, `client-instructions.tsx`, `fees.tsx`, `client/wealth-planner.tsx`, `client/fee-consents.tsx`, `client/advice-viewer.tsx`
- Adviser: `client/src/pages/adviser/dashboard.tsx`, `clients.tsx`, `client-detail.tsx`, `client-holdings.tsx`, `workflow.tsx`, `tasks.tsx`, `instructions.tsx`, `products.tsx`, `reports.tsx`, `fee-consents.tsx`, `fees.tsx`, `business.tsx`
- Admin: `client/src/pages/admin/dashboard.tsx`, `applications.tsx`, `advisers.tsx`, `adviser-clients.tsx`, `registration-invites.tsx`, `audit-logs.tsx`, `operator-alerts.tsx`, `products.tsx`, `instructions.tsx`, `reports.tsx`, `compliance.tsx`, `fee-consents.tsx`, `fees.tsx`, `reconciliation.tsx`, `background-jobs.tsx`, `kill-switches.tsx`, `error-log.tsx`

Main reusable UI areas:
- `client/src/components/ui/*` (buttons, cards, forms, dialogs, toasts)
- `client/src/components/dashboard/*`
- `client/src/components/adviser/wealth-planner-panel.tsx`
- `client/src/components/notifications-popover.tsx`
- `client/src/components/kill-switch-banner.tsx`
- `client/src/components/write-kill-switch-banner.tsx`

## 4) Backend API endpoints used by frontend (high-level map)

Common/client endpoints:
- `/api/user`
- `/api/portfolio`, `/api/portfolio/allocation`, `/api/portfolio/real-metrics`, `/api/portfolio/history/*`, `/api/portfolio/performance-chart/*`
- `/api/wallets`
- `/api/transactions`
- `/api/fx-rates`, `/api/fx-rates/:base/:target`
- `/api/ai-recommendations`, `/api/ai-recommendations/:id/read`, `/api/ai-recommendations/:id/apply`
- `/api/investment-products`, `/api/investment-products/:id`
- `/api/user-investments`, `/api/investments`, `/api/investment-performance`, `/api/investment-breakdown`, `/api/investments/history-ytd`
- `/api/compliance/overview`, `/api/kyc/state`, `/api/risk-assessment`
- `/api/client/instructions/pending`
- `/api/client/objectives`, `/api/client/documents`, `/api/client/documents/:id/download`
- `/api/client/fee-consent-requests`, `/api/client/fee-consents`, PDF/sign/decline subroutes
- `/api/client/fees`, `/api/client/fee-deductions`
- `/api/client/advice/:id`
- `/api/kill-switches/status`, `/api/system/write-state`, `/api/system/deduction-execution-state`

Adviser endpoints:
- `/api/adviser/dashboard`
- `/api/adviser/clients`, `/api/adviser/clients/:id`, `/api/adviser/clients/:id/portfolio`, `/api/adviser/clients/:id/transactions`, `/api/adviser/clients/:id/holdings`
- `/api/adviser/tasks` (+ PATCH by id)
- `/api/adviser/instructions`
- `/api/adviser/products`
- `/api/adviser/reports` (+ download/regenerate/cancel/audit-log)
- `/api/adviser/notifications`
- `/api/adviser/fee-consent-requests` (+ withdraw)
- `/api/adviser/fee-rules`, `/api/adviser/fee-accruals`, `/api/adviser/fee-deductions`
- `/api/adviser/client-objectives/:clientId`, `/api/adviser/client-documents/:clientId`, `/api/adviser/client-notes/:clientId`

Admin endpoints:
- `/api/admin/dashboard`, `/api/admin/metrics`
- `/api/admin/applications`
- `/api/admin/advisers`, `/api/admin/registration-invites`
- `/api/admin/audit-logs`
- `/api/admin/operator-alerts*` (list, summary, test, failover, acknowledgements, prune-runs)
- `/api/admin/products*` (list/create/update/history/active-holdings-count)
- `/api/admin/instructions*`, `/api/admin/review-notes`
- `/api/admin/reports*` (list/retry/sweeper)
- `/api/admin/compliance/overview`
- `/api/admin/fee-consent-requests*`, `/api/admin/fee-consents*`
- `/api/admin/fee-rules*`, `/api/admin/fee-accruals*`, `/api/admin/fee-deductions*`
- `/api/admin/reconciliation` family (`wallet-ledger-reconciliations`, drift acknowledgements)
- `/api/admin/background-jobs*`
- `/api/admin/kill-switches*`
- `/api/admin/error-log*`
- `/api/admin/system-status`

## 5) Env variables required (frontend/dev startup)

Hard requirements to boot backend (needed because frontend is served with backend in this setup):
- `DATABASE_URL` (required in `server/db.ts`)
- `JWT_SECRET` required outside isolated local dev (`server/auth.ts`)

Frontend-specific env usage:
- `VITE_PUBLIC_ENV` (used by `client/src/pages/landing.tsx` to control dev/staging banner)

Observed non-blocking-but-important runtime vars (can generate cron/service errors if missing):
- `PLATFORM_USER_ID` (used by ledger/insufficient-funds services)

## 6) Safe files to edit for redesign (visual-only phase)

Safe targets:
- `client/src/pages/**/*`
- `client/src/components/**/*` (especially `components/layout/*`, `components/ui/*`, dashboard/adviser/admin presentation components)
- `client/src/index.css`
- `client/src/App.tsx` (route/layout composition only, no API contract changes)
- `client/index.html` (metadata/container only)

Guideline:
- Keep redesign changes to JSX/CSS/layout/UX flow.
- Preserve existing API calls, payloads, auth behavior, and route paths.

## 7) Files/areas NOT to touch during redesign

Do not modify:
- `server/routes.ts` (explicitly protected)
- `server/services/ledger.ts`
- wallet/transaction money-movement backend logic (`server/routes.ts` money routes, related services)
- DB schema and migrations:
  - `shared/schema.ts`
  - `drizzle.config.ts`
  - `migrations/*`
  - DB connection layer `server/db.ts`

Also avoid backend refactors in:
- `server/**/*` unless needed to fix a frontend startup blocker.

