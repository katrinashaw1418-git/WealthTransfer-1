// ---------------------------------------------------------------------------
// Record a Stage 1 strict-gate verdict (Task #231).
//
// Reads the JSON verdict file written by `scripts/pre-launch-safety.ts
// --json-verdict <path>` and persists the run's outcome to two operator-
// queryable surfaces so SKIP / FAIL trends across deploys are spottable
// without scrolling through individual deploy logs:
//
//   1. Appends one line to `docs/PRE_LAUNCH_CHECKLIST.md` under a new
//      "## Deploy strict-gate verdicts" section. The section is created
//      on first run and prior entries are preserved (mirrors how the
//      "Post-merge rechecks" section in the same checklist is appended
//      by `scripts/post-merge-safety-recheck.ts`). Useful for local /
//      developer-driven invocations of `predeploy-build.sh` where the
//      checkout IS a git working tree and the line will land in the
//      next commit.
//
//   2. Inserts one row into `operator_alerts` with severity `info` and
//      source `predeploy-strict-gate`. Useful for production deploys
//      where the deploy build environment is not a git working tree:
//      the row survives in the production DB and is queryable from the
//      admin alerts UI (and via SQL: `SELECT created_at, details FROM
//      operator_alerts WHERE source='predeploy-strict-gate' ORDER BY
//      created_at DESC`).
//
// Both surfaces include the per-gate FAIL / SKIP names verbatim so an
// operator scanning the trend can spot "gate X has SKIPped on every
// deploy this week" before it masks a real incident — the failure mode
// motivating this task.
//
// Failure modes — by design, this script NEVER blocks the deploy:
//   * Verdict file missing (pre-launch-safety crashed before writing it):
//     record a placeholder line in the checklist + an info alert noting
//     "verdict file not produced". The absence is itself a useful signal
//     and SHOULD show up in the trend.
//   * Checklist write fails (read-only filesystem in production deploy):
//     log a warning and continue.
//   * Operator-alerts insert fails (no DB, schema drift): log a warning
//     and continue.
//   * Any exception in the script body: log it but exit 0. The deploy's
//     own pass/fail is owned by the gates themselves, not by whether we
//     succeeded in writing the trend artefacts.
//
// CLI:
//   npx tsx scripts/record-strict-gate-verdict.ts <verdict-json-path>
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as path from "node:path";

const CHECKLIST_PATH = path.resolve(
  process.cwd(),
  "docs",
  "PRE_LAUNCH_CHECKLIST.md",
);

const ALERT_SOURCE = "predeploy-strict-gate";

interface VerdictGate {
  name: string;
  outcome: "pass" | "fail" | "skip" | "missing";
  details: string;
}
interface Verdict {
  schemaVersion?: number;
  startedAt?: string;
  finishedAt?: string;
  strict?: boolean;
  exitCode?: number;
  crashed?: boolean;
  gitSha?: string;
  summary?: {
    pass?: number;
    fail?: number;
    skip?: number;
    missing?: number;
  };
  gates?: VerdictGate[];
  failedGateNames?: string[];
  skippedGateNames?: string[];
  missingGateNames?: string[];
}

