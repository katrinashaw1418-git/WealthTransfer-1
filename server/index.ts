import express, { type Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import rateLimit from "express-rate-limit";
import { registerRoutes } from "./routes";
import { registerHealthRoutes } from "./health";
import { setupVite, serveStatic, log } from "./vite";
import { recordServerError } from "./services/error-log";

const app = express();
app.set("trust proxy", 1); // Trust first proxy hop (Replit's reverse proxy sets X-Forwarded-For)
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------------------------------------------------------------------------
// Task #157 — uptime endpoints (/health, /ready)
// ---------------------------------------------------------------------------
// Mounted BEFORE the rate limiter, the request logger, and the heavy
// `registerRoutes` setup so external monitors can probe `/health` and
// `/ready` from the moment the process is up — even while the rest of
// the app is still finishing its boot-time DB migrations. They live
// outside `/api`, so the per-IP rate limiter and the `/api`-only request
// logger below also leave them alone (no auth, no audit log noise).
//
// REBASE NOTE (Task #157 over Task #144): Task #144 had earlier added its
// own `app.get("/health", ...)` here that called `buildHealthReport()`
// from `services/health.ts`. Task #157 supersedes that route with a
// `/health` whose payload shape is the one the spec asks for
// (status / uptimeSeconds / version / db.{ok,latencyMs}) AND adds the
// new `/ready` endpoint. The admin-dashboard "lastSuccessfulHealthProbeAt"
// signal Task #144 wired into `recordSuccessfulHealthProbe()` is preserved
// because `registerHealthRoutes` calls it on every successful /health hit.
// `services/health.ts` is left in place for any future caller of
// `buildHealthReport()`.
// ---------------------------------------------------------------------------
registerHealthRoutes(app);

// ---------------------------------------------------------------------------
// TASK #144 — per-request id
// ---------------------------------------------------------------------------
// Tagged onto every request so the persistent error log line and any
// downstream service log can be correlated. Uses an inbound `x-request-id`
// header when present (handy for tracing through a proxy), otherwise mints
// a fresh UUID. We attach to res.locals so the global error handler can
// read it without re-parsing headers.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  const inbound = req.header("x-request-id");
  const id =
    inbound && inbound.length > 0 && inbound.length <= 128 ? inbound : randomUUID();
  (res.locals as Record<string, unknown>).requestId = id;
  res.setHeader("x-request-id", id);
  next();
});

// ---------------------------------------------------------------------------
// TASK #144 — universal 5xx response sniffer
// ---------------------------------------------------------------------------
// The global Express error middleware (registered far below) only fires when
// a route calls `next(err)`. Many existing handlers (in routes.ts,
// admin-routes.ts, adviser-routes.ts, client-routes.ts, etc.) instead use
// `res.status(500).json(...)` directly — those responses would otherwise
// never be persisted to the rotating error log file.
//
// To close that gap we hook `res.on('finish', …)` here, BEFORE any route
// runs, so every response (regardless of how it was produced) is inspected
// once after Express finishes flushing it. If the status code is in the 5xx
// range AND the global error middleware did not already record this same
// response (it sets `_serverErrorRecorded` on `res.locals` to prevent double
// counting), we record a synthetic entry. The synthetic entry has no JS
// error/stack — it's the best we can do for a manually-returned 5xx — but
// it still captures method, route, status, user id, and request id so the
// rotating log file is genuinely complete.
//
// We attach the listener exactly once per response and use a tiny try/catch
// so a logging hiccup can never break a real client response.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.on("finish", () => {
    try {
      if (res.statusCode < 500) return;
      const locals = res.locals as Record<string, unknown>;
      // The global error middleware sets this flag when it has already
      // recorded the failure with a real Error/stack — skip the synthetic
      // record so we don't double-count in the http5xx counter.
      if (locals._serverErrorRecorded) return;
      const userId =
        (req as unknown as { user?: { userId?: number } }).user?.userId ?? null;
      recordServerError({
        tag: "http_5xx",
        requestId: typeof locals.requestId === "string" ? locals.requestId : null,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        userId,
        // Synthetic marker — distinguishes "manual res.status(500).json(...)"
        // from "thrown error caught by global handler" in the persisted log.
        error: new Error(
          `manual_5xx_response (no error object available — route returned ${res.statusCode} without throwing)`,
        ),
      });
    } catch (hookErr) {
      console.error("[error-log] response-finish hook failed", hookErr);
    }
  });
  next();
});

