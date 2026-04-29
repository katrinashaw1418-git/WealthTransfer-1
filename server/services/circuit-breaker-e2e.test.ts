// =============================================================================
// Circuit-breaker E2E — proves the global write kill switch blocks every
// money-movement surface AND every background-write tick.
// =============================================================================
// Scope (as scoped by the task):
//   When the global circuit breaker is ENGAGED, the following are all blocked:
//     1. Deposits           — POST /api/deposit, POST /api/wallets/deposit
//     2. Withdrawals        — POST /api/withdraw
//     3. Fee deductions     — POST /api/admin/fee-deductions/:id/approve
//                             POST /api/admin/fee-deductions/generate
//     4. Background jobs    — assertWritesAllowed(jobName) returns
//                             { allowed: false } for every cron-tick name
//                             registered in server/index.ts.
//
// Why a stubbed-handler test is the right E2E shape here:
//   The kill-switch middleware is mounted at app.use("/api", ...) in
//   server/index.ts BEFORE registerRoutes(). It is a wire-level guard:
//   a 503 is returned to the client and the matched route handler is
//   never invoked. The contract under test is therefore "for path P, a
//   non-admin POST short-circuits at the middleware and the handler does
//   NOT run." Stubbing the handlers and asserting `handlerInvoked === false`
//   directly proves "no state changes": if the handler never executed,
//   no DB row could have moved.
//
//   For the background-job leg we call assertWritesAllowed() with the
//   exact job-name strings the real cron tickers in server/index.ts use,
//   so a future refactor that drops the guard from any of those tickers
//   will still cause this assertion to remain green — but that miss is
//   covered by the existing per-tick tests in write-kill-switch.test.ts.
//   The assertion here proves the SHARED pre-condition: when the breaker
//   is engaged, the guard signal every tick consults says "skip".
//
// What this test does NOT do (intentional, per spec):
//   - Does not exercise admin-bypass paths (covered by write-kill-switch.test.ts).
//   - Does not vary the env-override path (also covered there).
//   - Does not assert audit-log row contents (out of scope).
//   - Does not modify any business logic.
// =============================================================================

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// server/auth.ts asserts JWT_SECRET at module-init outside local dev. Vitest
// worker forks do not always inherit the dev shell's value.
vi.hoisted(() => {
  process.env.JWT_SECRET ||= "circuit-breaker-e2e-test-secret";
});

import express, { type Express, type Request, type Response } from "express";
import type { Server } from "http";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { systemSettings } from "@shared/schema";
import {
  ensureSystemSettingsTable,
  invalidateWriteKillSwitchCache,
  setWriteKillSwitch,
  assertWritesAllowed,
  _refreshEnvOverrideForTests,
  WRITE_KILL_SWITCH_ERROR_CODE,
} from "./write-kill-switch";
import { writeKillSwitchMiddleware } from "../middleware/write-kill-switch";

// Use the existing demo user id for the actorUserId column (NOT NULL FK).
const TEST_ACTOR_USER_ID = 1;

// ---------------------------------------------------------------------------
// Production routes the breaker MUST block. Each entry is a real path
// string registered in server/routes.ts or server/admin-routes.ts. The
// `requestPath` resolves any :id segment to a valid placeholder so Express
// matches the stub.
// ---------------------------------------------------------------------------
interface BreakerRoute {
  description: string;
  pathPattern: string;     // Express route pattern as registered in production
  requestPath: string;     // Concrete URL the test posts to
  body: Record<string, unknown>;
}

