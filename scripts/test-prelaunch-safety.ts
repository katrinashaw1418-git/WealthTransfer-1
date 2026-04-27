// =============================================================================
// PRE-LAUNCH SAFETY VERIFICATION — Task #133
// =============================================================================
// 30-minute launch-readiness gate covering money movement, ledger integrity,
// idempotency, reconciliation, valuation truth and compliance enforcement.
//
// Wraps the existing focused safety scripts and adds:
//   - missing-price valuation truth check (source-level regression guard)
//   - explicit SKIP entries (with reason) for rails not yet wired in this repo
//
// Hard rules:
//   - exits 0 only when all RUN checks pass
//   - never touches production user data
//   - never initiates an external transfer or real custodian call
//   - SKIP entries are NEVER counted as PASS — operator must wire the missing
//     rail before launch
//
// Usage:
//   npx tsx scripts/test-prelaunch-safety.ts
// =============================================================================

import "./_bootstrap-test-env";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

type Status = "pass" | "fail" | "skip";
interface CheckResult {
  name: string;
  status: Status;
  reason?: string;
  durationMs?: number;
}

const results: CheckResult[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runChildScript(label: string, scriptPath: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    console.log(`\n──────────────────────────────────────────────────────────────`);
    console.log(`▶ Running: ${label}`);
    console.log(`  (${scriptPath})`);
    console.log(`──────────────────────────────────────────────────────────────`);

    const child = spawn("npx", ["tsx", scriptPath], {
      stdio: "inherit",
      env: process.env,
    });

    child.on("exit", (code) => {
      const durationMs = Date.now() - start;
      if (code === 0) {
        resolve({ name: label, status: "pass", durationMs });
      } else {
        resolve({
          name: label,
          status: "fail",
          reason: `child script exited with code ${code}`,
          durationMs,
        });
      }
    });

    child.on("error", (err) => {
      const durationMs = Date.now() - start;
      resolve({
        name: label,
        status: "fail",
        reason: `failed to spawn: ${err.message}`,
        durationMs,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Custom check: valuation truth — manual_nav / missing-rate guards
// ---------------------------------------------------------------------------
// Verifies that calculateInvestmentPerformance still fail-closes for assets
// without a real price source (manual_nav, market_price) and for products
// missing an explicit annualReturn rate. This is a regression guard — if a
// future change quietly reintroduces a category-fallback fake rate, this
// check fails and blocks launch.
function checkValuationTruthSource(): CheckResult {
  const start = Date.now();
  const path = join(process.cwd(), "server", "routes.ts");
  let src: string;
  try {
    src = readFileSync(path, "utf-8");
  } catch (err: any) {
    return {
      name: "Valuation truth — missing price / missing rate guards",
      status: "fail",
      reason: `could not read ${path}: ${err.message}`,
      durationMs: Date.now() - start,
    };
  }

  const requiredMarkers = [
    // manual_nav / market_price → currentValue null with explicit status
    `valuationStatus = "missing_price_source"`,
    // products without an explicit rate → currentValue null with explicit status
    `valuationStatus = "missing_product_rate"`,
    // hasUnpricedAssets surfaces the gap to API callers
    "hasUnpricedAssets",
    // fail-closed comment is intentional documentation against silent fallback
    "Fail-closed",
  ];

  const missing = requiredMarkers.filter((m) => !src.includes(m));

  if (missing.length > 0) {
    return {
      name: "Valuation truth — missing price / missing rate guards",
      status: "fail",
      reason: `regression: missing markers in server/routes.ts: ${missing.join(", ")}`,
      durationMs: Date.now() - start,
    };
  }

  // Also ensure the dangerous getAnnualReturnFallback is NOT being used inside
  // calculateInvestmentPerformance. The function is allowed to exist for other
  // illustrative contexts but must not silently overwrite null currentValue.
  const perfFnStart = src.indexOf("function calculateInvestmentPerformance(");
  const perfFnEnd =
    perfFnStart >= 0
      ? src.indexOf("\n}\n", perfFnStart)
      : -1;
  if (perfFnStart >= 0 && perfFnEnd > perfFnStart) {
    const fnBody = src.slice(perfFnStart, perfFnEnd);
    // Strip line/block comments before scanning for an actual call. The
    // intentional comment "Category assumption fallbacks (getAnnualReturnFallback)
    // are intentionally not used here" is documentation, not a call.
    const fnBodyNoComments = fnBody
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
    if (/getAnnualReturnFallback\s*\(/.test(fnBodyNoComments)) {
      return {
        name: "Valuation truth — missing price / missing rate guards",
        status: "fail",
        reason:
          "regression: calculateInvestmentPerformance is CALLING getAnnualReturnFallback() — silent fake rate fallback reintroduced",
        durationMs: Date.now() - start,
      };
    }
  }

  return {
    name: "Valuation truth — missing price / missing rate guards",
    status: "pass",
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Custom check: synthetic UI residue — the three items cleaned in #132
// ---------------------------------------------------------------------------
function checkNoSyntheticUiResidue(): CheckResult {
  const start = Date.now();
  const path = join(process.cwd(), "client", "src", "pages", "ai-advisory.tsx");
  let src: string;
  try {
    src = readFileSync(path, "utf-8");
  } catch (err: any) {
    return {
      name: "No synthetic UI residue (ai-advisory.tsx)",
      status: "fail",
      reason: `could not read ${path}: ${err.message}`,
      durationMs: Date.now() - start,
    };
  }

  const forbidden: Array<{ pattern: string; why: string }> = [
    {
      pattern: "Requested 2 Aug 2025",
      why: "fake SOA timeline date — fabricated compliance state",
    },
    {
      pattern: "Cash allocation (fiat)\", current: 47",
      why: "hardcoded mock allocation chart",
    },
    {
      pattern: "const allocationData = [",
      why: "mock allocationData array",
    },
    {
      pattern: "const soaItems = [",
      why: "mock soaItems array",
    },
  ];

  const present = forbidden.filter((f) => src.includes(f.pattern));
  if (present.length > 0) {
    return {
      name: "No synthetic UI residue (ai-advisory.tsx)",
      status: "fail",
      reason:
        "regression — synthetic content reappeared: " +
        present.map((p) => `"${p.pattern}" (${p.why})`).join("; "),
      durationMs: Date.now() - start,
    };
  }

  return {
    name: "No synthetic UI residue (ai-advisory.tsx)",
    status: "pass",
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Custom check: rebalancing benchmark is honestly labelled as illustrative
// ---------------------------------------------------------------------------
function checkBenchmarkHonestlyLabelled(): CheckResult {
  const start = Date.now();
  const path = join(process.cwd(), "server", "routes.ts");
  let src: string;
  try {
    src = readFileSync(path, "utf-8");
  } catch (err: any) {
    return {
      name: "Rebalancing benchmark labelled as illustrative",
      status: "fail",
      reason: `could not read ${path}: ${err.message}`,
      durationMs: Date.now() - start,
    };
  }

  const required = [
    `rebalancingBenchmarkType = "equal_weight_illustrative"`,
    "rebalancingBenchmarkNote",
    "A personalised benchmark must be set by your adviser",
  ];

  const missing = required.filter((m) => !src.includes(m));
  if (missing.length > 0) {
    return {
      name: "Rebalancing benchmark labelled as illustrative",
      status: "fail",
      reason: `missing transparency markers: ${missing.join(", ")}`,
      durationMs: Date.now() - start,
    };
  }

  return {
    name: "Rebalancing benchmark labelled as illustrative",
    status: "pass",
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  AMAX WEALTH — PRE-LAUNCH SAFETY VERIFICATION");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("Scope: idempotency · ledger truth · lifecycle · compliance");
  console.log("       valuation truth · UI residue · benchmark transparency");
  console.log("");

  // 1. Transaction safety rails
  results.push(
    await runChildScript(
      "Transaction safety rails (idempotency · ledger · lifecycle · reconciliation · race)",
      "scripts/test-transaction-safety.ts",
    ),
  );

  // 2. Wealth planner compliance gates (lock · audit · diff)
  results.push(
    await runChildScript(
      "Wealth planner compliance gates (lock · audit · diff)",
      "scripts/test-wealth-planner-compliance.ts",
    ),
  );

  // 3. Fee deduction insufficient funds
  results.push(
    await runChildScript(
      "Fee deduction — insufficient funds gate",
      "scripts/test-fee-insufficient-funds.ts",
    ),
  );

  // 4. Fee deduction approval gate
  results.push(
    await runChildScript(
      "Fee deduction — approval gate",
      "scripts/test-fee-deduction-gate-b.ts",
    ),
  );

  // 5. Valuation truth (source regression guard)
  console.log(`\n──────────────────────────────────────────────────────────────`);
  console.log(`▶ Static check: valuation truth guards`);
  console.log(`──────────────────────────────────────────────────────────────`);
  const v = checkValuationTruthSource();
  console.log(`  ${v.status === "pass" ? "PASS" : "FAIL"}${v.reason ? " — " + v.reason : ""}`);
  results.push(v);

  // 6. No synthetic UI residue
  console.log(`\n──────────────────────────────────────────────────────────────`);
  console.log(`▶ Static check: no synthetic UI residue`);
  console.log(`──────────────────────────────────────────────────────────────`);
  const u = checkNoSyntheticUiResidue();
  console.log(`  ${u.status === "pass" ? "PASS" : "FAIL"}${u.reason ? " — " + u.reason : ""}`);
  results.push(u);

  // 7. Benchmark labelled honestly
  console.log(`\n──────────────────────────────────────────────────────────────`);
  console.log(`▶ Static check: rebalancing benchmark transparency`);
  console.log(`──────────────────────────────────────────────────────────────`);
  const b = checkBenchmarkHonestlyLabelled();
  console.log(`  ${b.status === "pass" ? "PASS" : "FAIL"}${b.reason ? " — " + b.reason : ""}`);
  results.push(b);

  // 8. SKIP — Custodian failure simulation (no custodian SDK in repo)
  results.push({
    name: "Custodian failure simulation",
    status: "skip",
    reason:
      "no custodian integration SDK present in repo — wire and re-enable before any real money rail goes live",
  });

  // 9. SKIP — Inbound webhook duplicate (no inbound payment-rail webhook handler)
  results.push({
    name: "Duplicate inbound webhook idempotency",
    status: "skip",
    reason:
      "no inbound payment-rail webhook handler verified — wire and re-enable before any real money rail goes live",
  });

  // ----- Summary -----
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  PRE-LAUNCH SAFETY — RESULTS");
  console.log("══════════════════════════════════════════════════════════════");

  let pass = 0,
    fail = 0,
    skip = 0;
  for (const r of results) {
    const tag =
      r.status === "pass" ? "[PASS]" : r.status === "fail" ? "[FAIL]" : "[SKIP]";
    const dur = r.durationMs != null ? ` (${r.durationMs}ms)` : "";
    console.log(`  ${tag} ${r.name}${dur}${r.reason ? "\n         → " + r.reason : ""}`);
    if (r.status === "pass") pass++;
    else if (r.status === "fail") fail++;
    else skip++;
  }

  console.log(
    `\n  Summary: ${pass} pass · ${fail} fail · ${skip} skip · ${results.length} total`,
  );

  if (fail > 0) {
    console.log("\n  RESULT: NOT LAUNCH READY — failures above must be fixed.\n");
    process.exit(1);
  }
  if (skip > 0) {
    console.log(
      "\n  RESULT: PARTIAL — all run checks pass, but the SKIPPED rails above\n" +
        "          MUST be wired and verified before any real money rail goes live.\n",
    );
    // exit 0 — partial pass is intentional for this stage; SKIPs are visible & honest
    process.exit(0);
  }
  console.log("\n  RESULT: ALL VERIFIED CHECKS PASS — launch gate green.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n[pre-launch-safety] uncaught:", err);
  process.exit(1);
});
