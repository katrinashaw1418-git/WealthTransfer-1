// =============================================================================
// Task #144 — regression coverage for the persistent 5xx error log
// =============================================================================
// Two scenarios are exercised end-to-end against a tiny Express app:
//
//   1. A route that throws inside the handler (caught by Express's global
//      error middleware → recordServerError with a real Error/stack).
//
//   2. A route that returns `res.status(500).json(...)` directly (NOT caught
//      by the global error middleware — must still be persisted via the
//      response-finish sniffer in `server/index.ts`).
//
// Both should produce exactly one structured JSON line in `logs/errors.log`
// (the test redirects `LOG_DIR` to a tmp directory so it never touches the
// project's real log file).
// =============================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import http from "http";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Pin LOG_DIR to a tmp location BEFORE importing error-log so its lazy path
// resolution picks up the override. Importing the module first would still
// work (paths are resolved per-call), but pinning up-front documents intent.
const TMP_LOG_DIR = mkdtempSync(path.join(tmpdir(), "errlog-test-"));
process.env.LOG_DIR = TMP_LOG_DIR;

// Dynamic import so the env var above is honoured.
let recordServerError: typeof import("./error-log").recordServerError;

beforeAll(async () => {
  const mod = await import("./error-log");
  recordServerError = mod.recordServerError;
});

afterAll(() => {
  rmSync(TMP_LOG_DIR, { recursive: true, force: true });
});

interface BuildAppOptions {
  /** When true, install the same response-finish sniffer used in production. */
  installSniffer: boolean;
}

function buildApp(opts: BuildAppOptions): express.Express {
  const app = express();

  // Response-finish sniffer — copied from server/index.ts so the test
  // exercises the exact behaviour without booting the entire production
  // server (which would require a live DB connection).
  if (opts.installSniffer) {
    app.use((req, res, next) => {
      res.on("finish", () => {
        try {
          if (res.statusCode < 500) return;
          const locals = res.locals as Record<string, unknown>;
          if (locals._serverErrorRecorded) return;
          recordServerError({
            tag: "http_5xx",
            requestId: null,
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            userId: null,
            error: new Error(`manual_5xx_response (status ${res.statusCode})`),
          });
        } catch {
          /* swallow */
        }
      });
      next();
    });
  }

  app.get("/throws", (_req, _res, next) => {
    next(new Error("synthetic thrown failure"));
  });

  app.get("/manual-500", (_req, res) => {
    res.status(500).json({ error: "manual failure" });
  });

  // Global error middleware mimicking server/index.ts (records via the
  // shared helper, then sets the dedup flag so the sniffer skips this one).
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    const locals = res.locals as Record<string, unknown>;
    recordServerError({
      tag: "http_5xx",
      requestId: null,
      method: req.method,
      path: req.originalUrl,
      status: 500,
      userId: null,
      error: err,
    });
    locals._serverErrorRecorded = true;
    res.status(500).json({ message: "Internal Server Error" });
  });

  return app;
}

function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

async function readLog(): Promise<unknown[]> {
  // The sink serialises writes through a microtask chain — give it a tick
  // to flush before we read.
  await new Promise((r) => setTimeout(r, 100));
  const file = path.join(TMP_LOG_DIR, "errors.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function clearLog(): void {
  const file = path.join(TMP_LOG_DIR, "errors.log");
  if (existsSync(file)) rmSync(file);
}

describe("persistent error log", () => {
  beforeEach(() => clearLog());

  it("records a thrown 500 with method, path, status, and stack", async () => {
    const { url, close } = await listen(buildApp({ installSniffer: true }));
    try {
      const res = await fetch(`${url}/throws`);
      expect(res.status).toBe(500);
    } finally {
      await close();
    }

    const lines = await readLog();
    // Exactly one entry — the sniffer must NOT double-record because the
    // global middleware set _serverErrorRecorded.
    expect(lines).toHaveLength(1);
    const entry = lines[0] as Record<string, unknown>;
    expect(entry.tag).toBe("http_5xx");
    expect(entry.method).toBe("GET");
    expect(entry.path).toBe("/throws");
    expect(entry.status).toBe(500);
    expect(entry.message).toBe("synthetic thrown failure");
    expect(typeof entry.stack).toBe("string");
    expect((entry.stack as string).length).toBeGreaterThan(0);
  });

  it("records a manual res.status(500) response via the response-finish sniffer", async () => {
    const { url, close } = await listen(buildApp({ installSniffer: true }));
    try {
      const res = await fetch(`${url}/manual-500`);
      expect(res.status).toBe(500);
    } finally {
      await close();
    }

    const lines = await readLog();
    expect(lines).toHaveLength(1);
    const entry = lines[0] as Record<string, unknown>;
    expect(entry.tag).toBe("http_5xx");
    expect(entry.method).toBe("GET");
    expect(entry.path).toBe("/manual-500");
    expect(entry.status).toBe(500);
    // The synthetic marker proves the entry came from the sniffer, not the
    // global error middleware (which only fires for thrown errors).
    expect(String(entry.message)).toContain("manual_5xx_response");
  });

  it("does not record 4xx responses", async () => {
    const app = buildApp({ installSniffer: true });
    app.get("/four-oh-four", (_req, res) => res.status(404).json({}));
    const { url, close } = await listen(app);
    try {
      const res = await fetch(`${url}/four-oh-four`);
      expect(res.status).toBe(404);
    } finally {
      await close();
    }

    const lines = await readLog();
    expect(lines).toHaveLength(0);
  });
});