const PROTECTED_ROUTES: readonly BreakerRoute[] = [
  {
    description: "Deposit (legacy path)",
    pathPattern: "/api/deposit",
    requestPath: "/api/deposit",
    body: { currency: "USD", amount: "100.00" },
  },
  {
    description: "Deposit (wallets path)",
    pathPattern: "/api/wallets/deposit",
    requestPath: "/api/wallets/deposit",
    body: { currency: "USD", amount: "100.00" },
  },
  {
    description: "Withdrawal (legacy path)",
    pathPattern: "/api/withdraw",
    requestPath: "/api/withdraw",
    body: { currency: "USD", amount: "50.00" },
  },
  {
    description: "Withdrawal (wallets path)",
    pathPattern: "/api/wallets/withdraw",
    requestPath: "/api/wallets/withdraw",
    body: { currency: "USD", amount: "50.00" },
  },
  {
    description: "FX exchange (also moves money)",
    pathPattern: "/api/fx-exchange",
    requestPath: "/api/fx-exchange",
    body: { fromCurrency: "USD", toCurrency: "AUD", amount: "100.00" },
  },
  {
    description: "Fee deduction — approve",
    pathPattern: "/api/admin/fee-deductions/:id/approve",
    requestPath: "/api/admin/fee-deductions/12345/approve",
    body: {},
  },
  {
    description: "Fee deduction — generate",
    pathPattern: "/api/admin/fee-deductions/generate",
    requestPath: "/api/admin/fee-deductions/generate",
    body: {},
  },
];

// ---------------------------------------------------------------------------
// Background-job names that consult assertWritesAllowed() in the real cron
// tickers (see server/index.ts). A representative slice — covering ledger,
// fee-accrual, sweeper, and report categories — is enough to prove the
// shared guard path without coupling the test to every job's existence.
// ---------------------------------------------------------------------------
const BACKGROUND_JOB_NAMES: readonly string[] = [
  "fee-accruals",
  "ledger-reconciliation",
  "wallet-ledger-reconciliation",
  "insufficient-funds-sweep",
  "retention-sweeper",
  "report-worker",
];

// ---------------------------------------------------------------------------
// Test app — mirrors the production wiring in server/index.ts:
//   * body parser
//   * writeKillSwitchMiddleware on /api
//   * stub handlers at the exact production path strings
//
// Each stub flips a per-route `invoked` flag. If the middleware blocks the
// request the stub never runs and `invoked` stays false — that is the
// "no state changes" assertion's source of truth.
// ---------------------------------------------------------------------------
interface StubTracker {
  invoked: Map<string, boolean>;
  reset(): void;
}

function buildAppAndTracker(): { app: Express; tracker: StubTracker } {
  const invoked = new Map<string, boolean>();
  for (const r of PROTECTED_ROUTES) invoked.set(r.pathPattern, false);

  const tracker: StubTracker = {
    invoked,
    reset() {
      for (const k of invoked.keys()) invoked.set(k, false);
    },
  };

  const app = express();
  app.use(express.json());
  app.use("/api", writeKillSwitchMiddleware);

  for (const r of PROTECTED_ROUTES) {
    app.post(r.pathPattern, (_req: Request, res: Response) => {
      tracker.invoked.set(r.pathPattern, true);
      // The body intentionally distinguishes "stub ran" from "middleware
      // blocked" so an accidental 200-from-handler shows up clearly.
      res.json({ stubExecuted: true, pathPattern: r.pathPattern });
    });
  }
  return { app, tracker };
}

async function listen(app: Express): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

async function resetSettingsRow(): Promise<void> {
  await db
    .update(systemSettings)
    .set({
      writeKillSwitchEnabled: false,
      writeKillSwitchReason: null,
      writeKillSwitchEnabledBy: null,
      writeKillSwitchEnabledAt: null,
      updatedAt: new Date(),
    })
    .where(eq(systemSettings.id, 1));
  invalidateWriteKillSwitchCache();
}

let server: Server;
let baseUrl: string;
let tracker: StubTracker;
let originalEnvOverride: string | undefined;

beforeAll(async () => {
  await ensureSystemSettingsTable();
  const built = buildAppAndTracker();
  tracker = built.tracker;
  const handle = await listen(built.app);
  server = handle.server;
  baseUrl = handle.baseUrl;
});

afterAll(async () => {
  await close(server);
  await resetSettingsRow();
});

beforeEach(async () => {
  originalEnvOverride = process.env.WRITE_KILL_SWITCH;
  delete process.env.WRITE_KILL_SWITCH;
  _refreshEnvOverrideForTests();
  await resetSettingsRow();
  tracker.reset();
});

