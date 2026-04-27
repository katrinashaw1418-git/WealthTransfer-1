// =============================================================================
// Task #168 — automated tests that prove the kill switches stop money movement
// =============================================================================
// The kill-switch service, route guards, and cron skips were originally
// added without automated coverage. A future refactor that:
//
//   * adds a new money-movement endpoint and forgets `assertKillSwitchOff`,
//   * tweaks the 503 envelope so clients can no longer parse it,
//   * silently drops the cron skip so accruals/sweeps run while operators
//     have explicitly stopped them,
//
// would all leave the service "looking healthy" while quietly bypassing
// the kill switches. This suite locks the contract in place:
//
//   1. EVERY guarded HTTP endpoint returns HTTP 503 with the canonical
//      `{ error: "operation_disabled", switch: <key> }` body when the
//      switch it depends on is engaged. We exercise the master
//      `transactions` switch (which blocks deposits, withdrawals, fees,
//      FX, investments, wallet-transfer) AND the specific switches
//      (`deposits`, `withdrawals`).
//
//   2. The fee-engine `settleApprovedDeduction` and `reverseSettledDeduction`
//      throw KillSwitchActiveError when either `fee_deductions` or the
//      master `transactions` switch is engaged — enforced BEFORE any DB
//      transaction begins, so a hit produces no half-state. We assert the
//      throw happens by passing a non-existent deductionId; without the
//      guard the error would be `Deduction not found` (404), not the
//      kill-switch error (503).
//
//   3. The fee-accruals and insufficient-funds-sweep cron wrappers
//      return their canonical "skipped: kill switch fee_deductions ..."
//      summary line when `fee_deductions` is engaged, and crucially do
//      NOT call the inner accrual/sweep work. The sweep wrapper has an
//      injectable `runSweep` so we can assert the inner function was
//      never invoked.
//
//   4. Toggling a switch via `setKillSwitchState` writes BOTH an
//      `audit_logs` row (entityType='kill_switch', entityId=<key>) AND
//      an `operator_alerts` row (source='kill-switch') so the off-hours
//      paging and admin audit trail both fire.
//
//   5. The env-var override (DISABLE_TRANSACTIONS, etc.) forces the
//      switch ON regardless of the DB row, AND `setKillSwitchState`
//      refuses to toggle while the env var is set (returns 409). This is
//      the redeploy-free escape hatch — a regression here would silently
//      break the operations team's last-resort kill.
//
// Cleanup mirrors the other DB-using tests in this directory: every
// inserted row (kill_switches, audit_logs, operator_alerts, transactions,
// users, etc.) is removed in afterAll so reruns are idempotent against
// the dev database. We deliberately do NOT delete audit_logs at all —
// audit_logs is immutable at the DB level (Task #149), so we instead
// scope each assertion to a unique-per-run identifier.
// =============================================================================

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Auth module asserts JWT_SECRET at import time outside local-dev. ES module
// imports are hoisted above plain statements, so the env var must be set
// inside `vi.hoisted` to land before any transitive import of server/auth.
vi.hoisted(() => {
  process.env.JWT_SECRET ||= "kill-switch-test-secret";
});

import express from "express";
import request from "supertest";
import { and, desc, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { db } from "../db";
import {
  auditLogs,
  killSwitches,
  operatorAlerts,
  users,
  type KillSwitchKey,
} from "@shared/schema";
import {
  KillSwitchActiveError,
  assertKillSwitchOff,
  getKillSwitchState,
  invalidateKillSwitchCache,
  isKillSwitchActive,
  killSwitchEnvVarName,
  killSwitchKeyValues,
  setKillSwitchState,
} from "./kill-switch";
import { reverseSettledDeduction, settleApprovedDeduction } from "./fee-engine";
import {
  FEE_ACCRUALS_KILL_SWITCH_SKIP_NOTE,
  SWEEP_KILL_SWITCH_SKIP_NOTE,
  runFeeAccrualsCronOnce,
  runInsufficientFundsSweepCronOnce,
} from "./cron-fee-deductions";
import { signToken } from "../auth";
import { registerRoutes } from "../routes";
import type { Server } from "http";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------
// One verified user is enough for the HTTP coverage — the kill-switch guard
// runs after auth + KYC but before any handler-specific work, so we don't
// need separate users per endpoint. The user is created once in beforeAll
// and torn down in afterAll.
const TEST_USERNAME = "__kill_switch_test_user__";
const TEST_EMAIL = "kill-switch-test@test.invalid";

let testUserId: number;
let testToken: string;
let testApp: express.Express;
let httpServer: Server;

async function ensureTestUser(): Promise<number> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.username, TEST_USERNAME));
  if (existing) {
    // KYC must be verified — money-movement routes call requireKyc() before
    // the kill-switch guard. If a previous run left it as anything else the
    // guard tests would all fail with 403 instead of 503.
    if (existing.kycStatus !== "verified") {
      await db
        .update(users)
        .set({ kycStatus: "verified", emailVerified: true })
        .where(eq(users.id, existing.id));
    }
    return existing.id;
  }
  const [created] = await db
    .insert(users)
    .values({
      username: TEST_USERNAME,
      email: TEST_EMAIL,
      password: "not-a-real-password",
      firstName: "KillSwitch",
      lastName: "Test",
      kycStatus: "verified",
      emailVerified: true,
      role: "client",
    })
    .returning();
  return created.id;
}

// Force a switch into either ON or OFF via direct DB upsert — bypasses
// `setKillSwitchState` so the toggle side-effect tests (audit log +
// operator alert) can stand on their own without being tripped by setup
// rows from the HTTP/cron tests.
async function forceSwitch(key: KillSwitchKey, enabled: boolean): Promise<void> {
  await db
    .insert(killSwitches)
    .values({
      switchKey: key,
      enabled,
      reason: enabled ? "test fixture engaged" : "test fixture cleared",
      lastToggledByUserId: testUserId,
      lastToggledAt: new Date(),
    })
    .onConflictDoUpdate({
      target: killSwitches.switchKey,
      set: {
        enabled,
        reason: enabled ? "test fixture engaged" : "test fixture cleared",
        lastToggledByUserId: testUserId,
        lastToggledAt: new Date(),
      },
    });
  invalidateKillSwitchCache();
}

async function clearAllSwitches(): Promise<void> {
  for (const k of killSwitchKeyValues) {
    await forceSwitch(k, false);
  }
}

beforeAll(async () => {
  // Defensive — if a stale DISABLE_* env var leaked in from the dev shell
  // every assertion below would falsely "pass" by returning 503 for the
  // wrong reason. Wipe them up front and restore in afterAll.
  for (const k of killSwitchKeyValues) {
    delete process.env[killSwitchEnvVarName(k)];
  }

  testUserId = await ensureTestUser();
  testToken = signToken({
    userId: testUserId,
    username: TEST_USERNAME,
    email: TEST_EMAIL,
    role: "client",
  });

  // Build a real Express app and mount the production routes. We rely on
  // the same trust-proxy + json middleware setup that server/index.ts
  // uses, so the rate limiter keys by X-Forwarded-For (we set a fresh
  // IP on every request below to avoid the 30-req/5-min limit getting
  // anywhere near the run cap).
  testApp = express();
  testApp.set("trust proxy", true);
  testApp.use(express.json());
  testApp.use(express.urlencoded({ extended: false }));
  httpServer = await registerRoutes(testApp);

  await clearAllSwitches();
}, 60_000);

afterAll(async () => {
  await clearAllSwitches();
  await db.delete(killSwitches);
  // Remove operator_alerts rows we generated under the kill-switch source so
  // a flapping local environment doesn't accumulate fixture rows.
  await db.delete(operatorAlerts).where(eq(operatorAlerts.source, "kill-switch"));
  // audit_logs is immutable (Task #149) — we deliberately leave kill-switch
  // audit rows in place. They are scoped to entityType='kill_switch' and
  // accumulate harmlessly between runs.
  //
  // The fixture user is left in place too, matching the convention used by
  // advice-write-gate.test.ts / insufficient-funds-sweep.test.ts: real users
  // accumulate too many incidental FK referrers (wallets, portfolio_snapshots,
  // audit_logs) for a clean delete to be safe, and the next run reuses the
  // same username idempotently via ensureTestUser().
  if (httpServer && typeof httpServer.close === "function") {
    httpServer.close();
  }
});

beforeEach(async () => {
  // Always start each test with all switches OFF so a prior test leaving
  // one engaged cannot mask the next test's setup.
  await clearAllSwitches();
});

// Each request gets a unique X-Forwarded-For so the per-IP money-movement
// rate limiter never trips during the test run. Counter is process-local;
// it never has to survive a restart.
let ipCounter = 0;
function nextTestIp(): string {
  ipCounter++;
  // Keep within a private range so this can never collide with a real IP
  // policy decision somewhere in the request pipeline.
  return `10.99.${Math.floor(ipCounter / 256) % 256}.${ipCounter % 256}`;
}

function authedPost(path: string, body: unknown = {}) {
  return request(testApp)
    .post(path)
    .set("Authorization", `Bearer ${testToken}`)
    .set("X-Forwarded-For", nextTestIp())
    .send(body);
}

// ---------------------------------------------------------------------------
// 1. Guarded HTTP endpoints
// ---------------------------------------------------------------------------
// Each of these routes calls `assertKillSwitchOff(...)` at the top of its
// handler. The contract: when the named switch is ON the response is
// HTTP 503 with body `{ error: "operation_disabled", switch: <key> }`,
// and crucially the underlying handler logic never runs (no transactions
// row, no ledger entry, no rate-limit consumption beyond the request).
//
// We keep the body of each request minimal — the schemas would reject the
// payloads on validation, but the kill-switch guard fires BEFORE Zod
// parsing so the 503 still wins. That is itself part of the contract.
// ---------------------------------------------------------------------------
type GuardedRoute = {
  label: string;
  path: string;
  body: Record<string, unknown>;
  // The most-specific switch this route honours. The test asserts the 503
  // body's `switch` field matches this key when only this switch is on.
  specificSwitch?: KillSwitchKey;
};

const MONEY_MOVEMENT_ROUTES: GuardedRoute[] = [
  {
    label: "FX exchange",
    path: "/api/fx-exchange",
    body: { fromCurrency: "USD", toCurrency: "AUD", amount: "10" },
  },
  {
    label: "Deposit (canonical)",
    path: "/api/deposit",
    body: { currency: "USD", amount: "10" },
    specificSwitch: "deposits",
  },
  {
    label: "Deposit (legacy /wallets path)",
    path: "/api/wallets/deposit",
    body: { currency: "USD", amount: "10" },
    specificSwitch: "deposits",
  },
  {
    label: "Withdraw (canonical)",
    path: "/api/withdraw",
    body: { currency: "USD", amount: "10" },
    specificSwitch: "withdrawals",
  },
  {
    label: "Withdraw (legacy /wallets path)",
    path: "/api/wallets/withdraw",
    body: { currency: "USD", amount: "10" },
    specificSwitch: "withdrawals",
  },
  {
    label: "Investment buy",
    path: "/api/investments",
    body: { productId: 1, amount: "100" },
  },
  {
    label: "Wallet transfer (FX)",
    path: "/api/wallets/transfer",
    body: { fromCurrency: "USD", toCurrency: "AUD", amount: "10" },
  },
];