// General rate limit — covers all /api/* routes against burst abuse.
// 200 req/min per IP is generous enough for a dashboard with auto-refresh queries.
app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please try again shortly." },
  })
);

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      // Log method, path, status, and duration only.
      // Response bodies are intentionally excluded — logging financial data
      // (balances, transactions, portfolio values) to stdout is a data-leak risk
      // and would fill logs with sensitive operational detail.
      log(`${req.method} ${path} ${res.statusCode} in ${duration}ms`);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  // ---------------------------------------------------------------------------
  // TASK #156 — Operator-alerts boot log
  // ---------------------------------------------------------------------------
  // Print whether the webhook is wired up the moment the server comes up,
  // so a misconfigured deployment is caught BEFORE the first real alert
  // fires (otherwise the operator would only learn the webhook was missing
  // at the exact moment it was needed). The helper hides the URL itself
  // and only logs the host + dedupe window + timeout.
  // ---------------------------------------------------------------------------
  const { logOperatorAlertsStartup } = await import("./services/operator-alerts");
  logOperatorAlertsStartup();

  // ---------------------------------------------------------------------------
  // SESSION 25 (Task #17) — Daily wallet ↔ ledger reconciliation
  // ---------------------------------------------------------------------------
  // LEDGER IS THE SOURCE OF TRUTH — wallet cache is derived only.
  //
  // Compares the cached wallet display balance against `SUM(ledger_entries)`
  // for every (userId, currency) pair we know about, on either side, and
  // writes one row per pair into `wallet_ledger_reconciliations` so the
  // admin Reconciliation page can show "the most recent check".
  //
  // This REPLACES the pre-existing `reconcileWalletBalances` cron, which
  // compared wallet balances against the *transactions* table — a weaker
  // check now that the ledger is the system of record. The new service
  // never mutates the ledger or the wallet cache; it only observes.
  // ---------------------------------------------------------------------------
  const { runWalletLedgerReconciliation } = await import("./services/reconciliation");
  // Task #79 — generic background-job run record. Each cron's tick is wrapped
  // in `withBackgroundJobRunRecord` so the admin "Background Jobs" page can
  // show a uniform "last run + overdue" view without grepping logs. The
  // existing job-specific tables (`fee_accrual_runs`, `operator_alert_prune_runs`)
  // are unchanged and continue to back their own surfaces.
  const { withBackgroundJobRunRecord } = await import("./services/background-jobs");

  async function runWalletReconciliation() {
    try {
      await withBackgroundJobRunRecord("wallet-ledger-reconciliation", async () => {
        const summary = await runWalletLedgerReconciliation();
        const line =
          `${summary.pairsChecked} pair(s), ${summary.matches} match, ` +
          `${summary.mismatches} mismatch, ${summary.alerts} alert, ` +
          `${summary.criticals} critical, ` +
          `${summary.operatorNotifications} operator notification(s) dispatched`;
        log(`[wallet-ledger-reconciliation] completed: ${line}`);
        return line;
      });
    } catch (e) {
      console.error("[wallet-ledger-reconciliation] cron error", e);
    }
  }

  setInterval(runWalletReconciliation, 24 * 60 * 60 * 1000);

  // ---------------------------------------------------------------------------
  // SESSION 8 — Daily ledger-vs-custodian reconciliation
  // ---------------------------------------------------------------------------
  // The other half of the verification picture: compares internal ledger
  // balances (SUM(ledger_entries) per user/currency) against external
  // custodian balances. Currently the custodian fetcher is a Phase 1 stub
  // that returns null, so every (user, currency) pair will be recorded as
  // "external_unavailable" — the "verification could not be performed"
  // status — until Session 9 wires the partner SDK. This is the *correct*
  // Phase 1 behaviour: we want the audit trail to show that we ATTEMPTED
  // verification and could not, rather than silently producing false matches.
  //
  // Staggered 60s after wallet reconciliation so the log streams are easy to
  // disambiguate when both run.
  // ---------------------------------------------------------------------------
  const { runLedgerReconciliation } = await import("./services/reconciliation");

  async function runLedgerReconciliationCron() {
    try {
      await withBackgroundJobRunRecord("ledger-reconciliation", async () => {
        const summary = await runLedgerReconciliation();
        const line =
          `${summary.pairsChecked} pair(s), ${summary.matches} match, ` +
          `${summary.mismatches} mismatch, ${summary.externalUnavailable} unavailable, ` +
          `${summary.alerts} alert, ${summary.criticals} critical`;
        log(`[ledger-reconciliation] completed: ${line}`);
        return line;
      });
    } catch (e) {
      console.error("[ledger-reconciliation] cron error", e);
    }
  }

  setTimeout(() => {
    void runLedgerReconciliationCron();
    setInterval(runLedgerReconciliationCron, 24 * 60 * 60 * 1000);
  }, 60 * 1000);

  // ---------------------------------------------------------------------------
  // SESSION 9.1 — Daily adviser-task automation
  // ---------------------------------------------------------------------------
  // Scans every active adviser-client link and creates open adviser_tasks
  // rows for three deterministic triggers:
  //   1. kyc_followup            — client.kycStatus !== 'verified'
  //   2. fee_consent_renewal     — active fee consent expiring within 30 days
  //   3. portfolio_review        — no portfolio_review created in last 90 days
  //
  // The cron is fully idempotent: re-running the same day will create zero
  // new tasks. Writes ONLY to adviser_tasks — no client-owned state mutated.
  // Staggered 120s after start so the three crons (wallet recon, ledger
  // recon, task automation) do not overlap on first boot.
  // ---------------------------------------------------------------------------
  const { runAdviserTaskAutomation } = await import("./services/adviser-task-automation");

  async function runAdviserTaskAutomationCron() {
    try {
      await withBackgroundJobRunRecord("adviser-task-automation", async () => {
        const s = await runAdviserTaskAutomation();
        // Aggregate skipped = open-task duplicates + 90-day cadence suppression.
        // We log both components so reviewers can tell idempotency hits from
        // quarterly-review cadence skips at a glance.
        const skipped = s.idempotencySkips + s.cadenceSkips;
        const line =
          `${s.linksScanned} link(s) scanned, ` +
          `${s.kycFollowupsCreated} kyc_followup, ` +
          `${s.feeConsentRenewalsCreated} fee_consent_renewal, ` +
          `${s.portfolioReviewsCreated} portfolio_review created, ` +
          `${skipped} skipped (idempotency=${s.idempotencySkips}, cadence=${s.cadenceSkips})`;
        log(`[adviser-task-automation] completed: ${line}`);
        return line;
      });
    } catch (e) {
      console.error("[adviser-task-automation] cron error", e);
    }
  }

  setTimeout(() => {
    void runAdviserTaskAutomationCron();
    setInterval(runAdviserTaskAutomationCron, 24 * 60 * 60 * 1000);
  }, 120 * 1000);

  // ---------------------------------------------------------------------------
  // SESSION 26 (Task #13) — Daily fee accrual sweep
  //   + SESSION 27 (Task #24) — Automatic backfill of missed UTC days
  // ---------------------------------------------------------------------------
  // Runs `runDailyAccruals` once per day for the current UTC date so the
  // adviser fee engine no longer relies on an admin pressing the "Run today's
  // accruals" button. Gate A invariants are unchanged: the service writes
  // ONLY to `adviser_fee_accruals` and never moves money or posts to the
  // ledger. The "Run today's accruals" admin trigger remains in place for
  // manual catch-up.
  //
  // Backfill behaviour (Task #24): if the server was offline across one or
  // more midnights (deploy, outage, maintenance), today's tick alone would
  // silently skip the missed dates. Instead, on every tick we look up the
  // most recent `accrualDate` already present in `adviser_fee_accruals` and
  // run the sweep for every UTC date between (latest + 1) and today
  // inclusive. The window is capped at FEE_ACCRUAL_BACKFILL_MAX_DAYS so a
  // pathologically long outage cannot trigger a runaway sweep — the oldest
  // missed days beyond the cap are dropped (admins can still hit them via
  // the manual "Run today's accruals" trigger).
  //
  // Idempotent by construction — `adviser_fee_accruals` has a unique index on
  // (`feeRuleId`, `accrualDate`), and `runDailyAccruals` returns explicit
  // `inserted` / `skipped` (gated rows) / `duplicates` counts. Re-running
  // for any date already swept is a no-op (everything counts as duplicate).
  //
  // Failures on a single date are caught and logged so the remaining dates
  // still get a chance to run; the next scheduled tick is the natural retry
  // for any date that fails today.
  //
  // Staggered 180s after start so the four daily crons (wallet recon, ledger
  // recon, adviser-task automation, fee accruals) don't pile up on first boot.
  // ---------------------------------------------------------------------------
  // Task #23 added `runDailyAccrualsAndRecord` — a thin wrapper that records
  // one row in `fee_accrual_runs` per invocation so admins can see the latest
  // run without scanning logs. We keep using it here (one record per date),
  // which means a backfill run produces one record per backfilled date —
  // exactly the audit trail admins need.
  const { runDailyAccrualsAndRecord, getLatestAccrualDate } = await import(
    "./services/fee-engine"
  );

  const FEE_ACCRUAL_BACKFILL_MAX_DAYS = 14;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function startOfUtcDay(d: Date): Date {
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    );
  }

  async function runDailyFeeAccrualsCronInner() {
    // Task #146 — kill switch. When fee_deductions is disabled, scheduled
    // accrual still represents fee work that operators have asked us to
    // stop. Bail with a single info-level summary line so the cron leaves
    // a clean trace in `background_job_runs` (instead of a blank pass that
    // looks identical to "no rules to accrue").
    const { isKillSwitchActive } = await import("./services/kill-switch");
    if (await isKillSwitchActive("fee_deductions")) {
      const note =
        "skipped: kill switch fee_deductions is engaged — no accruals run";
      log(`[fee-accruals] ${note}`);
      return note;
    }

    const today = startOfUtcDay(new Date());

    // Decide which UTC dates to run. Default: today only. If a previous
    // accrual exists and there's a gap, fill in every missed UTC date up to
    // today (capped). If the table is empty (first ever run) we don't try
    // to invent history — we just do today.
    let plannedDates: Date[] = [today];
    try {
      const latest = await getLatestAccrualDate();
      if (latest) {
        const latestDay = startOfUtcDay(latest);
        // Both operands are UTC-midnight Dates so the divison is an exact
        // integer; Math.floor makes the "calendar day count" intent obvious.
        const gapDays = Math.floor(
          (today.getTime() - latestDay.getTime()) / DAY_MS,
        );
        if (gapDays > 0) {
          const computed: Date[] = [];
          for (let i = 1; i <= gapDays; i++) {
            computed.push(new Date(latestDay.getTime() + i * DAY_MS));
          }
          // Keep the most recent N days if the gap exceeds the cap so the
          // catch-up still reaches `today`; older days fall off.
          plannedDates =
            computed.length > FEE_ACCRUAL_BACKFILL_MAX_DAYS
              ? computed.slice(computed.length - FEE_ACCRUAL_BACKFILL_MAX_DAYS)
              : computed;
        }
      }
    } catch (e) {
      console.error(
        "[fee-accruals] failed to determine backfill range; running today only",
        e,
      );
      plannedDates = [today];
    }

    let totalInserted = 0;
    let totalSkipped = 0;
    let totalDuplicates = 0;
    const totalsByGate: Record<string, number> = {};
    const datesRun: string[] = [];
    const datesFailed: string[] = [];

    for (const accrualDate of plannedDates) {
      const iso = accrualDate.toISOString().slice(0, 10);
      try {
        const s = await runDailyAccrualsAndRecord({
          accrualDate,
          trigger: "cron",
          triggeredByUserId: null,
        });
        totalInserted += s.inserted;
        totalSkipped += s.skipped;
        totalDuplicates += s.duplicates;
        for (const [k, v] of Object.entries(s.byGateReason)) {
          totalsByGate[k] = (totalsByGate[k] ?? 0) + v;
        }
        datesRun.push(iso);
      } catch (e) {
        // One failed date doesn't block the rest — the next scheduled tick
        // will retry it (idempotency + per-date transaction make that safe).
        // The recording wrapper already wrote a `fee_accrual_runs` row with
        // errorMessage set before re-throwing, so the failure is visible in
        // the admin UI too.
        console.error(`[fee-accruals] cron error for ${iso}`, e);
        datesFailed.push(iso);
      }
    }

    const gateBreakdown =
      Object.entries(totalsByGate)
        .map(([k, v]) => `${k}=${v}`)
        .join(",") || "none";
    const todayIso = today.toISOString().slice(0, 10);
    const failedSuffix =
      datesFailed.length > 0
        ? `, ${datesFailed.length} failed (${datesFailed.join(",")})`
        : "";

    // "today only" is reserved for the case where the cron PLANNED a single
    // tick (no backfill needed). If we planned multiple dates and only some
    // succeeded, we still report it as a backfill run so operators can see
    // the failed dates in the log line above.
    const plannedTodayOnly =
      plannedDates.length === 1 &&
      plannedDates[0].toISOString().slice(0, 10) === todayIso;

    let summaryLine: string;
    if (plannedTodayOnly) {
      summaryLine =
        `for ${todayIso} (today only): ` +
        `${totalInserted} inserted, ${totalSkipped} gated (${gateBreakdown}), ` +
        `${totalDuplicates} duplicate(s)${failedSuffix}`;
      log(`[fee-accruals] completed ${summaryLine}`);
    } else {
      const firstPlanned = plannedDates[0].toISOString().slice(0, 10);
      const lastPlanned = plannedDates[plannedDates.length - 1]
        .toISOString()
        .slice(0, 10);
      // "backfilled N" counts past-day catch-ups (i.e. planned dates other
      // than today), regardless of which actually succeeded — that matches
      // operator intent ("we attempted to fill N missed days").
      const backfilled = plannedDates.filter(
        (d) => d.toISOString().slice(0, 10) !== todayIso,
      ).length;
      summaryLine =
        `for ${firstPlanned}..${lastPlanned} (backfilled ${backfilled} day(s)): ` +
        `${totalInserted} inserted, ${totalSkipped} gated (${gateBreakdown}), ` +
        `${totalDuplicates} duplicate(s)${failedSuffix}`;
      if (datesRun.length > 0 || datesFailed.length > 0) {
        log(`[fee-accruals] completed ${summaryLine}`);
      }
    }
    return summaryLine;
  }

  // Outer wrapper so a clean per-tick summary lands in `background_job_runs`.
  // The inner function intentionally never throws (each per-date failure is
  // caught), so the wrapper records 'success' even on partial-failure ticks;
  // the summary string carries the failed-dates suffix in that case so the
  // dashboard still shows what went wrong.
  async function runDailyFeeAccrualsCron() {
    try {
      await withBackgroundJobRunRecord("fee-accruals", () =>
        runDailyFeeAccrualsCronInner(),
      );
    } catch (e) {
      console.error("[fee-accruals] cron error", e);
    }
  }

  setTimeout(() => {
    void runDailyFeeAccrualsCron();
    setInterval(runDailyFeeAccrualsCron, 24 * 60 * 60 * 1000);
  }, 180 * 1000);

  // ---------------------------------------------------------------------------
  // Task #44 — Daily operator-alert retention prune
  // ---------------------------------------------------------------------------
  // The `operator_alerts` table receives one row per dispatched alert (wallet
  // recon drifts, ledger recon drifts, webhook failures, etc.) and previously
  // had no retention policy. Left alone, it grows forever — fine for a few
  // weeks, painful after a year. This cron deletes rows older than the
  // retention window (default 180 days, override with the
  // OPERATOR_ALERT_RETENTION_DAYS env var) once per day.
  //
  // The DELETE is bounded by the existing `operator_alerts_created_at_idx`
  // index, so even on a large table it touches only the rows it needs to
  // remove. Outcomes (deleted count, cutoff, duration) are logged on stdout
  // for observability; we deliberately do NOT call notifyOperator from here,
  // as that would write a fresh row into the very table we are trying to
  // bound.
  //
  // Staggered 240s after start so it lands after the four other daily crons
  // (wallet recon, ledger recon, adviser-task automation, fee accruals) have
  // fired on first boot.
  // ---------------------------------------------------------------------------
  const {
    pruneOperatorAlertsAndRecord,
    checkOperatorAlertsPruneFreshness,
  } = await import("./services/operator-alerts-prune");

  async function runOperatorAlertsPruneCron() {
    try {
      // The recording wrapper writes one row to `operator_alert_prune_runs`
      // per attempt (success or failure) so the freshness watchdog below
      // has a durable signal to read. The wrapper still re-throws on
      // failure, preserving this try/catch's existing logging contract.
      // Task #79: also records a generic row in `background_job_runs` so the
      // admin "Background Jobs" page sees this job alongside the others.
      await withBackgroundJobRunRecord("operator-alerts-prune", async () => {
        const r = await pruneOperatorAlertsAndRecord();
        // r.prune is null only when the call threw, in which case the
        // wrapper has already re-thrown — by the time we reach this line
        // it must be populated.
        const p = r.prune!;
        return `${p.deleted} deleted, retention=${p.retentionDays}d, ${p.durationMs}ms`;
      });
    } catch (e) {
      console.error("[operator-alerts-prune] cron error", e);
    }
  }

  setTimeout(() => {
    void runOperatorAlertsPruneCron();
    setInterval(runOperatorAlertsPruneCron, 24 * 60 * 60 * 1000);
  }, 240 * 1000);

  // ---------------------------------------------------------------------------
  // TASK #60 — Stalled-prune watchdog
  // ---------------------------------------------------------------------------
  // The prune above is fire-and-forget; if it silently stops running
  // (deploy that crashes the cron, env-var typo that throws on every tick,
  // a future refactor that drops the setInterval entirely), the
  // `operator_alerts` table starts growing again and nobody notices until
  // it is huge.
  //
  // This watchdog dispatches a `notifyOperator` warning whenever no
  // successful prune has been recorded for more than 2× the expected
  // interval (= 48h). It runs independently of the prune cron above:
  //   * Its own setTimeout/setInterval pair, so a broken prune cron
  //     scheduler cannot also disable the watchdog scheduler.
  //   * It only READS from `operator_alert_prune_runs`, so even a prune
  //     that throws on every tick (and therefore writes only 'error' rows
  //     or no rows at all) will leave a stale "most recent success"
  //     timestamp the watchdog will detect.
  //
  // Frequency: once per day is plenty — the threshold is 48h, so checking
  // hourly would only re-fire the same alert without adding signal. We
  // stagger 300s after start so the four other daily crons have a chance
  // to settle first.
  // ---------------------------------------------------------------------------
  async function runOperatorAlertsPruneWatchdog() {
    try {
      await withBackgroundJobRunRecord("operator-alerts-prune-watchdog", async () => {
        const result = await checkOperatorAlertsPruneFreshness();
        if (result.fired) {
          log(
            `[operator-alerts-prune-watchdog] alerted: reason=${result.reason}, ` +
              `mostRecentSuccessAt=${result.mostRecentSuccessAt?.toISOString() ?? "none"}, ` +
              `ageMs=${result.ageMs ?? "n/a"}, thresholdMs=${result.thresholdMs}`,
          );
          return `alert fired: reason=${result.reason}`;
        }
        return `ok (mostRecentSuccessAt=${result.mostRecentSuccessAt?.toISOString() ?? "none"})`;
      });
    } catch (e) {
      console.error("[operator-alerts-prune-watchdog] watchdog error", e);
    }
  }

  setTimeout(() => {
    void runOperatorAlertsPruneWatchdog();
    setInterval(runOperatorAlertsPruneWatchdog, 24 * 60 * 60 * 1000);
  }, 300 * 1000);

  // ---------------------------------------------------------------------------
  // Task #64 — Daily insufficient-funds re-check + client notification sweep
  // ---------------------------------------------------------------------------
  // Walks every adviser fee deduction parked in `insufficient_funds` (Task
  // #34) and re-attempts settlement against the current ledger balance. Rows
  // whose client has since topped up settle on this pass; rows still short
  // trigger a debounced "your fee couldn't be deducted" notification so the
  // client can act without waiting for an adviser to chase them.
  //
  // Idempotency is inherited from settleApprovedDeduction's deterministic
  // idempotency key (`fee_deduction_<id>`) — the cron and an admin's manual
  // approve click cannot double-post even if they race. Per-row failures are
  // caught inside the sweep so one bad deduction never aborts the rest.
  //
  // Staggered 360s after start so it lands AFTER all five other daily crons
  // (wallet recon, ledger recon, adviser-task automation, fee accruals, the
  // operator-alerts prune at 240s, and the prune-watchdog at 300s introduced
  // by Task #60). We deliberately want this to run AFTER the fee-accruals
  // cron so any deduction that flipped to insufficient_funds in the morning
  // settle pass has had its tracking columns initialised before the sweep
  // visits it.
  // ---------------------------------------------------------------------------
  const { runInsufficientFundsSweep } = await import(
    "./services/insufficient-funds-sweep"
  );

  async function runInsufficientFundsSweepCron() {
    try {
      // Output line + audit logs are written by the service itself; the cron
      // wrapper only needs to swallow errors so a single failure doesn't
      // crash the server.
      await withBackgroundJobRunRecord("insufficient-funds-sweep", async () => {
        // Task #146 — kill switch. Mirror the fee-accruals cron skip:
        // emit an explicit, recognisable summary line so operators can
        // tell "we skipped because the switch is engaged" apart from
        // "we ran and there was nothing to do" in background_job_runs.
        // The service itself also bails to be safe for any non-cron
        // caller, but the cron summary is what shows in the dashboard.
        const { isKillSwitchActive } = await import(
          "./services/kill-switch"
        );
        if (await isKillSwitchActive("fee_deductions")) {
          const note =
            "skipped: kill switch fee_deductions is engaged — no settlements attempted";
          log(`[insufficient-funds-sweep] ${note}`);
          return note;
        }
        const r = await runInsufficientFundsSweep();
        // The service returns a structured summary; surface the key counts so
        // the dashboard's "summary" cell tells operators what happened.
        const parts: string[] = [];
        if (r && typeof r === "object") {
          for (const [k, v] of Object.entries(r)) {
            if (typeof v === "number") parts.push(`${k}=${v}`);
          }
        }
        return parts.length > 0 ? parts.join(", ") : "completed";
      });
    } catch (e) {
      console.error("[insufficient-funds-sweep] cron error", e);
    }
  }

  setTimeout(() => {
    void runInsufficientFundsSweepCron();
    setInterval(runInsufficientFundsSweepCron, 24 * 60 * 60 * 1000);
  }, 360 * 1000);

  // ---------------------------------------------------------------------------
  // Task #63 — Posting-receipt invariant guard
  // ---------------------------------------------------------------------------
  // Self-healing replacement for the manual "re-run
  // scripts/backfill-ledger-postings.ts" runbook step. Compares the count of
  // distinct transactionIds with ledger entries against the count of
  // receipt rows in `ledger_postings`. Any divergence pages an operator via
  // notifyOperator(), naming a sample of the missing transactionIds so ops
  // know which environment to backfill.
  //
  // Runs once shortly after boot (so a deploy that forgot the runbook step
  // is caught within seconds), then daily. The check is read-only — it
  // never mutates the ledger or the receipt table; the remediation is to
  // run the backfill script.
  //
  // Staggered 30s after boot (long before the other crons) so a misconfigured
  // environment is flagged before the first wallet-recon tick papers over it
  // by writing fresh reconciliation rows.
  // ---------------------------------------------------------------------------
  const { runPostingReceiptInvariantCheck } = await import(
    "./services/posting-receipt-invariant"
  );

  async function runPostingReceiptInvariantCron() {
    try {
      await withBackgroundJobRunRecord("posting-receipt-invariant", async () => {
      const r = await runPostingReceiptInvariantCheck();
      // Treat ANY non-zero divergence as such in the log (matches the
      // alert dispatch logic, which fires in both directions). Negative
      // missingCount means orphan receipts — entries deleted out-of-band —
      // and is just as alert-worthy as missing receipts, so the log line
      // must not call it "ok".
      if (r.missingCount > 0) {
        log(
          `[posting-receipt-invariant] DIVERGENCE (missing receipts): ` +
            `${r.txWithEntries} tx with entries, ${r.receipts} receipts, ` +
            `${r.missingCount} missing — alertDispatched=${r.alertDispatched} ` +
            `(${r.durationMs}ms)`,
        );
      } else if (r.missingCount < 0) {
        log(
          `[posting-receipt-invariant] DIVERGENCE (orphan receipts): ` +
            `${r.txWithEntries} tx with entries, ${r.receipts} receipts, ` +
            `${Math.abs(r.missingCount)} orphan — alertDispatched=${r.alertDispatched} ` +
            `(${r.durationMs}ms)`,
        );
      } else {
        log(
          `[posting-receipt-invariant] ok: ${r.txWithEntries} tx with entries == ` +
            `${r.receipts} receipts (${r.durationMs}ms)`,
        );
      }
      // Compact summary for the Background Jobs dashboard.
      if (r.missingCount > 0) {
        return `DIVERGENCE: ${r.missingCount} missing receipt(s), tx=${r.txWithEntries}, receipts=${r.receipts}`;
      }
      if (r.missingCount < 0) {
        return `DIVERGENCE: ${Math.abs(r.missingCount)} orphan receipt(s), tx=${r.txWithEntries}, receipts=${r.receipts}`;
      }
      return `ok: ${r.txWithEntries} tx == ${r.receipts} receipts`;
      });
    } catch (e) {
      console.error("[posting-receipt-invariant] cron error", e);
    }
  }

  setTimeout(() => {
    void runPostingReceiptInvariantCron();
    setInterval(runPostingReceiptInvariantCron, 24 * 60 * 60 * 1000);
  }, 30 * 1000);

  // ---------------------------------------------------------------------------
  // TASK #145 — Stuck pending transactions watch (hourly)
  // ---------------------------------------------------------------------------
  // Runs once per hour. The check is read-only against `transactions` and
  // dispatches one ack-suppressible operator alert per stable "set of stuck
  // ids". Wrapped in `withBackgroundJobRunRecord` so the admin Background
  // Jobs page sees this job alongside the others.
  // ---------------------------------------------------------------------------
  const { runStuckPendingTransactionsCheck } = await import(
    "./services/stuck-pending-transactions"
  );

  async function runStuckPendingTransactionsCron() {
    try {
      await withBackgroundJobRunRecord("stuck-pending-transactions", async () => {
        const r = await runStuckPendingTransactionsCheck();
        if (r.stuckCount === 0) {
          return `ok: 0 stuck (threshold=${r.thresholdMinutes}m)`;
        }
        return (
          `${r.stuckCount} stuck (threshold=${r.thresholdMinutes}m), ` +
          `alerted=${r.alerted}, suppressed=${r.suppressed}`
        );
      });
    } catch (e) {
      console.error("[stuck-pending-transactions] cron error", e);
    }
  }

  setTimeout(() => {
    void runStuckPendingTransactionsCron();
    setInterval(runStuckPendingTransactionsCron, 60 * 60 * 1000);
  }, 360 * 1000);

  // ---------------------------------------------------------------------------
  // TASK #145 — DB connection health watcher
  // ---------------------------------------------------------------------------
  // Independent setInterval: pings the DB on a fixed cadence and dispatches
  // an operator alert when N consecutive pings have failed within an
  // M-second window. Deliberately NOT wrapped in `withBackgroundJobRunRecord`
  // — the recorder itself writes to the DB; if connectivity is broken, the
  // recorder write would throw and mask the alert we are trying to fire.
  // ---------------------------------------------------------------------------
  const { startDbHealthWatcher } = await import("./services/db-health-watcher");
  startDbHealthWatcher();

  // -------------------------------------------------------------------------
  // Task #147 — Database backup, restore drill, and watchdog crons.
  //
  // All three are gated on `isBackupsEnabled()` (i.e. DB_BACKUP_DIR set) so
  // a dev environment with no backup directory does not spam an
  // operator-paged watchdog every day. The schedules are staggered after the
  // existing crons (30..360s) so process startup never tries to run more
  // than one heavy job at once:
  //
  //   * 420s + daily   — pg_dump backup with retention prune.
  //   * 480s + weekly  — restore-drill into a scratch DB.
  //   * 540s + daily   — freshness watchdog (read-only; pages an operator
  //                      if either of the two above has gone stale).
  //
  // Each cron wrapper records a generic `background_job_runs` row through
  // `withBackgroundJobRunRecord`; the service layer ALSO records a typed
  // row in `database_backup_runs` / `database_restore_drill_runs`. The two
  // tables intentionally double up — the generic table powers the
  // background-jobs admin page (uniform across all jobs), the typed tables
  // power the dashboard "Backup health" tile and surface domain-specific
  // detail like dump path and per-check integrity-result.
  // -------------------------------------------------------------------------
  const {
    runDatabaseBackup,
    runDatabaseRestoreDrill,
    checkBackupFreshness,
    isBackupsEnabled,
  } = await import("./services/database-backups");

  if (isBackupsEnabled()) {
    // const-arrow-function form (not function-declaration) so TypeScript's
    // strict-mode rule that bans block-scoped function declarations under
    // an ES5 target stays happy.
    const runDatabaseBackupCron = async () => {
      try {
        await withBackgroundJobRunRecord("database-backup", async () => {
          const r = await runDatabaseBackup();
          const sizeMb = (r.dumpSizeBytes / (1024 * 1024)).toFixed(2);
          return `dump=${r.dumpPath} size=${sizeMb}MiB pruned=${r.prunedCount} duration=${r.durationMs}ms`;
        });
      } catch (e) {
        console.error("[database-backup] cron error", e);
      }
    };

    const runDatabaseRestoreDrillCron = async () => {
      try {
        await withBackgroundJobRunRecord("database-restore-drill", async () => {
          const r = await runDatabaseRestoreDrill();
          const failed = r.integrity.checks.filter((c) => !c.ok).length;
          return `dump=${r.dumpPath} scratch=${r.scratchDbName} checks=${r.integrity.checks.length} failed=${failed} duration=${r.durationMs}ms`;
        });
      } catch (e) {
        console.error("[database-restore-drill] cron error", e);
      }
    };

    const runDatabaseBackupWatchdog = async () => {
      try {
        await withBackgroundJobRunRecord("database-backup-watchdog", async () => {
          const r = await checkBackupFreshness();
          if (r.fired) {
            console.warn(
              `[database-backup-watchdog] alerted: reasons=${r.reasons.join(",")}` +
                `, alertId=${r.alertId ?? "<n/a>"}`,
            );
            return `STALE: ${r.reasons.join(",")}`;
          }
          return `fresh: ${r.reasons.join(",")}`;
        });
      } catch (e) {
        console.error("[database-backup-watchdog] watchdog error", e);
      }
    };

    setTimeout(() => {
      void runDatabaseBackupCron();
      setInterval(runDatabaseBackupCron, 24 * 60 * 60 * 1000);
    }, 420 * 1000);

    setTimeout(() => {
      void runDatabaseRestoreDrillCron();
      setInterval(runDatabaseRestoreDrillCron, 7 * 24 * 60 * 60 * 1000);
    }, 480 * 1000);

    setTimeout(() => {
      void runDatabaseBackupWatchdog();
      setInterval(runDatabaseBackupWatchdog, 24 * 60 * 60 * 1000);
    }, 540 * 1000);
  } else {
    // Make the skip visible at boot — silent skipping makes "why are there no
    // backups happening?" investigations much harder.
    console.log(
      "[database-backup] DB_BACKUP_DIR is not set; daily backup, weekly restore drill, and watchdog crons are NOT registered.",
    );
  }

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    // Expose the original message for 4xx client errors; hide internals for 5xx.
    const message = status < 500 ? (err.message || "Request failed") : "Internal Server Error";

    // Log 5xx errors internally before responding (never after — that causes
    // "Cannot set headers after they are sent" crashes). Task #144: every
    // 5xx is also written to the rotating `logs/errors.log` file so a
    // post-mortem after a restart still has the request id, route, user id,
    // and stack — the in-memory dev console alone is not enough for a
    // production wealth platform.
    if (status >= 500) {
      const locals = res.locals as Record<string, unknown>;
      const requestId = locals.requestId as string | undefined;
      // `req.user` is set by the JWT middleware in routes.ts; we read it
      // defensively so a 5xx from an unauthenticated route still records
      // cleanly. Using the loose `any` cast avoids importing the auth type
      // here just to read an optional field.
      const userId =
        (req as unknown as { user?: { userId?: number } }).user?.userId ?? null;
      recordServerError({
        tag: "http_5xx",
        requestId: requestId ?? null,
        method: req.method,
        path: req.originalUrl,
        status,
        userId,
        error: err,
      });
      // Tell the response-finish sniffer (registered above) that this 5xx
      // has already been persisted with a real error/stack — without this
      // the sniffer would record a second synthetic entry on `finish`.
      locals._serverErrorRecorded = true;
    }

    res.status(status).json({ message });
    // Do NOT re-throw here: the response is already sent. Re-throwing causes
    // Express to crash the request cycle and can trigger the unhandled-rejection
    // handler, producing duplicate error logs and broken client responses.
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on port 5000
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = 5000;
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  });
})();
