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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import http from "http";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, statSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Pin LOG_DIR to a tmp location BEFORE importing error-log so its lazy path
// resolution picks up the override. Importing the module first would still
// work (paths are resolved per-call), but pinning up-front documents intent.
const TMP_LOG_DIR = mkdtempSync(path.join(tmpdir(), "errlog-test-"));
process.env.LOG_DIR = TMP_LOG_DIR;

// Dynamic import so the env var above is honoured.
let recordServerError: typeof import("./error-log").recordServerError;
let bumpFailedTransactions: typeof import("./error-log").bumpFailedTransactions;
let bumpAuditWriteFailures: typeof import("./error-log").bumpAuditWriteFailures;
let bumpFeeDeductionFailures: typeof import("./error-log").bumpFeeDeductionFailures;
let getInProcessCounters: typeof import("./error-log").getInProcessCounters;

beforeAll(async () => {
  const mod = await import("./error-log");
  recordServerError = mod.recordServerError;
  bumpFailedTransactions = mod.bumpFailedTransactions;
  bumpAuditWriteFailures = mod.bumpAuditWriteFailures;
  bumpFeeDeductionFailures = mod.bumpFeeDeductionFailures;
  getInProcessCounters = mod.getInProcessCounters;
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

// =============================================================================
// Task #166 — file rotation regression coverage
// =============================================================================
// Locks in the rotation contract from services/error-log.ts:
//
//   * When errors.log is at or above MAX_FILE_BYTES, the next append rotates
//     errors.log → errors.log.1 (and any prior errors.log.{N} → .{N+1}).
//   * The cap is MAX_ROTATIONS (=3): the oldest rotated copy beyond .3 is
//     dropped so the on-disk footprint stays bounded under sustained 5xx
//     volume.
//
// We pre-fill the log file (and its prior rotations) directly via fs writes
// — no need to drive 5MB of HTTP traffic through the sink — and then trigger
// exactly one append via recordServerError. Each rotated file is tagged with
// a unique marker so we can prove the shift happened in the right direction.
// =============================================================================

const ERR_LOG = (): string => path.join(TMP_LOG_DIR, "errors.log");
const ROTATED = (n: number): string => path.join(TMP_LOG_DIR, `errors.log.${n}`);
const FIVE_MB = 5 * 1024 * 1024;

function writeMarker(file: string, marker: string, padToBytes = 0): void {
  // Marker is the first line so it survives the rotation rename. Pad with a
  // single newline + filler so the file size matches the production threshold
  // exactly when needed.
  const head = `MARKER:${marker}\n`;
  const padBytes = Math.max(0, padToBytes - head.length);
  const filler = padBytes > 0 ? "x".repeat(padBytes) : "";
  writeFileSync(file, head + filler, "utf8");
}

function readMarker(file: string): string | null {
  if (!existsSync(file)) return null;
  // First line is enough — the marker convention pins it there.
  const firstLine = readFileSync(file, "utf8").split("\n")[0] ?? "";
  const m = firstLine.match(/^MARKER:(.+)$/);
  return m ? m[1] : null;
}

async function flushWriteChain(): Promise<void> {
  // Same trick the existing readLog() helper uses — give the serialised
  // appendFile chain a tick to settle before observing the filesystem.
  await new Promise((r) => setTimeout(r, 100));
}

describe("error log file rotation", () => {
  beforeEach(() => {
    // Wipe the log file and any rotated copies so each test starts clean.
    for (const p of [ERR_LOG(), ROTATED(1), ROTATED(2), ROTATED(3), ROTATED(4)]) {
      if (existsSync(p)) rmSync(p);
    }
  });

  it("rotates errors.log → errors.log.1 when the file is at the size threshold", async () => {
    // Pre-fill the live file so it is exactly at the MAX_FILE_BYTES boundary
    // — the production check is `size < MAX_FILE_BYTES ? skip : rotate`, so
    // a file AT the threshold must rotate on the next append.
    writeMarker(ERR_LOG(), "live-pre-rotation", FIVE_MB);
    expect(statSync(ERR_LOG()).size).toBeGreaterThanOrEqual(FIVE_MB);

    // Trigger one append. The rotation runs synchronously inside the write
    // chain BEFORE the new entry is appended.
    recordServerError({
      tag: "http_5xx",
      method: "GET",
      path: "/rotation-trigger",
      status: 500,
      error: new Error("rotation trigger"),
    });
    await flushWriteChain();

    // The pre-existing live file now lives at errors.log.1; the new live
    // file contains ONLY the freshly-appended entry (no marker).
    expect(readMarker(ROTATED(1))).toBe("live-pre-rotation");
    expect(readMarker(ERR_LOG())).toBeNull();

    // The new live file holds exactly one structured entry — proves the
    // append happened AFTER the rename, not before it (which would have
    // dragged the new line into the rotated copy).
    const liveLines = readFileSync(ERR_LOG(), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(liveLines).toHaveLength(1);
    expect(JSON.parse(liveLines[0]).path).toBe("/rotation-trigger");
  });

  it("does NOT rotate when the file is comfortably below the threshold", async () => {
    // Same trigger, but the file is small. We must observe the new entry
    // appended in place with NO rotated copy created.
    writeMarker(ERR_LOG(), "small-live-file", 1024);
    recordServerError({
      tag: "http_5xx",
      method: "GET",
      path: "/no-rotation",
      status: 500,
      error: new Error("no rotation expected"),
    });
    await flushWriteChain();

    expect(readMarker(ERR_LOG())).toBe("small-live-file");
    expect(existsSync(ROTATED(1))).toBe(false);
  });

  it("caps the rotated copies at MAX_ROTATIONS — the oldest is dropped, never shifted to .4", async () => {
    // Set up a full rotation ladder + a live file at the threshold:
    //   errors.log     — "live"  (will become .1)
    //   errors.log.1   — "gen-1" (will become .2)
    //   errors.log.2   — "gen-2" (will become .3)
    //   errors.log.3   — "gen-3" (the oldest — must be DROPPED)
    writeMarker(ERR_LOG(), "live", FIVE_MB);
    writeMarker(ROTATED(1), "gen-1", 256);
    writeMarker(ROTATED(2), "gen-2", 256);
    writeMarker(ROTATED(3), "gen-3", 256);

    recordServerError({
      tag: "http_5xx",
      method: "GET",
      path: "/cap-trigger",
      status: 500,
      error: new Error("cap trigger"),
    });
    await flushWriteChain();

    // The shift happened correctly:
    //   .1 ← live    (the previous .1 contents have moved on to .2)
    //   .2 ← gen-1
    //   .3 ← gen-2
    expect(readMarker(ROTATED(1))).toBe("live");
    expect(readMarker(ROTATED(2))).toBe("gen-1");
    expect(readMarker(ROTATED(3))).toBe("gen-2");

    // The oldest copy was dropped, NOT promoted to errors.log.4. This is
    // the bounded-disk-footprint invariant the rotation cap exists for.
    expect(existsSync(ROTATED(4))).toBe(false);
  });
});

// =============================================================================
// Task #166 — sliding-window counter regression coverage
// =============================================================================
// Locks in the contract for the in-process counters that feed the admin
// metrics tile (see services/error-log.ts → getInProcessCounters):
//
//   * Recent bumps are visible immediately.
//   * Bumps older than the 24h window are PRUNED on the next read — a
//     long-running process that bursted yesterday MUST report 0 today.
//   * The four counters (failed transactions, audit-log write failures,
//     fee-deduction failures, http5xx) are independent — pruning one does
//     not affect the others.
//
// Time is controlled with vi.useFakeTimers so the 24h boundary can be
// crossed in a millisecond. Date.now() is what the production code reads
// internally to timestamp every bump.
// =============================================================================

describe("in-process counter sliding window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Drain in two steps so neither real-time timestamps from the file's
    // earlier describe blocks NOR fake-time timestamps from sibling tests
    // in this block survive into the current test:
    //   1. Jump the fake clock to the far future. Everything previously
    //      bumped — at any real wall-clock or any earlier fake timestamp
    //      we have used — is now older than (now - 24h).
    //   2. A single getInProcessCounters() call runs the prune sweep on
    //      every counter array, leaving them empty.
    //   3. Rewind to the stable base time used by the assertions below so
    //      the per-test math (advance N hours, expect K pruned) is easy
    //      to read.
    vi.setSystemTime(new Date("2200-01-01T00:00:00Z"));
    void getInProcessCounters();
    vi.setSystemTime(new Date("2099-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts recent bumps and prunes anything older than 24h on the next read", async () => {
    // Two bumps at t=0 — both well inside the 24h window.
    bumpFailedTransactions();
    bumpFailedTransactions();
    expect(getInProcessCounters().failedTransactionsLast24h).toBe(2);

    // Jump 23h59m — both bumps are still fresh.
    vi.advanceTimersByTime(23 * 60 * 60 * 1000 + 59 * 60 * 1000);
    expect(getInProcessCounters().failedTransactionsLast24h).toBe(2);

    // Jump 2 minutes more — total 24h02m elapsed since the original bumps,
    // so the prune on the next read MUST drop both. This is the regression
    // a future change to WINDOW_MS that silently flips the verdict (e.g.
    // 23h vs 24h vs 36h) would trip on.
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(getInProcessCounters().failedTransactionsLast24h).toBe(0);
  });

  it("keeps recent entries while pruning only the stale ones (mixed-age window)", async () => {
    // One bump at t=0 (will go stale), two bumps at t=23h (will survive).
    bumpAuditWriteFailures();
    vi.advanceTimersByTime(23 * 60 * 60 * 1000);
    bumpAuditWriteFailures();
    bumpAuditWriteFailures();
    expect(getInProcessCounters().auditWriteFailuresLast24h).toBe(3);

    // Jump 2h forward — total elapsed 25h for the first bump (stale), 2h
    // for the latter two (still fresh). The prune must keep exactly the
    // two recent ones.
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(getInProcessCounters().auditWriteFailuresLast24h).toBe(2);
  });

  it("isolates each counter — pruning failedTransactions does not touch fee-deduction failures", async () => {
    // Two old bumps on counter A, one fresh bump on counter B.
    bumpFailedTransactions();
    bumpFailedTransactions();
    vi.advanceTimersByTime(25 * 60 * 60 * 1000); // age out counter A
    bumpFeeDeductionFailures(); // fresh on counter B

    const c = getInProcessCounters();
    expect(c.failedTransactionsLast24h).toBe(0);
    expect(c.feeDeductionFailuresLast24h).toBe(1);
    // The audit and 5xx counters were never touched in this test — must
    // still be zero. (beforeEach drained any leftovers from prior tests.)
    expect(c.auditWriteFailuresLast24h).toBe(0);
    expect(c.http5xxLast24h).toBe(0);
  });

  it("bumps the http5xx counter as a side-effect of recordServerError", async () => {
    // recordServerError with the default tag should increment http5xx
    // exactly once — proving the metrics tile sees real error volume even
    // though there is no public bumpHttp5xx export.
    expect(getInProcessCounters().http5xxLast24h).toBe(0);
    recordServerError({
      tag: "http_5xx",
      method: "GET",
      path: "/internal-err",
      status: 500,
      error: new Error("counted"),
    });
    expect(getInProcessCounters().http5xxLast24h).toBe(1);

    // Audit-log-tagged calls bump auditWriteFailures, NOT http5xx — the
    // two tags MUST stay on separate ledgers so the admin tile can show
    // them independently.
    recordServerError({
      tag: "audit_log_write_failure",
      error: new Error("audit blew up"),
    });
    const after = getInProcessCounters();
    expect(after.http5xxLast24h).toBe(1);
    expect(after.auditWriteFailuresLast24h).toBe(1);
  });
});
