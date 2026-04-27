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

// Suppress unused-import lints in environments that don't strip them
// automatically; these helpers are referenced via vitest patterns above.
void drizzleSql;
void inArray;