function readVerdict(verdictPath: string):
  | { ok: true; verdict: Verdict }
  | { ok: false; reason: string } {
  if (!existsSync(verdictPath)) {
    return {
      ok: false,
      reason: `verdict file not produced at ${verdictPath} ` +
        `(pre-launch-safety likely crashed before reaching its finally block)`,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(verdictPath, "utf8");
  } catch (err: any) {
    return {
      ok: false,
      reason: `failed to read verdict file ${verdictPath}: ${err?.message ?? err}`,
    };
  }
  try {
    const parsed = JSON.parse(raw) as Verdict;
    return { ok: true, verdict: parsed };
  } catch (err: any) {
    return {
      ok: false,
      reason: `failed to parse verdict JSON at ${verdictPath}: ${err?.message ?? err}`,
    };
  }
}

function verdictLabel(v: Verdict): "🟢 GREEN" | "🔴 RED" | "⚠️ UNKNOWN" {
  // GREEN ⇔ exit=0, no FAIL, no SKIP under strict, no missing gates, no crash.
  // The deploy gate runs --strict, so any SKIP is also a hard failure here.
  if (v.crashed) return "⚠️ UNKNOWN";
  if (typeof v.exitCode !== "number") return "⚠️ UNKNOWN";
  if (v.exitCode !== 0) return "🔴 RED";
  const fail = v.summary?.fail ?? 0;
  const skip = v.summary?.skip ?? 0;
  const missing = v.summary?.missing ?? 0;
  if (fail > 0 || missing > 0) return "🔴 RED";
  if (v.strict && skip > 0) return "🔴 RED";
  return "🟢 GREEN";
}

const SECTION_HEADING = `## Deploy strict-gate verdicts`;
const SECTION_INTRO = [
  "",
  "Each line below records one Stage 1 strict-gate run launched by",
  "`scripts/predeploy-build.sh` (the deploy-build wrapper). The recorder",
  "(`scripts/record-strict-gate-verdict.ts`) appends a new line per",
  "invocation; nothing is overwritten so prior verdicts stay visible in",
  "version control. Use this section to spot SKIP trends across recent",
  "deploys (for example, a gate that started SKIPping a week ago and is",
  "now hiding a real failure) WITHOUT having to scroll through individual",
  "deploy logs.",
  "",
  "For a production-DB-backed view of the same trend (queryable from the",
  "admin alerts UI even when no git checkout is to hand), filter",
  "`operator_alerts` by `source = 'predeploy-strict-gate'`.",
  "",
  "The full per-gate detail for each line lives in the named",
  "`docs/golive/strict-gate-*.json` file (gitignored — these are runtime",
  "artefacts written by the deploy build environment).",
  "",
].join("\n");

function renderChecklistLine(opts: {
  verdict: Verdict | null;
  fallbackReason: string | null;
  verdictPath: string;
}): string {
  const verdictPathBasename = path.basename(opts.verdictPath);
  const ts = opts.verdict?.startedAt ?? new Date().toISOString();
  if (!opts.verdict || opts.fallbackReason) {
    // Verdict file missing or unparseable. Still record the attempt so the
    // trend doesn't silently lose a deploy.
    return (
      `- ${ts} — ⚠️ UNKNOWN (verdict file not produced) — ` +
      `${opts.fallbackReason ?? "unknown reason"} — ` +
      `expected at \`${opts.verdictPath}\``
    );
  }
  const v = opts.verdict;
  const label = verdictLabel(v);
  const pass = v.summary?.pass ?? 0;
  const fail = v.summary?.fail ?? 0;
  const skip = v.summary?.skip ?? 0;
  const missing = v.summary?.missing ?? 0;
  const exit = v.exitCode ?? "?";
  const sha = (v.gitSha ?? "unknown").slice(0, 12);
  const counts =
    `${pass} passed, ${fail} failed, ${skip} skipped` +
    (missing > 0 ? `, ${missing} missing` : "") +
    `, exit=${exit}`;
  const failed = (v.failedGateNames ?? []).slice(0, 5);
  const skipped = (v.skippedGateNames ?? []).slice(0, 5);
  const failedSnippet =
    failed.length > 0
      ? ` — FAIL: ${failed.map((n) => `\`${n}\``).join(", ")}` +
        (failed.length < (v.failedGateNames?.length ?? 0) ? " …" : "")
      : "";
  const skippedSnippet =
    skipped.length > 0
      ? ` — SKIP: ${skipped.map((n) => `\`${n}\``).join(", ")}` +
        (skipped.length < (v.skippedGateNames?.length ?? 0) ? " …" : "")
      : "";
  const crashedSnippet = v.crashed ? " — script crashed mid-run" : "";
  return (
    `- ${ts} — ${label} (${counts}) — commit \`${sha}\` — ` +
    `[\`${verdictPathBasename}\`](./golive/${verdictPathBasename})` +
    failedSnippet +
    skippedSnippet +
    crashedSnippet
  );
}

function appendChecklistLine(line: string): void {
  let current: string;
  try {
    current = readFileSync(CHECKLIST_PATH, "utf8");
  } catch (err: any) {
    console.warn(
      `[record-strict-gate-verdict] could not read ${CHECKLIST_PATH}: ` +
        `${err?.message ?? err}. Skipping checklist append.`,
    );
    return;
  }
  if (!current.endsWith("\n")) current += "\n";

  let next: string;
  if (!current.includes(SECTION_HEADING)) {
    if (!current.endsWith("\n\n")) current += "\n";
    next = `${current}${SECTION_HEADING}\n${SECTION_INTRO}\n${line}\n`;
  } else {
    // Insert at the END of the section (just before the next "## " heading,
    // or end of file). Mirrors the post-merge recheck appender.
    const sectionStart = current.indexOf(SECTION_HEADING);
    const afterHeading = sectionStart + SECTION_HEADING.length;
    const tail = current.slice(afterHeading);
    const nextSectionMatch = /\n## /.exec(tail);
    if (nextSectionMatch) {
      const insertAt = afterHeading + nextSectionMatch.index;
      const before = current.slice(0, insertAt).replace(/\n+$/, "\n");
      const after = current.slice(insertAt);
      next = `${before}${line}\n${after}`;
    } else {
      next = current.replace(/\n+$/, "\n") + `${line}\n`;
    }
  }

  try {
    writeFileSync(CHECKLIST_PATH, next, "utf8");
    console.log(
      `[record-strict-gate-verdict] appended trend line to ${CHECKLIST_PATH}`,
    );
  } catch (err: any) {
    console.warn(
      `[record-strict-gate-verdict] could not write ${CHECKLIST_PATH}: ` +
        `${err?.message ?? err}. Skipping checklist append.`,
    );
  }
}

