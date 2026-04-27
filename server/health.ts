// =============================================================================
// Task #157 — /health and /ready endpoints for uptime monitoring
// =============================================================================
// Two small unauthenticated GET endpoints intended for external monitors
// (load balancers, uptime checkers, on-call rotas):
//
//   GET /health  — "is the process up and the primary DB reachable?"
//                  200 ok | 503 degraded. Cheap enough to be hit on a
//                  tight interval (every 10–30s).
//
//   GET /ready   — "is the process up, the DB reachable, AND no critical
//                  background subsystem in a known-bad state (any cron
//                  flagged isOverdue by the background-jobs health
//                  snapshot)?" 200 ok | 503 degraded.
//
// Both endpoints:
//   * Do NOT require auth (uptime monitors don't carry credentials).
//   * Are mounted outside `/api`, so the per-IP rate limiter and the
//     `/api`-only request logger in `server/index.ts` never touch them.
//   * Are GETs only, so they wouldn't be blocked by a future write
//     kill-switch even if it lands as middleware on mutating verbs.
//   * Return well under a second under normal load — the DB ping uses
//     a 1s timeout so a hung pool can't make the endpoint slow either.
//
// The kill-switch task hadn't landed when these endpoints were written;
// once it does, surface its state as `writeKillSwitch: { enabled, reason }`
// in the /health payload (informational — does not flip status to 503).
// =============================================================================

import type { Express } from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db";
import {
  DEFAULT_OVERDUE_AFTER_MS,
  getBackgroundJobsHealth,
  type BackgroundJobsHealth,
} from "./services/background-jobs";
import { recordSuccessfulHealthProbe } from "./services/error-log";

/** Hard cap on how long the DB ping is allowed to take before we mark the
 *  endpoint degraded. Matches the spec ("short timeout, e.g. 1s"). */
export const DB_PING_TIMEOUT_MS = 1_000;

export interface DbPingResult {
  ok: boolean;
  /** Wall-clock latency of the ping attempt (ms), even on failure. */
  latencyMs: number;
  /** Populated only when ok=false. Short, safe-to-log message. */
  error?: string;
}

/**
 * Lightweight `SELECT 1` against the primary pool with a hard timeout.
 * Never throws — failures are returned as `{ ok: false, error }` so the
 * caller can map them to 503 without a try/catch around every call site.
 */
export async function pingDatabase(
  timeoutMs: number = DB_PING_TIMEOUT_MS,
): Promise<DbPingResult> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`db ping timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Version field. Prefer GIT_SHA (set at build time by CI) so an incident
// triage can map a /health response to a specific commit; fall back to the
// package.json version so the field is always populated.
// ---------------------------------------------------------------------------
let cachedVersion: string | null = null;

export function getServerVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  const sha = process.env.GIT_SHA?.trim();
  if (sha) {
    cachedVersion = sha;
    return cachedVersion;
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // Dev: server/health.ts → ../package.json. Prod (esbuild bundle): dist/index.js → ../package.json.
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    cachedVersion = pkg.version ?? "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

/** Test seam — clears the memoised version so a test that mutates env vars
 *  can re-read GIT_SHA on the next call. Not used in production. */
export function __resetVersionCacheForTests(): void {
  cachedVersion = null;
}

export interface HealthRouteDeps {
  /** Override the DB ping (tests inject a forced failure). */
  dbPing?: (timeoutMs?: number) => Promise<DbPingResult>;
  /** Override the background-jobs health snapshot (tests inject overdue jobs). */
  jobsHealth?: () => Promise<BackgroundJobsHealth>;
  /** Override the version string so tests don't depend on package.json. */
  version?: string;
  /** Override `process.uptime()` for deterministic tests. */
  uptimeSeconds?: () => number;
}

export interface HealthPayload {
  status: "ok" | "degraded";
  uptimeSeconds: number;
  version: string;
  db: DbPingResult;
}

export interface ReadyPayload extends HealthPayload {
  jobs: {
    ok: boolean;
    overdueAfterMs: number;
    overdueJobs: string[];
    /** Populated if the snapshot itself failed to compute. */
    error?: string;
  };
}

/**
 * Mount `/health` and `/ready`. Call this BEFORE any auth, rate-limiting,
 * or kill-switch middleware so the endpoints stay reachable when the rest
 * of the app is in a degraded state (which is exactly when monitors care).
 */
export function registerHealthRoutes(
  app: Express,
  deps: HealthRouteDeps = {},
): void {
  const dbPing = deps.dbPing ?? pingDatabase;
  const jobsHealth = deps.jobsHealth ?? getBackgroundJobsHealth;
  const version = deps.version ?? getServerVersion();
  const uptimeSeconds =
    deps.uptimeSeconds ?? (() => Math.floor(process.uptime()));

  app.get("/health", async (_req, res) => {
    const db = await dbPing();
    const payload: HealthPayload = {
      status: db.ok ? "ok" : "degraded",
      uptimeSeconds: uptimeSeconds(),
      version,
      db,
    };
    // The kill-switch field is intentionally omitted until that task lands;
    // see the file header for the contract to add then.
    if (db.ok) {
      // Preserve the "lastSuccessfulHealthProbeAt" signal Task #144 wired
      // into the admin dashboard — only successful probes refresh it.
      try {
        recordSuccessfulHealthProbe();
      } catch {
        // Recording is in-memory and shouldn't fail; never let it break /health.
      }
    }
    res.status(db.ok ? 200 : 503).json(payload);
  });

  app.get("/ready", async (_req, res) => {
    const db = await dbPing();
    let snapshot: BackgroundJobsHealth | null = null;
    let snapshotError: string | undefined;
    try {
      snapshot = await jobsHealth();
    } catch (e) {
      snapshotError = e instanceof Error ? e.message : String(e);
    }
    const overdueJobs = snapshot
      ? snapshot.jobs.filter((j) => j.isOverdue).map((j) => j.name)
      : [];
    const jobsOk = snapshotError === undefined && overdueJobs.length === 0;
    const ready = db.ok && jobsOk;
    const payload: ReadyPayload = {
      status: ready ? "ok" : "degraded",
      uptimeSeconds: uptimeSeconds(),
      version,
      db,
      jobs: {
        ok: jobsOk,
        overdueAfterMs: snapshot?.overdueAfterMs ?? DEFAULT_OVERDUE_AFTER_MS,
        overdueJobs,
        ...(snapshotError ? { error: snapshotError } : {}),
      },
    };
    res.status(ready ? 200 : 503).json(payload);
  });
}
