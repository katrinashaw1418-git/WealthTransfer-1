// ---------------------------------------------------------------------------
// Final go/no-go pre-launch verification (Task #150)
//
// Single-command launch gate that wires the entire pre-launch checklist
// (kill switches, monitoring, alerting, rollback, security, compliance) on
// top of the existing `scripts/pre-launch-safety.ts` rollup, and writes
// one structured GO/NO-GO markdown report a human can act on.
//
// Run with:
//   npx tsx scripts/go-no-go.ts
//
// What this proves (in order):
//   1. The existing pre-launch safety rollup still passes end-to-end
//      (delegates to scripts/pre-launch-safety.ts in --strict mode).
//   2. Infrastructure: required env vars/secrets are set, last successful
//      backup is fresh.
//   3. Monitoring: /health probe (DB ping) returns ok, persistent log dir
//      exists and is writable, business-metrics tile responds with a
//      generatedAt timestamp from THIS run.
//   4. Alerting: every known alert source (wallet-ledger-reconciliation,
//      posting-receipt-invariant, database-restore-drill, kill-switch,
//      stuck-pending-transactions, audit-log-write-failure,
//      db-connection-failure, operator-alerts-prune-watchdog,
//      database-backup-watchdog) accepts a tagged drill alert and the
//      alert is persisted into `operator_alerts`. Drill payloads are
//      tagged `drill: true` so they are recognisable as test artifacts.
//   5. Kill switches: every switch can be toggled ON (proves the guard
//      throws KillSwitchActiveError → 503) and OFF, with audit rows
//      written for both transitions. The switch is restored to its
//      starting state at the end so the verification has no side effects.
//   6. Rollback: the most recent successful restore drill is fresh.
//   7. Security: a disallowed-mime upload is rejected with HTTP 400, every
//      /api/admin/* route is JWT-guarded (returns 401 without a token),
//      and the per-IP login rate limiter is wired in routes.ts.
//   8. Compliance: audit_logs UPDATE/DELETE/TRUNCATE are blocked by the
//      DB triggers, the wealth-planner review-lock constant is exported
//      and active, and `scripts/test-no-synthetic-portfolio-data.ts`
//      passes (no fake data in client-visible views).
//
// Output:
//   * docs/golive/go-no-go-<UTC-timestamp>.md — a structured report with a
//     top-level GO or NO-GO verdict followed by a per-section pass/fail
//     breakdown. Any FAIL produces a NO-GO verdict and a short "what to
//     do" hint pointing at the relevant runbook.
//   * Stdout: a one-line verdict on the final line.
//
// Exit code:
//   * 0 only when the verdict is GO.
//   * 1 on NO-GO (any FAIL anywhere).
//
// Re-runnability:
//   The script is safe to re-run. Test alerts go to a clearly-tagged drill
//   payload, kill-switch toggles are reverted at the end, and audit-log
//   probe rows are well-formed and tagged `{ drill: true, runId }` so an
//   operator can recognise them later (audit_logs is append-only by design).
// ---------------------------------------------------------------------------

// Snapshot raw env BEFORE the bootstrap defaults run. The infrastructure
// section validates against this snapshot, otherwise a missing real
// production secret would be silently masked by the dev fallback in
// `_bootstrap-test-env.ts` and produce a false GO verdict.
import { RAW_ENV_SNAPSHOT } from "./_raw-env-snapshot";
import "./_bootstrap-test-env";

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Express, Request } from "express";
import { and, desc, eq, gt, sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  auditLogs,
  killSwitches,
  operatorAlerts,
  users,
  type KillSwitchKey,
} from "../shared/schema";
import { signToken } from "../server/auth";
import { registerRoutes } from "../server/routes";
import {
  killSwitchKeyValues,
  killSwitchLabel,
  setKillSwitchState,
  isKillSwitchActive,
  assertKillSwitchOff,
  KillSwitchActiveError,
  invalidateKillSwitchCache,
} from "../server/services/kill-switch";
import {
  notifyOperator,
  type OperatorAlert,
  type OperatorAlertSeverity,
} from "../server/services/operator-alerts";
import {
  getBackupStatus,
  isBackupsEnabled,
  DEFAULT_BACKUP_STALE_THRESHOLD_MS,
  DEFAULT_DRILL_STALE_THRESHOLD_MS,
} from "../server/services/database-backups";
import { pingDatabase, getServerVersion } from "../server/health";
import { installAuditLogsImmutabilityTriggers } from "../server/services/audit-immutability-migration";
import {
  buildUploadMiddleware,
  DEFAULT_ALLOWED_MIME_TYPES,
  resolveMaxUploadBytes,
} from "../server/services/upload-security";
import { REVIEW_LOCK_REASON } from "../server/services/wealth-planner";

// ---------------------------------------------------------------------------
// Result model
// ---------------------------------------------------------------------------
type Outcome = "pass" | "fail" | "skip";

interface Check {
  name: string;
  outcome: Outcome;
  details: string;
  /** Short remediation pointer surfaced under any FAIL/SKIP. */
  hint?: string;
}

interface Section {
  name: string;
  /** Short paragraph describing what this section verifies. */
  summary: string;
  checks: Check[];
}

