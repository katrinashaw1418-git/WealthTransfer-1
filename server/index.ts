import express, { type Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";

const app = express();
app.set("trust proxy", 1); // Trust first proxy hop (Replit's reverse proxy sets X-Forwarded-For)
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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

  async function runWalletReconciliation() {
    try {
      const summary = await runWalletLedgerReconciliation();
      log(
        `[wallet-ledger-reconciliation] completed: ${summary.pairsChecked} pair(s), ` +
          `${summary.matches} match, ${summary.mismatches} mismatch, ` +
          `${summary.alerts} alert, ${summary.criticals} critical, ` +
          `${summary.operatorNotifications} operator notification(s) dispatched`
      );
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
      const summary = await runLedgerReconciliation();
      log(
        `[ledger-reconciliation] completed: ${summary.pairsChecked} pair(s), ` +
          `${summary.matches} match, ${summary.mismatches} mismatch, ` +
          `${summary.externalUnavailable} unavailable, ` +
          `${summary.alerts} alert, ${summary.criticals} critical`
      );
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
      const s = await runAdviserTaskAutomation();
      // Aggregate skipped = open-task duplicates + 90-day cadence suppression.
      // We log both components so reviewers can tell idempotency hits from
      // quarterly-review cadence skips at a glance.
      const skipped = s.idempotencySkips + s.cadenceSkips;
      log(
        `[adviser-task-automation] completed: ${s.linksScanned} link(s) scanned, ` +
          `${s.kycFollowupsCreated} kyc_followup, ` +
          `${s.feeConsentRenewalsCreated} fee_consent_renewal, ` +
          `${s.portfolioReviewsCreated} portfolio_review created, ` +
          `${skipped} skipped (idempotency=${s.idempotencySkips}, cadence=${s.cadenceSkips})`
      );
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

  async function runDailyFeeAccrualsCron() {
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

    if (plannedTodayOnly) {
      log(
        `[fee-accruals] completed for ${todayIso} (today only): ` +
          `${totalInserted} inserted, ${totalSkipped} gated (${gateBreakdown}), ` +
          `${totalDuplicates} duplicate(s)${failedSuffix}`,
      );
    } else if (datesRun.length > 0 || datesFailed.length > 0) {
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
      log(
        `[fee-accruals] completed for ${firstPlanned}..${lastPlanned} ` +
          `(backfilled ${backfilled} day(s)): ` +
          `${totalInserted} inserted, ${totalSkipped} gated (${gateBreakdown}), ` +
          `${totalDuplicates} duplicate(s)${failedSuffix}`,
      );
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
      await pruneOperatorAlertsAndRecord();
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
      const result = await checkOperatorAlertsPruneFreshness();
      if (result.fired) {
        log(
          `[operator-alerts-prune-watchdog] alerted: reason=${result.reason}, ` +
            `mostRecentSuccessAt=${result.mostRecentSuccessAt?.toISOString() ?? "none"}, ` +
            `ageMs=${result.ageMs ?? "n/a"}, thresholdMs=${result.thresholdMs}`,
        );
      }
    } catch (e) {
      console.error("[operator-alerts-prune-watchdog] watchdog error", e);
    }
  }

  setTimeout(() => {
    void runOperatorAlertsPruneWatchdog();
    setInterval(runOperatorAlertsPruneWatchdog, 24 * 60 * 60 * 1000);
  }, 300 * 1000);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    // Expose the original message for 4xx client errors; hide internals for 5xx.
    const message = status < 500 ? (err.message || "Request failed") : "Internal Server Error";

    // Log 5xx errors internally before responding (never after — that causes
    // "Cannot set headers after they are sent" crashes).
    if (status >= 500) console.error("[server error]", err);

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
