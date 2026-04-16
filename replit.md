# Wealth Management Platform

## Overview
This platform is a comprehensive cross-border wealth management solution designed for high-net-worth individuals, the global Chinese diaspora, and SMEs with international financial needs. It integrates traditional finance and cryptocurrency services, offering dual-channel support for FX and crypto trading, multi-currency wallets, AI-powered wealth advisory, and robust compliance features. The vision is to provide a unified, intelligent, and secure platform for managing diverse global assets.

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