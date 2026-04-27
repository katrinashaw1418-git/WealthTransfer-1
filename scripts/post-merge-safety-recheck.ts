// ---------------------------------------------------------------------------
// Post-merge pre-launch strict safety recheck (Task #184).
//
// Tasks #168 (kill-switch end-to-end) and #150 (final go/no-go report)
// produced a clean strict run of `scripts/pre-launch-safety.ts --strict`
// (10 passed, 0 failed, 0 skipped) while their own changes were still in
// flight. This runner re-confirms the same strict run is still clean
// AFTER both merges have landed on main and captures the verdict in
// version control next to the go/no-go report so launch sign-off does
// not depend on someone remembering to run the script by hand.
//
// What this runner does:
//   1. Shells out to `npx tsx scripts/pre-launch-safety.ts --strict` and
//      captures stdout, stderr, exit code, and wall-clock duration.
//   2. Parses the canonical PASS/FAIL/SKIP gate lines and the
//      `Summary: N passed, N failed, N skipped` line out of the output.
//   3. Computes a top-line verdict:
//        - GREEN if exit=0 AND `Summary: 10 passed, 0 failed, 0 skipped`.
//        - RED   otherwise (any FAIL, any SKIP under --strict, non-zero
//                exit, or fewer than the expected 10 gates reported).
//   4. Writes a structured markdown result file to
//      `docs/golive/post-merge-safety-recheck-<timestamp>.md` containing:
//        - The verdict, summary line, per-gate PASS/FAIL/SKIP table.
//        - The git commit SHA the recheck ran against.
//        - The task refs of the merges this recheck was gating on
//          (#168 and #150).
//        - A pointer to the most recent `docs/golive/go-no-go-*.md`
//          report it complements (or a clear note that none was found).
//        - On RED: the failing/skipped gate names verbatim and a
//          "what to do" hint pointing at the underlying safety script
//          so an operator can reproduce locally.
//        - The raw stdout / stderr (collapsed) for forensic detail.
//   5. Appends one line to `docs/PRE_LAUNCH_CHECKLIST.md` under a
//      "Post-merge rechecks" section (created on first run), recording
//      the timestamp, verdict, summary counts, short SHA, and a
//      relative link to the new result file. Existing entries are
//      preserved so prior verdicts stay visible in version control.
//
// Re-runnability:
//   The runner is safe to invoke repeatedly. Each invocation produces a
//   new timestamped result file (no overwrite) and appends a new
//   checklist line below the existing ones (no rewrite of prior rows).
//
// Out of scope (intentional, per task #184):
//   - Wiring the strict run into CI / deploy gating — Task #151 owns
//     that; this runner is the post-merge confirmation, not the gate.
//   - Adding new safety gates or changing the script's PASS/FAIL/SKIP
//     semantics. If the recheck comes back RED, do NOT patch
//     `pre-launch-safety.ts` here — record the result, leave the
//     failing gate names in the report, and flag a follow-up against
//     the actual regression.
// ---------------------------------------------------------------------------

import { execSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const REPORT_DIR = path.resolve(process.cwd(), "docs", "golive");
const CHECKLIST_PATH = path.resolve(
  process.cwd(),
  "docs",
  "PRE_LAUNCH_CHECKLIST.md",
);
const STARTED_AT = new Date();

// The canonical clean strict result the post-merge recheck must reproduce.
// Matches `Summary: 14 passed, 0 failed, 0 skipped` from the script output.
//
// Task #188 — bumped from 10 → 14 to track the four additional idempotency-
// under-concurrency lifecycle gates (withdraw, fx-exchange,
// wallets/transfer, investments) that have been added to
// `pre-launch-safety.ts` since this recheck was authored. The forward-
// compatible prefix check below already surfaces new "lifecycle: …" /
// "reconciliation: …" / "existing: …" gates, but the verdict comparison
// has to know the new total or every clean run reports RED with a stale
// "expected=10" footnote.
//
// Bumped from 14 → 19 after task #193 (CI ledger-leak gate) wired five
// new top-level PASS lines into the strict reporter:
//   - "ledger-leak: test-transaction-safety"     (1)
//   - "ledger-leak: test-fee-deduction-gate-b"   (2)
//   - "ledger-leak: test-wealth-planner-compliance" (3)
//   - "ledger-leak: test-task-35-suppression"    (4)
//   - "ledger-leak: ci-gate (other test-*.ts)"   (5)
// These are roll-ups, not invariant gates per se, but pre-launch-safety
// emits them with `PASS <name> — <details>` shape and the recheck's
// summary parser counts them. This is the manual-review action the
// recheck was designed to force whenever the gate count changes.
//
// Bumped from 19 → 27 after tasks #202 + #210 (platform-leg invariant
// per Stage-2 scenario + end-of-Stage-2 fixture-user contract) wired
// eight new top-level PASS lines into the strict reporter:
//   - "platform-leg: lifecycle 1 (happy path)"                       (1)
//   - "platform-leg: lifecycle 2 (idempotency: deposit)"             (2)
//   - "platform-leg: lifecycle 2b (idempotency: withdraw)"           (3)
//   - "platform-leg: lifecycle 2c (idempotency: fx-exchange)"        (4)
//   - "platform-leg: lifecycle 2d (idempotency: wallets/transfer)"   (5)
//   - "platform-leg: lifecycle 2e (idempotency: investments)"        (6)
//   - "platform-leg: lifecycle 3 (reversal symmetry)"                (7)
//   - "lifecycle: end-of-Stage-2 fixture-user contract"              (8)
// Recounted from `CANONICAL_ORDER` in scripts/pre-launch-safety.ts
// at the time of this fix (27 entries). If you add or remove a
// canonical roll-up there, bump this constant in lockstep — that is
// the entire point of this guard.
const EXPECTED_PASS_COUNT = 27;

// The canonical roll-up gate names emitted by pre-launch-safety.ts in
// its final reporter block. The four spawned sub-scripts ALSO print their
// own internal `PASS <name> — <details>` assertion lines (e.g.
// `PASS deposit idempotency — …`, `PASS 1. retention defaults wired — …`)
// that must NOT be confused with the roll-up gates. We therefore restrict
// gate parsing to the canonical names, which all start with one of three
// well-known prefixes.
const CANONICAL_GATE_NAME_PREFIXES = [
  "existing:",
  "lifecycle:",
  "reconciliation:",
  // Task #193 — pre-launch-safety wraps each Stage-1 sub-script in a
  // per-script ledger-leak gate AND emits a final ci-gate roll-up. All
  // five emit canonical `PASS ledger-leak: <name> — <details>` lines.
  "ledger-leak:",
  // Task #202 — per-Stage-2-scenario platform-leg invariant. Each
  // lifecycle scenario emits a canonical `PASS platform-leg: lifecycle
  // <n> (<scenario>) — <details>` line. Listed as a prefix so that
  // future scenarios added to CANONICAL_ORDER are forward-compatible
  // with the recheck's parser without a code change here (the
  // EXPECTED_PASS_COUNT mismatch will still force a manual review).
  "platform-leg:",
] as const;
const EXPECTED_CANONICAL_GATE_NAMES = new Set<string>([
  "existing: test-transaction-safety",
  "existing: test-fee-deduction-gate-b",
  "existing: test-wealth-planner-compliance",
  "existing: test-task-35-suppression",
  "lifecycle: happy-path wallet matches ledger",
  "lifecycle: idempotency under concurrency",
  // Task #188 — added the four new lifecycle idempotency-under-concurrency
  // gates that pre-launch-safety.ts now emits (one per money route).
  "lifecycle: idempotency under concurrency (withdraw)",
  "lifecycle: idempotency under concurrency (fx-exchange)",
  "lifecycle: idempotency under concurrency (wallets/transfer)",
  "lifecycle: idempotency under concurrency (investments)",
  "lifecycle: reversal symmetry",
  // Task #202 — per-Stage-2-scenario platform-leg invariant. Seven new
  // canonical roll-up gates (one per lifecycle scenario), interleaved
  // with their corresponding `lifecycle: …` gate in CANONICAL_ORDER.
  "platform-leg: lifecycle 1 (happy path)",
  "platform-leg: lifecycle 2 (idempotency: deposit)",
  "platform-leg: lifecycle 2b (idempotency: withdraw)",
  "platform-leg: lifecycle 2c (idempotency: fx-exchange)",
  "platform-leg: lifecycle 2d (idempotency: wallets/transfer)",
  "platform-leg: lifecycle 2e (idempotency: investments)",
  "platform-leg: lifecycle 3 (reversal symmetry)",
  // Task #210 — end-of-Stage-2 fixture-user contract. One new canonical
  // roll-up gate that asserts every `__prelaunch_%` fixture user owns
  // zero transactions after Stage-2 finishes scrubbing.
  "lifecycle: end-of-Stage-2 fixture-user contract",
  "reconciliation: wallet-ledger clean-room",
  "reconciliation: ledger-vs-custodian clean-room",
  "reconciliation: posting-receipt invariant clean-room",
  // Task #193 — five new ledger-leak roll-up gates from the per-script
  // wraps + final ci-gate. Listed explicitly so the membership check
  // succeeds even if a future change removes the prefix shortcut.
  "ledger-leak: test-transaction-safety",
  "ledger-leak: test-fee-deduction-gate-b",
  "ledger-leak: test-wealth-planner-compliance",
  "ledger-leak: test-task-35-suppression",
  "ledger-leak: ci-gate (other test-*.ts)",
]);

function isCanonicalGateName(name: string): boolean {
  // Membership against the documented set is the strict gate; the prefix
  // check is a forward-compatibility safety net so that if pre-launch-
  // safety.ts adds a new roll-up gate using one of these prefixes, the
  // runner still surfaces it (and the EXPECTED_PASS_COUNT mismatch will
  // make the verdict RED, prompting a manual review of this constant).
  if (EXPECTED_CANONICAL_GATE_NAMES.has(name)) return true;
  return CANONICAL_GATE_NAME_PREFIXES.some((p) => name.startsWith(p));
}

// The merges this recheck was gating on. Recorded verbatim in the report
// so the artifact is self-describing once it lands in version control.
const GATING_TASKS = [
  "#168 (kill-switch end-to-end automated test coverage)",
  "#150 (final go/no-go pre-launch verification)",
];

interface GateRow {
  name: string;
  outcome: "PASS" | "FAIL" | "SKIP";
  details: string;
}

interface ParsedResult {
  pass: number;
  fail: number;
  skip: number;
  summaryLine: string | null;
  finalVerdictLine: string | null;
  gates: GateRow[];
}

// Match canonical reporter lines like:
//   PASS existing: test-transaction-safety — exit=0
//   FAIL lifecycle: happy-path wallet matches ledger — drift=…
//   SKIP reconciliation: wallet-ledger clean-room — no data
// Em-dash "—" (U+2014) is the separator emitted by pre-launch-safety.ts.
const GATE_LINE_RE = /^(PASS|FAIL|SKIP)\s+(.+?)\s+—\s+(.*)$/;
const SUMMARY_LINE_RE =
  /^Summary:\s+(\d+)\s+passed,\s+(\d+)\s+failed,\s+(\d+)\s+skipped/;
const VERDICT_LINE_RE = /^PRE-LAUNCH SAFETY:.*$/;

function parseScriptOutput(combined: string): ParsedResult {
  const seen = new Set<string>();
  const gates: GateRow[] = [];
  let summaryLine: string | null = null;
  let finalVerdictLine: string | null = null;
  let pass = 0;
  let fail = 0;
  let skip = 0;

  for (const raw of combined.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const g = GATE_LINE_RE.exec(line);
    if (g) {
      const name = g[2];
      // CRITICAL: pre-launch-safety.ts spawns four sub-scripts that each
      // print their OWN internal `PASS <assertion> — <details>` lines
      // (e.g. `PASS deposit idempotency — …`, `PASS 1. retention defaults
      // wired — …`, `PASS approved deduction posts once`). Those are
      // sub-test assertions, NOT roll-up gates, and including them would
      // (a) bloat the per-gate table with non-gate rows, and (b) inflate
      // gates.length so the canonical-count check in isGreen() would
      // fail on a clean strict run (false RED). Restrict to canonical
      // gate names only.
      if (!isCanonicalGateName(name)) continue;
      // The script also prints per-skip detail under a "Skipped gates:"
      // footer with `  - <name>: <details>` lines, but that doesn't match
      // GATE_LINE_RE so we don't risk double-counting. Still, dedupe
      // defensively in case future versions of the script change.
      if (!seen.has(name)) {
        seen.add(name);
        gates.push({
          name,
          outcome: g[1] as GateRow["outcome"],
          details: g[3],
        });
      }
      continue;
    }

    const s = SUMMARY_LINE_RE.exec(line);
    if (s) {
      pass = Number(s[1]);
      fail = Number(s[2]);
      skip = Number(s[3]);
      summaryLine = line;
      continue;
    }

    if (VERDICT_LINE_RE.test(line)) {
      finalVerdictLine = line;
    }
  }

  return { pass, fail, skip, summaryLine, finalVerdictLine, gates };
}

function getGitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function findLatestGoNoGoReport(): Promise<string | null> {
  try {
    const entries = await fs.readdir(REPORT_DIR);
    const candidates = entries
      .filter((n) => n.startsWith("go-no-go-") && n.endsWith(".md"))
      .sort();
    return candidates.length === 0 ? null : candidates[candidates.length - 1];
  } catch {
    return null;
  }
}

function isGreen(exitCode: number, parsed: ParsedResult): boolean {
  // GREEN is defined by the task as: exit 0 AND
  // `Summary: 10 passed, 0 failed, 0 skipped`. The summary line is the
  // authoritative source — it's what the script's own --strict mode
  // computes its own exit code from. The per-gate parsed count and
  // outcomes are checked as defence in depth so that a future change
  // which drops a gate line (but still emits a misleading summary) is
  // still caught here. If the summary is missing entirely, fall back to
  // the parsed-gate counts so we never silently mark a malformed run
  // as GREEN.
  if (exitCode !== 0) return false;
  if (parsed.summaryLine === null) return false;
  if (
    parsed.pass !== EXPECTED_PASS_COUNT ||
    parsed.fail !== 0 ||
    parsed.skip !== 0
  ) {
    return false;
  }
  // Defence in depth — the canonical 10 gate names should have been
  // emitted and all of them should be PASS. Tolerate >10 gates (forward-
  // compatible) only if every parsed gate is PASS and the summary still
  // reads 10/0/0; the EXPECTED_PASS_COUNT bound is the strict floor.
  if (parsed.gates.length < EXPECTED_PASS_COUNT) return false;
  if (parsed.gates.some((g) => g.outcome !== "PASS")) return false;
  return true;
}

function renderMarkdownReport(opts: {
  verdict: "GREEN" | "RED";
  exitCode: number;
  durationMs: number;
  parsed: ParsedResult;
  stdout: string;
  stderr: string;
  gitSha: string;
  latestGoNoGo: string | null;
  signal: NodeJS.Signals | null;
  spawnError: string | null;
}): string {
  const {
    verdict,
    exitCode,
    durationMs,
    parsed,
    stdout,
    stderr,
    gitSha,
    latestGoNoGo,
    signal,
    spawnError,
  } = opts;

  const lines: string[] = [];
  lines.push(`# Post-merge pre-launch strict safety recheck`);
  lines.push("");
  lines.push(
    `**Verdict:** ${verdict === "GREEN" ? "🟢 GREEN" : "🔴 RED"}`,
  );
  lines.push("");
  lines.push(`* Started: ${STARTED_AT.toISOString()}`);
  lines.push(`* Finished: ${new Date().toISOString()}`);
  lines.push(
    `* Wall-clock duration: ${durationMs}ms (${(durationMs / 1000).toFixed(1)}s)`,
  );
  lines.push(`* Command: \`npx tsx scripts/pre-launch-safety.ts --strict\``);
  lines.push(`* Exit code: \`${exitCode}\``);
  if (signal) lines.push(`* Killed by signal: \`${signal}\``);
  if (spawnError) lines.push(`* Spawn error: \`${spawnError}\``);
  lines.push(`* Git commit SHA: \`${gitSha}\``);
  lines.push(`* Gating tasks (now merged into main):`);
  for (const t of GATING_TASKS) lines.push(`  - ${t}`);
  if (latestGoNoGo) {
    lines.push(
      `* Complements latest go/no-go report: [\`${latestGoNoGo}\`](./${latestGoNoGo}).`,
    );
  } else {
    lines.push(
      `* Complements latest go/no-go report: _none found in \`docs/golive/\`. The \`go-no-go-*.md\` files are gitignored — re-run \`npx tsx scripts/go-no-go.ts\` if you want a fresh evidence pair alongside this recheck._`,
    );
  }
  lines.push("");

  lines.push(`## Summary`);
  lines.push("");
  lines.push("```");
  lines.push(parsed.summaryLine ?? "(no summary line parsed from script output)");
  if (parsed.finalVerdictLine) lines.push(parsed.finalVerdictLine);
  lines.push("```");
  lines.push("");

  lines.push(`## Per-gate results`);
  lines.push("");
  if (parsed.gates.length === 0) {
    lines.push(
      `_No per-gate result lines were parsed from the script output. Inspect the raw stdout/stderr below to localise the failure._`,
    );
  } else {
    lines.push(`| Gate | Result | Details |`);
    lines.push(`| --- | --- | --- |`);
    for (const g of parsed.gates) {
      const detailsCell = g.details
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ")
        .slice(0, 240);
      lines.push(`| ${g.name} | ${g.outcome} | ${detailsCell} |`);
    }
  }
  lines.push("");

  if (verdict === "RED") {
    lines.push(`## Failing / skipped gates`);
    lines.push("");
    const bad = parsed.gates.filter((g) => g.outcome !== "PASS");
    if (bad.length === 0) {
      lines.push(
        `_The recheck is RED but no FAIL/SKIP gates were parsed from the script output (exit=${exitCode}, parsed gates=${parsed.gates.length}, expected=${EXPECTED_PASS_COUNT}). The sub-script likely crashed before reaching the canonical reporter — see the raw stdout/stderr below._`,
      );
    } else {
      for (const g of bad) {
        lines.push(`- **${g.outcome}** \`${g.name}\` — ${g.details}`);
      }
    }
    lines.push("");
    lines.push(`### What to do`);
    lines.push("");
    lines.push(
      `Reproduce locally by running the same script the runner spawned:`,
    );
    lines.push("");
    lines.push("```sh");
    lines.push(`npx tsx scripts/pre-launch-safety.ts --strict`);
    lines.push("```");
    lines.push("");
    lines.push(
      `For per-gate context (what each gate is asserting and which sub-script owns the underlying invariant) see \`docs/PRE_LAUNCH_CHECKLIST.md\`. The four "existing: …" gates are owned by:`,
    );
    lines.push("");
    lines.push(`- \`existing: test-transaction-safety\` — \`scripts/test-transaction-safety.ts\``);
    lines.push(`- \`existing: test-fee-deduction-gate-b\` — \`scripts/test-fee-deduction-gate-b.ts\``);
    lines.push(`- \`existing: test-wealth-planner-compliance\` — \`scripts/test-wealth-planner-compliance.ts\``);
    lines.push(`- \`existing: test-task-35-suppression\` — \`scripts/test-task-35-suppression.ts\``);
    lines.push("");
    lines.push(
      `The three \`lifecycle: …\` and three \`reconciliation: …\` gates run in-process inside \`scripts/pre-launch-safety.ts\` itself — re-run the strict command above to see their full assertion failures.`,
    );
    lines.push("");
    lines.push(
      `Do NOT patch the gates or the script in response to a RED here. Record the verdict, leave the failing gate names in this file, and flag a follow-up task against the actual regression so the recheck has something to confirm fixed.`,
    );
    lines.push("");
  }

  lines.push(`## Raw script output`);
  lines.push("");
  lines.push(`<details><summary>stdout (${stdout.length} bytes)</summary>`);
  lines.push("");
  lines.push("```");
  lines.push(stdout.length > 0 ? stdout.trimEnd() : "(empty)");
  lines.push("```");
  lines.push("");
  lines.push(`</details>`);
  lines.push("");
  lines.push(`<details><summary>stderr (${stderr.length} bytes)</summary>`);
  lines.push("");
  lines.push("```");
  lines.push(stderr.length > 0 ? stderr.trimEnd() : "(empty)");
  lines.push("```");
  lines.push("");
  lines.push(`</details>`);
  lines.push("");
  lines.push(`---`);
  lines.push("");
  lines.push(
    `Generated by \`scripts/post-merge-safety-recheck.ts\` (Task #184).`,
  );
  lines.push("");
  return lines.join("\n");
}

const POST_MERGE_SECTION_HEADING = `## Post-merge rechecks`;
const POST_MERGE_SECTION_INTRO = [
  "",
  "Each line below records one auto-run of `scripts/post-merge-safety-recheck.ts`",
  "after a merge that was gated on `scripts/pre-launch-safety.ts --strict` (the",
  "go-live rollup). The runner appends a new line per invocation; nothing is",
  "overwritten so prior verdicts stay visible in version control.",
  "",
].join("\n");

async function appendChecklistEntry(opts: {
  verdict: "GREEN" | "RED";
  reportFilename: string;
  isoTimestamp: string;
  pass: number;
  fail: number;
  skip: number;
  exitCode: number;
  gitSha: string;
}): Promise<void> {
  const verdictLabel = opts.verdict === "GREEN" ? "🟢 GREEN" : "🔴 RED";
  const entry =
    `- ${opts.isoTimestamp} — ${verdictLabel} ` +
    `(${opts.pass} passed, ${opts.fail} failed, ${opts.skip} skipped, exit=${opts.exitCode}) — ` +
    `commit \`${opts.gitSha.slice(0, 12)}\` — ` +
    `[\`${opts.reportFilename}\`](./golive/${opts.reportFilename})`;

  let current = await fs.readFile(CHECKLIST_PATH, "utf8");
  if (!current.endsWith("\n")) current += "\n";

  if (!current.includes(POST_MERGE_SECTION_HEADING)) {
    // First-ever post-merge recheck: create the section at the end.
    if (!current.endsWith("\n\n")) current += "\n";
    current +=
      `${POST_MERGE_SECTION_HEADING}\n${POST_MERGE_SECTION_INTRO}\n${entry}\n`;
    await fs.writeFile(CHECKLIST_PATH, current, "utf8");
    return;
  }

  // Section exists: insert the new entry at the END of the section
  // (just before the next "## " heading, or at end-of-file).
  const sectionStart = current.indexOf(POST_MERGE_SECTION_HEADING);
  const afterHeading = sectionStart + POST_MERGE_SECTION_HEADING.length;
  const tail = current.slice(afterHeading);
  // Look for the next top-level section. We anchor on a newline so the
  // initial "##" of the heading itself is not matched.
  const nextSectionMatch = /\n## /.exec(tail);

  if (nextSectionMatch) {
    const insertAt = afterHeading + nextSectionMatch.index;
    const before = current.slice(0, insertAt).replace(/\n+$/, "\n");
    const after = current.slice(insertAt);
    current = `${before}${entry}\n${after}`;
  } else {
    // Section runs to EOF — append the entry at the bottom.
    current = current.replace(/\n+$/, "\n") + `${entry}\n`;
  }

  await fs.writeFile(CHECKLIST_PATH, current, "utf8");
}

async function main(): Promise<void> {
  await fs.mkdir(REPORT_DIR, { recursive: true });

  console.log(
    `[post-merge-recheck] running: npx tsx scripts/pre-launch-safety.ts --strict`,
  );
  const startedAtMs = Date.now();
  const r = spawnSync(
    "npx",
    ["tsx", "scripts/pre-launch-safety.ts", "--strict"],
    {
      env: process.env,
      encoding: "utf8",
      // The pre-launch script can emit a few hundred KB of output across
      // the four spawned sub-scripts and three lifecycle scenarios;
      // 64MB is well above that and far below memory pressure.
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const durationMs = Date.now() - startedAtMs;

  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  // Mirror the captured output to this process's streams so an operator
  // running the runner from a terminal still sees what the script said.
  if (stdout.length > 0) process.stdout.write(stdout);
  if (stderr.length > 0) process.stderr.write(stderr);

  const exitCode =
    r.error || r.signal ? -1 : r.status ?? -1;
  const parsed = parseScriptOutput(`${stdout}\n${stderr}`);
  const green = isGreen(exitCode, parsed);
  const verdict: "GREEN" | "RED" = green ? "GREEN" : "RED";

  const gitSha = getGitSha();
  const latestGoNoGo = await findLatestGoNoGoReport();

  const isoTimestamp = STARTED_AT.toISOString();
  const stamp = isoTimestamp.replace(/[:.]/g, "-");
  const reportFilename = `post-merge-safety-recheck-${stamp}.md`;
  const reportPath = path.join(REPORT_DIR, reportFilename);
  const report = renderMarkdownReport({
    verdict,
    exitCode,
    durationMs,
    parsed,
    stdout,
    stderr,
    gitSha,
    latestGoNoGo,
    signal: r.signal ?? null,
    spawnError: r.error ? r.error.message : null,
  });
  await fs.writeFile(reportPath, report, "utf8");

  await appendChecklistEntry({
    verdict,
    reportFilename,
    isoTimestamp,
    pass: parsed.pass,
    fail: parsed.fail,
    skip: parsed.skip,
    exitCode,
    gitSha,
  });

  console.log("");
  console.log(`[post-merge-recheck] report written:    ${reportPath}`);
  console.log(`[post-merge-recheck] checklist updated: ${CHECKLIST_PATH}`);
  console.log(
    `[post-merge-recheck] verdict: ${verdict === "GREEN" ? "🟢 GREEN" : "🔴 RED"} ` +
      `(exit=${exitCode}, ${parsed.pass} passed, ${parsed.fail} failed, ${parsed.skip} skipped)`,
  );

  process.exit(verdict === "GREEN" ? 0 : 1);
}

main().catch((err) => {
  console.error("[post-merge-recheck] crashed:", err);
  process.exit(1);
});
