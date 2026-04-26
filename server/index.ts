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
  // Daily wallet-balance reconciliation (PRE-EXISTING, internal-only)
  // ---------------------------------------------------------------------------
  // Compares each user's cached wallet display balance against the sum of
  // their transactions. Catches drift between the legacy wallet-balance cache
  // and the transaction history. Internal-only — does not touch external
  // custodian feeds.
  // ---------------------------------------------------------------------------
  const { db: cronDb } = await import("./db");
  const { users: usersTable } = await import("@shared/schema");
  const { reconcileWalletBalances } = await import("./routes");

  async function runWalletReconciliation() {
    try {
      const allUsers = await cronDb.select({ id: usersTable.id }).from(usersTable);
      for (const user of allUsers) {
        await reconcileWalletBalances(user.id, new Date()).catch((e: any) =>
          console.error(`[wallet-reconciliation] failed for userId=${user.id}`, e)
        );
      }
      log(`[wallet-reconciliation] completed for ${allUsers.length} user(s)`);
    } catch (e) {
      console.error("[wallet-reconciliation] cron error", e);
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
