// =============================================================================
// Task #475 — DB-level fee-rule amount-equality trigger
// =============================================================================
// Locks in the contract for the Postgres BEFORE INSERT/UPDATE trigger
// installed by `installFeeRuleAmountEqualityTrigger`. The service-layer
// `validateRuleAmountAgainstConsent` check has its own unit-test file
// (consent-integrity.test.ts); THIS test exercises the database backstop:
//
//   A raw `db.insert(adviserFeeRules)` that bypasses the service path
//   MUST be rejected by Postgres when the rule's monetary parameter does
//   not equal the linked consent's amount.
//
// Without this test the trigger could silently regress (e.g. an OR
// REPLACE that drops the body) and we would only notice when a regulator
// asked why the $150-vs-$495 drift bug came back.
// =============================================================================

import "../../scripts/_bootstrap-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  adviceRecords,
  adviserFeeRules,
  auditLogs,
  feeConsents,
  users,
} from "@shared/schema";
import { installFeeRuleAmountEqualityTrigger } from "./consent-integrity";

const TAG = `t475-trigger-${Date.now()}`;

let clientUserId: number;
let adviserUserId: number;
let adviceRecordId: number;
let consentId: number;

async function seed() {
  // We use raw SQL with explicit column lists for the parent rows. Other
  // suites in this codebase pre-date several schema additions whose
  // corresponding columns may not yet have been pushed to the dev DB
  // (e.g. advice_records.soa_target_allocation), and the Drizzle insert
  // builder writes those defaulted columns into its INSERT statement,
  // which would crash here for a reason unrelated to the trigger under
  // test. Hand-rolled SQL keeps this suite faithful to its single concern.
  const clientRow = await db.execute<{ id: number }>(sql`
    INSERT INTO users (username, email, password, first_name, last_name, role)
    VALUES (${`${TAG}-client`}, ${`${TAG}-client@test.local`}, 'x', 'Test', 'Client', 'client')
    RETURNING id
  `);
  const adviserRow = await db.execute<{ id: number }>(sql`
    INSERT INTO users (username, email, password, first_name, last_name, role)
    VALUES (${`${TAG}-adviser`}, ${`${TAG}-adviser@test.local`}, 'x', 'Test', 'Adviser', 'adviser')
    RETURNING id
  `);
  clientUserId = (clientRow.rows ?? (clientRow as any))[0].id;
  adviserUserId = (adviserRow.rows ?? (adviserRow as any))[0].id;

  const adviceRow = await db.execute<{ id: number }>(sql`
    INSERT INTO advice_records (client_id, adviser_id, advice_type, advice_source, status)
    VALUES (${clientUserId}, ${adviserUserId}, 'personal', 'hybrid', 'issued')
    RETURNING id
  `);
  adviceRecordId = (adviceRow.rows ?? (adviceRow as any))[0].id;

  // Fixed-fee consent for AUD 495.0000 — the canonical drift-bug fixture.
  const oneYearMs = 365 * 24 * 3600 * 1000;
  const now = new Date();
  const inAYear = new Date(Date.now() + oneYearMs);
  const consentRow = await db.execute<{ id: number }>(sql`
    INSERT INTO fee_consents (
      advice_record_id, client_id, adviser_id, fee_type, amount_type,
      amount, account_number, deduction_frequency, reference_day,
      renewal_window_start, renewal_window_end, consent_expiry_date,
      renewal_status, client_signature_name
    ) VALUES (
      ${adviceRecordId}, ${clientUserId}, ${adviserUserId},
      'ongoing_service_fee', 'fixed', '495.0000', ${`${TAG}-ACC-1`},
      'monthly', ${now}, ${now}, ${inAYear}, ${inAYear},
      'active', 'Test Client'
    )
    RETURNING id
  `);
  consentId = (consentRow.rows ?? (consentRow as any))[0].id;
}

async function cleanup() {
  // FK-respecting teardown. Best-effort — a partial seed (e.g. crash
  // mid-test) should not block the next run.
  try {
    await db
      .delete(auditLogs)
      .where(
        sql`${auditLogs.entityType} = 'adviser_fee_rule' AND ${auditLogs.metadata}->>'feeConsentId' = ${String(consentId)}`,
      );
  } catch {}
  try {
    await db.delete(adviserFeeRules).where(eq(adviserFeeRules.clientUserId, clientUserId));
  } catch {}
  try {
    await db.delete(feeConsents).where(eq(feeConsents.clientId, clientUserId));
  } catch {}
  try {
    await db.delete(adviceRecords).where(eq(adviceRecords.id, adviceRecordId));
  } catch {}
  try {
    await db.delete(users).where(eq(users.id, clientUserId));
    await db.delete(users).where(eq(users.id, adviserUserId));
  } catch {}
}

