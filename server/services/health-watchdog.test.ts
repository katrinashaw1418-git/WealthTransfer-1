// =============================================================================
// Task #164 — automated tests for the in-process /health watchdog
// =============================================================================
// Locks in five guarantees of `tickHealthWatchdog`:
//
//   1. A healthy report keeps the watchdog quiet and never pages.
//   2. A degraded report under the threshold tracks the episode but does
//      NOT page yet — operators are not woken for a 30-second blip.
//   3. Once the report has been degraded for longer than the threshold,
//      ONE alert is dispatched (severity=alert) and subsequent degraded
//      ticks do NOT re-page (debounce — a 24h outage produces one alert,
//      not 1440).
//   4. Recovery (back to ok) after a paged episode dispatches an info
//      "recovered" row AND clears the in-flight state so the next outage
//      is paged afresh.
//   5. A degraded episode that recovers BEFORE crossing the threshold does
//      NOT dispatch a recovery row — operators were never told about the
//      outage so a recovery row would just be noise.
//
// The buildReport and notify dispatchers are injected so we exercise the
// state machine without driving the real DB into the various failure modes.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HEALTH_WATCHDOG_SOURCE,
  resolveHealthWatchdogConfig,
  resetHealthWatchdogStateForTests,
  tickHealthWatchdog,
} from "./health-watchdog";
import type { HealthReport } from "./health";
import type { OperatorAlertResult } from "./operator-alerts";

const okReport = (): HealthReport => ({
  status: "ok",
  generatedAt: new Date().toISOString(),
  durationMs: 1,
  checks: [
    {
      name: "database_connectivity",
      status: "ok",
      detail: "SELECT 1 round-trip 1ms",
    },
    {
      name: "fee_accruals",
      status: "ok",
      detail: "last success 5m ago",
      lastSuccessAt: new Date().toISOString(),
      ageMs: 5 * 60_000,
      thresholdMs: 36 * 60 * 60 * 1000,
    },
  ],
  lastSuccessfulProbeAt: new Date().toISOString(),
});

const degradedReport = (): HealthReport => ({
  status: "degraded",
  generatedAt: new Date().toISOString(),
  durationMs: 1,
  checks: [
    {
      name: "database_connectivity",
      status: "ok",
      detail: "SELECT 1 round-trip 1ms",
    },
    {
      name: "fee_accruals",
      status: "fail",
      detail: "no successful run recorded",
      lastSuccessAt: null,
      ageMs: null,
      thresholdMs: 36 * 60 * 60 * 1000,
    },
  ],
  lastSuccessfulProbeAt: null,
});

type CapturedAlert = {
  source: string;
  severity: string;
  title: string;
  details: Record<string, unknown>;
};

function makeNotifyStub() {
  const calls: CapturedAlert[] = [];
  let nextId = 1000;
  const notify = async (alert: CapturedAlert): Promise<OperatorAlertResult> => {
    calls.push(alert);
    return {
      channelsAttempted: ["log"],
      outcomes: [{ channel: "log", status: "success", durationMs: 0 }],
      channels: ["log"],
      alertId: nextId++,
      deliveryStatus: "delivered",
      occurrences: 1,
      dedupeKey: "test-key",
    };
  };
  return { notify, calls };
}

const ENV_KEYS = [
  "HEALTH_WATCHDOG_THRESHOLD_MINUTES",
  "HEALTH_WATCHDOG_PROBE_INTERVAL_SECONDS",
] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    originalEnv[k] = process.env[k];
    delete process.env[k];
  }
  resetHealthWatchdogStateForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = originalEnv[k];
    }
  }
  resetHealthWatchdogStateForTests();
});

