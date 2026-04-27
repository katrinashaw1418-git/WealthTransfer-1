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
