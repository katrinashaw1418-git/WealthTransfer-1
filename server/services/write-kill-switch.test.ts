// =============================================================================
// TASK #155 — Focused tests for the global write kill switch
// =============================================================================
// Locks in the contracts that an admin (or an on-call operator) cares about
// during an incident:
//
//   1. Default state is OFF — a fresh row + no env override = writes flow.
//   2. setWriteKillSwitch({ enabled: true, ... }) flips the in-memory cache
//      and the DB; isWriteBlocked() returns true; a subsequent
//      setWriteKillSwitch({ enabled: false }) flips it back.
//   3. The toggle's before/after snapshot accurately reflects the OFF→ON and
//      ON→OFF transitions, including reason + actorUserId attribution.
//   4. assertWritesAllowed() returns { allowed: false } when ON so background
//      jobs can short-circuit cleanly without throwing.
//   5. The WRITE_KILL_SWITCH=on env override forces the effective state ON
//      regardless of the DB row, AND surfaces envOverride=true on the state
//      snapshot so admins know they cannot turn it off via the UI.
//   6. The HTTP middleware returns 503 with the stable JSON shape for
//      non-admin POSTs and lets GETs + admin-token POSTs through.
//
// Every test resets state in afterEach so reruns are idempotent.
// =============================================================================

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// server/auth.ts asserts JWT_SECRET at module-init outside local-dev, but
// vitest worker forks do not always inherit the dev shell's JWT_SECRET.
// vi.hoisted runs before any of the static imports below resolve.
vi.hoisted(() => {
  process.env.JWT_SECRET ||= "write-kill-switch-test-secret";
});

import { eq } from "drizzle-orm";
import express from "express";
import type { Server } from "http";
import { db } from "../db";
import { systemSettings } from "@shared/schema";
import {
  ensureSystemSettingsTable,
  getWriteKillSwitchState,
  invalidateWriteKillSwitchCache,
  isWriteBlocked,
  setWriteKillSwitch,
  assertWritesAllowed,
  _refreshEnvOverrideForTests,
  WRITE_KILL_SWITCH_ERROR_CODE,
} from "./write-kill-switch";
import { writeKillSwitchMiddleware } from "../middleware/write-kill-switch";
import { signToken } from "../auth";

// Use a fixed test actor id so we don't need to seed a fresh user. We rely
// on the FK column being nullable in practice for the OFF row, but for the
// ON path we use user id 1 (the demo user) which the dev DB always has.
const TEST_ACTOR_USER_ID = 1;