describe("tickHealthWatchdog (Task #164)", () => {
  const cfg = { thresholdMinutes: 10, probeIntervalSeconds: 60 };

  it("stays quiet when /health is ok and no episode is in flight", async () => {
    const { notify, calls } = makeNotifyStub();
    const r = await tickHealthWatchdog({
      config: cfg,
      now: new Date("2026-04-26T12:00:00.000Z"),
      buildReport: async () => okReport(),
      notify,
    });
    expect(r.outcome).toBe("ok_no_episode");
    expect(r.alertId).toBeNull();
    expect(r.state.degradedSince).toBeNull();
    expect(r.state.alertFired).toBe(false);
    expect(r.state.lastStatus).toBe("ok");
    expect(calls).toHaveLength(0);
  });

  it("tracks a degraded episode under the threshold WITHOUT paging", async () => {
    const { notify, calls } = makeNotifyStub();
    const start = new Date("2026-04-26T12:00:00.000Z");
    const r1 = await tickHealthWatchdog({
      config: cfg,
      now: start,
      buildReport: async () => degradedReport(),
      notify,
    });
    expect(r1.outcome).toBe("degraded_under_threshold");
    expect(r1.state.degradedSince).toEqual(start);
    expect(r1.state.alertFired).toBe(false);
    expect(calls).toHaveLength(0);

    // 5 minutes later — still under the 10-minute threshold.
    const r2 = await tickHealthWatchdog({
      config: cfg,
      now: new Date(start.getTime() + 5 * 60_000),
      buildReport: async () => degradedReport(),
      notify,
    });
    expect(r2.outcome).toBe("degraded_under_threshold");
    expect(r2.state.degradedSince).toEqual(start);
    expect(r2.state.alertFired).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("dispatches exactly ONE alert once the threshold is crossed and stays silent thereafter", async () => {
    const { notify, calls } = makeNotifyStub();
    const start = new Date("2026-04-26T12:00:00.000Z");

    // Tick at t=0: under threshold, no page.
    await tickHealthWatchdog({
      config: cfg,
      now: start,
      buildReport: async () => degradedReport(),
      notify,
    });

    // Tick at t=11min: over threshold, MUST page.
    const fired = await tickHealthWatchdog({
      config: cfg,
      now: new Date(start.getTime() + 11 * 60_000),
      buildReport: async () => degradedReport(),
      notify,
    });
    expect(fired.outcome).toBe("degraded_alerted");
    expect(fired.state.alertFired).toBe(true);
    expect(fired.alertId).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBe(HEALTH_WATCHDOG_SOURCE);
    expect(calls[0].severity).toBe("alert");
    expect(calls[0].title).toMatch(/degraded for longer than the threshold/);
    expect((calls[0].details as { ageMinutes: number }).ageMinutes).toBe(11);
    expect(
      (calls[0].details as { thresholdMinutes: number }).thresholdMinutes,
    ).toBe(10);

    // Tick at t=12min: still degraded — debounce, MUST NOT page again.
    const stillDegraded = await tickHealthWatchdog({
      config: cfg,
      now: new Date(start.getTime() + 12 * 60_000),
      buildReport: async () => degradedReport(),
      notify,
    });
    expect(stillDegraded.outcome).toBe("degraded_already_alerted");
    expect(stillDegraded.alertId).toBeNull();
    expect(calls).toHaveLength(1);

    // Simulate "1440 ticks during a 24h outage" by advancing 24h.
    // Still degraded, still must NOT page again.
    const dayLater = await tickHealthWatchdog({
      config: cfg,
      now: new Date(start.getTime() + 24 * 60 * 60 * 1000),
      buildReport: async () => degradedReport(),
      notify,
    });
    expect(dayLater.outcome).toBe("degraded_already_alerted");
    expect(calls).toHaveLength(1);
  });

  it("dispatches an info recovery row when ok returns after a paged episode", async () => {
    const { notify, calls } = makeNotifyStub();
    const start = new Date("2026-04-26T12:00:00.000Z");

    // Drive one full degraded → over-threshold → alert episode.
    await tickHealthWatchdog({
      config: cfg,
      now: start,
      buildReport: async () => degradedReport(),
      notify,
    });
    await tickHealthWatchdog({
      config: cfg,
      now: new Date(start.getTime() + 11 * 60_000),
      buildReport: async () => degradedReport(),
      notify,
    });
    expect(calls).toHaveLength(1);

    // Recovery tick.
    const recovered = await tickHealthWatchdog({
      config: cfg,
      now: new Date(start.getTime() + 20 * 60_000),
      buildReport: async () => okReport(),
      notify,
    });
    expect(recovered.outcome).toBe("recovered");
    expect(recovered.state.degradedSince).toBeNull();
    expect(recovered.state.alertFired).toBe(false);
    expect(recovered.state.totalRecoveriesFired).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].source).toBe(HEALTH_WATCHDOG_SOURCE);
    expect(calls[1].severity).toBe("info");
    expect(calls[1].title).toMatch(/recovered/i);
    expect(
      (calls[1].details as { episodeDurationMinutes: number })
        .episodeDurationMinutes,
    ).toBe(20);
  });

  it("does NOT dispatch a recovery row when the episode never crossed the threshold", async () => {
    const { notify, calls } = makeNotifyStub();
    const start = new Date("2026-04-26T12:00:00.000Z");

    // Brief degraded blip — under the 10-minute threshold.
    await tickHealthWatchdog({
      config: cfg,
      now: start,
      buildReport: async () => degradedReport(),
      notify,
    });
    expect(calls).toHaveLength(0);

    // Recovery 2 minutes later — operators were never paged so we MUST
    // NOT dispatch a recovery row.
    const recovered = await tickHealthWatchdog({
      config: cfg,
      now: new Date(start.getTime() + 2 * 60_000),
      buildReport: async () => okReport(),
      notify,
    });
    expect(recovered.outcome).toBe("recovered");
    expect(recovered.alertId).toBeNull();
    expect(recovered.state.degradedSince).toBeNull();
    expect(recovered.state.alertFired).toBe(false);
    expect(recovered.state.totalRecoveriesFired).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("re-pages on the NEXT outage after recovery (state truly clears)", async () => {
    const { notify, calls } = makeNotifyStub();
    const start = new Date("2026-04-26T12:00:00.000Z");

    // Episode 1: alert + recover.
    await tickHealthWatchdog({
      config: cfg,
      now: start,
      buildReport: async () => degradedReport(),
      notify,
    });
    await tickHealthWatchdog({
      config: cfg,
      now: new Date(start.getTime() + 11 * 60_000),
      buildReport: async () => degradedReport(),
      notify,
    });
    await tickHealthWatchdog({
      config: cfg,
      now: new Date(start.getTime() + 15 * 60_000),
      buildReport: async () => okReport(),
      notify,
    });
    expect(calls).toHaveLength(2); // alert + recovery

    // Episode 2 starts an hour later — must page again.
    const ep2Start = new Date(start.getTime() + 60 * 60_000);
    await tickHealthWatchdog({
      config: cfg,
      now: ep2Start,
      buildReport: async () => degradedReport(),
      notify,
    });
    const ep2Fired = await tickHealthWatchdog({
      config: cfg,
      now: new Date(ep2Start.getTime() + 11 * 60_000),
      buildReport: async () => degradedReport(),
      notify,
    });
    expect(ep2Fired.outcome).toBe("degraded_alerted");
    expect(calls).toHaveLength(3);
    expect(calls[2].severity).toBe("alert");
  });

  it("treats a probe that throws as a degraded signal toward the threshold", async () => {
    const { notify, calls } = makeNotifyStub();
    const start = new Date("2026-04-26T12:00:00.000Z");

    // Probe throws — counts as degraded but under threshold.
    const t1 = await tickHealthWatchdog({
      config: cfg,
      now: start,
      buildReport: async () => {
        throw new Error("simulated db pool exhausted");
      },
      notify,
    });
    expect(t1.outcome).toBe("probe_error_under_threshold");
    expect(t1.state.lastStatus).toBe("probe_error");
    expect(t1.state.lastProbeError).toMatch(/pool exhausted/);
    expect(calls).toHaveLength(0);

    // Still throwing 11 minutes later — must page.
    const t2 = await tickHealthWatchdog({
      config: cfg,
      now: new Date(start.getTime() + 11 * 60_000),
      buildReport: async () => {
        throw new Error("simulated db pool exhausted");
      },
      notify,
    });
    expect(t2.outcome).toBe("probe_error_alerted");
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toMatch(/probe has been failing/);
    expect((calls[0].details as { status: string }).status).toBe("probe_error");
  });
});

describe("resolveHealthWatchdogConfig (Task #164)", () => {
  it("uses defaults when env vars are unset", () => {
    delete process.env.HEALTH_WATCHDOG_THRESHOLD_MINUTES;
    delete process.env.HEALTH_WATCHDOG_PROBE_INTERVAL_SECONDS;
    const c = resolveHealthWatchdogConfig();
    expect(c.thresholdMinutes).toBe(10);
    expect(c.probeIntervalSeconds).toBe(60);
  });

  it("honours valid env values and falls back on invalid ones", () => {
    process.env.HEALTH_WATCHDOG_THRESHOLD_MINUTES = "5";
    process.env.HEALTH_WATCHDOG_PROBE_INTERVAL_SECONDS = "30";
    expect(resolveHealthWatchdogConfig()).toEqual({
      thresholdMinutes: 5,
      probeIntervalSeconds: 30,
    });

    process.env.HEALTH_WATCHDOG_THRESHOLD_MINUTES = "0";
    process.env.HEALTH_WATCHDOG_PROBE_INTERVAL_SECONDS = "-1";
    expect(resolveHealthWatchdogConfig()).toEqual({
      thresholdMinutes: 10,
      probeIntervalSeconds: 60,
    });

    process.env.HEALTH_WATCHDOG_THRESHOLD_MINUTES = "not-a-number";
    process.env.HEALTH_WATCHDOG_PROBE_INTERVAL_SECONDS = "   ";
    expect(resolveHealthWatchdogConfig()).toEqual({
      thresholdMinutes: 10,
      probeIntervalSeconds: 60,
    });
  });
});