describe("HTTP money-movement guards (Task #168)", () => {
  describe("master `transactions` switch blocks every money-movement endpoint", () => {
    beforeEach(async () => {
      await forceSwitch("transactions", true);
    });

    for (const route of MONEY_MOVEMENT_ROUTES) {
      it(`${route.label} → 503 operation_disabled / switch=transactions`, async () => {
        const res = await authedPost(route.path, route.body);
        expect(res.status).toBe(503);
        // assertKillSwitchOff iterates the keys in argument order and throws
        // on the first hit. Even routes that pass their specific switch
        // first (e.g. ("deposits","transactions")) fall through to
        // `transactions` when only the master is on, so EVERY guarded route
        // must report switch='transactions' in this scenario.
        expect(res.body).toEqual({
          error: "operation_disabled",
          switch: "transactions",
        });
      });
    }
  });

  describe("specific switches block their own endpoints with the most-specific name", () => {
    it("`deposits` blocks both /api/deposit and /api/wallets/deposit and reports switch=deposits", async () => {
      await forceSwitch("deposits", true);

      const canonical = await authedPost("/api/deposit", {
        currency: "USD",
        amount: "10",
      });
      expect(canonical.status).toBe(503);
      expect(canonical.body).toEqual({
        error: "operation_disabled",
        switch: "deposits",
      });

      const legacy = await authedPost("/api/wallets/deposit", {
        currency: "USD",
        amount: "10",
      });
      expect(legacy.status).toBe(503);
      expect(legacy.body).toEqual({
        error: "operation_disabled",
        switch: "deposits",
      });
    });

    it("`withdrawals` blocks both /api/withdraw and /api/wallets/withdraw and reports switch=withdrawals", async () => {
      await forceSwitch("withdrawals", true);

      const canonical = await authedPost("/api/withdraw", {
        currency: "USD",
        amount: "10",
      });
      expect(canonical.status).toBe(503);
      expect(canonical.body).toEqual({
        error: "operation_disabled",
        switch: "withdrawals",
      });

      const legacy = await authedPost("/api/wallets/withdraw", {
        currency: "USD",
        amount: "10",
      });
      expect(legacy.status).toBe(503);
      expect(legacy.body).toEqual({
        error: "operation_disabled",
        switch: "withdrawals",
      });
    });

    it("`deposits` does NOT block FX/withdraw/investment/transfer (negative coverage)", async () => {
      // Spot-check that an unrelated specific switch does not accidentally
      // block other endpoints via a misconfigured guard. We don't care
      // what status these return — just that it's NOT 503/operation_disabled.
      await forceSwitch("deposits", true);

      for (const route of [
        "/api/fx-exchange",
        "/api/withdraw",
        "/api/investments",
        "/api/wallets/transfer",
      ]) {
        const res = await authedPost(route, {
          fromCurrency: "USD",
          toCurrency: "AUD",
          currency: "USD",
          amount: "10",
          productId: 1,
        });
        if (res.status === 503) {
          // If we got 503 it must NOT be the kill-switch envelope.
          expect(res.body.error).not.toBe("operation_disabled");
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Fee-engine guard contract
// ---------------------------------------------------------------------------
// settleApprovedDeduction + reverseSettledDeduction throw
// KillSwitchActiveError BEFORE entering their DB transaction. We pass an
// obviously-bogus deductionId — without the guard, those functions would
// throw `Deduction not found` (status=404). With the guard active, they
// must throw KillSwitchActiveError carrying the engaged switch key.
// ---------------------------------------------------------------------------
const BOGUS_DEDUCTION_ID = -42;

describe("fee-engine guard (Task #168)", () => {
  it("settleApprovedDeduction throws KillSwitchActiveError when fee_deductions is on", async () => {
    await forceSwitch("fee_deductions", true);
    await expect(
      settleApprovedDeduction({
        deductionId: BOGUS_DEDUCTION_ID,
        approverUserId: testUserId,
      }),
    ).rejects.toMatchObject({
      name: "KillSwitchActiveError",
      switchKey: "fee_deductions",
      status: 503,
    });
  });

  it("settleApprovedDeduction throws KillSwitchActiveError (switchKey=transactions) when only the master is on", async () => {
    // The fee engine calls assertKillSwitchOff("fee_deductions", "transactions").
    // With only `transactions` engaged, the iteration falls through to it
    // and throws with switchKey='transactions'. This proves the master
    // switch covers fee deductions even when the specific switch is off.
    await forceSwitch("transactions", true);
    await expect(
      settleApprovedDeduction({
        deductionId: BOGUS_DEDUCTION_ID,
        approverUserId: testUserId,
      }),
    ).rejects.toMatchObject({
      name: "KillSwitchActiveError",
      switchKey: "transactions",
      status: 503,
    });
  });

  it("reverseSettledDeduction throws KillSwitchActiveError when fee_deductions is on", async () => {
    await forceSwitch("fee_deductions", true);
    await expect(
      reverseSettledDeduction({
        deductionId: BOGUS_DEDUCTION_ID,
        reverserUserId: testUserId,
        reason: "test",
      }),
    ).rejects.toMatchObject({
      name: "KillSwitchActiveError",
      switchKey: "fee_deductions",
      status: 503,
    });
  });

  it("reverseSettledDeduction throws KillSwitchActiveError (switchKey=transactions) when only the master is on", async () => {
    await forceSwitch("transactions", true);
    await expect(
      reverseSettledDeduction({
        deductionId: BOGUS_DEDUCTION_ID,
        reverserUserId: testUserId,
        reason: "test",
      }),
    ).rejects.toMatchObject({
      name: "KillSwitchActiveError",
      switchKey: "transactions",
      status: 503,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Cron skip behaviour
// ---------------------------------------------------------------------------
// Both daily fee-deduction crons return a recognisable "skipped: ..."
// summary string when fee_deductions is engaged. The summary is what
// `withBackgroundJobRunRecord` records on the dashboard row, so a
// regression here would silently be invisible to operators (the cron
// would simply log "completed" with no work done, indistinguishable
// from a "nothing to do" tick).
//
// For the sweep we additionally inject a spy `runSweep` to prove the
// inner sweep is NEVER invoked while the switch is on — the strongest
// contract: "no settlements attempted".
// ---------------------------------------------------------------------------
describe("cron skip behaviour (Task #168)", () => {
  it("runFeeAccrualsCronOnce returns the canonical skip note when fee_deductions is on", async () => {
    await forceSwitch("fee_deductions", true);
    const summary = await runFeeAccrualsCronOnce({ now: new Date() });
    expect(summary).toBe(FEE_ACCRUALS_KILL_SWITCH_SKIP_NOTE);
    // Sanity: the canonical note matches the documented contract — the
    // task brief calls for an explicit "skipped" line so a future change
    // that swallows the engagement into a generic "completed" string
    // breaks here.
    expect(summary).toContain("skipped");
    expect(summary).toContain("fee_deductions");
  });

  it("runInsufficientFundsSweepCronOnce returns the canonical skip note AND never invokes the inner sweep", async () => {
    await forceSwitch("fee_deductions", true);
    const sweepSpy = vi.fn(async () => ({
      checked: 0,
      settled: 0,
      stillInsufficient: 0,
      errors: 0,
      notificationsSent: 0,
      notificationsSkippedDueToDebounce: 0,
      notificationsFailed: 0,
    }));

    const summary = await runInsufficientFundsSweepCronOnce({
      runSweep: sweepSpy,
    });
    expect(summary).toBe(SWEEP_KILL_SWITCH_SKIP_NOTE);
    expect(summary).toContain("no settlements attempted");
    // The strongest assertion: the inner sweep — the function that would
    // actually attempt settlement work — must NOT run while the switch
    // is engaged. A "ran but did nothing" pass would still consume DB
    // connections and log noise.
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it("runInsufficientFundsSweepCronOnce DOES invoke the inner sweep when fee_deductions is off", async () => {
    // Negative case so a regression where the helper always skips is
    // caught — the previous test passes whether the kill switch logic
    // works or whether the helper is permanently broken.
    const sweepSpy = vi.fn(async () => ({
      checked: 0,
      settled: 0,
      stillInsufficient: 0,
      errors: 0,
      notificationsSent: 0,
      notificationsSkippedDueToDebounce: 0,
      notificationsFailed: 0,
    }));
    const summary = await runInsufficientFundsSweepCronOnce({
      runSweep: sweepSpy,
    });
    expect(sweepSpy).toHaveBeenCalledTimes(1);
    // The summary should be the per-key counts joined — not the skip note.
    expect(summary).not.toBe(SWEEP_KILL_SWITCH_SKIP_NOTE);
    expect(summary).toContain("checked=0");
  });
});

// ---------------------------------------------------------------------------
// 4. Toggle side-effects (audit log + operator alert)
// ---------------------------------------------------------------------------
// `setKillSwitchState` MUST write both an audit_logs row (the who-did-what
// trail) AND an operator_alerts row (off-hours paging). Either one going
// silent is a compliance break that the calling admin endpoint cannot
// detect on its own.
// ---------------------------------------------------------------------------
describe("setKillSwitchState side-effects (Task #168)", () => {
  it("engaging a switch writes an audit_logs row AND an operator_alerts row", async () => {
    await clearAllSwitches();
    const beforeAuditCount = (
      await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, "kill_switch"),
            eq(auditLogs.entityId, "transactions"),
            eq(auditLogs.action, "kill_switch_enabled"),
          ),
        )
    ).length;
    const beforeAlertCount = (
      await db
        .select({ id: operatorAlerts.id })
        .from(operatorAlerts)
        .where(eq(operatorAlerts.source, "kill-switch"))
    ).length;

    await setKillSwitchState({
      key: "transactions",
      enabled: true,
      reason: "Task #168 audit-log assertion",
      actorUserId: testUserId,
      ipAddress: "203.0.113.7",
    });

    // Audit row written under entityType='kill_switch', entityId='transactions'.
    const auditRows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "kill_switch"),
          eq(auditLogs.entityId, "transactions"),
          eq(auditLogs.action, "kill_switch_enabled"),
        ),
      )
      .orderBy(desc(auditLogs.id));
    expect(auditRows.length).toBe(beforeAuditCount + 1);
    const newest = auditRows[0];
    expect(newest.userId).toBe(testUserId);
    expect(newest.ipAddress).toBe("203.0.113.7");
    const meta = newest.metadata as Record<string, unknown>;
    expect(meta).toMatchObject({
      switchKey: "transactions",
      reason: "Task #168 audit-log assertion",
    });
    // Before/after diff present so the audit reader can render a clean
    // change view without re-querying the table.
    expect((meta as any).before).toMatchObject({ enabled: false });
    expect((meta as any).after).toMatchObject({ enabled: true });

    // Operator alert row written under source='kill-switch'.
    const alertRows = await db
      .select()
      .from(operatorAlerts)
      .where(eq(operatorAlerts.source, "kill-switch"))
      .orderBy(desc(operatorAlerts.id));
    expect(alertRows.length).toBe(beforeAlertCount + 1);
    const alert = alertRows[0];
    expect(alert.severity).toBe("warning");
    expect(alert.title).toContain("ENGAGED");
    expect(alert.title).toContain("Transactions");
    expect(alert.details).toMatchObject({
      switchKey: "transactions",
      enabled: true,
      actorUserId: testUserId,
    });
  });

  it("disengaging a switch also writes audit + operator alert rows (info severity)", async () => {
    // Pre-engage so the disengage is a real state change.
    await setKillSwitchState({
      key: "deposits",
      enabled: true,
      reason: "set up for clear test",
      actorUserId: testUserId,
      ipAddress: null,
    });
    const beforeDisableAlertCount = (
      await db
        .select({ id: operatorAlerts.id })
        .from(operatorAlerts)
        .where(eq(operatorAlerts.source, "kill-switch"))
    ).length;

    await setKillSwitchState({
      key: "deposits",
      enabled: false,
      reason: "incident resolved",
      actorUserId: testUserId,
      ipAddress: "203.0.113.7",
    });

    const disableAudit = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "kill_switch"),
          eq(auditLogs.entityId, "deposits"),
          eq(auditLogs.action, "kill_switch_disabled"),
        ),
      )
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(disableAudit.length).toBe(1);
    expect(disableAudit[0].userId).toBe(testUserId);

    const alertsAfter = await db
      .select()
      .from(operatorAlerts)
      .where(eq(operatorAlerts.source, "kill-switch"))
      .orderBy(desc(operatorAlerts.id));
    expect(alertsAfter.length).toBe(beforeDisableAlertCount + 1);
    const newAlert = alertsAfter[0];
    // Disengage = info severity, ENGAGED → CLEARED in title.
    expect(newAlert.severity).toBe("info");
    expect(newAlert.title).toContain("CLEARED");
    expect(newAlert.title).toContain("Deposits");
  });

  it("setKillSwitchState refuses an empty reason (400)", async () => {
    // Reason is required so the audit + alert payload always carries
    // operator intent. A blank reason would defeat the entire point of
    // the audit trail.
    await expect(
      setKillSwitchState({
        key: "transactions",
        enabled: true,
        reason: "   ",
        actorUserId: testUserId,
        ipAddress: null,
      }),
    ).rejects.toMatchObject({ message: "Reason is required", status: 400 });
  });

  it("setKillSwitchState invalidates the cache so the next guard read picks up the new state", async () => {
    await clearAllSwitches();
    // Prime the cache with "transactions OFF".
    expect(await isKillSwitchActive("transactions")).toBe(false);
    await setKillSwitchState({
      key: "transactions",
      enabled: true,
      reason: "cache invalidation test",
      actorUserId: testUserId,
      ipAddress: null,
    });
    // Without cache invalidation this would still report false until the
    // 5s TTL elapses — which would let real money-movement traffic pass
    // for several seconds after the toggle.
    expect(await isKillSwitchActive("transactions")).toBe(true);
    // assertKillSwitchOff also picks up the new state immediately.
    await expect(assertKillSwitchOff("transactions")).rejects.toBeInstanceOf(
      KillSwitchActiveError,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Env-var override behaviour
// ---------------------------------------------------------------------------
// The DISABLE_<KEY> env vars are the redeploy-free escape hatch — when
// truthy they FORCE the switch ON regardless of the DB row. They must
// also block admin toggles entirely (409) so an admin doesn't unwittingly
// "clear" a switch the env var still pins on.
// ---------------------------------------------------------------------------
describe("env-var override (Task #168)", () => {
  // Save and restore for safety even though beforeAll already wiped these.
  let savedEnv: Partial<Record<string, string>> = {};
  beforeEach(() => {
    savedEnv = {};
    for (const k of killSwitchKeyValues) {
      savedEnv[killSwitchEnvVarName(k)] =
        process.env[killSwitchEnvVarName(k)];
    }
  });
  afterEach(() => {
    for (const k of killSwitchKeyValues) {
      const name = killSwitchEnvVarName(k);
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name]!;
    }
    invalidateKillSwitchCache();
  });

  it("DISABLE_TRANSACTIONS=true forces the switch ON even with no DB row engaged", async () => {
    await clearAllSwitches();
    process.env.DISABLE_TRANSACTIONS = "true";
    invalidateKillSwitchCache();

    expect(await isKillSwitchActive("transactions")).toBe(true);
    const state = await getKillSwitchState("transactions");
    expect(state.enabled).toBe(true);
    expect(state.envForced).toBe(true);

    // And the HTTP guard agrees — money-movement endpoints return 503.
    const res = await authedPost("/api/fx-exchange", {
      fromCurrency: "USD",
      toCurrency: "AUD",
      amount: "10",
    });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: "operation_disabled",
      switch: "transactions",
    });
  });

  it("setKillSwitchState refuses to toggle an env-forced switch (409)", async () => {
    process.env.DISABLE_DEPOSITS = "1";
    invalidateKillSwitchCache();

    // Trying to ENGAGE while env-forced is also rejected — the audit
    // trail would otherwise misleadingly attribute the engage to the
    // admin user, when in reality the env var has been the source of
    // truth since boot.
    await expect(
      setKillSwitchState({
        key: "deposits",
        enabled: true,
        reason: "should be rejected",
        actorUserId: testUserId,
        ipAddress: null,
      }),
    ).rejects.toMatchObject({ status: 409 });

    // And clearing is rejected too — operators must remove the env var
    // and redeploy to release the switch.
    await expect(
      setKillSwitchState({
        key: "deposits",
        enabled: false,
        reason: "should also be rejected",
        actorUserId: testUserId,
        ipAddress: null,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

// ---------------------------------------------------------------------------
// Compile-time guard: kept here so a future addition to KillSwitchKey is
// flagged at build time when the test suite hasn't been updated to cover
// the new key. Without this, adding e.g. `crypto_withdrawals` to the
// enum could ship without any test exercising its guard.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _coveredKeys: Record<KillSwitchKey, true> = {
  transactions: true,
  deposits: true,
  withdrawals: true,
  fee_deductions: true,
};

// ---------------------------------------------------------------------------
// 6. Entry-point coverage walk (Task #183)
// ---------------------------------------------------------------------------
// The compile-time `_coveredKeys` guard above catches the case where a new
// KillSwitchKey lands without a test. This block catches the symmetric
// failure mode: a new MONEY-MOVEMENT FUNCTION (the kind of code that
// actually moves balances around) lands in `server/services/` without a
// kill-switch guard at all, so engaging the switch leaves the code path
// silently un-blocked.
//
// The check is intentionally a static walk of `server/services/*.ts`
// rather than a runtime exercise: enumerating every callsite at runtime
// would mean spinning up a real money-movement transaction per function,
// which the kill-switch guard would (correctly) refuse to let proceed,
// leaving us nothing to assert against. A grep-style scan over the
// service source files gives us the strong "fail when a guard is missing"
// signal while keeping the test cheap and DB-free.
//
// MATCHING POLICY
//   We scan every `export function` / `export async function` whose name
//   (case-insensitive) contains one of the canonical money-movement verbs:
//     deposit, withdraw, transfer, settle, post, credit, debit
//   For each match we classify it as one of:
//
//     guarded                       — function body calls assertKillSwitchOff(...)
//     allowlisted_primitive         — low-level callee that is reachable ONLY
//                                     through callers that themselves call
//                                     assertKillSwitchOff. Adding a guard
//                                     directly here would double-fire alerts
//                                     and obscure WHICH entry-point engaged
//                                     the switch in the operator alert
//                                     payload.
//     allowlisted_not_money_movement — function name happens to contain a
//                                     verb (e.g. "Posting" in
//                                     runPostingReceiptInvariantCheck) but
//                                     the function does not write balances.
//                                     Read-only checks live here.
//
// FAILURE MODES THE TEST CATCHES
//   * A new exported function whose name matches the verb pattern but is
//     not in the registry → fail with a message telling the author exactly
//     what to do (add a guard, or register it as a primitive/non-mm with
//     a documented reason).
//   * A registry entry classified `guarded` whose body no longer contains
//     `assertKillSwitchOff(` → fail (a refactor silently dropped the guard).
//   * A registry entry classified `allowlisted_not_money_movement` whose
//     body now does call `assertKillSwitchOff(` → fail (the function now
//     looks like an entry point — re-classify it as `guarded`).
//   * A registry entry that no longer corresponds to any source-file
//     export → fail (the function was renamed/removed; clean up the
//     registry so the doc-of-record stays accurate).
//
// HOW TO EXTEND
//   When you add a new money-movement entry point:
//     1. Call `await assertKillSwitchOff(<specific>, "transactions")` at
//        the top of the function body, BEFORE any DB write.
//     2. Add it to KILL_SWITCH_ENTRY_POINT_REGISTRY below as
//        `{ classification: "guarded", reason: "<one-line summary>" }`.
//     3. Add an HTTP/throw assertion to the appropriate `describe(...)`
//        block above (Section 1, 2, or 3) so engagement actually surfaces
//        as 503 / KillSwitchActiveError / canonical skip note.
// ---------------------------------------------------------------------------
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVICES_DIR = path.dirname(fileURLToPath(import.meta.url));
const MONEY_MOVEMENT_VERB_RE = /(deposit|withdraw|transfer|settle|post|credit|debit)/i;

// Single source of truth for every money-movement-named export. Reviewers
// can read this map top-to-bottom to see what is in scope at a glance.
// New entry points MUST be classified here — the test below fails closed
// on any unclassified match.
type EntryPointClassification =
  | "guarded"
  | "allowlisted_primitive"
  | "allowlisted_not_money_movement";

const KILL_SWITCH_ENTRY_POINT_REGISTRY: Record<
  string,
  { classification: EntryPointClassification; reason: string }
> = {
  "fee-engine.ts:settleApprovedDeduction": {
    classification: "guarded",
    reason:
      "Fee settlement entry point. Calls assertKillSwitchOff('fee_deductions', 'transactions') before opening its DB tx.",
  },
  "fee-engine.ts:reverseSettledDeduction": {
    classification: "guarded",
    reason:
      "Fee reversal entry point. Calls assertKillSwitchOff('fee_deductions', 'transactions') before opening its DB tx.",
  },
  "ledger.ts:postLedgerEntries": {
    classification: "allowlisted_primitive",
    reason:
      "Lowest-level ledger primitive — the only function permitted to insert into ledger_entries. Every caller (HTTP money-movement routes in routes.ts; settleApprovedDeduction / reverseSettledDeduction in fee-engine.ts; the insufficient-funds sweep) holds a kill-switch guard upstream. Adding a guard here would (a) double-fire operator alerts and (b) hide which entry point a 503 actually came from in the alert payload.",
  },
  "posting-receipt-invariant.ts:runPostingReceiptInvariantCheck": {
    classification: "allowlisted_not_money_movement",
    reason:
      "Read-only invariant check — compares COUNT(DISTINCT transaction_id) FROM ledger_entries against COUNT(*) FROM ledger_postings and dispatches an operator alert on divergence. Never writes to ledger_entries, wallets, or transactions.",
  },
};

type DiscoveredEntryPoint = {
  id: string; // "<file>:<name>"
  file: string;
  name: string;
  body: string;
};

async function discoverMoneyMovementExports(): Promise<DiscoveredEntryPoint[]> {
  const dirents = await fs.readdir(SERVICES_DIR, { withFileTypes: true });
  const found: DiscoveredEntryPoint[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    if (!dirent.name.endsWith(".ts")) continue;
    if (dirent.name.endsWith(".test.ts")) continue;

    const filePath = path.join(SERVICES_DIR, dirent.name);
    const text = await fs.readFile(filePath, "utf8");
    const lines = text.split("\n");

    // Two passes per file:
    //   pass 1 — locate every "export function NAME(" / "export async function NAME(" line.
    //   pass 2 — for each match, take the body to be everything until the
    //            next top-level `export ` line (or EOF). This is a
    //            deliberately loose body-extraction heuristic: the only
    //            string we care about inside the body is the literal
    //            `assertKillSwitchOff(` call, which appears verbatim at
    //            every guarded callsite. Including a few extra lines from
    //            the next declaration in the slice is harmless because we
    //            only test for substring presence — the next function is
    //            either also a money-movement export (so we'd catch its
    //            guard separately on its own iteration) or it is not
    //            (so it can't smuggle a false-positive guard match in).
    const exportLineIdxs: { idx: number; name: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      // TODO: expand the discovery regex to cover `export const NAME = (async) (...) => ...`
      // and `export default (async) function NAME(...)` if the services
      // codebase ever adopts those export forms for money-movement work.
      // Today every entry point in server/services/ is declared with the
      // `export (async) function NAME(` shape this regex matches; a deviation
      // would silently bypass this check.
      const m = /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*[<(]/.exec(
        lines[i],
      );
      if (!m) continue;
      const name = m[1];
      if (!MONEY_MOVEMENT_VERB_RE.test(name)) continue;
      exportLineIdxs.push({ idx: i, name });
    }

    for (let k = 0; k < exportLineIdxs.length; k++) {
      const { idx, name } = exportLineIdxs[k];
      let endLine = lines.length;
      for (let j = idx + 1; j < lines.length; j++) {
        if (/^export\s/.test(lines[j])) {
          endLine = j;
          break;
        }
      }
      const body = lines.slice(idx, endLine).join("\n");
      found.push({
        id: `${dirent.name}:${name}`,
        file: dirent.name,
        name,
        body,
      });
    }
  }
  return found;
}

describe("entry-point coverage walk (Task #183)", () => {
  it("every money-movement-named export in server/services/ is either guarded or registered with a reason", async () => {
    const discovered = await discoverMoneyMovementExports();

    // Sanity: if the discovery function returns nothing, something has gone
    // wrong with the file walk (wrong directory, regex change, etc.) and
    // every check below would silently pass. Anchor on the entry points
    // we already KNOW exist so a future "discovery returns []" regression
    // is loud.
    expect(discovered.length).toBeGreaterThanOrEqual(
      Object.keys(KILL_SWITCH_ENTRY_POINT_REGISTRY).length,
    );

    const issues: string[] = [];
    const seenIds = new Set<string>();

    for (const entry of discovered) {
      seenIds.add(entry.id);
      const guardsItself = /\bassertKillSwitchOff\s*\(/.test(entry.body);
      const registered = KILL_SWITCH_ENTRY_POINT_REGISTRY[entry.id];

      if (!registered) {
        if (guardsItself) {
          issues.push(
            `${entry.id} calls assertKillSwitchOff() but is missing from KILL_SWITCH_ENTRY_POINT_REGISTRY. Add it as { classification: "guarded", reason: "<summary>" } so the in-scope set stays auditable.`,
          );
        } else {
          issues.push(
            `${entry.id} matches the money-movement verb pattern but neither calls assertKillSwitchOff() nor appears in KILL_SWITCH_ENTRY_POINT_REGISTRY. Either: (a) add \`await assertKillSwitchOff(<specific>, "transactions")\` at the top of the body and register it as "guarded"; (b) if it is reachable only through an already-guarded caller, register it as "allowlisted_primitive" with a reason explaining the upstream guards; or (c) if its name is misleading and it does not move money, register it as "allowlisted_not_money_movement".`,
          );
        }
        continue;
      }

      switch (registered.classification) {
        case "guarded":
          if (!guardsItself) {
            issues.push(
              `${entry.id} is registered as "guarded" but its body no longer calls assertKillSwitchOff(). Either restore the guard or move the registry entry to "allowlisted_primitive" with a reason describing the upstream callers.`,
            );
          }
          break;
        case "allowlisted_primitive":
          // No assertion on the body — the contract is "callers guard, I do not".
          // We deliberately do not require the absence of the guard call
          // here: a defensive double-guard is acceptable, just not required.
          break;
        case "allowlisted_not_money_movement":
          if (guardsItself) {
            issues.push(
              `${entry.id} is registered as "allowlisted_not_money_movement" but its body now calls assertKillSwitchOff(). If the function does in fact move money, re-classify it as "guarded".`,
            );
          }
          break;
      }
    }

    for (const id of Object.keys(KILL_SWITCH_ENTRY_POINT_REGISTRY)) {
      if (!seenIds.has(id)) {
        issues.push(
          `KILL_SWITCH_ENTRY_POINT_REGISTRY entry "${id}" no longer matches any exported function in server/services/. Remove the stale registry entry so the doc-of-record stays accurate.`,
        );
      }
    }

    if (issues.length > 0) {
      throw new Error(
        `Kill-switch entry-point coverage check failed:\n  - ${issues.join(
          "\n  - ",
        )}`,
      );
    }
  });

  it("registry covers the historically-guarded entry points (anchor)", () => {
    // Belt-and-braces: independent of the discovery walk, assert the
    // specific entry points the rest of this suite exercises are still
    // listed in the registry. If someone deletes a registry entry AND
    // the underlying function in the same change, the "stale entry"
    // check above goes silent — this anchor keeps the headline guarded
    // set explicit.
    expect(KILL_SWITCH_ENTRY_POINT_REGISTRY).toHaveProperty(
      "fee-engine.ts:settleApprovedDeduction",
    );
    expect(KILL_SWITCH_ENTRY_POINT_REGISTRY).toHaveProperty(
      "fee-engine.ts:reverseSettledDeduction",
    );
    expect(
      KILL_SWITCH_ENTRY_POINT_REGISTRY["fee-engine.ts:settleApprovedDeduction"]
        .classification,
    ).toBe("guarded");
    expect(
      KILL_SWITCH_ENTRY_POINT_REGISTRY["fee-engine.ts:reverseSettledDeduction"]
        .classification,
    ).toBe("guarded");
  });
});

// ---------------------------------------------------------------------------
// 6b. Ledger-primitive caller coverage walk (Task #190)
// ---------------------------------------------------------------------------
// The Section-6 walk above guarantees that any NEW exported function in
// `server/services/` whose name matches a money-movement verb is either
// guarded or explicitly registered. That alone is not enough for the ledger
// primitive itself: `postLedgerEntries` in `server/services/ledger.ts` is
// classified as an `allowlisted_primitive` because every caller is supposed
// to hold its own kill-switch guard upstream — but the registry only asserts
// that claim by hand. A future caller that forgets to add the guard
// (e.g. a new HTTP route, a new fee-engine path, or a sweep helper) would
// slip past the Section-6 walk because the walk only inspects names of
// exported services, not the call graph.
//
// This walk closes the gap by enumerating every CALLSITE of the ledger
// primitives across `server/routes.ts` and `server/services/*.ts`, finding
// the enclosing named function for each, and asserting that enclosing
// function either:
//   (a) calls `assertKillSwitchOff(...)` directly in its own body, AND is
//       listed in either `KILL_SWITCH_ENTRY_POINT_REGISTRY` (for service
//       exports) or `LEDGER_PRIMITIVE_HTTP_ROUTE_REGISTRY` (for the
//       route-handler local consts in routes.ts that aren't service
//       exports); OR
//   (b) is itself called only by registered guarded functions (one level
//       of indirection — the chain must terminate in a guarded function
//       within at most one hop).
//
// PRIMITIVES IN SCOPE
//   * postLedgerEntries           — the only writer of ledger_entries
//   * refreshWalletCacheBalance   — the only writer of wallets.balance/availableBalance
//   * getOrCreateClientAccount    — creates/locates client accounts (an
//                                   account row is a precondition for posting
//                                   to it; gating account creation on the
//                                   kill switch keeps half-state out of the
//                                   accounts table when the operator engages
//                                   the switch mid-transaction)
//   * getOrCreateSuspenseAccount  — same rationale, platform suspense leg
//   * getOrCreateFeeAccount       — same rationale, platform fee revenue leg
//
// FILES IN SCOPE
//   * server/routes.ts            — HTTP money-movement routes
//   * server/services/*.ts        — service-layer code, EXCLUDING:
//       - ledger.ts itself        — the primitives' own declarations (and
//                                   the lines `await postLedgerEntries(...)`
//                                   in their JSDoc would otherwise produce
//                                   spurious matches; AST-based scanning
//                                   ignores comments anyway)
//       - *.test.ts               — tests intentionally exercise the
//                                   primitives directly with the switch off
//
//   `scripts/*.ts` are deliberately OUT OF SCOPE: those are operator-only
//   maintenance utilities (pre-launch safety probes, cleanup helpers,
//   reconciliation backfills) that run with elevated trust outside the
//   request path. Kill-switch guarding scripts would prevent the operator
//   from cleaning up AFTER engaging the switch — the opposite of what the
//   switch is for.
//
// FAILURE MODES THIS TEST CATCHES
//   * A new HTTP route that calls postLedgerEntries() / refreshWalletCacheBalance()
//     without an `await assertKillSwitchOff(...)` at the top → fail with a
//     message naming the file, the enclosing function, and the missing guard.
//   * A new service-layer function that calls a primitive but is missing
//     from both registries → fail with a message telling the author to
//     either add the guard + register it as `guarded`, or document the
//     upstream guard chain via the indirection allowance.
//   * A registry entry classified `guarded` whose body silently lost its
//     `assertKillSwitchOff(...)` call → already caught by the Section-6
//     check; this section additionally surfaces it through the call-graph
//     view (the primitive call now has no upstream guard).
//
// HOW TO EXTEND
//   When you add a new caller of a ledger primitive:
//     1. Put `await assertKillSwitchOff(<specific>, "transactions")` at the
//        top of the enclosing function, BEFORE any `db.transaction(...)` or
//        primitive call.
//     2. If the enclosing function is an `export function` in
//        `server/services/`, add it to KILL_SWITCH_ENTRY_POINT_REGISTRY
//        as `{ classification: "guarded", reason: "<one-line summary>" }`.
//        If it's a local `const handleX = async (req, res) => ...` in
//        `server/routes.ts`, add it to LEDGER_PRIMITIVE_HTTP_ROUTE_REGISTRY
//        below with the same shape.
//     3. Wire an HTTP / throw assertion in Sections 1–3 above so engagement
//        actually surfaces as 503 / KillSwitchActiveError.
// ---------------------------------------------------------------------------

// Local-handler counterparts to KILL_SWITCH_ENTRY_POINT_REGISTRY: the
// route-handler `const handleX` arrows in `server/routes.ts` are not
// exported (they're locals inside `registerRoutes(app)`), so the
// service-export-only Section-6 walk does not see them. We list them
// explicitly here. Each entry is the (file, name) of a NAMED function or
// const-arrow whose body contains a primitive call AND a direct
// `assertKillSwitchOff(...)` call.
const LEDGER_PRIMITIVE_HTTP_ROUTE_REGISTRY: Record<
  string,
  { classification: "guarded"; reason: string }
> = {
  "routes.ts:handleDeposit": {
    classification: "guarded",
    reason:
      "POST /api/deposit and /api/wallets/deposit. Calls assertKillSwitchOff('deposits', 'transactions') at the top of the handler, before db.transaction(...) or any ledger primitive call.",
  },
  "routes.ts:handleWithdraw": {
    classification: "guarded",
    reason:
      "POST /api/withdraw and /api/wallets/withdraw. Calls assertKillSwitchOff('withdrawals', 'transactions') at the top of the handler, before db.transaction(...) or any ledger primitive call.",
  },
};

const LEDGER_PRIMITIVES = [
  "postLedgerEntries",
  "refreshWalletCacheBalance",
  "getOrCreateClientAccount",
  "getOrCreateSuspenseAccount",
  "getOrCreateFeeAccount",
] as const;
type LedgerPrimitive = (typeof LEDGER_PRIMITIVES)[number];
const LEDGER_PRIMITIVE_SET: ReadonlySet<string> = new Set(LEDGER_PRIMITIVES);

const SERVER_DIR = path.resolve(SERVICES_DIR, "..");
const REPO_ROOT = path.resolve(SERVER_DIR, "..");
const LEDGER_PRIMITIVE_SOURCE = path.resolve(SERVICES_DIR, "ledger.ts");
const KILL_SWITCH_GUARD_SOURCE = path.resolve(SERVICES_DIR, "kill-switch.ts");

type FuncInfo = {
  id: string; // "<file>:<name>"
  file: string; // basename, e.g. "routes.ts"
  name: string;
  hasGuard: boolean; // body contains a (symbol-resolved) assertKillSwitchOff(...) call
  primitiveCalls: LedgerPrimitive[]; // keyed by the resolved primitive name (alias-safe)
  calleeOwnerIds: Set<string>; // SYMBOL-resolved ids of in-graph callees this owner invokes
  exported: boolean; // true if this is an `export function` / `export const` at module top level
};

// Files we walk for the call-graph analysis. Kept narrow on purpose so the
// test stays cheap and so adding a brand-new file under server/ doesn't
// accidentally widen the surface without a deliberate update. The list is
// also used as the canonical "in-scope file set" assertion below — every
// owner the walk produces MUST resolve to one of these files (anything
// else means a script or unrelated module slipped in).
async function listLedgerPrimitiveCallerFiles(): Promise<string[]> {
  const files: string[] = [path.join(SERVER_DIR, "routes.ts")];
  const dirents = await fs.readdir(SERVICES_DIR, { withFileTypes: true });
  for (const d of dirents) {
    if (!d.isFile()) continue;
    if (!d.name.endsWith(".ts")) continue;
    if (d.name.endsWith(".test.ts")) continue;
    if (d.name === "ledger.ts") continue;
    files.push(path.join(SERVICES_DIR, d.name));
  }
  return files.map((f) => path.resolve(f));
}

// Build a TS Program over the in-scope files (plus their transitive imports
// via standard module resolution). The TypeChecker lets us:
//   * resolve a callsite identifier to the ACTUAL imported declaration,
//     so `import { postLedgerEntries as foo } from "../services/ledger";`
//     plus `await foo(...)` is recognised as a primitive call by symbol
//     identity, not by spelling.
//   * link `<file>:<name>` owners by ts.Symbol identity, so two functions
//     in different files that happen to share a name are NOT conflated
//     when we check one-hop indirection.
async function buildFunctionGraph(): Promise<{
  graph: Map<string, FuncInfo>;
  inScopeFiles: ReadonlySet<string>;
}> {
  const ts = await import("typescript");
  const inScopeFiles = await listLedgerPrimitiveCallerFiles();
  const inScopeFileSet = new Set(inScopeFiles);

  // Use the project tsconfig so module resolution + path aliases match
  // production. We force noEmit and skipLibCheck for speed.
  const tsconfigPath = path.resolve(REPO_ROOT, "tsconfig.json");
  const cf = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (cf.error) {
    throw new Error(
      `Failed to read tsconfig at ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(cf.error.messageText, "\n")}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    cf.config,
    ts.sys,
    path.dirname(tsconfigPath),
  );
  const program = ts.createProgram({
    rootNames: inScopeFiles,
    options: { ...parsed.options, noEmit: true, skipLibCheck: true },
  });
  const checker = program.getTypeChecker();

  const graph = new Map<string, FuncInfo>();
  // Map from ts.Symbol → owner id for the four in-scope owner functions.
  // We use this to resolve "owner X calls owner Y" edges by symbol identity.
  const symbolToOwnerId = new Map<ts.Symbol, string>();

  function relFile(absPath: string): string {
    return path.relative(SERVER_DIR, absPath); // "routes.ts" or "services/fee-engine.ts"
  }

  function ensureOwner(
    file: string,
    name: string,
    exported: boolean,
    symbol: ts.Symbol | undefined,
  ): FuncInfo {
    // We key by (basename, name) to keep the public id format stable with
    // the registries, but we ALSO record the symbol so cross-file collisions
    // (e.g. two `processQueue` functions in two files) cannot conflate.
    const id = `${path.basename(file)}:${name}`;
    let info = graph.get(id);
    if (!info) {
      info = {
        id,
        file: path.basename(file),
        name,
        hasGuard: false,
        primitiveCalls: [],
        calleeOwnerIds: new Set(),
        exported,
      };
      graph.set(id, info);
    } else if (exported) {
      info.exported = true;
    }
    if (symbol && !symbolToOwnerId.has(symbol)) {
      symbolToOwnerId.set(symbol, id);
    }
    return info;
  }

  // Pass 1 — discover every named function/var-arrow in every in-scope file
  // and register their symbols. We need this BEFORE we resolve calls so that
  // any "owner A calls owner B" edge can be linked by symbol on first sight.
  const ownerEnvelopesByFile = new Map<
    string,
    Array<{ start: number; end: number; info: FuncInfo }>
  >();
  for (const filePath of inScopeFiles) {
    const sf = program.getSourceFile(filePath);
    if (!sf) {
      throw new Error(`TS Program missing in-scope source file ${filePath}`);
    }
    const file = relFile(filePath);
    const envelopes: Array<{ start: number; end: number; info: FuncInfo }> = [];

    function recordOwner(
      nameNode: ts.Identifier,
      exported: boolean,
      bodyHost: ts.Node,
    ): FuncInfo {
      const symbol = checker.getSymbolAtLocation(nameNode);
      const info = ensureOwner(file, nameNode.text, exported, symbol);
      envelopes.push({ start: bodyHost.getStart(), end: bodyHost.getEnd(), info });
      return info;
    }

    function walk(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const exported =
          node.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.ExportKeyword,
          ) ?? false;
        recordOwner(node.name, exported, node);
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer))
      ) {
        let exported = false;
        let parent: ts.Node | undefined = node.parent;
        while (parent && !ts.isVariableStatement(parent)) parent = parent.parent;
        if (parent && ts.isVariableStatement(parent)) {
          exported =
            parent.modifiers?.some(
              (m) => m.kind === ts.SyntaxKind.ExportKeyword,
            ) ?? false;
        }
        recordOwner(node.name, exported, node);
      }
      node.forEachChild(walk);
    }
    walk(sf);
    ownerEnvelopesByFile.set(filePath, envelopes);
  }

  // Pass 2 — visit every CallExpression in every in-scope file, resolve the
  // callee symbol (following alias imports), and attribute the call to the
  // OUTERMOST named owner whose lexical span contains the call.
  for (const filePath of inScopeFiles) {
    const sf = program.getSourceFile(filePath)!;
    const envelopes = ownerEnvelopesByFile.get(filePath) ?? [];

    function ownerAtPosition(pos: number): FuncInfo | null {
      // INNERMOST containing envelope wins — the immediate enclosing
      // named function/const-arrow. We want `handleDeposit` (the local
      // const-arrow) to own its primitive calls, not its outer wrapper
      // `registerRoutes`. Likewise for any nested helper an author
      // introduces inside an existing entry point: the test then asserts
      // on the helper's name and forces the author to either guard it
      // directly or register the indirection.
      let best: { start: number; end: number; info: FuncInfo } | null = null;
      for (const env of envelopes) {
        if (env.start <= pos && pos <= env.end) {
          if (!best || env.start > best.start) best = env;
        }
      }
      return best?.info ?? null;
    }

    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        // Locate the identifier we'll resolve. Bare-call: `foo(...)` — the
        // expression is an Identifier. Property-access: `obj.bar(...)` — we
        // look at the .name. (`obj.bar` could still resolve to one of our
        // primitives via re-export, but in practice none of our primitives
        // are accessed via property syntax.)
        let calleeIdent: ts.Identifier | null = null;
        if (ts.isIdentifier(node.expression)) {
          calleeIdent = node.expression;
        } else if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.name)
        ) {
          calleeIdent = node.expression.name;
        }
        if (calleeIdent) {
          const ownerInfo = ownerAtPosition(node.getStart());
          if (ownerInfo) {
            let symbol = checker.getSymbolAtLocation(calleeIdent);
            // Follow alias imports so `import { postLedgerEntries as p }`
            // resolves to the primitive's actual declaration.
            if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
              try {
                symbol = checker.getAliasedSymbol(symbol);
              } catch {
                /* unresolvable alias — leave symbol as-is */
              }
            }
            const decls = symbol?.declarations ?? [];
            for (const decl of decls) {
              const declFile = path.resolve(decl.getSourceFile().fileName);
              const declName = symbol?.name;
              if (
                declFile === LEDGER_PRIMITIVE_SOURCE &&
                declName &&
                LEDGER_PRIMITIVE_SET.has(declName)
              ) {
                ownerInfo.primitiveCalls.push(declName as LedgerPrimitive);
              }
              if (
                declFile === KILL_SWITCH_GUARD_SOURCE &&
                declName === "assertKillSwitchOff"
              ) {
                ownerInfo.hasGuard = true;
              }
            }
            // Symbol-keyed edge to another in-scope owner (if any). This
            // is what makes the one-hop indirection check identity-based
            // instead of name-based: `processQueue` in services/A.ts and
            // `processQueue` in services/B.ts have distinct symbols and
            // therefore distinct owner ids on the edge.
            if (symbol) {
              const calleeOwnerId = symbolToOwnerId.get(symbol);
              if (calleeOwnerId && calleeOwnerId !== ownerInfo.id) {
                ownerInfo.calleeOwnerIds.add(calleeOwnerId);
              }
            }
          }
        }
      }
      node.forEachChild(visit);
    }
    visit(sf);
  }

  return { graph, inScopeFiles: inScopeFileSet };
}

function isRegisteredAsGuarded(id: string): boolean {
  const httpEntry = LEDGER_PRIMITIVE_HTTP_ROUTE_REGISTRY[id];
  if (httpEntry?.classification === "guarded") return true;
  const serviceEntry = KILL_SWITCH_ENTRY_POINT_REGISTRY[id];
  if (serviceEntry?.classification === "guarded") return true;
  return false;
}

describe("ledger-primitive caller coverage walk (Task #190)", () => {
  it("every caller of postLedgerEntries / refreshWalletCacheBalance / getOrCreate*Account is itself kill-switched", async () => {
    const { graph, inScopeFiles } = await buildFunctionGraph();

    // Anchor: discovery must produce the headline owners we already know
    // about. If the AST walk silently returns nothing (wrong directory,
    // ts-import failure, etc.) every per-callsite assertion below would
    // pass vacuously — so we hard-fail up front when the headline owners
    // aren't present.
    const KNOWN_OWNERS = [
      "routes.ts:handleDeposit",
      "routes.ts:handleWithdraw",
      "fee-engine.ts:settleApprovedDeduction",
      "fee-engine.ts:reverseSettledDeduction",
    ];
    for (const id of KNOWN_OWNERS) {
      expect(graph.has(id), `function graph missing known owner ${id}`).toBe(
        true,
      );
    }

    // Collect every (owner, primitive) pair, then validate each owner.
    const callerOwners = Array.from(graph.values()).filter(
      (info) => info.primitiveCalls.length > 0,
    );

    // A second anchor: the owners we expect to see calling primitives
    // include AT LEAST the four headline functions above. Subset (not
    // strict equality) so a legitimately-added new caller doesn't trip
    // this anchor — the per-owner validation loop below is what gates
    // new callers on having a guard. AND every detected owner's source
    // file MUST be one of the basenames produced by
    // listLedgerPrimitiveCallerFiles() — that's what stops a
    // script-style file from silently widening the in-scope set.
    const callerOwnerIds = callerOwners.map((o) => o.id).sort();
    for (const id of KNOWN_OWNERS) {
      expect(
        callerOwnerIds,
        `expected the function graph to include caller ${id}`,
      ).toContain(id);
    }
    const allowedBasenames = new Set(
      Array.from(inScopeFiles).map((f) => path.basename(f)),
    );
    for (const owner of callerOwners) {
      expect(
        allowedBasenames.has(owner.file),
        `unexpected file ${owner.file} sneaked into the caller scan; allowed: ${Array.from(allowedBasenames).join(", ")}`,
      ).toBe(true);
    }

    const issues: string[] = [];

    for (const owner of callerOwners) {
      // Path 1 — owner directly calls assertKillSwitchOff AND is registered.
      if (owner.hasGuard && isRegisteredAsGuarded(owner.id)) continue;

      // Path 2 — one level of indirection. The owner is itself called by
      // one or more in-scope owners; if EVERY such caller is registered
      // as guarded AND has the guard call in its own body, accept the
      // chain. Edges are symbol-resolved (see calleeOwnerIds), so two
      // unrelated functions with the same name in different files are
      // never conflated. This intentionally caps the search at one hop.
      const directCallers = Array.from(graph.values()).filter((other) =>
        other.calleeOwnerIds.has(owner.id) && other.id !== owner.id,
      );
      const indirectionOk =
        directCallers.length > 0 &&
        directCallers.every(
          (caller) => caller.hasGuard && isRegisteredAsGuarded(caller.id),
        );
      if (indirectionOk) continue;

      // Build a precise diagnostic explaining which knob the author needs
      // to turn. We keep the message long on purpose — this test will
      // typically fail the FIRST time someone adds a new money-movement
      // path, and the failure has to be self-explanatory in CI.
      const calls = Array.from(new Set(owner.primitiveCalls)).join(", ");
      if (!owner.hasGuard) {
        issues.push(
          `${owner.id} calls ledger primitive(s) [${calls}] but does NOT call assertKillSwitchOff() in its own body, ` +
            `and no caller of ${owner.name} (one hop) terminates in a guarded, registered function. ` +
            `Add \`await assertKillSwitchOff(<specific>, "transactions")\` at the top of ${owner.name} ` +
            `(BEFORE any db.transaction(...) or primitive call), then register it as ` +
            `{ classification: "guarded", reason: "..." } in ` +
            `${owner.file === "routes.ts" ? "LEDGER_PRIMITIVE_HTTP_ROUTE_REGISTRY" : "KILL_SWITCH_ENTRY_POINT_REGISTRY"}.`,
        );
        continue;
      }
      // Owner has the guard but is missing from the registry.
      issues.push(
        `${owner.id} calls ledger primitive(s) [${calls}] and DOES guard with assertKillSwitchOff(), ` +
          `but is missing from ${owner.file === "routes.ts" ? "LEDGER_PRIMITIVE_HTTP_ROUTE_REGISTRY" : "KILL_SWITCH_ENTRY_POINT_REGISTRY"}. ` +
          `Add it as { classification: "guarded", reason: "<one-line summary>" } so the in-scope set stays auditable.`,
      );
    }

    if (issues.length > 0) {
      throw new Error(
        `Ledger-primitive caller coverage check failed:\n  - ${issues.join("\n  - ")}`,
      );
    }
  });

  it("HTTP-route registry covers handleDeposit and handleWithdraw (anchor)", () => {
    // Mirrors the Section-6 anchor for KILL_SWITCH_ENTRY_POINT_REGISTRY:
    // keeps the headline routes explicit so a registry edit + handler
    // rename in the same change can't go silent.
    expect(LEDGER_PRIMITIVE_HTTP_ROUTE_REGISTRY).toHaveProperty(
      "routes.ts:handleDeposit",
    );
    expect(LEDGER_PRIMITIVE_HTTP_ROUTE_REGISTRY).toHaveProperty(
      "routes.ts:handleWithdraw",
    );
    expect(
      LEDGER_PRIMITIVE_HTTP_ROUTE_REGISTRY["routes.ts:handleDeposit"]
        .classification,
    ).toBe("guarded");
    expect(
      LEDGER_PRIMITIVE_HTTP_ROUTE_REGISTRY["routes.ts:handleWithdraw"]
        .classification,
    ).toBe("guarded");
  });
});

// ---------------------------------------------------------------------------
// 6c. Raw ledger_entries / wallets writer coverage walk (Task #195)
// ---------------------------------------------------------------------------
// Section 6b above proves every CALLER of postLedgerEntries /
// refreshWalletCacheBalance is itself kill-switched. That closes the loop
// for code that goes THROUGH the ledger primitives. This block closes the
// symmetric gap one layer below: a future refactor that bypasses the
// primitives entirely and writes the underlying tables directly via raw
// drizzle calls would slip past Section 6b because the call-graph walk
// only sees calls TO the primitives, not direct table writes.
//
// CONCRETE FAILURE MODES THIS CATCHES
//   * A new helper that calls `tx.insert(ledgerEntries).values(...)`
//     directly. That path skips the same-transaction posting guard
//     (the ledger_postings receipt PK lock — Task #22 / #37), the
//     balanced-pair / single-currency check, AND every kill-switch
//     upstream of postLedgerEntries.
//   * A new helper that calls `tx.update(wallets).set({ balance, ... })`
//     directly. `storage.updateWallet` already throws at runtime when
//     `balance` or `availableBalance` is in the patch, but a brand-new
//     helper that builds the SQL itself would not be caught — the
//     denormalised cache would silently drift from SUM(ledger_entries),
//     which the daily reconciliation would then surface as a mismatch
//     after the fact.
//
// PRIMITIVES IN SCOPE
//   * `ledgerEntries` table — only `postLedgerEntries` in
//     `server/services/ledger.ts` is permitted to insert here.
//   * `wallets` table where `balance` or `availableBalance` is written —
//     only `refreshWalletCacheBalance` in `server/services/ledger.ts`
//     is permitted to write those columns. Other column updates on the
//     `wallets` table (e.g. `walletType`, `currency`) are fine and not
//     in scope for this check.
//
// FILES IN SCOPE
//   Every `.ts` file under `server/` (recursive), excluding `*.test.ts`.
//   Unlike Section 6b which is narrowed to ledger-primitive callers,
//   this walk is FULL-SERVER because the bypass we are guarding against
//   can land anywhere — a fresh service module, a new admin route, a
//   utility in `server/storage.ts`, etc.
//
//   `scripts/*.ts` are deliberately OUT OF SCOPE for the same reason as
//   Section 6b: those are operator-only maintenance utilities that run
//   with elevated trust outside the request path.
//
// MATCHING POLICY
//   We use the TypeScript checker (same `ts.Program` machinery as
//   Section 6b) so that:
//     * `import { ledgerEntries } from "@shared/schema"` is resolved by
//       symbol identity, not by spelling — a future variable named
//       `ledgerEntries` in some unrelated file cannot trigger a false
//       match, and an `import { ledgerEntries as le } from "..."` plus
//       `tx.insert(le).values(...)` would still be caught.
//     * `import { wallets } from "@shared/schema"` likewise.
//
//   For `ledgerEntries` we flag EVERY `<x>.insert(<id>)` call where the
//   resolved declaration of `<id>` lives in `shared/schema.ts` and is
//   the `ledgerEntries` table.
//
//   For `wallets` we flag a `<x>.update(<id>)` call where the resolved
//   declaration of `<id>` is the `wallets` table AND the chained
//   `.set(<arg>)` on the resulting `Drizzle` query builder COULD touch
//   `balance` / `availableBalance`. Concretely:
//     * `<arg>` is an object literal containing a `balance` or
//       `availableBalance` property → DEFINITELY a balance write → flag.
//     * `<arg>` is anything other than an object literal (variable,
//       function call, spread, etc.) → COULD include those fields
//       (we cannot statically prove otherwise) → flag.
//     * `<arg>` is an object literal whose property names do NOT
//       include `balance` or `availableBalance` → SAFE → not flagged.
//       This matches the runtime contract of `storage.updateWallet`'s
//       `WalletUpdatePayload` type (which excludes those two fields).
//
// HOW THE ALLOWLIST WORKS
//   Each callsite is identified by `<file>:<enclosingContext>`, where
//   the enclosing context is derived by walking up the AST until we hit
//   one of (in priority order):
//     1. A named function declaration (`function foo() {...}`).
//     2. A variable declaration whose initializer is an arrow /
//        function expression (`const handleDeposit = async (...) => {}`).
//     3. A class method declaration (`class DatabaseStorage { async
//        updateWallet() {...} }`) — recorded as `Class.method`.
//     4. An `app.<verb>("<path>", ...)` call expression (the
//        registration site for an inline route handler) — recorded as
//        `<VERB> <path>`.
//     5. Synthetic `<top-level>` if none of the above is found.
//
//   Each registry entry records the EXPECTED COUNT of callsites in
//   that context. A NEW write smuggled into an already-allowlisted
//   handler would tip the count over and fail the test, so a primitive
//   bypass cannot hide under cover of an existing legacy bypass.
//
// FAILURE MODES THE TEST CATCHES
//   * A NEW callsite appears in a context that is not in the registry
//     → fail with the file, context, and line, and instruct the author
//     to either route through `postLedgerEntries` /
//     `refreshWalletCacheBalance` or — only when there is a documented
//     reason the primitive cannot be used — register the context here
//     with that reason.
//   * An EXISTING allowlisted context grows a new callsite (count goes
//     up) → fail asking the author to either remove the new bypass or
//     bump the registered count with a reason for the additional site.
//   * An EXISTING allowlisted context loses callsites (count goes
//     down to zero) → fail asking the author to remove the stale entry
//     so the doc-of-record stays accurate. (A non-zero shrink is also
//     a failure — the count must match exactly, not "≥".)
//
// HOW TO EXTEND
//   When you legitimately need to write `ledger_entries` or
//   `wallets.balance` outside the sanctioned primitives:
//     1. Strongly consider routing through the primitive instead — that
//        is the intended path and what the kill-switch fence is built
//        around.
//     2. If you genuinely cannot (e.g. a one-off backfill that runs
//        OFFLINE outside the request path — though those should live in
//        `scripts/*.ts`, which is out of scope for this walk anyway),
//        add the context to RAW_LEDGER_ENTRIES_WRITER_REGISTRY or
//        RAW_WALLET_BALANCE_WRITER_REGISTRY below with
//        `{ count: <N>, reason: "<one-line summary>" }`.
// ---------------------------------------------------------------------------

const SCHEMA_SOURCE = path.resolve(REPO_ROOT, "shared", "schema.ts");

type RawWriteRegistryEntry = { count: number; reason: string };

// Allowlisted callers of `tx.insert(ledgerEntries)`. The scan FAILS if
// any unlisted file/context calls insert on `ledgerEntries`, OR if a
// listed context's callsite count drifts away from the recorded value.
const RAW_LEDGER_ENTRIES_WRITER_REGISTRY: Record<string, RawWriteRegistryEntry> = {
  "services/ledger.ts:postLedgerEntries": {
    count: 1,
    reason:
      "The ONE sanctioned writer of ledger_entries. Performs the same-transaction posting guard (ledger_postings PK lock — Task #22/#37), the balanced-pair check, and the single-currency check before inserting. Every other server-side caller MUST route through this function.",
  },
};

// Allowlisted callers of `tx.update(wallets).set({...})` where the set
// payload could touch `balance` / `availableBalance`. Same drift rules
// as above. Object-literal `.set(...)` payloads that demonstrably do
// NOT mention `balance` or `availableBalance` are out of scope and
// neither flagged nor counted here.
const RAW_WALLET_BALANCE_WRITER_REGISTRY: Record<string, RawWriteRegistryEntry> = {
  "services/ledger.ts:refreshWalletCacheBalance": {
    count: 1,
    reason:
      "The ONE sanctioned writer of wallets.balance / wallets.availableBalance. Recomputes SUM(ledger_entries) for (userId, currency) and writes the cached value inside the same DB transaction in which the entries were just posted. Every other server-side caller MUST route through this function.",
  },
  "storage.ts:DatabaseStorage.updateWallet": {
    count: 1,
    reason:
      "Generic wallet patch helper. Set arg is a typed `WalletUpdatePayload` (Partial<Omit<InsertWallet, 'balance' | 'availableBalance'>>) — the type forbids the two cached columns at compile time, AND the function additionally throws at runtime if either field appears in the patch. The static scan flags this site because the set arg is a variable (not an object literal) and could in principle include the cached columns; the runtime guard is the second line of defence.",
  },
  // Pre-Task #17 legacy direct writes in routes.ts. These three handlers
  // bypass the ledger entirely and update `wallets.balance` /
  // `wallets.availableBalance` directly inside the transaction. They are
  // kill-switched at the HTTP layer (every handler calls
  // `assertKillSwitchOff(...)` before opening its DB tx) so the
  // operator's switch still stops them, but they predate the
  // ledger-as-source-of-truth migration and produce drift the daily
  // reconciliation surfaces. They are recorded here so the test does NOT
  // silently approve a NEW bypass landing alongside them — adding any
  // further `tx.update(wallets).set({balance,...})` callsite in any of
  // these handlers WILL tip the count and fail the test.
  "routes.ts:POST /api/fx-exchange": {
    count: 2,
    reason:
      "Pre-Task-#17 legacy direct wallet write — debits the source wallet and credits the target wallet inside a SERIALIZABLE transaction without posting ledger entries. Kill-switched at the HTTP layer via `assertKillSwitchOff('transactions')` at the top of the handler. Slated for migration onto `postLedgerEntries` + `refreshWalletCacheBalance`.",
  },
  "routes.ts:POST /api/investments": {
    count: 1,
    reason:
      "Pre-Task-#17 legacy direct wallet write — debits the source currency wallet for an investment buy without posting ledger entries. Kill-switched at the HTTP layer via `assertKillSwitchOff('transactions')` at the top of the handler. Slated for migration onto `postLedgerEntries` + `refreshWalletCacheBalance`.",
  },
  "routes.ts:POST /api/wallets/transfer": {
    count: 2,
    reason:
      "Pre-Task-#17 legacy direct wallet write — debits the source wallet and credits the target wallet inside a SERIALIZABLE transaction without posting ledger entries. Kill-switched at the HTTP layer via `assertKillSwitchOff('transactions')` at the top of the handler. Slated for migration onto `postLedgerEntries` + `refreshWalletCacheBalance`.",
  },
};

type RawTableWrite = {
  file: string; // path relative to server/, e.g. "services/ledger.ts"
  context: string; // function/method/route id
  id: string; // `<file>:<context>`
  line: number; // 1-indexed
};

// Recursively gather every `.ts` file under server/ excluding tests. We
// rebuild this list each test run rather than baking in a static list
// so a brand-new file under `server/` is automatically swept into the
// scan (which is the point — a primitive bypass might hide in code
// that didn't exist when this test was last touched).
async function listServerSourceFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        if (!entry.name.endsWith(".ts")) continue;
        if (entry.name.endsWith(".test.ts")) continue;
        out.push(path.resolve(full));
      }
    }
  }
  await walk(SERVER_DIR);
  return out;
}

async function discoverRawTableWrites(): Promise<{
  ledgerEntriesWrites: RawTableWrite[];
  walletBalanceWrites: RawTableWrite[];
}> {
  const ts = await import("typescript");
  const inScopeFiles = await listServerSourceFiles();

  const tsconfigPath = path.resolve(REPO_ROOT, "tsconfig.json");
  const cf = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (cf.error) {
    throw new Error(
      `Failed to read tsconfig at ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(cf.error.messageText, "\n")}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    cf.config,
    ts.sys,
    path.dirname(tsconfigPath),
  );
  const program = ts.createProgram({
    rootNames: inScopeFiles,
    options: { ...parsed.options, noEmit: true, skipLibCheck: true },
  });
  const checker = program.getTypeChecker();

  function relFile(absPath: string): string {
    return path.relative(SERVER_DIR, absPath);
  }

  function resolvedDeclName(node: ts.Identifier): {
    declFile: string;
    declName: string | undefined;
  } | null {
    let symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return null;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {
        /* unresolvable alias — leave as-is */
      }
    }
    const decl = symbol.declarations?.[0];
    if (!decl) return null;
    return {
      declFile: path.resolve(decl.getSourceFile().fileName),
      declName: symbol.name,
    };
  }

  // Walk up from `node` to find the enclosing context — see Section 6c
  // header for the priority order. The FIRST hit wins, so an inline
  // route-handler arrow inside `app.post("/api/x", async () => {...})`
  // resolves to "POST /api/x" (the inner-most app.<verb>) before we ever
  // reach the outer `registerRoutes` arrow.
  function getEnclosingContext(node: ts.Node): string {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isFunctionDeclaration(current) && current.name) {
        return current.name.text;
      }
      if (
        ts.isVariableDeclaration(current) &&
        ts.isIdentifier(current.name) &&
        current.initializer &&
        (ts.isArrowFunction(current.initializer) ||
          ts.isFunctionExpression(current.initializer))
      ) {
        return current.name.text;
      }
      if (
        ts.isMethodDeclaration(current) &&
        ts.isIdentifier(current.name)
      ) {
        let cls: ts.Node | undefined = current.parent;
        while (cls && !ts.isClassDeclaration(cls)) cls = cls.parent;
        const className =
          cls && ts.isClassDeclaration(cls) && cls.name
            ? cls.name.text
            : "<anon-class>";
        return `${className}.${current.name.text}`;
      }
      if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        ts.isIdentifier(current.expression.expression) &&
        current.expression.expression.text === "app" &&
        ts.isIdentifier(current.expression.name) &&
        ["post", "put", "patch", "delete", "get"].includes(
          current.expression.name.text,
        )
      ) {
        const firstArg = current.arguments[0];
        if (firstArg && ts.isStringLiteral(firstArg)) {
          return `${current.expression.name.text.toUpperCase()} ${firstArg.text}`;
        }
      }
      current = current.parent;
    }
    return "<top-level>";
  }

  function lineOf(sf: ts.SourceFile, pos: number): number {
    return sf.getLineAndCharacterOfPosition(pos).line + 1;
  }

  const ledgerEntriesWrites: RawTableWrite[] = [];
  const walletBalanceWrites: RawTableWrite[] = [];

  for (const filePath of inScopeFiles) {
    const sf = program.getSourceFile(filePath);
    if (!sf) {
      throw new Error(`TS Program missing in-scope source file ${filePath}`);
    }
    const file = relFile(filePath);

    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.name) &&
        node.arguments.length >= 1
      ) {
        const methodName = node.expression.name.text;
        // Accept both identifier-form (`tx.insert(ledgerEntries)`) and
        // property-access-form (`tx.insert(schema.ledgerEntries)`). For
        // property access we resolve the symbol of the trailing
        // identifier (`.name`) — that's the name actually bound to the
        // exported table, regardless of whether the import is
        // `import { ledgerEntries }` or `import * as schema`.
        const arg = node.arguments[0];
        let tableArg: ts.Identifier | null = null;
        if (ts.isIdentifier(arg)) {
          tableArg = arg;
        } else if (
          ts.isPropertyAccessExpression(arg) &&
          ts.isIdentifier(arg.name)
        ) {
          tableArg = arg.name;
        }
        if (!tableArg) {
          node.forEachChild(visit);
          return;
        }

        if (methodName === "insert") {
          const resolved = resolvedDeclName(tableArg);
          if (
            resolved &&
            resolved.declFile === SCHEMA_SOURCE &&
            resolved.declName === "ledgerEntries"
          ) {
            const context = getEnclosingContext(node);
            ledgerEntriesWrites.push({
              file,
              context,
              id: `${file}:${context}`,
              line: lineOf(sf!, node.getStart()),
            });
          }
        } else if (methodName === "update") {
          const resolved = resolvedDeclName(tableArg);
          if (
            resolved &&
            resolved.declFile === SCHEMA_SOURCE &&
            resolved.declName === "wallets"
          ) {
            // Find the chained `.set(...)` — `update(wallets).set(...)`
            // is a property access on this node's parent. Drizzle returns
            // a fluent builder so `.set` is the next method in the chain.
            // We accept either:
            //   tx.update(wallets).set({...})              [direct]
            //   tx.update(wallets)                          [stored, .set later — rare]
            // For the direct shape we inspect the .set arg to decide
            // whether `balance` / `availableBalance` is in scope. For the
            // stored shape (no immediate .set), we conservatively treat
            // it as in scope because we cannot trace the builder forward
            // statically.
            let setArg: ts.Expression | null = null;
            let sawSetCall = false;
            const parent = node.parent;
            if (
              parent &&
              ts.isPropertyAccessExpression(parent) &&
              ts.isIdentifier(parent.name) &&
              parent.name.text === "set" &&
              parent.parent &&
              ts.isCallExpression(parent.parent) &&
              parent.parent.expression === parent
            ) {
              sawSetCall = true;
              setArg = parent.parent.arguments[0] ?? null;
            }

            let touchesBalance = true;
            if (sawSetCall && setArg && ts.isObjectLiteralExpression(setArg)) {
              // Object literal: inspect properties. Only flag if the
              // payload mentions `balance` or `availableBalance`. This
              // mirrors the runtime contract of `storage.updateWallet`
              // (its `WalletUpdatePayload` type explicitly excludes the
              // two cache columns).
              touchesBalance = false;
              for (const prop of setArg.properties) {
                let name: string | null = null;
                if (
                  (ts.isPropertyAssignment(prop) ||
                    ts.isShorthandPropertyAssignment(prop)) &&
                  ts.isIdentifier(prop.name)
                ) {
                  name = prop.name.text;
                } else if (
                  ts.isShorthandPropertyAssignment(prop) &&
                  ts.isIdentifier(prop.name)
                ) {
                  name = prop.name.text;
                } else if (
                  ts.isPropertyAssignment(prop) &&
                  ts.isStringLiteral(prop.name)
                ) {
                  name = prop.name.text;
                } else if (ts.isSpreadAssignment(prop)) {
                  // Conservative: a spread could carry balance fields.
                  touchesBalance = true;
                  break;
                }
                if (name === "balance" || name === "availableBalance") {
                  touchesBalance = true;
                  break;
                }
              }
            }
            // sawSetCall=false OR setArg is non-literal → conservative
            // `touchesBalance = true` (left at its default).

            if (touchesBalance) {
              const context = getEnclosingContext(node);
              walletBalanceWrites.push({
                file,
                context,
                id: `${file}:${context}`,
                line: lineOf(sf!, node.getStart()),
              });
            }
          }
        }
      }
      node.forEachChild(visit);
    }
    visit(sf);
  }

  return { ledgerEntriesWrites, walletBalanceWrites };
}

function validateRawWriteRegistry(
  label: string,
  writes: RawTableWrite[],
  registry: Record<string, RawWriteRegistryEntry>,
  fixupHint: string,
): string[] {
  const issues: string[] = [];
  // Group findings by context id.
  const byId = new Map<string, RawTableWrite[]>();
  for (const w of writes) {
    const arr = byId.get(w.id) ?? [];
    arr.push(w);
    byId.set(w.id, arr);
  }

  for (const [id, sites] of byId) {
    const reg = registry[id];
    if (!reg) {
      const lines = sites
        .map((s) => `${s.file}:${s.line}`)
        .join(", ");
      issues.push(
        `${label}: NEW callsite in unlisted context "${id}" (${sites.length} site(s) at ${lines}). ${fixupHint} If this write is genuinely necessary and routing through the primitive is impossible, register the context with { count: ${sites.length}, reason: "<one-line summary>" } and document why the primitive cannot be used.`,
      );
      continue;
    }
    if (reg.count !== sites.length) {
      const lines = sites.map((s) => `${s.file}:${s.line}`).join(", ");
      issues.push(
        `${label}: registered context "${id}" expected count=${reg.count} but the scan found ${sites.length} callsite(s) at ${lines}. If a NEW write was added to this handler/function, ${fixupHint} If a callsite was legitimately removed, drop the count to match the new total (or remove the entry entirely if it dropped to zero).`,
      );
    }
  }

  for (const id of Object.keys(registry)) {
    if (!byId.has(id)) {
      issues.push(
        `${label}: registered context "${id}" no longer matches any callsite — remove the stale registry entry so the doc-of-record stays accurate.`,
      );
    }
  }

  return issues;
}

describe("raw ledger_entries / wallets writer coverage walk (Task #195)", () => {
  it("every direct insert(ledgerEntries) callsite is routed through postLedgerEntries or explicitly allowlisted", async () => {
    const { ledgerEntriesWrites } = await discoverRawTableWrites();

    // Anchor: discovery must locate the one sanctioned writer
    // (postLedgerEntries) — otherwise the scan silently broke (wrong
    // dir, broken symbol resolution, etc.) and every per-context check
    // below would falsely "pass".
    const sanctioned = ledgerEntriesWrites.filter(
      (w) => w.id === "services/ledger.ts:postLedgerEntries",
    );
    expect(
      sanctioned.length,
      "Static scan failed to locate the sanctioned ledger_entries writer (services/ledger.ts:postLedgerEntries). Symbol resolution or file walk is broken.",
    ).toBeGreaterThanOrEqual(1);

    const issues = validateRawWriteRegistry(
      "ledger_entries",
      ledgerEntriesWrites,
      RAW_LEDGER_ENTRIES_WRITER_REGISTRY,
      "Route the insert through `postLedgerEntries(transactionId, entries, tx)` in `server/services/ledger.ts` so the same-transaction posting guard, balanced-pair check, and upstream kill-switches all run.",
    );

    if (issues.length > 0) {
      throw new Error(
        `Raw ledger_entries writer scan failed:\n  - ${issues.join(
          "\n  - ",
        )}`,
      );
    }
  });

  it("every direct update(wallets).set({balance,...}) callsite is routed through refreshWalletCacheBalance or explicitly allowlisted", async () => {
    const { walletBalanceWrites } = await discoverRawTableWrites();

    // Anchor: same as above — make sure the scan saw the sanctioned
    // wallet-balance writer and the runtime-guarded storage helper.
    const sanctioned = walletBalanceWrites.filter(
      (w) => w.id === "services/ledger.ts:refreshWalletCacheBalance",
    );
    expect(
      sanctioned.length,
      "Static scan failed to locate the sanctioned wallet-balance writer (services/ledger.ts:refreshWalletCacheBalance). Symbol resolution or file walk is broken.",
    ).toBeGreaterThanOrEqual(1);
    const guarded = walletBalanceWrites.filter(
      (w) => w.id === "storage.ts:DatabaseStorage.updateWallet",
    );
    expect(
      guarded.length,
      "Static scan failed to locate the runtime-guarded wallet update helper (storage.ts:DatabaseStorage.updateWallet). Symbol resolution or file walk is broken.",
    ).toBeGreaterThanOrEqual(1);

    const issues = validateRawWriteRegistry(
      "wallets.balance",
      walletBalanceWrites,
      RAW_WALLET_BALANCE_WRITER_REGISTRY,
      "Route the update through `refreshWalletCacheBalance(tx, userId, currency)` in `server/services/ledger.ts` immediately after `postLedgerEntries(...)` in the SAME transaction, so the cached balance can never lag the ledger.",
    );

    if (issues.length > 0) {
      throw new Error(
        `Raw wallets.balance writer scan failed:\n  - ${issues.join(
          "\n  - ",
        )}`,
      );
    }
  });

  it("registries cover the sanctioned primitives and known legacy bypasses (anchor)", () => {
    // Belt-and-braces: independent of the discovery walk, assert the
    // headline writers (sanctioned + runtime-guarded + known legacy
    // bypasses) are still listed. If someone deletes a registry entry
    // AND the underlying callsite in the same change, the "stale
    // entry" check above goes silent — this anchor keeps the headline
    // writer set explicit.
    expect(RAW_LEDGER_ENTRIES_WRITER_REGISTRY).toHaveProperty(
      "services/ledger.ts:postLedgerEntries",
    );
    expect(RAW_WALLET_BALANCE_WRITER_REGISTRY).toHaveProperty(
      "services/ledger.ts:refreshWalletCacheBalance",
    );
    expect(RAW_WALLET_BALANCE_WRITER_REGISTRY).toHaveProperty(
      "storage.ts:DatabaseStorage.updateWallet",
    );
    expect(RAW_WALLET_BALANCE_WRITER_REGISTRY).toHaveProperty(
      "routes.ts:POST /api/fx-exchange",
    );
    expect(RAW_WALLET_BALANCE_WRITER_REGISTRY).toHaveProperty(
      "routes.ts:POST /api/investments",
    );
    expect(RAW_WALLET_BALANCE_WRITER_REGISTRY).toHaveProperty(
      "routes.ts:POST /api/wallets/transfer",
    );
  });
});

// ---------------------------------------------------------------------------
// 7. HTTP entry-point coverage walk (Task #189)
// ---------------------------------------------------------------------------
// Section 6 above catches a new MONEY-MOVEMENT FUNCTION landing in
// `server/services/` without a guard. This block catches the symmetric
// failure mode at the HTTP layer: a new `app.post|put|patch|delete(...)`
// in `server/routes.ts` whose path or handler name matches the
// money-movement verb pattern (deposit/withdraw/transfer/settle/post/
// credit/debit) but whose handler body forgets `assertKillSwitchOff`.
//
// Concrete failure mode this catches:
//   * A future webhook handler — e.g. `POST /api/webhooks/<provider>/
//     credit-wallet` — silently bypasses the kill switch because the
//     author copy-pasted from a non-money-movement template that never
//     called `assertKillSwitchOff`. Section 1 above only exercises the
//     seven hand-enumerated routes in `MONEY_MOVEMENT_ROUTES`, so it
//     would not notice the new endpoint.
//
// Like Section 6, the check is a static walk of `server/routes.ts`. We
// don't try to spin up the new endpoint at runtime — the kill-switch
// guard would (correctly) block its execution path, leaving us nothing
// to assert against. A grep-style scan over the source file gives us the
// strong "fail when a guard is missing" signal while keeping the test
// cheap and DB-free.
//
// MATCHING POLICY
//   For every `app.post|put|patch|delete("PATH", ...)` registration we
//   discover in `server/routes.ts`:
//     * Verb-matching = the route PATH or the named handler symbol
//       (e.g. `handleDeposit`) contains one of the canonical
//       money-movement verbs (case-insensitive).
//     * Body = either (a) the inline arrow body that follows the
//       registration, or (b) the body of the named handler (e.g.
//       `const handleDeposit = async (req, ...) => { ... };`) referenced
//       at the registration site.
//
//   Each verb-matching route MUST be classified in
//   KILL_SWITCH_HTTP_ROUTE_REGISTRY below as one of:
//
//     guarded                       — handler body calls assertKillSwitchOff(...)
//     allowlisted_not_money_movement — path/handler name happens to
//                                      contain a verb but the endpoint
//                                      does not move money. Read-only
//                                      reporting endpoints live here.
//
//   The registry ALSO lists guarded routes whose path does NOT match the
//   verb pattern (e.g. `/api/fx-exchange`, `/api/investments`) — they
//   are still money-movement and we want them enumerated in one place
//   so reviewers can see the full guarded set at a glance ("the seven
//   currently-guarded routes are enumerated in one place" — Task #189
//   acceptance criterion).
//
// FAILURE MODES THE TEST CATCHES
//   * A new verb-matching `app.<method>("PATH", ...)` lands without an
//     `assertKillSwitchOff` guard AND is not in the registry → fail
//     with a message telling the author exactly what to do (add the
//     guard, or register as not-money-movement with a documented
//     reason).
//   * A registry entry classified `guarded` whose handler body no
//     longer contains `assertKillSwitchOff(` → fail (a refactor
//     silently dropped the guard).
//   * A registry entry classified `allowlisted_not_money_movement`
//     whose body now does call `assertKillSwitchOff(` → fail
//     (re-classify as `guarded`).
//   * A registry entry that no longer corresponds to a real
//     `app.<method>("PATH", ...)` registration → fail (the route was
//     renamed/removed; clean up the registry so the doc-of-record stays
//     accurate).
//
// HOW TO EXTEND
//   When you add a new money-movement HTTP route:
//     1. Call `await assertKillSwitchOff(<specific>, "transactions")`
//        at the top of the handler body, BEFORE any DB write.
//     2. Add it to KILL_SWITCH_HTTP_ROUTE_REGISTRY below as
//        `{ classification: "guarded", reason: "<one-line summary>" }`.
//     3. Add it to MONEY_MOVEMENT_ROUTES (Section 1) so HTTP engagement
//        actually surfaces as 503 with the canonical envelope.
// ---------------------------------------------------------------------------

const ROUTES_FILE = path.resolve(SERVICES_DIR, "..", "routes.ts");

type HttpRouteClassification = "guarded" | "allowlisted_not_money_movement";

// Single source of truth for the seven currently-guarded money-movement
// HTTP routes. Reviewers can read this map top-to-bottom to see exactly
// which routes are in scope. Mirror of KILL_SWITCH_ENTRY_POINT_REGISTRY
// for the HTTP layer.
const KILL_SWITCH_HTTP_ROUTE_REGISTRY: Record<
  string,
  { classification: HttpRouteClassification; reason: string }
> = {
  "POST /api/fx-exchange": {
    classification: "guarded",
    reason:
      "FX exchange endpoint. Calls assertKillSwitchOff('transactions') (no narrower category exists for this op).",
  },
  "POST /api/deposit": {
    classification: "guarded",
    reason:
      "Canonical deposit endpoint, mounted with shared handleDeposit. handleDeposit calls assertKillSwitchOff('deposits', 'transactions') before opening its DB tx.",
  },
  "POST /api/wallets/deposit": {
    classification: "guarded",
    reason:
      "Legacy deposit endpoint, mounted with shared handleDeposit. Same guard as POST /api/deposit.",
  },
  "POST /api/withdraw": {
    classification: "guarded",
    reason:
      "Canonical withdrawal endpoint, mounted with shared handleWithdraw. handleWithdraw calls assertKillSwitchOff('withdrawals', 'transactions') before opening its DB tx.",
  },
  "POST /api/wallets/withdraw": {
    classification: "guarded",
    reason:
      "Legacy withdrawal endpoint, mounted with shared handleWithdraw. Same guard as POST /api/withdraw.",
  },
  "POST /api/investments": {
    classification: "guarded",
    reason:
      "Investment buy endpoint. Calls assertKillSwitchOff('transactions') — investments fall under the master switch (no narrower category).",
  },
  "POST /api/wallets/transfer": {
    classification: "guarded",
    reason:
      "Wallet currency conversion endpoint. Calls assertKillSwitchOff('transactions') — internal money-movement under the master switch.",
  },
};

type DiscoveredHttpRoute = {
  id: string; // "<METHOD> <path>"
  method: string;
  routePath: string;
  handlerName: string | null;
  body: string;
};

// Discovery is intentionally a syntactic walk rather than a TypeScript AST
// parse, to keep the test cheap and dependency-free. That choice rests on
// these conventions in `server/routes.ts` — if a future refactor changes
// any of them, the corresponding regex below needs to be updated or the
// new shape will silently slip past the guard check:
//   * Route paths are double-quoted string literals: `app.post("/api/...")`.
//     Single quotes, template strings, or variables for the path will not
//     be discovered.
//   * Named handler references are the LAST positional argument on the
//     SAME line as the registration: `app.post("/path", limiter, handleX);`.
//     A multi-line registration that puts the handler name on its own line
//     would fall through to the inline-body branch and miss the named
//     handler's body.
//   * Named handlers are declared as `const handleX = async (req...) => { ... };`
//     at 2-space indentation inside `registerRoutes(app)`. Other shapes
//     (function declarations, default exports) are not indexed.
//   * Inline arrow handlers live at 2-space indentation, so the body
//     slice terminates at the next sibling `app.<method>(` or
//     `const ...` at that exact indentation level.
async function discoverHttpRoutes(): Promise<DiscoveredHttpRoute[]> {
  const text = await fs.readFile(ROUTES_FILE, "utf8");
  const lines = text.split("\n");

  // Pass 1: index every named handler definition of the form
  //   `  const handleX = async (req: Request, res: any) => {`
  // The body extends until the matching `};` at the same indentation. We
  // need this so that a route registered as
  //   `app.post("/api/deposit", moneyMovementLimiter, handleDeposit);`
  // resolves to handleDeposit's body when we look for `assertKillSwitchOff`.
  const handlerBodies = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*async\s*\(/.exec(
      lines[i],
    );
    if (!m) continue;
    const indent = m[1];
    const name = m[2];
    let endIdx = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      // Same-indentation `};` is the canonical close for an arrow assigned
      // to a `const`. The handler defs in routes.ts all follow this shape.
      if (lines[j] === `${indent}};`) {
        endIdx = j + 1;
        break;
      }
    }
    handlerBodies.set(name, lines.slice(i, endIdx).join("\n"));
  }

  // Pass 2: every `app.<method>("PATH", ...)` call.
  const found: DiscoveredHttpRoute[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /\bapp\.(post|put|patch|delete)\s*\(\s*"([^"]+)"/.exec(lines[i]);
    if (!m) continue;
    const method = m[1].toUpperCase();
    const routePath = m[2];
    const id = `${method} ${routePath}`;

    // Single-line registration referencing a named handler:
    //   `app.post("/api/deposit", moneyMovementLimiter, handleDeposit);`
    // The trailing `, identifier);` lets us look up the handler body.
    const namedM = /,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*;?\s*$/.exec(lines[i]);
    let handlerName: string | null = null;
    let body: string;
    if (namedM && handlerBodies.has(namedM[1])) {
      handlerName = namedM[1];
      body = handlerBodies.get(handlerName)!;
    } else {
      // Inline arrow handler. Take from this line until the next sibling
      // declaration at the SAME indentation level (i.e. the next route
      // registration or the next named `const handle...` declaration
      // inside the registerRoutes(app) function). All route registrations
      // and handler defs in routes.ts live at 2-space indentation; the
      // `const idemKey = ...`, `const parsed = ...` declarations inside
      // a handler body are indented 4+ spaces, so anchoring on the exact
      // 2-space prefix avoids cutting off the body at the very first
      // inner `const` (which would falsely "lose" the guard call further
      // down). The 2-space anchor is also why `handleDeposit` /
      // `handleWithdraw` (defined between route registrations) cannot
      // smuggle a false-positive guard match into the FX route's body —
      // the slice stops at their `const handle... =` line.
      const indentMatch = /^(\s*)/.exec(lines[i]);
      const baseIndent = indentMatch ? indentMatch[1] : "";
      const siblingRouteRe = new RegExp(
        `^${baseIndent}app\\.(post|put|patch|delete|get|use)\\s*\\(`,
      );
      const siblingConstRe = new RegExp(
        `^${baseIndent}const\\s+[A-Za-z_][A-Za-z0-9_]*\\s*=`,
      );
      let endIdx = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (siblingRouteRe.test(lines[j]) || siblingConstRe.test(lines[j])) {
          endIdx = j;
          break;
        }
      }
      body = lines.slice(i, endIdx).join("\n");
    }

    found.push({ id, method, routePath, handlerName, body });
  }
  return found;
}

describe("HTTP entry-point coverage walk (Task #189)", () => {
  it("every money-movement-named HTTP route in server/routes.ts is either guarded or registered with a reason", async () => {
    const discovered = await discoverHttpRoutes();

    // Sanity: if discovery returned nothing, the file walk silently broke
    // and every check below would falsely "pass". Anchor on the routes we
    // already KNOW exist so a "discovery returns []" regression is loud.
    expect(discovered.length).toBeGreaterThanOrEqual(
      Object.keys(KILL_SWITCH_HTTP_ROUTE_REGISTRY).length,
    );

    const issues: string[] = [];
    const seenIds = new Set<string>();

    for (const route of discovered) {
      const verbMatch =
        MONEY_MOVEMENT_VERB_RE.test(route.routePath) ||
        (route.handlerName !== null &&
          MONEY_MOVEMENT_VERB_RE.test(route.handlerName));
      const registered = KILL_SWITCH_HTTP_ROUTE_REGISTRY[route.id];
      if (registered) seenIds.add(route.id);

      const guardsItself = /\bassertKillSwitchOff\s*\(/.test(route.body);

      if (!registered) {
        if (!verbMatch) continue; // Out of scope — not a money-movement-named route.
        if (guardsItself) {
          issues.push(
            `${route.id} calls assertKillSwitchOff() but is missing from KILL_SWITCH_HTTP_ROUTE_REGISTRY. Add it as { classification: "guarded", reason: "<summary>" } so the in-scope set stays auditable.`,
          );
        } else {
          issues.push(
            `${route.id} matches the money-movement verb pattern (deposit/withdraw/transfer/settle/post/credit/debit) but neither calls assertKillSwitchOff() nor appears in KILL_SWITCH_HTTP_ROUTE_REGISTRY. Either: (a) add \`await assertKillSwitchOff(<specific>, "transactions")\` at the top of the handler body and register it as "guarded"; or (b) if the path/handler name is misleading and the endpoint does not move money, register it as "allowlisted_not_money_movement" with a one-line reason.`,
          );
        }
        continue;
      }

      switch (registered.classification) {
        case "guarded":
          if (!guardsItself) {
            issues.push(
              `${route.id} is registered as "guarded" but its handler body no longer calls assertKillSwitchOff(). Either restore the guard at the top of the handler or move the registry entry to "allowlisted_not_money_movement" with a reason describing why the endpoint no longer needs the guard.`,
            );
          }
          break;
        case "allowlisted_not_money_movement":
          if (guardsItself) {
            issues.push(
              `${route.id} is registered as "allowlisted_not_money_movement" but its handler body now calls assertKillSwitchOff(). If the endpoint does in fact move money, re-classify it as "guarded".`,
            );
          }
          break;
      }
    }

    for (const id of Object.keys(KILL_SWITCH_HTTP_ROUTE_REGISTRY)) {
      if (!seenIds.has(id)) {
        issues.push(
          `KILL_SWITCH_HTTP_ROUTE_REGISTRY entry "${id}" no longer matches any \`app.<method>("PATH", ...)\` registration in server/routes.ts. Remove the stale registry entry so the doc-of-record stays accurate.`,
        );
      }
    }

    if (issues.length > 0) {
      throw new Error(
        `Kill-switch HTTP route coverage check failed:\n  - ${issues.join(
          "\n  - ",
        )}`,
      );
    }
  });

  it("registry covers the seven currently-guarded routes (anchor)", () => {
    // Belt-and-braces: independent of the discovery walk, assert the
    // seven guarded routes the rest of this suite exercises are still
    // listed in the registry. If someone deletes a registry entry AND
    // the underlying route in the same change, the "stale entry" check
    // above goes silent — this anchor keeps the headline guarded set
    // explicit.
    const expected = [
      "POST /api/fx-exchange",
      "POST /api/deposit",
      "POST /api/wallets/deposit",
      "POST /api/withdraw",
      "POST /api/wallets/withdraw",
      "POST /api/investments",
      "POST /api/wallets/transfer",
    ];
    for (const id of expected) {
      expect(KILL_SWITCH_HTTP_ROUTE_REGISTRY).toHaveProperty(id);
      expect(KILL_SWITCH_HTTP_ROUTE_REGISTRY[id].classification).toBe(
        "guarded",
      );
    }
    // And the headline anchor: the seven routes from MONEY_MOVEMENT_ROUTES
    // (Section 1) line up 1:1 with the guarded entries in the registry, so
    // a future addition to one MUST be mirrored to the other.
    const registryGuarded = Object.entries(KILL_SWITCH_HTTP_ROUTE_REGISTRY)
      .filter(([, v]) => v.classification === "guarded")
      .map(([k]) => k)
      .sort();
    const sectionOnePosts = MONEY_MOVEMENT_ROUTES.map(
      (r) => `POST ${r.path}`,
    ).sort();
    expect(registryGuarded).toEqual(sectionOnePosts);
  });
});

// Suppress unused-import lints in environments that don't strip them
// automatically; these helpers are referenced via vitest patterns above.
void drizzleSql;
void inArray;