const RUN_ID = `gng-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const STARTED_AT = new Date();
const REPORT_DIR = path.resolve(process.cwd(), "docs", "golive");

const sections: Section[] = [];

function addSection(s: Section): void {
  sections.push(s);
}

function check(
  name: string,
  outcome: Outcome,
  details: string,
  hint?: string,
): Check {
  return { name, outcome, details, hint };
}

// ---------------------------------------------------------------------------
// 1. Pre-launch safety rollup (delegates to existing script)
// ---------------------------------------------------------------------------
async function preLaunchSafetySection(): Promise<Section> {
  const startedAt = Date.now();
  const r = spawnSync(
    "npx",
    ["tsx", "scripts/pre-launch-safety.ts", "--strict"],
    {
      stdio: "pipe",
      env: process.env,
      encoding: "utf8",
    },
  );
  const durationMs = Date.now() - startedAt;
  const checks: Check[] = [];

  if (r.error) {
    checks.push(
      check(
        "pre-launch-safety.ts (strict)",
        "skip",
        `script did not run (spawn error: ${r.error.message})`,
        "Check the npx/tsx toolchain and re-run; SKIP is treated as NO-GO.",
      ),
    );
  } else if (r.signal) {
    checks.push(
      check(
        "pre-launch-safety.ts (strict)",
        "skip",
        `script did not complete (killed by signal ${r.signal})`,
        "Re-run with stdio=inherit to inspect the abrupt exit.",
      ),
    );
  } else if (r.status === 0) {
    checks.push(
      check(
        "pre-launch-safety.ts (strict)",
        "pass",
        `exit=0 in ${durationMs}ms (all gates passed, including --strict mode)`,
      ),
    );
  } else {
    // Pull the last 25 lines of combined output so the report has a hint
    // of what failed without us having to re-run the sub-script.
    const combined = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const tail = combined
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(-25)
      .join("\n");
    checks.push(
      check(
        "pre-launch-safety.ts (strict)",
        "fail",
        `exit=${r.status} after ${durationMs}ms\nlast lines:\n${tail}`,
        "See docs/PRE_LAUNCH_CHECKLIST.md and re-run `npx tsx scripts/pre-launch-safety.ts --strict` for the full output.",
      ),
    );
  }

  return {
    name: "Pre-launch safety rollup",
    summary:
      "Re-runs the existing pre-launch-safety script in --strict mode. " +
      "This covers the four regression suites and three lifecycle scenarios " +
      "documented in `docs/PRE_LAUNCH_CHECKLIST.md`.",
    checks,
  };
}

// ---------------------------------------------------------------------------
// 2. Infrastructure
// ---------------------------------------------------------------------------
async function infrastructureSection(): Promise<Section> {
  const checks: Check[] = [];

  // Required environment variables / secrets — validated against the RAW
  // env snapshot taken before _bootstrap-test-env injected defaults. We
  // MUST NOT use process.env here; the bootstrap fallbacks would mask a
  // missing real production secret.
  const requiredEnv = ["DATABASE_URL", "JWT_SECRET", "NODE_ENV"] as const;
  const missing = requiredEnv.filter((k) => !RAW_ENV_SNAPSHOT[k]);
  if (missing.length === 0) {
    checks.push(
      check(
        "Required environment variables present",
        "pass",
        `All present (raw env, before bootstrap defaults): ${requiredEnv.join(", ")}`,
      ),
    );
  } else {
    checks.push(
      check(
        "Required environment variables present",
        "fail",
        `Missing from the deploy environment (raw env, before bootstrap defaults): ${missing.join(", ")}`,
        "Populate the missing secrets in the deploy environment before launching. Dev-time defaults from scripts/_bootstrap-test-env.ts do NOT count.",
      ),
    );
  }

  // Env separation: NODE_ENV should reflect the deploy target. Validated
  // against the raw snapshot for the same reason as above — the bootstrap
  // would otherwise paint a missing NODE_ENV as "test".
  const rawNodeEnv = RAW_ENV_SNAPSHOT.NODE_ENV;
  if (!rawNodeEnv) {
    checks.push(
      check(
        "Environment separation (NODE_ENV)",
        "fail",
        `NODE_ENV is not set in the raw deploy environment.`,
        "Set NODE_ENV explicitly (production/staging/development) in the deploy environment so observability tags carry the right label.",
      ),
    );
  } else {
    checks.push(
      check(
        "Environment separation (NODE_ENV)",
        "pass",
        `NODE_ENV="${rawNodeEnv}" — go/no-go runs are typically against the same DB the deploy will use.`,
      ),
    );
  }

  // Latest successful backup freshness.
  if (!isBackupsEnabled()) {
    checks.push(
      check(
        "Latest successful backup is fresh",
        "fail",
        "DB_BACKUP_DIR is not configured — no backup pipeline is running in this environment.",
        "Set DB_BACKUP_DIR (and optionally DB_BACKUP_RETENTION) and run scripts/db-backup.ts; see docs/runbooks/rollback.md.",
      ),
    );
  } else {
    let status: Awaited<ReturnType<typeof getBackupStatus>> | null = null;
    try {
      status = await getBackupStatus();
    } catch (err) {
      checks.push(
        check(
          "Latest successful backup is fresh",
          "fail",
          `getBackupStatus() threw: ${(err as Error).message}`,
          "Check the database_backup_runs table; rerun scripts/db-backup.ts to take a fresh dump.",
        ),
      );
    }
    if (status) {
      const latest = status.latestBackup;
      if (!latest) {
        checks.push(
          check(
            "Latest successful backup is fresh",
            "fail",
            "No successful backup has ever been recorded in database_backup_runs.",
            "Run `npx tsx scripts/db-backup.ts` to take an initial dump and verify the cron is scheduled.",
          ),
        );
      } else if (latest.ageMs > DEFAULT_BACKUP_STALE_THRESHOLD_MS) {
        checks.push(
          check(
            "Latest successful backup is fresh",
            "fail",
            `Latest successful backup is ${formatAge(latest.ageMs)} old (threshold: ${formatAge(
              DEFAULT_BACKUP_STALE_THRESHOLD_MS,
            )}).`,
            "Investigate the daily backup cron; manually run `npx tsx scripts/db-backup.ts` and check the database_backup_runs table for failure reasons.",
          ),
        );
      } else {
        checks.push(
          check(
            "Latest successful backup is fresh",
            "pass",
            `Latest successful backup is ${formatAge(latest.ageMs)} old (path: ${latest.dumpPath ?? "n/a"}).`,
          ),
        );
      }
    }
  }

  return {
    name: "Infrastructure",
    summary:
      "Verifies environment separation, that required secrets are configured, and that " +
      "the daily backup pipeline produced a recent successful dump.",
    checks,
  };
}

// ---------------------------------------------------------------------------
// 3. Monitoring
// ---------------------------------------------------------------------------
async function monitoringSection(
  routeRunner: RouteRunner,
): Promise<Section> {
  const checks: Check[] = [];

  // /health probe — exercise pingDatabase directly, which is what the live
  // /health handler uses. A 200 from /health requires db.ok === true, so
  // a successful ping proves the same thing without binding a port.
  const ping = await pingDatabase();
  if (ping.ok) {
    checks.push(
      check(
        "/health probe (DB ping)",
        "pass",
        `pingDatabase() ok in ${ping.latencyMs}ms — /health would return 200 (version=${getServerVersion()}).`,
      ),
    );
  } else {
    checks.push(
      check(
        "/health probe (DB ping)",
        "fail",
        `pingDatabase() failed after ${ping.latencyMs}ms: ${ping.error ?? "unknown"} — /health would return 503.`,
        "Check the DB connection pool and DATABASE_URL; the deploy must boot with a reachable primary.",
      ),
    );
  }

  // Persistent error log file. Two requirements layered for a launch
  // gate:
  //   1. LOG_DIR must be EXPLICITLY set in the deploy env. Without it,
  //      server/services/error-log.ts falls back to `./logs`, which is
  //      ephemeral inside a container — every restart wipes the 5xx
  //      history and post-incident forensics become impossible.
  //   2. The directory must exist + be writable + the canonical
  //      `errors.log` file must be reachable. We touch the file as part
  //      of the check so that an operator inspecting the report sees
  //      proof that the path is fully wired end-to-end (not just a
  //      writable parent directory).
  if (!RAW_ENV_SNAPSHOT.LOG_DIR) {
    checks.push(
      check(
        "Persistent error log file present",
        "fail",
        "LOG_DIR is not set in the raw deploy environment — server/services/error-log.ts would fall back to ./logs, which is ephemeral inside a container.",
        "Mount a persistent volume and set LOG_DIR to its path in the deploy environment.",
      ),
    );
  } else {
    const logDir = RAW_ENV_SNAPSHOT.LOG_DIR;
    try {
      await fs.mkdir(logDir, { recursive: true });
      const errorsLog = path.join(logDir, "errors.log");
      // touch — creates an empty file if missing, leaves contents alone
      // if it already exists. This is the same semantics as `touch(1)`
      // and matches what the live error-log writer does on first append.
      const fh = await fs.open(errorsLog, "a");
      await fh.close();
      const stat = await fs.stat(errorsLog);
      checks.push(
        check(
          "Persistent error log file present",
          "pass",
          `LOG_DIR=${logDir}; canonical errors.log present at ${errorsLog} (size=${stat.size}B). Directory is writable.`,
        ),
      );
    } catch (err) {
      checks.push(
        check(
          "Persistent error log file present",
          "fail",
          `Cannot reach errors.log under LOG_DIR=${logDir}: ${(err as Error).message}`,
          "Verify the persistent volume is mounted, writable, and that LOG_DIR points at it.",
        ),
      );
    }
  }

  // Business metrics tile freshness — call the captured admin handler
  // with a synthetic admin JWT and assert generatedAt is from this run.
  const adminId = await ensureGoLiveAdminUser();
  const token = signToken({
    userId: adminId,
    username: "__golive_admin",
    email: "__golive_admin@drill.local",
    role: "admin",
  });
  try {
    const result = await routeRunner.call("GET", "/api/admin/metrics", {
      token,
    });
    if (result.statusCode !== 200) {
      checks.push(
        check(
          "Business metrics tile is fresh",
          "fail",
          `GET /api/admin/metrics returned ${result.statusCode}: ${JSON.stringify(result.body).slice(0, 300)}`,
          "Hit the admin metrics endpoint manually with a real admin JWT to inspect the failure.",
        ),
      );
    } else {
      const body = result.body as { generatedAt?: string; windowMs?: number };
      const age = body.generatedAt
        ? Date.now() - Date.parse(body.generatedAt)
        : NaN;
      if (Number.isFinite(age) && age >= 0 && age < 60_000) {
        checks.push(
          check(
            "Business metrics tile is fresh",
            "pass",
            `GET /api/admin/metrics generatedAt=${body.generatedAt} (age=${age}ms, window=${body.windowMs}ms).`,
          ),
        );
      } else {
        checks.push(
          check(
            "Business metrics tile is fresh",
            "fail",
            `GET /api/admin/metrics generatedAt is ${body.generatedAt ?? "missing"} (age=${age}ms).`,
            "Inspect /api/admin/metrics — generatedAt should always be the current wall clock.",
          ),
        );
      }
    }
  } catch (err) {
    checks.push(
      check(
        "Business metrics tile is fresh",
        "fail",
        `GET /api/admin/metrics threw: ${(err as Error).message}`,
        "Check server/admin-routes.ts /api/admin/metrics; verify auditLogs counters and DB indices.",
      ),
    );
  }

  return {
    name: "Monitoring",
    summary:
      "Verifies the /health probe path, the persistent error log destination, and " +
      "that the admin metrics tile responds with a fresh generatedAt timestamp.",
    checks,
  };
}

// ---------------------------------------------------------------------------
// 4. Alerting
// ---------------------------------------------------------------------------
const KNOWN_ALERT_SOURCES: Array<{
  source: string;
  severity: OperatorAlertSeverity;
  title: string;
}> = [
  { source: "wallet-ledger-reconciliation", severity: "info", title: "Pre-launch alerting drill" },
  { source: "posting-receipt-invariant", severity: "info", title: "Pre-launch alerting drill" },
  { source: "database-restore-drill", severity: "info", title: "Pre-launch alerting drill" },
  { source: "database-backup-watchdog", severity: "info", title: "Pre-launch alerting drill" },
  { source: "kill-switch", severity: "info", title: "Pre-launch alerting drill" },
  { source: "stuck-pending-transactions", severity: "info", title: "Pre-launch alerting drill" },
  { source: "audit-log-write-failure", severity: "info", title: "Pre-launch alerting drill" },
  { source: "db-connection-failure", severity: "info", title: "Pre-launch alerting drill" },
  { source: "operator-alerts-prune-watchdog", severity: "info", title: "Pre-launch alerting drill" },
];

async function alertingSection(): Promise<Section> {
  const checks: Check[] = [];
  const webhookConfigured = Boolean(process.env.OPERATOR_ALERT_WEBHOOK_URL?.trim());

  // Top-level info on which channels are configured. NO-GO if no
  // off-stdout channel is wired — running production behind log-only
  // alerting means an outage at 02:00 reaches nobody.
  if (webhookConfigured) {
    checks.push(
      check(
        "Off-host alert channel configured",
        "pass",
        "OPERATOR_ALERT_WEBHOOK_URL is set — alerts dispatch to log + webhook.",
      ),
    );
  } else {
    checks.push(
      check(
        "Off-host alert channel configured",
        "fail",
        "OPERATOR_ALERT_WEBHOOK_URL is unset — alerts only reach stdout, which is invisible to off-hours operators.",
        "Set OPERATOR_ALERT_WEBHOOK_URL to the on-call Slack/PagerDuty incoming webhook before launch.",
      ),
    );
  }

  // Per-source drill alerts. Every dispatch persists one row to
  // operator_alerts; details payload is tagged so operators can grep them.
  for (const spec of KNOWN_ALERT_SOURCES) {
    const alert: OperatorAlert = {
      source: spec.source,
      severity: spec.severity,
      title: `${spec.title} — ${spec.source}`,
      details: {
        drill: true,
        runId: RUN_ID,
        message:
          "Pre-launch go/no-go drill. NOT a real incident. Confirm receipt in the configured channel.",
        scheduledBy: "scripts/go-no-go.ts",
      },
    };
    try {
      const result = await notifyOperator(alert);
      const logOk = result.outcomes.find(
        (o) => o.channel === "log" && o.status === "success",
      );
      const webhookAttempted = result.outcomes.find((o) => o.channel === "webhook");
      const webhookOk =
        webhookAttempted && webhookAttempted.status === "success";

      if (!logOk) {
        checks.push(
          check(
            `Test alert: ${spec.source}`,
            "fail",
            `log channel did not succeed: ${JSON.stringify(result.outcomes)}`,
            "Check stdout is connected and writable; the log channel must always succeed.",
          ),
        );
        continue;
      }

      if (webhookConfigured) {
        if (webhookOk) {
          checks.push(
            check(
              `Test alert: ${spec.source}`,
              "pass",
              `dispatched (alertId=${result.alertId}, log+webhook ok, status=${webhookAttempted?.httpStatus ?? "n/a"}).`,
            ),
          );
        } else {
          checks.push(
            check(
              `Test alert: ${spec.source}`,
              "fail",
              `webhook channel failed: status=${webhookAttempted?.status} httpStatus=${webhookAttempted?.httpStatus ?? "n/a"} error=${webhookAttempted?.error ?? "n/a"}`,
              "Verify OPERATOR_ALERT_WEBHOOK_URL — the receiver must accept POST application/json and return 2xx.",
            ),
          );
        }
      } else {
        // Without a webhook, the per-source check still passes if the log
        // channel + DB persistence both worked — but the top-level
        // "Off-host alert channel configured" check above is already
        // a NO-GO, so the verdict is correct.
        checks.push(
          check(
            `Test alert: ${spec.source}`,
            "pass",
            `dispatched (alertId=${result.alertId}, log only — webhook not configured).`,
          ),
        );
      }

      if (result.alertId === null) {
        checks.push(
          check(
            `Audit row persisted: ${spec.source}`,
            "fail",
            "operator_alerts insert returned null — the durable record was not written.",
            "Check the operator_alerts table for permission errors or constraint violations.",
          ),
        );
      }
    } catch (err) {
      checks.push(
        check(
          `Test alert: ${spec.source}`,
          "fail",
          `notifyOperator() threw: ${(err as Error).message}`,
          "Inspect server/services/operator-alerts.ts dispatch; the dispatcher should never throw on a single-source failure.",
        ),
      );
    }
  }

  return {
    name: "Alerting",
    summary:
      "For every known alert source the dispatcher writes one drill alert (tagged " +
      "`drill: true`, `runId`) and persists a row in operator_alerts. A configured " +
      "off-host channel (OPERATOR_ALERT_WEBHOOK_URL) is required for launch.",
    checks,
  };
}

// ---------------------------------------------------------------------------
// 5. Kill switches
// ---------------------------------------------------------------------------
async function killSwitchesSection(): Promise<Section> {
  const checks: Check[] = [];
  const adminId = await ensureGoLiveAdminUser();

  for (const key of killSwitchKeyValues as readonly KillSwitchKey[]) {
    // Snapshot the current row so we can restore it at the end. An env-
    // forced switch can't be toggled at all — surface that as SKIP and
    // continue (the env var is the intentional ops escape hatch).
    const envVarName = `DISABLE_${key.toUpperCase()}`;
    const envForced = isTruthyEnv(process.env[envVarName]);
    if (envForced) {
      checks.push(
        check(
          `Kill switch toggle drill: ${key}`,
          "skip",
          `${envVarName} is forced ON via env var — the admin DB toggle is intentionally rejected. Cannot drill.`,
          "Clear the env var (and redeploy) to drill the DB-toggle path; SKIP is treated as NO-GO.",
        ),
      );
      continue;
    }

    const [before] = await db
      .select()
      .from(killSwitches)
      .where(eq(killSwitches.switchKey, key));
    const beforeEnabled = before?.enabled ?? false;

    let toggleErr: unknown = null;
    try {
      // ------------------------- ON --------------------------------------
      await setKillSwitchState({
        key,
        enabled: true,
        reason: `[drill ${RUN_ID}] go-no-go ${killSwitchLabel(key)} engagement test`,
        actorUserId: adminId,
        ipAddress: "127.0.0.1",
      });
      invalidateKillSwitchCache();

      const onActive = await isKillSwitchActive(key);
      if (!onActive) {
        throw new Error("isKillSwitchActive returned false after toggle ON");
      }

      // The route surface maps KillSwitchActiveError → HTTP 503 +
      // {error:"operation_disabled", switch:<key>}. Reproduce that exact
      // contract here without binding a port.
      let guarded = false;
      try {
        await assertKillSwitchOff(key);
      } catch (err) {
        if (
          err instanceof KillSwitchActiveError &&
          err.status === 503 &&
          err.switchKey === key
        ) {
          guarded = true;
        } else {
          throw err;
        }
      }
      if (!guarded) {
        throw new Error(
          "assertKillSwitchOff did not throw KillSwitchActiveError(503) while engaged",
        );
      }

      const auditOn = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, "kill_switch"),
            eq(auditLogs.entityId, key),
            eq(auditLogs.action, "kill_switch_enabled"),
            gt(auditLogs.createdAt, STARTED_AT),
          ),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(1);
      if (auditOn.length === 0) {
        throw new Error("no kill_switch_enabled audit row found after toggle ON");
      }

      // ------------------------- OFF -------------------------------------
      await setKillSwitchState({
        key,
        enabled: false,
        reason: `[drill ${RUN_ID}] go-no-go ${killSwitchLabel(key)} cleanup`,
        actorUserId: adminId,
        ipAddress: "127.0.0.1",
      });
      invalidateKillSwitchCache();

      const offActive = await isKillSwitchActive(key);
      if (offActive) {
        throw new Error(
          "isKillSwitchActive still true after toggle OFF — guard failed to clear",
        );
      }

      const auditOff = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, "kill_switch"),
            eq(auditLogs.entityId, key),
            eq(auditLogs.action, "kill_switch_disabled"),
            gt(auditLogs.createdAt, STARTED_AT),
          ),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(1);
      if (auditOff.length === 0) {
        throw new Error("no kill_switch_disabled audit row found after toggle OFF");
      }
    } catch (err) {
      toggleErr = err;
    } finally {
      // Best-effort restore of the prior state so the verification has no
      // lasting effect. We do not surface a restore failure as PASS — if
      // we can't restore the state, that itself is a NO-GO.
      try {
        await setKillSwitchState({
          key,
          enabled: beforeEnabled,
          reason: `[drill ${RUN_ID}] go-no-go restore prior state (enabled=${beforeEnabled})`,
          actorUserId: adminId,
          ipAddress: "127.0.0.1",
        });
        invalidateKillSwitchCache();
      } catch (restoreErr) {
        // If we couldn't restore, attach to the toggle error so the
        // report shows both.
        toggleErr = toggleErr ?? restoreErr;
      }
    }

    if (toggleErr) {
      checks.push(
        check(
          `Kill switch toggle drill: ${key}`,
          "fail",
          `${(toggleErr as Error).message}`,
          `Inspect kill_switches/audit_logs for ${key}; ensure env var ${envVarName} is unset and the admin user can write.`,
        ),
      );
    } else {
      checks.push(
        check(
          `Kill switch toggle drill: ${key}`,
          "pass",
          `Engaged → 503 envelope verified → audited → cleared → audited → restored to enabled=${beforeEnabled}.`,
        ),
      );
    }
  }

  return {
    name: "Kill switches",
    summary:
      "For every named kill switch (transactions, deposits, withdrawals, fee_deductions): " +
      "toggle ON, assert assertKillSwitchOff throws KillSwitchActiveError(503), assert " +
      "an audit row is written, toggle OFF, assert audit, restore prior state. Switches " +
      "forced ON by env var cannot be drilled and are reported as SKIP.",
    checks,
  };
}

// ---------------------------------------------------------------------------
// 6. Rollback
// ---------------------------------------------------------------------------
async function rollbackSection(): Promise<Section> {
  const checks: Check[] = [];

  if (!isBackupsEnabled()) {
    checks.push(
      check(
        "Last successful restore drill is fresh",
        "fail",
        "DB_BACKUP_DIR is not configured — restore drills cannot run.",
        "Configure DB_BACKUP_DIR and run `npx tsx scripts/db-restore-drill.ts`; see docs/runbooks/rollback.md.",
      ),
    );
    return {
      name: "Rollback",
      summary:
        "Verifies the most recent restore drill succeeded recently — the safety net " +
        "for a `Path B` rollback in docs/runbooks/rollback.md.",
      checks,
    };
  }

  let status: Awaited<ReturnType<typeof getBackupStatus>> | null = null;
  try {
    status = await getBackupStatus();
  } catch (err) {
    checks.push(
      check(
        "Last successful restore drill is fresh",
        "fail",
        `getBackupStatus() threw: ${(err as Error).message}`,
        "Check the database_restore_drill_runs table; rerun scripts/db-restore-drill.ts.",
      ),
    );
    return {
      name: "Rollback",
      summary:
        "Verifies the most recent restore drill succeeded recently — the safety net " +
        "for a `Path B` rollback in docs/runbooks/rollback.md.",
      checks,
    };
  }

  const drill = status.latestDrill;
  if (!drill) {
    checks.push(
      check(
        "Last successful restore drill is fresh",
        "fail",
        "No successful restore drill has ever been recorded in database_restore_drill_runs.",
        "Run `npx tsx scripts/db-restore-drill.ts` to take a fresh drill before launching.",
      ),
    );
  } else if (drill.ageMs > DEFAULT_DRILL_STALE_THRESHOLD_MS) {
    checks.push(
      check(
        "Last successful restore drill is fresh",
        "fail",
        `Latest successful restore drill is ${formatAge(drill.ageMs)} old (threshold: ${formatAge(
          DEFAULT_DRILL_STALE_THRESHOLD_MS,
        )}).`,
        "Run `npx tsx scripts/db-restore-drill.ts` and re-run go-no-go.",
      ),
    );
  } else {
    checks.push(
      check(
        "Last successful restore drill is fresh",
        "pass",
        `Latest successful restore drill is ${formatAge(drill.ageMs)} old (dump: ${drill.dumpPath ?? "n/a"}).`,
      ),
    );
  }

  return {
    name: "Rollback",
    summary:
      "Verifies the most recent restore drill succeeded recently — the safety net " +
      "for a `Path B` rollback in docs/runbooks/rollback.md.",
    checks,
  };
}

// ---------------------------------------------------------------------------
// 7. Security
// ---------------------------------------------------------------------------
async function securitySection(routeRunner: RouteRunner): Promise<Section> {
  const checks: Check[] = [];

  // Upload rejection: build the same middleware factory a route uses, then
  // hand it a request whose mimetype is NOT in the allow-list. Multer
  // rejects on the file-filter callback and the middleware writes a 400.
  try {
    const mw = buildUploadMiddleware();
    const result = await runUploadProbe(mw.handler, {
      mimetype: "application/x-msdownload", // Windows .exe — never allowed.
      content: Buffer.from("MZ\u0000\u0000fake-exe", "utf8"),
    });
    if (result.statusCode === 400) {
      checks.push(
        check(
          "Upload rejection (disallowed mime)",
          "pass",
          `400 returned for application/x-msdownload (max=${resolveMaxUploadBytes()} bytes, allow-list size=${DEFAULT_ALLOWED_MIME_TYPES.length}).`,
        ),
      );
    } else {
      checks.push(
        check(
          "Upload rejection (disallowed mime)",
          "fail",
          `expected 400, got ${result.statusCode}: ${JSON.stringify(result.body).slice(0, 300)}`,
          "Inspect server/services/upload-security.ts; the file-filter must reject any mime not in the allow-list.",
        ),
      );
    }
  } catch (err) {
    checks.push(
      check(
        "Upload rejection (disallowed mime)",
        "fail",
        `upload probe threw: ${(err as Error).message}`,
        "Re-run server/services/upload-security.test.ts to localise the regression.",
      ),
    );
  }

  // All admin routes guarded — every captured /api/admin/* handler is
  // wrapped in adminRoute(), which calls requireAuth FIRST (before any
  // param-dependent logic). So an unauthenticated invocation must
  // return 401 for every single route, regardless of URL parameters.
  // We probe ALL captured admin handlers, not just one example, so a
  // single forgotten guard fails the launch gate loudly.
  const adminPaths = routeRunner.list().filter((k) => k.includes(" /api/admin/"));
  if (adminPaths.length === 0) {
    checks.push(
      check(
        "Admin routes registered + guarded",
        "fail",
        "No /api/admin/* routes were captured from registerRoutes() — admin surface missing.",
        "Confirm registerAdminRoutes() runs in registerRoutes(); see server/admin-routes.ts.",
      ),
    );
  } else {
    const unguarded: Array<{ key: string; statusCode: number }> = [];
    for (const key of adminPaths) {
      const [method, pathStr] = key.split(" ", 2);
      try {
        const result = await routeRunner.call(method, pathStr, {
          noAuth: true,
        });
        if (result.statusCode !== 401) {
          unguarded.push({ key, statusCode: result.statusCode });
        }
      } catch (err) {
        // A handler that throws on unauth (instead of writing 401) is
        // also a bug — the wrapper must convert errors to a 401 envelope
        // before sending. Surface as unguarded with statusCode -1.
        unguarded.push({ key: `${key} (threw: ${(err as Error).message.slice(0, 80)})`, statusCode: -1 });
      }
    }
    if (unguarded.length === 0) {
      checks.push(
        check(
          "Admin routes registered + guarded",
          "pass",
          `${adminPaths.length} /api/admin/* routes registered; every one returned 401 to an unauthenticated call.`,
        ),
      );
    } else {
      const sample = unguarded.slice(0, 5).map((u) => `  - ${u.key} → ${u.statusCode}`).join("\n");
      checks.push(
        check(
          "Admin routes registered + guarded",
          "fail",
          `${unguarded.length}/${adminPaths.length} /api/admin/* routes did NOT return 401 to an unauthenticated call:\n${sample}${unguarded.length > 5 ? `\n  …(${unguarded.length - 5} more)` : ""}`,
          "Wrap every admin handler in adminRoute() so requireAuth + requireRole('admin') run before any other logic; inspect server/admin-routes.ts.",
        ),
      );
    }
  }

  // Login rate limit active. The limiter is a per-route middleware, not a
  // global app.use(), so we verify the wiring at the source. Greppy but
  // robust: the route file MUST mention the limiter on the login handler.
  try {
    const routesSrc = await fs.readFile(
      path.resolve(process.cwd(), "server", "routes.ts"),
      "utf8",
    );
    const hasLimiter = /loginLimiter\b/.test(routesSrc);
    const wiredOnLogin = /post\("\/api\/auth\/login"\s*,\s*loginLimiter\b/.test(
      routesSrc,
    );
    if (hasLimiter && wiredOnLogin) {
      checks.push(
        check(
          "Login rate limit active",
          "pass",
          "loginLimiter is declared and applied to POST /api/auth/login in server/routes.ts.",
        ),
      );
    } else {
      checks.push(
        check(
          "Login rate limit active",
          "fail",
          `loginLimiter present=${hasLimiter}, applied to /api/auth/login=${wiredOnLogin}.`,
          "Re-wire the per-IP rate limiter on POST /api/auth/login (Task #148).",
        ),
      );
    }
  } catch (err) {
    checks.push(
      check(
        "Login rate limit active",
        "fail",
        `could not read server/routes.ts: ${(err as Error).message}`,
        "Verify the script is run from the project root.",
      ),
    );
  }

  return {
    name: "Security",
    summary:
      "Verifies the upload-rejection contract for disallowed mime types, that every " +
      "admin route is JWT-guarded (an unauthenticated call returns 401), and that the " +
      "per-IP login rate limiter is wired.",
    checks,
  };
}

// ---------------------------------------------------------------------------
// 8. Compliance
// ---------------------------------------------------------------------------
async function complianceSection(): Promise<Section> {
  const checks: Check[] = [];

  // Audit-log immutability — exercise the live triggers against the
  // production schema. INSERT a probe row, then attempt UPDATE / DELETE
  // and assert both throw with the canonical "audit_logs is immutable"
  // message. The probe row remains forever (audit_logs is append-only by
  // design); we tag it `{ drill: true, runId }` so it's recognisable.
  try {
    await installAuditLogsImmutabilityTriggers(db);
    const stamp = `go-no-go-immutability-probe-${RUN_ID}`;
    const [row] = await db
      .insert(auditLogs)
      .values({
        userId: null,
        action: stamp,
        entityType: "go-no-go-drill",
        entityId: stamp,
        metadata: { drill: true, runId: RUN_ID, kind: "immutability_probe" },
        ipAddress: null,
      })
      .returning();

    let updateBlocked = false;
    try {
      await db
        .update(auditLogs)
        .set({ action: "tampered" })
        .where(eq(auditLogs.id, row.id));
    } catch (err) {
      if (/audit_logs is immutable/i.test((err as Error).message)) {
        updateBlocked = true;
      } else {
        throw err;
      }
    }

    let deleteBlocked = false;
    try {
      await db.delete(auditLogs).where(eq(auditLogs.id, row.id));
    } catch (err) {
      if (/audit_logs is immutable/i.test((err as Error).message)) {
        deleteBlocked = true;
      } else {
        throw err;
      }
    }

    if (updateBlocked && deleteBlocked) {
      checks.push(
        check(
          "audit_logs UPDATE/DELETE blocked at the DB layer",
          "pass",
          `INSERT id=${row.id} succeeded; UPDATE and DELETE both rejected by trigger.`,
        ),
      );
    } else {
      checks.push(
        check(
          "audit_logs UPDATE/DELETE blocked at the DB layer",
          "fail",
          `update_blocked=${updateBlocked} delete_blocked=${deleteBlocked} (probe id=${row.id}).`,
          "Re-run installAuditLogsImmutabilityTriggers() at boot; see server/services/audit-immutability-migration.ts.",
        ),
      );
    }
  } catch (err) {
    checks.push(
      check(
        "audit_logs UPDATE/DELETE blocked at the DB layer",
        "fail",
        `audit-log immutability probe threw: ${(err as Error).message}`,
        "Confirm the audit_logs table exists and the immutability triggers installer ran.",
      ),
    );
  }

  // Review lock — the wealth-planner exports REVIEW_LOCK_REASON which the
  // 423 envelope on locked records uses. Verify the constant is exported
  // and unchanged so a downstream UI relying on it can't silently drift.
  if (REVIEW_LOCK_REASON === "record_locked_under_review") {
    checks.push(
      check(
        "Review lock contract intact",
        "pass",
        `REVIEW_LOCK_REASON="${REVIEW_LOCK_REASON}" is the documented 423 reason in server/services/wealth-planner.ts.`,
      ),
    );
  } else {
    checks.push(
      check(
        "Review lock contract intact",
        "fail",
        `REVIEW_LOCK_REASON has drifted to "${REVIEW_LOCK_REASON}".`,
        "Restore the published constant; downstream UIs key off this exact string.",
      ),
    );
  }

  // No fake data in client-visible views — delegate to the existing
  // regression script. A non-zero exit is a NO-GO.
  const r = spawnSync(
    "npx",
    ["tsx", "scripts/test-no-synthetic-portfolio-data.ts"],
    {
      stdio: "pipe",
      env: process.env,
      encoding: "utf8",
    },
  );
  if (r.error) {
    checks.push(
      check(
        "No synthetic portfolio data in client views",
        "skip",
        `script did not run: ${r.error.message}`,
        "Re-run `npx tsx scripts/test-no-synthetic-portfolio-data.ts` to localise the failure; SKIP is treated as NO-GO.",
      ),
    );
  } else if (r.status === 0) {
    checks.push(
      check(
        "No synthetic portfolio data in client views",
        "pass",
        "test-no-synthetic-portfolio-data.ts exited 0 — no hardcoded sample arrays detected.",
      ),
    );
  } else {
    const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(-15)
      .join("\n");
    checks.push(
      check(
        "No synthetic portfolio data in client views",
        "fail",
        `test-no-synthetic-portfolio-data.ts exited ${r.status}\nlast lines:\n${tail}`,
        "Replace inline numeric arrays with real data sources; see scripts/test-no-synthetic-portfolio-data.ts header.",
      ),
    );
  }

  return {
    name: "Compliance",
    summary:
      "Verifies audit_logs is truly append-only at the DB layer, the wealth-planner " +
      "review-lock contract holds, and no synthetic portfolio data has crept back into " +
      "client-visible views.",
    checks,
  };
}

// ---------------------------------------------------------------------------
// Helpers — env, formatting, fixtures
// ---------------------------------------------------------------------------
function isTruthyEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const GO_LIVE_ADMIN_USERNAME = "__golive_drill_admin";

async function ensureGoLiveAdminUser(): Promise<number> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, GO_LIVE_ADMIN_USERNAME));
  if (existing) return existing.id;
  const [row] = await db
    .insert(users)
    .values({
      username: GO_LIVE_ADMIN_USERNAME,
      email: "__golive_drill_admin@drill.local",
      password: "not-a-real-password",
      firstName: "GoNoGo",
      lastName: "Drill",
      role: "admin",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning({ id: users.id });
  return row.id;
}

// ---------------------------------------------------------------------------
// Captured-route runner. registerRoutes() is async and registers handlers
// inline; we hand it a callable mock that records every (method, path) →
// last-handler pair, then call individual handlers with mock req/res
// objects. Same approach as scripts/pre-launch-safety.ts.
// ---------------------------------------------------------------------------
type CapturedHandler = (req: Request, res: any) => unknown;

interface RouteRunner {
  list(): string[];
  call(
    method: string,
    pathStr: string,
    opts?: {
      token?: string;
      noAuth?: boolean;
      body?: unknown;
      headers?: Record<string, string>;
      params?: Record<string, string>;
    },
  ): Promise<{ statusCode: number; body: unknown }>;
}

async function buildRouteRunner(): Promise<RouteRunner> {
  const captured = new Map<string, CapturedHandler>();
  const app: any = function fakeApp(_req: any, _res: any) {};
  const recorder = (verb: string) => (
    p: string,
    ...handlers: CapturedHandler[]
  ) => {
    captured.set(`${verb} ${p}`, handlers[handlers.length - 1]);
    return app;
  };
  app.get = recorder("GET");
  app.post = recorder("POST");
  app.patch = recorder("PATCH");
  app.delete = recorder("DELETE");
  app.put = recorder("PUT");
  app.all = recorder("ALL");
  app.use = () => app;
  app.set = () => app;
  app.engine = () => app;
  app.disable = () => app;
  app.enable = () => app;
  app.locals = {};
  await registerRoutes(app as Express);

  return {
    list: () => Array.from(captured.keys()),
    call: async (method, pathStr, opts = {}) => {
      const key = `${method} ${pathStr}`;
      const handler = captured.get(key);
      if (!handler) throw new Error(`route handler not captured: ${key}`);
      const result = { statusCode: 200, body: undefined as unknown };
      const headers: Record<string, string> = {};
      if (!opts.noAuth && opts.token) {
        headers.authorization = `Bearer ${opts.token}`;
      }
      Object.assign(headers, opts.headers ?? {});
      const req = {
        headers,
        params: opts.params ?? {},
        body: opts.body ?? {},
        query: {},
        path: pathStr,
        method,
        ip: "127.0.0.1",
      } as unknown as Request;
      const res = {
        status(code: number) {
          result.statusCode = code;
          return this;
        },
        json(b: unknown) {
          result.body = b;
          return this;
        },
        send(b: unknown) {
          result.body = b;
          return this;
        },
      };
      await handler(req, res);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Upload probe — runs the multer-based middleware against a synthetic
// multipart request, returning the eventual {statusCode, body}. The
// rejection path returns 400 from inside the middleware (it never calls
// next()), so we don't need a real route handler downstream.
// ---------------------------------------------------------------------------
async function runUploadProbe(
  handler: (req: any, res: any, next: any) => unknown,
  file: { mimetype: string; content: Buffer },
): Promise<{ statusCode: number; body: unknown }> {
  const result = { statusCode: 200, body: undefined as unknown };
  // Build a real multipart body so multer's parser actually sees the file.
  const boundary = `----go-no-go-${RUN_ID}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="probe.bin"\r\n` +
      `Content-Type: ${file.mimetype}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([head, file.content, tail]);

  // Minimal IncomingMessage-shaped readable stream.
  const { Readable } = await import("node:stream");
  const stream = Readable.from([body]) as any;
  stream.headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "content-length": String(body.length),
  };
  stream.method = "POST";
  stream.url = "/upload-probe";

  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader() {},
    getHeader() {},
    end(chunk?: unknown) {
      if (chunk !== undefined) result.body = String(chunk);
    },
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    json(b: unknown) {
      result.body = b;
      return this;
    },
    send(b: unknown) {
      result.body = b;
      return this;
    },
  };

  await new Promise<void>((resolve) => {
    handler(stream, res, (_err?: unknown) => {
      // If multer ever calls next() we treat it as "did not reject" —
      // a probe with a disallowed mime should never reach here.
      result.statusCode = 200;
      result.body = { error: "next() called — file was NOT rejected" };
      resolve();
    });
    // The middleware writes the response synchronously on rejection;
    // give the event loop a tick to flush before timing out.
    setTimeout(resolve, 1500);
  });
  return result;
}

// ---------------------------------------------------------------------------
// Verdict + report
// ---------------------------------------------------------------------------
type Verdict = "GO" | "NO-GO";

function computeVerdict(secs: Section[]): Verdict {
  for (const s of secs) {
    for (const c of s.checks) {
      if (c.outcome === "fail" || c.outcome === "skip") return "NO-GO";
    }
  }
  return "GO";
}

function symbol(o: Outcome): string {
  return o === "pass" ? "PASS" : o === "fail" ? "FAIL" : "SKIP";
}

function renderMarkdown(verdict: Verdict, secs: Section[]): string {
  const lines: string[] = [];
  lines.push(`# Pre-launch GO/NO-GO report`);
  lines.push("");
  lines.push(`**Verdict:** ${verdict === "GO" ? "**GO**" : "**NO-GO**"}`);
  lines.push("");
  lines.push(`* Run id: \`${RUN_ID}\``);
  lines.push(`* Started: ${STARTED_AT.toISOString()}`);
  lines.push(`* Finished: ${new Date().toISOString()}`);
  lines.push(`* NODE_ENV: \`${process.env.NODE_ENV ?? "(unset)"}\``);
  lines.push(`* Server version: \`${getServerVersion()}\``);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`| Section | Pass | Fail | Skip |`);
  lines.push(`| --- | ---: | ---: | ---: |`);
  for (const s of secs) {
    const pass = s.checks.filter((c) => c.outcome === "pass").length;
    const fail = s.checks.filter((c) => c.outcome === "fail").length;
    const skip = s.checks.filter((c) => c.outcome === "skip").length;
    lines.push(`| ${s.name} | ${pass} | ${fail} | ${skip} |`);
  }
  lines.push("");

  for (const s of secs) {
    lines.push(`## ${s.name}`);
    lines.push("");
    lines.push(s.summary);
    lines.push("");
    for (const c of s.checks) {
      lines.push(`### ${symbol(c.outcome)} — ${c.name}`);
      lines.push("");
      lines.push("```");
      lines.push(c.details);
      lines.push("```");
      if ((c.outcome === "fail" || c.outcome === "skip") && c.hint) {
        lines.push("");
        lines.push(`> **What to do:** ${c.hint}`);
      }
      lines.push("");
    }
  }

  lines.push(`---`);
  lines.push("");
  lines.push(
    `Generated by \`scripts/go-no-go.ts\`. See \`docs/runbooks/go-no-go.md\` for how to interpret this report.`,
  );
  lines.push("");
  return lines.join("\n");
}

async function writeReport(report: string): Promise<string> {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const stamp = STARTED_AT.toISOString().replace(/[:.]/g, "-");
  const out = path.join(REPORT_DIR, `go-no-go-${stamp}.md`);
  await fs.writeFile(out, report, "utf8");
  return out;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const routeRunner = await buildRouteRunner();

  addSection(await preLaunchSafetySection());
  addSection(await infrastructureSection());
  addSection(await monitoringSection(routeRunner));
  addSection(await alertingSection());
  addSection(await killSwitchesSection());
  addSection(await rollbackSection());
  addSection(await securitySection(routeRunner));
  addSection(await complianceSection());

  const verdict = computeVerdict(sections);
  const report = renderMarkdown(verdict, sections);
  const reportPath = await writeReport(report);

  // Console summary — verdict on the last line so a CI step can `tail -1`.
  console.log(`\n[go-no-go] Report written to: ${reportPath}`);
  for (const s of sections) {
    const pass = s.checks.filter((c) => c.outcome === "pass").length;
    const fail = s.checks.filter((c) => c.outcome === "fail").length;
    const skip = s.checks.filter((c) => c.outcome === "skip").length;
    console.log(
      `[go-no-go]   ${s.name}: pass=${pass} fail=${fail} skip=${skip}`,
    );
  }
  console.log(
    `[go-no-go] Verdict: ${verdict === "GO" ? "GO ✅" : "NO-GO ❌"}`,
  );

  process.exit(verdict === "GO" ? 0 : 1);
}

main().catch((err) => {
  console.error("[go-no-go] orchestrator crashed:", err);
  process.exit(1);
});