beforeAll(async () => {
  // Defensive: if vitest runs against a freshly-migrated DB where the
  // server's startup path hasn't fired, install the trigger ourselves so
  // the test exercises the real production object.
  await installFeeRuleAmountEqualityTrigger(db);
  await seed();
});

afterAll(async () => {
  await cleanup();
});

describe("adviser_fee_rules amount-equality trigger (Task #475)", () => {
  it("rejects a raw INSERT when the rule's fixed_amount differs from the consent's amount", async () => {
    // The consent is a $495 fixed fee; the rule below claims $150 — exactly
    // the historical drift the trigger exists to prevent. Bypass the
    // service layer entirely so we are observing Postgres' own decision.
    let caught: unknown;
    try {
      await db.insert(adviserFeeRules).values({
        feeConsentId: consentId,
        clientUserId,
        adviserUserId,
        feeType: "ongoing_service_fee",
        amountType: "fixed",
        // Drift: rule says $150, signed consent says $495.
        fixedAmount: "150.0000",
        rateBps: null,
        currency: "AUD",
        adviserSplitBps: 8000,
        platformSplitBps: 2000,
        status: "active",
        accountNumber: `${TAG}-ACC-1`,
        effectiveDate: new Date(),
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    const message = String((caught as Error)?.message ?? caught);
    // The trigger raises with the literal "fee rule consent amount drift"
    // prefix — callers and ops dashboards branch on that signature, so the
    // assertion is intentionally on the message text.
    expect(message).toMatch(/fee rule consent amount drift/i);

    // And the rejection must mean NO row landed.
    const rows = await db
      .select()
      .from(adviserFeeRules)
      .where(eq(adviserFeeRules.feeConsentId, consentId));
    expect(rows).toHaveLength(0);
  });

  it("exempts terminal-state UPDATEs so a drifted row can still be flipped to 'superseded'", async () => {
    // Locks in the Task #475 terminal-state exemption: the supersede pass
    // and the expiry sweep both UPDATE pre-trigger drifted rows to set
    // lifecycle pointers WITHOUT touching the amount columns. Without the
    // exemption, those updates would be rejected by the equality check
    // and the supersede flow would wedge. We seed a drifted row through
    // the back door (raw SQL bypasses the trigger? No — the trigger fires
    // on every INSERT/UPDATE; we therefore disable it for the seed only,
    // re-enable, then UPDATE the row to status='superseded' and assert
    // Postgres accepts it).
    const accountNumber = `${TAG}-ACC-EXEMPT`;
    await db.execute(
      sql`ALTER TABLE adviser_fee_rules DISABLE TRIGGER adviser_fee_rules_amount_equality`,
    );
    let driftedRuleId: number | null = null;
    try {
      const seedRow = await db.execute<{ id: number }>(sql`
        INSERT INTO adviser_fee_rules (
          fee_consent_id, client_user_id, adviser_user_id, fee_type,
          amount_type, fixed_amount, currency,
          adviser_split_bps, platform_split_bps, status,
          account_number, effective_date
        ) VALUES (
          ${consentId}, ${clientUserId}, ${adviserUserId}, 'ongoing_service_fee',
          'fixed', '150.0000', 'AUD', 8000, 2000, 'active',
          ${accountNumber}, NOW()
        )
        RETURNING id
      `);
      driftedRuleId = (seedRow.rows ?? (seedRow as any))[0].id;
    } finally {
      await db.execute(
        sql`ALTER TABLE adviser_fee_rules ENABLE TRIGGER adviser_fee_rules_amount_equality`,
      );
    }

    // Sanity: with the trigger re-enabled, an UPDATE that touches the
    // monetary fields on the still-active drifted row would be rejected.
    // (Not asserted here — that is the rejection test above.) The
    // exemption applies only when NEW.status is terminal.
    const updateRow = await db.execute<{ id: number; status: string }>(sql`
      UPDATE adviser_fee_rules
         SET status = 'superseded',
             superseded_by_rule_id = ${driftedRuleId!},
             superseded_at = NOW(),
             superseded_reason = 'task475_exemption_test',
             updated_at = NOW()
       WHERE id = ${driftedRuleId!}
       RETURNING id, status
    `);
    const updated = (updateRow.rows ?? (updateRow as any))[0];
    expect(updated.status).toBe("superseded");
    // No tidy-up needed: the row references itself via superseded_by_rule_id,
    // which Postgres permits to be deleted in the same DELETE that removes
    // its own referent. afterAll() will clear the row alongside the rest of
    // the suite's seed.
  });
});
