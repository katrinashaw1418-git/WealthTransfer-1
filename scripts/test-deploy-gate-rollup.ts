// =============================================================================
// REGRESSION TEST — Task #225 (one page per deploy, not nine)
// =============================================================================
// Pins the deploy-gate rollup behaviour added by Task #218 so a future
// refactor of `alertingSection()` cannot silently re-enable per-source
// webhook posts and turn every Publish into a nine-page on-call burst.
//
// Strategy
// --------
// Imports `alertingSection()` directly from `scripts/go-no-go.ts`, with
// a stubbed dispatcher in place of `notifyOperator()`. The stub records
// (a) the alert payload it received and (b) the value of
// `process.env.OPERATOR_ALERT_WEBHOOK_URL` at the moment of the call —
// which is the exact env var the real dispatcher reads at call time to
// decide whether to attempt a webhook POST. By observing the env var
// across the loop we prove the script's transient unset/restore around
// the per-source loop still works, without binding a real receiver or
// touching the live `notifyOperator` pipeline.
//
// Invariants asserted
// -------------------
//   --deploy-gate mode (DEPLOY-GATE):
//     1. Exactly KNOWN_ALERT_SOURCES.length + 1 (= 10) dispatches.
//     2. The first KNOWN_ALERT_SOURCES.length saw the env var UNSET at
//        call time — i.e. the dispatcher would NOT have attempted the
//        webhook channel for any per-source firing.
//     3. The final dispatch is the rollup: source =
//        "launch-readiness-gate", details.rolledUp = true,
//        details.runId stable, env restored at call time.
//     4. Exactly one webhook-eligible dispatch (rollup), so the on-call
//        channel sees one page per Publish.
//
//   default mode (DEFAULT):
//     1. Exactly KNOWN_ALERT_SOURCES.length (= 9) dispatches.
//     2. Every dispatch saw the env var SET at call time.
//     3. NO rollup dispatch (source "launch-readiness-gate" never appears).
//
// Wired into CI by scripts/test-predeploy-gate.sh, which is itself the
// `predeploy-gate-smoke` job in .github/workflows/planner.yml. That
// makes the test a merge gate, not just a deploy gate.
// =============================================================================

// Side-effect bootstrap MUST run before importing scripts/go-no-go.ts
// because that module's dependency chain pulls in server/db.ts, which
// throws at module init if DATABASE_URL is unset. ESM hoists static
// imports above body code, so we cannot set the env var inline here —
// the bootstrap file does it as part of its own module body, which
// runs before the next static import resolves.
import "./_bootstrap-stub-db";

import {
  alertingSection,
  KNOWN_ALERT_SOURCES,
} from "./go-no-go";
import type {
  OperatorAlert,
  OperatorAlertResult,
} from "../server/services/operator-alerts";

const STUB_WEBHOOK_URL = "https://stub.invalid/operator-alerts-test";
const TEST_RUN_ID = "task-225-test-runid";

interface RecordedDispatch {
  alert: OperatorAlert;
  /** OPERATOR_ALERT_WEBHOOK_URL as the dispatcher would read it. */
  webhookEnvAtCall: string | undefined;
}

function makeRecorder(): {
  calls: RecordedDispatch[];
  dispatch: (alert: OperatorAlert) => Promise<OperatorAlertResult>;
} {
  const calls: RecordedDispatch[] = [];
  let nextAlertId = 1000;
  const dispatch = async (
    alert: OperatorAlert,
  ): Promise<OperatorAlertResult> => {
    const webhookEnvAtCall = process.env.OPERATOR_ALERT_WEBHOOK_URL;
    calls.push({
      alert: JSON.parse(JSON.stringify(alert)) as OperatorAlert,
      webhookEnvAtCall,
    });
    // Synthesise a successful OperatorAlertResult that mirrors what the
    // real dispatcher would return: log channel always succeeds; webhook
    // channel is only present when the env var is set (matches the real
    // `getWebhookUrl()` semantics).
    const id = nextAlertId++;
    if (webhookEnvAtCall && webhookEnvAtCall.trim().length > 0) {
      return {
        channelsAttempted: ["log", "webhook"],
        outcomes: [
          { channel: "log", status: "success", durationMs: 0 },
          {
            channel: "webhook",
            status: "success",
            httpStatus: 200,
            durationMs: 0,
            attempt: 1,
          },
        ],
        channels: ["log", "webhook"],
        alertId: id,
        deliveryStatus: "delivered",
        occurrences: 1,
        dedupeKey: `stub-${id}`,
      };
    }
    return {
      channelsAttempted: ["log"],
      outcomes: [{ channel: "log", status: "success", durationMs: 0 }],
      channels: ["log"],
      alertId: id,
      deliveryStatus: "delivered",
      occurrences: 1,
      dedupeKey: `stub-${id}`,
    };
  };
  return { calls, dispatch };
}

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failures++;
    console.error(`✗ FAIL: ${msg}`);
  } else {
    console.log(`✓ ${msg}`);
  }
}

