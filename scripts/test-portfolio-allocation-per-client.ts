// =============================================================================
// /api/portfolio/allocation — per-client benchmark regression (Task #406)
// -----------------------------------------------------------------------------
// Task #388 made `/api/portfolio/allocation` resolve the benchmark per-client
// from `risk_profiles` instead of returning the shared 25/25/25/25 default
// to every user. The pure-resolver math is gated by
// `scripts/test-rebalancing-benchmark.ts`, but that script never exercises
// the route handler — so a future regression that re-introduces the shared
// default in the handler (or wires the resolver to the wrong user) would
// pass that gate while silently breaking every client's portfolio page.
//
// This script closes that gap end-to-end:
//
//   1. Seeds two distinct test clients with different `risk_profiles`
//      allocations (canonical `conservative` vs `high_growth`).
//   2. Seeds a third test client with NO `risk_profiles` row.
//   3. Mounts `registerPortfolioAllocationRoute` on a tiny loopback express
//      server with the real DB (so the route's per-user `where
//      clientId = ?` query is exercised) but with a stubbed
//      `calculatePortfolioTotalsAtDate` so the test is independent of
//      wallet / FX / investment fixtures.
//   4. Issues an authenticated GET against each user and asserts:
//        - User A and User B return different `benchmark.targets` payloads.
//        - User A's targets match the resolver's output for `conservative`
//          (`type === "risk_profile_personalised"`).
//        - User B's targets match the resolver's output for `high_growth`
//          (`type === "risk_profile_personalised"`).
//        - User C falls back to `equal_weight_illustrative` with
//          25/25/25/25 targets — the documented no-profile contract.
//
// The script cleans up its own rows on every run (same try/finally pattern
// as the other DB-touching `scripts/test-*.ts` files) so it can sit on the
// shared CI ledger-leak gate without producing drift.
//
// Run with: `npx tsx scripts/test-portfolio-allocation-per-client.ts`
//
// Exits non-zero on the first failure with an actionable message.
// =============================================================================

// Bootstrap MUST be the first import — sets JWT_SECRET + NODE_ENV defaults
// and refuses to run against a production-like database.
import "./_bootstrap-test-env";

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  users,
  riskProfiles,
  factFindSnapshots,
} from "../shared/schema";
import { signToken } from "../server/auth";
import {
  registerPortfolioAllocationRoute,
  type PortfolioAllocationTotals,
} from "../server/portfolio-allocation-route";
import {
  DEFAULT_REBALANCING_BENCHMARK,
  resolveBenchmarkForRiskProfileRow,
} from "../server/config/rebalancing-benchmark";
import { PORTFOLIO_ALLOCATIONS } from "../server/services/risk-scoring";

// ---------------------------------------------------------------------------
// Tiny assertion helpers — kept local so this script has no test-runner
// dependency, matching the style of `scripts/test-rebalancing-benchmark.ts`.
// ---------------------------------------------------------------------------
const failures: string[] = [];
let passed = 0;