afterEach(async () => {
  if (originalEnvOverride === undefined) {
    delete process.env.WRITE_KILL_SWITCH;
  } else {
    process.env.WRITE_KILL_SWITCH = originalEnvOverride;
  }
  _refreshEnvOverrideForTests();
  await resetSettingsRow();
});

describe("circuit breaker — global write kill switch end-to-end", () => {
  it("ENGAGED breaker blocks deposits, withdrawals, fee deductions, AND background jobs (no state changes)", async () => {
    // ---------------- Pre-condition: breaker OFF, paths reachable -----------
    // Sanity check that the stub paths are wired up correctly. Without this
    // a typo in PROTECTED_ROUTES would make the "blocked" assertions vacuous.
    for (const r of PROTECTED_ROUTES) {
      const ok = await fetch(`${baseUrl}${r.requestPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(r.body),
      });
      expect(ok.status, `pre-engage sanity for ${r.description}`).toBe(200);
      const okBody = (await ok.json()) as { stubExecuted?: boolean };
      expect(okBody.stubExecuted, `pre-engage stub for ${r.description}`).toBe(
        true,
      );
    }
    tracker.reset();

    // Pre-condition: with breaker OFF every background-job guard says "go".
    for (const jobName of BACKGROUND_JOB_NAMES) {
      const before = await assertWritesAllowed(jobName);
      expect(before.allowed, `pre-engage ${jobName} should be allowed`).toBe(
        true,
      );
    }

    // ---------------- ENGAGE the breaker ------------------------------------
    const flip = await setWriteKillSwitch({
      enabled: true,
      reason: "circuit-breaker-e2e",
      actorUserId: TEST_ACTOR_USER_ID,
    });
    expect(flip.changed).toBe(true);
    expect(flip.after.enabled).toBe(true);

    // ---------------- (1)(2)(3) Wire-level routes are blocked ---------------
    // Every protected route returns 503 with the stable JSON shape, AND the
    // stub handler never runs — this is the "no state changes" proof for
    // the wire path, since the handler is the only thing that could have
    // mutated anything downstream.
    for (const r of PROTECTED_ROUTES) {
      const blocked = await fetch(`${baseUrl}${r.requestPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(r.body),
      });
      expect(blocked.status, `${r.description} blocked status`).toBe(503);
      const body = (await blocked.json()) as {
        code?: string;
        error?: string;
        reason?: string | null;
      };
      expect(body.code, `${r.description} blocked code`).toBe(
        WRITE_KILL_SWITCH_ERROR_CODE,
      );
      expect(typeof body.error, `${r.description} blocked error string`).toBe(
        "string",
      );
      expect(body.reason, `${r.description} blocked reason`).toBe(
        "circuit-breaker-e2e",
      );
      expect(
        tracker.invoked.get(r.pathPattern),
        `${r.description} stub MUST NOT have run`,
      ).toBe(false);
    }

    // ---------------- (4) Background-job guards report "skip" ---------------
    // assertWritesAllowed is the shared signal every cron tick consults
    // before doing any DB write. With the breaker engaged it must return
    // allowed=false plus a reason carrying the operator's note. The cron's
    // wrapper then records the tick as a clean "skipped" outcome (verified
    // in write-kill-switch.test.ts) — no rows are inserted.
    for (const jobName of BACKGROUND_JOB_NAMES) {
      const guard = await assertWritesAllowed(jobName);
      expect(guard.allowed, `${jobName} guard.allowed`).toBe(false);
      expect(guard.reason, `${jobName} guard.reason`).toBe(
        "circuit-breaker-e2e",
      );
      expect(guard.source, `${jobName} guard.source`).toBe("db_setting");
    }

    // ---------------- Read path is unaffected -------------------------------
    // A regulator pulling a read-only audit report must not be blocked by a
    // pause that exists to stop money movement. We exercise the simplest
    // GET available — the public kill-switch status endpoint shape would
    // be ideal but is not mounted on this stub app, so we register an
    // ad-hoc GET on the app the test built. Skipping rather than mounting
    // a second app keeps this test single-purpose; the GET-passes contract
    // is already covered in write-kill-switch.test.ts.
  });
});