async function main(): Promise<void> {
  // Ensure the env var is set so `webhookConfigured` resolves true in
  // both branches of alertingSection(). The deploy-gate branch then
  // transiently deletes it for the per-source loop and restores it for
  // the rollup; the default branch leaves it set for the whole loop.
  const savedRealUrl = process.env.OPERATOR_ALERT_WEBHOOK_URL;
  process.env.OPERATOR_ALERT_WEBHOOK_URL = STUB_WEBHOOK_URL;

  try {
    // -----------------------------------------------------------------
    // DEPLOY-GATE MODE
    // -----------------------------------------------------------------
    const dg = makeRecorder();
    const dgSection = await alertingSection({
      deployGateMode: true,
      runId: TEST_RUN_ID,
      dispatcher: dg.dispatch,
    });

    const expectedTotal = KNOWN_ALERT_SOURCES.length + 1;
    assert(
      dg.calls.length === expectedTotal,
      `[DEPLOY-GATE] dispatch count: expected ${expectedTotal} (= ${KNOWN_ALERT_SOURCES.length} per-source + 1 rollup), got ${dg.calls.length}`,
    );

    // Per-source firings: env var must have been UNSET at call time so
    // the real dispatcher would have skipped the webhook channel.
    const dgPerSource = dg.calls.slice(0, KNOWN_ALERT_SOURCES.length);
    for (let i = 0; i < dgPerSource.length; i++) {
      const c = dgPerSource[i];
      const spec = KNOWN_ALERT_SOURCES[i];
      assert(
        c.alert.source === spec.source,
        `[DEPLOY-GATE] per-source #${i + 1} dispatched source="${c.alert.source}" (expected "${spec.source}")`,
      );
      assert(
        c.webhookEnvAtCall === undefined,
        `[DEPLOY-GATE] per-source #${i + 1} (${spec.source}) saw OPERATOR_ALERT_WEBHOOK_URL UNSET at dispatch (got ${JSON.stringify(c.webhookEnvAtCall)})`,
      );
      assert(
        c.alert.details && (c.alert.details as { rolledUp?: unknown }).rolledUp !== true,
        `[DEPLOY-GATE] per-source #${i + 1} (${spec.source}) is NOT a rollup`,
      );
      assert(
        (c.alert.details as { runId?: unknown }).runId === TEST_RUN_ID,
        `[DEPLOY-GATE] per-source #${i + 1} (${spec.source}) carries the injected runId`,
      );
    }

    // Rollup must be the LAST dispatch and the only webhook-eligible one.
    const rollup = dg.calls[dg.calls.length - 1];
    assert(
      rollup.alert.source === "launch-readiness-gate",
      `[DEPLOY-GATE] rollup source="launch-readiness-gate" (got "${rollup.alert.source}")`,
    );
    assert(
      (rollup.alert.details as { rolledUp?: unknown }).rolledUp === true,
      `[DEPLOY-GATE] rollup details.rolledUp === true`,
    );
    assert(
      (rollup.alert.details as { runId?: unknown }).runId === TEST_RUN_ID,
      `[DEPLOY-GATE] rollup carries the injected runId`,
    );
    assert(
      (rollup.alert.details as { sourcesChecked?: unknown }).sourcesChecked ===
        KNOWN_ALERT_SOURCES.length,
      `[DEPLOY-GATE] rollup details.sourcesChecked === ${KNOWN_ALERT_SOURCES.length}`,
    );
    assert(
      rollup.webhookEnvAtCall === STUB_WEBHOOK_URL,
      `[DEPLOY-GATE] rollup saw OPERATOR_ALERT_WEBHOOK_URL restored at dispatch (got ${JSON.stringify(rollup.webhookEnvAtCall)})`,
    );

    // The whole point of Task #218: exactly ONE webhook-eligible
    // dispatch per Publish, not nine. "Webhook-eligible" = env var was
    // visible to the dispatcher at call time.
    const dgWebhookEligible = dg.calls.filter(
      (c) => c.webhookEnvAtCall === STUB_WEBHOOK_URL,
    );
    assert(
      dgWebhookEligible.length === 1,
      `[DEPLOY-GATE] webhook-eligible dispatches: expected 1 (the rollup), got ${dgWebhookEligible.length}`,
    );
    assert(
      dgWebhookEligible[0]?.alert.source === "launch-readiness-gate",
      `[DEPLOY-GATE] the single webhook-eligible dispatch IS the rollup`,
    );

    // Sanity: the section the orchestrator returns must include the
    // rollup-specific check name. If a future refactor stops emitting
    // it, the `Off-host alert channel configured` summary line would
    // be lying.
    const dgCheckNames = dgSection.checks.map((c) => c.name);
    assert(
      dgCheckNames.includes(
        "Rolled-up drill alert reaches on-call webhook (--deploy-gate)",
      ),
      `[DEPLOY-GATE] section reports the rollup check`,
    );

    // The webhook env was set on entry — the section must restore it on
    // exit (the orchestrator relies on this for the rollup dispatch and
    // any later code path).
    assert(
      process.env.OPERATOR_ALERT_WEBHOOK_URL === STUB_WEBHOOK_URL,
      `[DEPLOY-GATE] OPERATOR_ALERT_WEBHOOK_URL restored after section`,
    );

    // -----------------------------------------------------------------
    // DEFAULT (interactive) MODE
    // -----------------------------------------------------------------
    const def = makeRecorder();
    const defSection = await alertingSection({
      deployGateMode: false,
      runId: TEST_RUN_ID,
      dispatcher: def.dispatch,
    });

    assert(
      def.calls.length === KNOWN_ALERT_SOURCES.length,
      `[DEFAULT] dispatch count: expected ${KNOWN_ALERT_SOURCES.length} (one per source, NO rollup), got ${def.calls.length}`,
    );

    for (let i = 0; i < def.calls.length; i++) {
      const c = def.calls[i];
      const spec = KNOWN_ALERT_SOURCES[i];
      assert(
        c.alert.source === spec.source,
        `[DEFAULT] per-source #${i + 1} dispatched source="${c.alert.source}" (expected "${spec.source}")`,
      );
      assert(
        c.webhookEnvAtCall === STUB_WEBHOOK_URL,
        `[DEFAULT] per-source #${i + 1} (${spec.source}) saw OPERATOR_ALERT_WEBHOOK_URL SET at dispatch`,
      );
      assert(
        (c.alert.details as { rolledUp?: unknown }).rolledUp !== true,
        `[DEFAULT] per-source #${i + 1} (${spec.source}) is NOT a rollup`,
      );
    }

    const defRollupCount = def.calls.filter(
      (c) => c.alert.source === "launch-readiness-gate",
    ).length;
    assert(
      defRollupCount === 0,
      `[DEFAULT] no rollup dispatched (got ${defRollupCount})`,
    );

    const defCheckNames = defSection.checks.map((c) => c.name);
    assert(
      !defCheckNames.includes(
        "Rolled-up drill alert reaches on-call webhook (--deploy-gate)",
      ),
      `[DEFAULT] section does NOT emit the deploy-gate-only rollup check`,
    );
  } finally {
    if (savedRealUrl === undefined) {
      delete process.env.OPERATOR_ALERT_WEBHOOK_URL;
    } else {
      process.env.OPERATOR_ALERT_WEBHOOK_URL = savedRealUrl;
    }
  }

  if (failures > 0) {
    console.error(`\n[task-225] FAILED — ${failures} assertion(s) did not hold.`);
    console.error(
      `[task-225] alertingSection() drifted from the one-page-per-deploy contract added by Task #218.`,
    );
    console.error(
      `[task-225] Re-read scripts/go-no-go.ts (alertingSection, KNOWN_ALERT_SOURCES) and predeploy-build.sh.`,
    );
    process.exit(1);
  }
  console.log(
    `\n[task-225] OK — alertingSection() dispatches 1 webhook-eligible alert per --deploy-gate run and ${KNOWN_ALERT_SOURCES.length} in default mode.`,
  );
}

main().catch((err) => {
  console.error(`[task-225] threw unexpectedly: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