async function recordOperatorAlert(opts: {
  verdict: Verdict | null;
  fallbackReason: string | null;
  verdictPath: string;
}): Promise<void> {
  // Lazy-load the DB layer so a missing DATABASE_URL or schema drift only
  // takes out the operator-alerts row, not the checklist append above.
  let dbModule: typeof import("../server/db");
  let schemaModule: typeof import("../shared/schema");
  try {
    dbModule = await import("../server/db");
    schemaModule = await import("../shared/schema");
  } catch (err: any) {
    console.warn(
      `[record-strict-gate-verdict] could not load DB modules: ` +
        `${err?.message ?? err}. Skipping operator_alerts insert.`,
    );
    return;
  }

  const v = opts.verdict;
  const label =
    v == null
      ? "⚠️ UNKNOWN"
      : verdictLabel(v);
  const title =
    v == null
      ? `Pre-deploy strict gate: verdict file not produced`
      : `Pre-deploy strict gate: ${label.replace(/^[^A-Z]+/, "")}` +
        ` (${v.summary?.pass ?? 0} passed, ${v.summary?.fail ?? 0} failed, ${
          v.summary?.skip ?? 0
        } skipped)`;

  const details: Record<string, unknown> = {
    verdictPath: opts.verdictPath,
    schemaVersion: v?.schemaVersion ?? null,
    startedAt: v?.startedAt ?? null,
    finishedAt: v?.finishedAt ?? null,
    strict: v?.strict ?? null,
    exitCode: v?.exitCode ?? null,
    crashed: v?.crashed ?? null,
    gitSha: v?.gitSha ?? null,
    summary: v?.summary ?? null,
    failedGateNames: v?.failedGateNames ?? [],
    skippedGateNames: v?.skippedGateNames ?? [],
    missingGateNames: v?.missingGateNames ?? [],
    fallbackReason: opts.fallbackReason,
  };

  try {
    await dbModule.db.insert(schemaModule.operatorAlerts).values({
      source: ALERT_SOURCE,
      severity: "info",
      title: title.slice(0, 1024),
      details,
      // Direct insert (no `notifyOperator`): we deliberately bypass the
      // webhook channel so a green deploy does not page on-call. The log
      // channel is implicit — `predeploy-build.sh` already streamed every
      // gate line to the deploy log; this row is the queryable trend
      // surface, not an additional page.
      channelsAttempted: ["log"],
      channelOutcomes: [
        {
          channel: "log",
          status: "success",
          durationMs: 0,
          attempt: 1,
        },
      ],
      deliveryStatus: "delivered",
      occurrences: 1,
    });
    console.log(
      `[record-strict-gate-verdict] inserted operator_alerts row ` +
        `(source=${ALERT_SOURCE}, severity=info)`,
    );
  } catch (err: any) {
    console.warn(
      `[record-strict-gate-verdict] could not insert operator_alerts row: ` +
        `${err?.message ?? err}. Skipping.`,
    );
  }
}

async function main(): Promise<void> {
  const verdictPath = process.argv[2];
  if (!verdictPath) {
    console.error(
      "usage: npx tsx scripts/record-strict-gate-verdict.ts <verdict-json-path>",
    );
    // Exit 0 — this script must NEVER block a deploy on its own argv. A
    // malformed invocation upstream is a wrapper bug to chase separately.
    process.exit(0);
  }

  const read = readVerdict(verdictPath);
  const verdict = read.ok ? read.verdict : null;
  const fallbackReason = read.ok ? null : read.reason;

  const line = renderChecklistLine({ verdict, fallbackReason, verdictPath });
  appendChecklistLine(line);

  await recordOperatorAlert({ verdict, fallbackReason, verdictPath });
}

main()
  .catch((err) => {
    console.error(
      "[record-strict-gate-verdict] unhandled error:",
      err?.message ?? err,
    );
  })
  .finally(() => {
    // Always exit 0. Persistence failures must not block a deploy that the
    // gates themselves passed. See file header for the full rationale.
    process.exit(0);
  });
