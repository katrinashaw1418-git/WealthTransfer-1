/**
 * Regression test for Task #132 — "Remove synthetic portfolio data".
 *
 * This script greps a small set of production-path files for two failure
 * modes and exits non-zero if either is found:
 *
 *   1. A hardcoded numeric array literal of length >= MIN_ARRAY_LEN whose
 *      elements are all bare numeric literals. This catches a developer
 *      pasting a sample allocation like `[47, 30, 15, 8]` back into a
 *      route handler or rendered component.
 *
 *   2. The previously-removed magic 0.25/0.25/0.25/0.25 quartet inside
 *      `server/routes.ts`. The benchmark constants now live in
 *      `server/config/rebalancing-benchmark.ts` (the one place where this
 *      quartet IS allowed). Reintroducing the literal in routes.ts would
 *      mean the magic constant has been re-inlined.
 *
 * Run with: `npx tsx scripts/test-no-synthetic-portfolio-data.ts`
 */

import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const TOUCHED_FILES = [
  "client/src/components/dashboard/quick-actions.tsx",
  "client/src/pages/ai-advisory.tsx",
  "server/routes.ts",
];

// "Meaningful length" — anything >= 4 numeric items in a single inline literal
// is large enough to look like sample portfolio data (asset allocation, price
// series, etc.). Smaller arrays (e.g. `[1, 2, 3]` for a skeleton key) are
// noise and would generate false positives.
const MIN_ARRAY_LEN = 4;

// Matches a `[ num, num, num, ... ]` array literal where every element is a
// bare numeric literal (integer or decimal, optionally signed). Whitespace,
// trailing commas, and newlines between items are all tolerated.
const NUMERIC_ARRAY_RE = /\[\s*(-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?)+)\s*,?\s*\]/g;

function checkNumericArrayLiteral(filePath: string, source: string): string[] {
  const failures: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = NUMERIC_ARRAY_RE.exec(source)) !== null) {
    const items = match[1].split(",").map((s) => s.trim()).filter(Boolean);
    if (items.length >= MIN_ARRAY_LEN) {
      // Find the line number of the match so the failure message is actionable.
      const upTo = source.slice(0, match.index);
      const line = upTo.split("\n").length;
      failures.push(
        `${filePath}:${line} — hardcoded numeric array of length ${items.length}: [${items.join(", ")}]`,
      );
    }
  }
  return failures;
}

function checkMagicEqualWeightInRoutes(filePath: string, source: string): string[] {
  if (!filePath.endsWith("server/routes.ts")) return [];
  // Re-inlined `0.25`-quartet detector. Allows arbitrary whitespace / commas /
  // newlines between the four occurrences, which is the only shape the old
  // bug ever took. `0.25` appearing in isolation (e.g. a comment or a totally
  // different formula) is allowed.
  const QUARTET_RE = /0\.25[\s\S]{0,200}0\.25[\s\S]{0,200}0\.25[\s\S]{0,200}0\.25/g;
  const failures: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = QUARTET_RE.exec(source)) !== null) {
    const upTo = source.slice(0, match.index);
    const line = upTo.split("\n").length;
    failures.push(
      `${filePath}:${line} — re-inlined 0.25/0.25/0.25/0.25 equal-weight quartet. ` +
        `Use server/config/rebalancing-benchmark.ts instead.`,
    );
  }
  return failures;
}

function main(): void {
  const allFailures: string[] = [];

  for (const rel of TOUCHED_FILES) {
    const abs = path.join(ROOT, rel);
    if (!existsSync(abs)) {
      allFailures.push(`MISSING FILE: ${rel}`);
      continue;
    }
    const source = readFileSync(abs, "utf8");
    allFailures.push(...checkNumericArrayLiteral(rel, source));
    allFailures.push(...checkMagicEqualWeightInRoutes(rel, source));
  }

  if (allFailures.length > 0) {
    console.error("✗ Synthetic-data regression detected:\n");
    for (const f of allFailures) console.error(`  - ${f}`);
    console.error(
      `\n${allFailures.length} failure(s). See task #132 (.local/tasks/task-132.md) for context.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ No synthetic-data regressions in ${TOUCHED_FILES.length} touched file(s).`,
  );
  console.log(`  Checked: ${TOUCHED_FILES.join(", ")}`);
  console.log(`  Threshold: numeric array length >= ${MIN_ARRAY_LEN}`);
}

main();