function record(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function approxEqual(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

function targetsApproxEqual(
  actual: { fiat: number; crypto: number; stablecoin: number; investment: number },
  expected: { fiat: number; crypto: number; stablecoin: number; investment: number },
  eps = 1e-9,
): boolean {
  return (
    approxEqual(actual.fiat, expected.fiat, eps) &&
    approxEqual(actual.crypto, expected.crypto, eps) &&
    approxEqual(actual.stablecoin, expected.stablecoin, eps) &&
    approxEqual(actual.investment, expected.investment, eps)
  );
}

function fmtTargets(
  t: { fiat: number; crypto: number; stablecoin: number; investment: number } | null | undefined,
): string {
  // Defensive: when an assertion is failing because the route returned no
  // `targets` object at all, the harness used to crash here while building
  // the failure message — masking the real cause behind a TypeError. Render
  // a clear "(none)" instead so the underlying assertion failure surfaces.
  if (t == null) return "(none)";
  return `{ fiat: ${t.fiat}, crypto: ${t.crypto}, stablecoin: ${t.stablecoin}, investment: ${t.investment} }`;
}

// ---------------------------------------------------------------------------
// Per-run fixture suffix — keeps concurrent runs of this script (and any
// stale rows from a hard-killed previous run) from colliding on the
// `users.username` UNIQUE constraint. The cleanup at the end of the script
// targets THIS run's suffix only via the `__alloc406_<suffix>__` prefix.
// ---------------------------------------------------------------------------
const RUN_SUFFIX = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const FIXTURE_PREFIX = `__alloc406_${RUN_SUFFIX}__`;

interface SeededUser {
  id: number;
  username: string;
}

async function seedClient(label: string): Promise<SeededUser> {
  const username = `${FIXTURE_PREFIX}${label}`;
  const email = `${username}@invalid.local`;
  const [u] = await db
    .insert(users)
    .values({
      username,
      email,
      password: "not-a-real-password",
      firstName: "Alloc406",
      lastName: label,
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  return { id: u.id, username };
}

async function seedRiskProfile(
  clientId: number,
  band: keyof typeof PORTFOLIO_ALLOCATIONS,
): Promise<void> {
  // risk_profiles.factFindSnapshotId is NOT NULL → seed a minimal
  // snapshot first. rawAnswers is the only other NOT NULL field.
  const [snap] = await db
    .insert(factFindSnapshots)
    .values({
      clientId,
      rawAnswers: { source: "test-portfolio-allocation-per-client" },
      isComplete: true,
    })
    .returning();

  await db.insert(riskProfiles).values({
    clientId,
    factFindSnapshotId: snap.id,
    behaviouralScore: 50,
    capacityAdjustment: 0,
    finalScore: 50,
    riskBand: band,
    recommendedPortfolio: band,
    overrideApplied: false,
    overrideReasons: [],
    allocation: PORTFOLIO_ALLOCATIONS[band],
    scoringInputs: { source: "test-portfolio-allocation-per-client" },
  });
}

async function cleanupRun(): Promise<void> {
  // Order matters: risk_profiles → fact_find_snapshots → users (FK chain).
  // Bound the sweep by THIS run's prefix so a parallel run is untouched.
  await db.execute(sql`
    DELETE FROM risk_profiles
    WHERE client_id IN (SELECT id FROM users WHERE username LIKE ${FIXTURE_PREFIX + "%"})
  `);
  await db.execute(sql`
    DELETE FROM fact_find_snapshots
    WHERE client_id IN (SELECT id FROM users WHERE username LIKE ${FIXTURE_PREFIX + "%"})
  `);
  await db.execute(sql`
    DELETE FROM users WHERE username LIKE ${FIXTURE_PREFIX + "%"}
  `);
}

// ---------------------------------------------------------------------------
// Loopback express harness — mounts ONLY the allocation route, with the
// real DB (so the per-user `where clientId = ?` query is exercised end-to-
// end) and a stubbed totals helper so the test is independent of wallet,
// FX, and investment fixtures. The benchmark payload doesn't depend on
// totals at all — the totals stub returns the same shape the production
// helper does so the rest of the response is well-formed.
// ---------------------------------------------------------------------------
const STUB_TOTALS: PortfolioAllocationTotals = {
  fiatValue: 5_000,
  cryptoValue: 2_500,
  stablecoinValue: 0,
  investmentValue: 2_500,
  totalValue: 10_000,
};

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const app = express();
  registerPortfolioAllocationRoute(app, {
    db,
    calculatePortfolioTotalsAtDate: async () => STUB_TOTALS,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

interface AllocationResponse {
  benchmark: {
    type: string;
    note: string;
    targets: { fiat: number; crypto: number; stablecoin: number; investment: number };
  };
}

async function fetchAllocation(
  baseUrl: string,
  user: SeededUser,
): Promise<{ status: number; body: AllocationResponse }> {
  const token = signToken({
    userId: user.id,
    username: user.username,
    email: `${user.username}@invalid.local`,
    role: "client",
  });
  const res = await fetch(`${baseUrl}/api/portfolio/allocation`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as AllocationResponse;
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Main — wrap everything in try/finally so the cleanup sweep runs even if
// an assertion or DB error throws.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  let harness: Harness | null = null;
  try {
    // Seed three clients: two with distinct risk profiles, one with none.
    // Conservative and high_growth are the canonical extremes — their
    // four-bucket projections differ in every bucket, so an off-by-one in
    // the route's per-user query (e.g. accidentally returning the same
    // profile for everyone) would FAIL every per-bucket assertion below.
    const [clientA, clientB, clientC] = await Promise.all([
      seedClient("conservative"),
      seedClient("high_growth"),
      seedClient("noprofile"),
    ]);
    await seedRiskProfile(clientA.id, "conservative");
    await seedRiskProfile(clientB.id, "high_growth");
    // clientC: no risk_profile row on purpose.

    harness = await startHarness();

    const [respA, respB, respC] = await Promise.all([
      fetchAllocation(harness.baseUrl, clientA),
      fetchAllocation(harness.baseUrl, clientB),
      fetchAllocation(harness.baseUrl, clientC),
    ]);

    record(
      "client A (conservative): HTTP 200",
      respA.status === 200,
      `expected 200, got ${respA.status}`,
    );
    record(
      "client B (high_growth): HTTP 200",
      respB.status === 200,
      `expected 200, got ${respB.status}`,
    );
    record(
      "client C (no profile): HTTP 200",
      respC.status === 200,
      `expected 200, got ${respC.status}`,
    );

    // -----------------------------------------------------------------------
    // 1. The personalised benchmark for each profiled client must match
    //    what `resolveBenchmarkForRiskProfileRow` would produce for that
    //    risk-band's allocation — i.e. the route delegates to the resolver
    //    on a per-user basis and does not return a hard-coded default.
    // -----------------------------------------------------------------------
    const expectedAWeights = resolveBenchmarkForRiskProfileRow({
      allocation: PORTFOLIO_ALLOCATIONS.conservative,
    }).weights;
    const expectedATargets = {
      fiat:       expectedAWeights.fiat       * 100,
      crypto:     expectedAWeights.crypto     * 100,
      stablecoin: expectedAWeights.stablecoin * 100,
      investment: expectedAWeights.investment * 100,
    };
    record(
      "client A: benchmark.type === 'risk_profile_personalised'",
      respA.body?.benchmark?.type === "risk_profile_personalised",
      `expected risk_profile_personalised, got ${respA.body?.benchmark?.type}`,
    );
    record(
      "client A: benchmark.targets matches conservative mapping",
      respA.body?.benchmark?.targets != null &&
        targetsApproxEqual(respA.body.benchmark.targets, expectedATargets),
      `expected ${fmtTargets(expectedATargets)}, got ${fmtTargets(respA.body?.benchmark?.targets)}`,
    );

    const expectedBWeights = resolveBenchmarkForRiskProfileRow({
      allocation: PORTFOLIO_ALLOCATIONS.high_growth,
    }).weights;
    const expectedBTargets = {
      fiat:       expectedBWeights.fiat       * 100,
      crypto:     expectedBWeights.crypto     * 100,
      stablecoin: expectedBWeights.stablecoin * 100,
      investment: expectedBWeights.investment * 100,
    };
    record(
      "client B: benchmark.type === 'risk_profile_personalised'",
      respB.body?.benchmark?.type === "risk_profile_personalised",
      `expected risk_profile_personalised, got ${respB.body?.benchmark?.type}`,
    );
    record(
      "client B: benchmark.targets matches high_growth mapping",
      respB.body?.benchmark?.targets != null &&
        targetsApproxEqual(respB.body.benchmark.targets, expectedBTargets),
      `expected ${fmtTargets(expectedBTargets)}, got ${fmtTargets(respB.body?.benchmark?.targets)}`,
    );

    // -----------------------------------------------------------------------
    // 2. The two profiled clients MUST see different targets. This is the
    //    headline regression the task exists to catch — a future change
    //    that re-introduces a shared default would make these payloads
    //    identical even though the seeded profiles differ in every bucket.
    //    Using the canonical extremes (conservative vs high_growth) means
    //    every bucket differs, so a partial regression (e.g. only the
    //    crypto bucket reverts to a shared value) still fails.
    // -----------------------------------------------------------------------
    const tA = respA.body?.benchmark?.targets;
    const tB = respB.body?.benchmark?.targets;
    record(
      "clients A and B see DIFFERENT benchmark.targets",
      tA != null &&
        tB != null &&
        !targetsApproxEqual(tA, tB),
      `client A=${fmtTargets(tA)} vs client B=${fmtTargets(tB)} — both clients are seeing the same target, which is exactly the regression Task #388 fixed and Task #406 pins`,
    );

    // -----------------------------------------------------------------------
    // 3. The no-profile client MUST fall back to the equal-weight
    //    illustrative default (25/25/25/25). This is the documented
    //    fallback contract from the resolver — see
    //    `scripts/test-rebalancing-benchmark.ts` for the resolver-side
    //    pin. Verifying it through the route handler proves the route
    //    actually queries by clientId (and so finds nothing for client C)
    //    rather than returning a globally-cached profile from a previous
    //    request.
    // -----------------------------------------------------------------------
    const expectedCTargets = {
      fiat:       DEFAULT_REBALANCING_BENCHMARK.weights.fiat       * 100,
      crypto:     DEFAULT_REBALANCING_BENCHMARK.weights.crypto     * 100,
      stablecoin: DEFAULT_REBALANCING_BENCHMARK.weights.stablecoin * 100,
      investment: DEFAULT_REBALANCING_BENCHMARK.weights.investment * 100,
    };
    record(
      "client C (no profile): benchmark.type === 'equal_weight_illustrative'",
      respC.body?.benchmark?.type === "equal_weight_illustrative",
      `expected equal_weight_illustrative, got ${respC.body?.benchmark?.type}`,
    );
    record(
      "client C (no profile): benchmark.targets is the equal-weight 25/25/25/25 default",
      respC.body?.benchmark?.targets != null &&
        targetsApproxEqual(respC.body.benchmark.targets, expectedCTargets),
      `expected ${fmtTargets(expectedCTargets)}, got ${fmtTargets(respC.body?.benchmark?.targets)}`,
    );
    // Belt-and-braces: the no-profile client's targets must NOT collide
    // with either personalised payload. A regression that returned the
    // most-recently-inserted profile for every user would be caught here
    // even if the type field happened to be reported correctly.
    record(
      "client C targets differ from client A (no cross-user leakage)",
      respC.body?.benchmark?.targets != null &&
        tA != null &&
        !targetsApproxEqual(respC.body.benchmark.targets, tA),
      `client C and client A both saw ${fmtTargets(tA)} — route is leaking a profile across users`,
    );
    record(
      "client C targets differ from client B (no cross-user leakage)",
      respC.body?.benchmark?.targets != null &&
        tB != null &&
        !targetsApproxEqual(respC.body.benchmark.targets, tB),
      `client C and client B both saw ${fmtTargets(tB)} — route is leaking a profile across users`,
    );
  } finally {
    if (harness) {
      try {
        await harness.close();
      } catch {
        // Best-effort — server close errors must not mask test failures.
      }
    }
    try {
      await cleanupRun();
    } catch (err) {
      console.error("[cleanup] failed:", err);
      throw err;
    }
  }
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(
        `✗ portfolio-allocation per-client tests: ${failures.length} failure(s) (${passed} passed)\n`,
      );
      for (const f of failures) console.error(`  - ${f}`);
      console.error(
        "\nSee server/portfolio-allocation-route.ts and Task #406 for context.",
      );
      process.exit(1);
    }
    console.log(
      `✓ portfolio-allocation per-client tests: ${passed} assertion(s) passed across two profiled clients and a no-profile fallback.`,
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error("✗ portfolio-allocation per-client tests: harness error:", err);
    process.exit(1);
  });