async function resetSettingsRow(): Promise<void> {
  // Force the row back to (off, null reason, null actor) so each test
  // starts from a known state. We do NOT delete the row — the singleton
  // CHECK constraint and the loader's seed path mean other code paths
  // would just recreate it on the next call anyway.
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

beforeAll(async () => {
  // Make sure the table exists in the dev DB even if `npm run db:push` has
  // not been run since this task landed.
  await ensureSystemSettingsTable();
});

let originalEnvOverride: string | undefined;

beforeEach(async () => {
  originalEnvOverride = process.env.WRITE_KILL_SWITCH;
  delete process.env.WRITE_KILL_SWITCH;
  _refreshEnvOverrideForTests();
  await resetSettingsRow();
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

describe("write kill switch — service layer", () => {
  it("defaults to OFF with no reason/actor when freshly seeded", async () => {
    const state = await getWriteKillSwitchState();
    expect(state.enabled).toBe(false);
    expect(state.envOverride).toBe(false);
    expect(state.reason).toBeNull();
    expect(state.enabledByUserId).toBeNull();
    expect(state.enabledAt).toBeNull();
    expect(await isWriteBlocked()).toBe(false);
  });

  it("flips ON via setWriteKillSwitch with reason + actor, then OFF again", async () => {
    const onResult = await setWriteKillSwitch({
      enabled: true,
      reason: "incident-test",
      actorUserId: TEST_ACTOR_USER_ID,
    });
    expect(onResult.changed).toBe(true);
    expect(onResult.before.enabled).toBe(false);
    expect(onResult.after.enabled).toBe(true);
    expect(onResult.after.reason).toBe("incident-test");
    expect(onResult.after.enabledByUserId).toBe(TEST_ACTOR_USER_ID);
    expect(onResult.after.enabledAt).toBeInstanceOf(Date);

    expect(await isWriteBlocked()).toBe(true);
    const live = await getWriteKillSwitchState();
    expect(live.enabled).toBe(true);
    expect(live.reason).toBe("incident-test");

    const offResult = await setWriteKillSwitch({
      enabled: false,
      reason: null,
      actorUserId: TEST_ACTOR_USER_ID,
    });
    expect(offResult.changed).toBe(true);
    expect(offResult.before.enabled).toBe(true);
    expect(offResult.after.enabled).toBe(false);
    expect(offResult.after.reason).toBeNull();
    expect(offResult.after.enabledByUserId).toBeNull();
    expect(offResult.after.enabledAt).toBeNull();
    expect(await isWriteBlocked()).toBe(false);
  });

  it("a no-op toggle (OFF→OFF) reports changed=false", async () => {
    const r = await setWriteKillSwitch({
      enabled: false,
      reason: null,
      actorUserId: TEST_ACTOR_USER_ID,
    });
    expect(r.changed).toBe(false);
    expect(r.before.enabled).toBe(false);
    expect(r.after.enabled).toBe(false);
  });

  it("assertWritesAllowed() returns allowed=true when OFF and allowed=false when ON", async () => {
    const okBefore = await assertWritesAllowed("test-job");
    expect(okBefore.allowed).toBe(true);
    expect(okBefore.reason).toBeNull();

    await setWriteKillSwitch({
      enabled: true,
      reason: "pause-for-test",
      actorUserId: TEST_ACTOR_USER_ID,
    });

    const blocked = await assertWritesAllowed("test-job");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("pause-for-test");
    expect(blocked.source).toBe("db_setting");
  });

  it("WRITE_KILL_SWITCH=on env override forces ON regardless of DB row", async () => {
    // DB row is OFF (reset in beforeEach). Set the env var and refresh.
    process.env.WRITE_KILL_SWITCH = "on";
    _refreshEnvOverrideForTests();
    invalidateWriteKillSwitchCache();

    expect(await isWriteBlocked()).toBe(true);
    const state = await getWriteKillSwitchState();
    expect(state.enabled).toBe(true);
    expect(state.envOverride).toBe(true);
    expect(state.reason).toContain("env var");

    // assertWritesAllowed mirrors the override.
    const blocked = await assertWritesAllowed("env-test-job");
    expect(blocked.allowed).toBe(false);
    expect(blocked.source).toBe("env_override");
  });
});

// ---------------------------------------------------------------------------
// Middleware integration — tiny in-memory express app with the kill switch
// middleware mounted exactly the way server/index.ts mounts it.
// ---------------------------------------------------------------------------
function buildTestApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api", writeKillSwitchMiddleware);
  app.get("/api/ping", (_req, res) => res.json({ ok: true }));
  app.post("/api/write", (_req, res) => res.json({ ok: true, wrote: true }));
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
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

describe("write kill switch — HTTP middleware", () => {
  it("OFF: GET and POST both succeed", async () => {
    const { server, baseUrl } = await listen(buildTestApp());
    try {
      const get = await fetch(`${baseUrl}/api/ping`);
      expect(get.status).toBe(200);

      const post = await fetch(`${baseUrl}/api/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(post.status).toBe(200);
      expect(await post.json()).toEqual({ ok: true, wrote: true });
    } finally {
      await close(server);
    }
  });

  it("ON: GET succeeds, non-admin POST returns 503 with stable JSON shape", async () => {
    await setWriteKillSwitch({
      enabled: true,
      reason: "middleware-test",
      actorUserId: TEST_ACTOR_USER_ID,
    });
    const { server, baseUrl } = await listen(buildTestApp());
    try {
      const get = await fetch(`${baseUrl}/api/ping`);
      expect(get.status).toBe(200);

      const post = await fetch(`${baseUrl}/api/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(post.status).toBe(503);
      const body = await post.json();
      expect(body.code).toBe(WRITE_KILL_SWITCH_ERROR_CODE);
      expect(typeof body.error).toBe("string");
      expect(body.reason).toBe("middleware-test");
    } finally {
      await close(server);
    }
  });

  it("ON: admin POST passes through (role=admin in JWT bypasses the gate)", async () => {
    await setWriteKillSwitch({
      enabled: true,
      reason: "admin-bypass-test",
      actorUserId: TEST_ACTOR_USER_ID,
    });
    const { server, baseUrl } = await listen(buildTestApp());
    try {
      const adminToken = signToken({
        userId: TEST_ACTOR_USER_ID,
        username: "admin-test",
        email: "admin-test@example.com",
        role: "admin",
      });
      const post = await fetch(`${baseUrl}/api/write`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({}),
      });
      expect(post.status).toBe(200);
      expect(await post.json()).toEqual({ ok: true, wrote: true });

      // Sanity: a NON-admin token is still blocked even when ON.
      const clientToken = signToken({
        userId: TEST_ACTOR_USER_ID + 99,
        username: "client-test",
        email: "client-test@example.com",
        role: "client",
      });
      const blocked = await fetch(`${baseUrl}/api/write`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${clientToken}`,
        },
        body: JSON.stringify({}),
      });
      expect(blocked.status).toBe(503);
      const body = await blocked.json();
      expect(body.code).toBe(WRITE_KILL_SWITCH_ERROR_CODE);
    } finally {
      await close(server);
    }
  });
});
