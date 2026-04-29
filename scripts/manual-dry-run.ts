// =============================================================================
// MANUAL END-TO-END DRY RUN — fresh dedicated test client
// =============================================================================
//
// One-shot operational script (NOT runtime code) that exercises the four
// canonical money-movement chokepoints end-to-end against a brand-new,
// isolated test client so we never touch the wiseinvestor demo configuration:
//
//   step 1  POST /api/deposit                   ($50 AUD into client wallet)
//   step 2  POST /api/admin/fee-accruals/run    (then fee-deductions/generate)
//   step 3  POST /api/admin/fee-deductions/:id/approve
//   step 4  POST /api/withdraw                  (attempt $50 AUD out)
//
// After each step we print the wallet cache vs the ledger sum for the new
// client's AUD column and assert they agree. Then we re-run the GO/NO-GO
// launch check so we know the cleanup work from the prior task hasn't drifted.
//
// Setup is idempotent: re-runs reuse the dryrun client if it already exists.
// All setup writes go through the same primitives prod uses (storage.createUser,
// storage.createWallet, ditto for adviser_clients / advice_records /
// fee_consents / fee_consent_requests / adviser_fee_rules — direct inserts in
// dependency order). Run-phase writes go through the live HTTP handlers (no
// duplication of business logic).
//
// Usage:  npx tsx scripts/manual-dry-run.ts
// =============================================================================

import { spawnSync } from "node:child_process";
import { sql, eq, and, desc } from "drizzle-orm";
import { db, pool } from "../server/db";
import {
  users,
  wallets,
  adviserClients,
  adviceRecords,
  feeConsents,
  feeConsentRequests,
  adviserFeeRules,
} from "@shared/schema";
import { hashPassword } from "../server/auth";

const BASE_URL = process.env.DRY_RUN_BASE_URL ?? "http://localhost:5000";
const ADMIN_USERNAME = "wise";
const ADMIN_PASSWORD = "wise888";
const ADVISER_USER_ID = 12; // wiseadviser

// Stable username so re-runs reuse the same fixture.
const DRY_USERNAME = "__dryrun_client__";
const DRY_EMAIL = "dryrun-client@test.invalid";
const DRY_PASSWORD = "dryrun_password_123";

interface SetupResult {
  clientUserId: number;
  feeRuleId: number;
  feeConsentId: number;
}

async function setup(): Promise<SetupResult> {
  // 1) User
  let [client] = await db.select().from(users).where(eq(users.username, DRY_USERNAME));
  if (!client) {
    const hashed = await hashPassword(DRY_PASSWORD);
    [client] = await db
      .insert(users)
      .values({
        username: DRY_USERNAME,
        email: DRY_EMAIL,
        password: hashed,
        firstName: "DryRun",
        lastName: "Client",
        role: "client",
        kycStatus: "verified",
        userTier: "standard",
        emailVerified: true,
      })
      .returning();
    console.log(`[setup] created user id=${client.id} username=${client.username}`);
  } else {
    console.log(`[setup] reusing user id=${client.id} username=${client.username}`);
  }
  const clientUserId = client.id;

  // 2) AUD wallet (the deposit handler refuses to auto-create — we do it once here)
  const [existingWallet] = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, clientUserId), eq(wallets.currency, "AUD")));
  if (!existingWallet) {
    await db.insert(wallets).values({
      userId: clientUserId,
      currency: "AUD",
      balance: "0.00000000",
      availableBalance: "0.00000000",
      walletType: "fiat",
    });
    console.log(`[setup] created AUD wallet for user ${clientUserId}`);
  } else {
    console.log(`[setup] reusing AUD wallet for user ${clientUserId}`);
  }

  // 3) Adviser link
  const [existingLink] = await db
    .select()
    .from(adviserClients)
    .where(
      and(
        eq(adviserClients.adviserUserId, ADVISER_USER_ID),
        eq(adviserClients.clientUserId, clientUserId),
      ),
    );
  if (!existingLink) {
    await db.insert(adviserClients).values({
      adviserUserId: ADVISER_USER_ID,
      clientUserId,
      relationshipType: "primary",
      isActive: true,
    });
    console.log(`[setup] linked client ${clientUserId} ↔ adviser ${ADVISER_USER_ID}`);
  } else if (!existingLink.isActive) {
    await db
      .update(adviserClients)
      .set({ isActive: true, unlinkedAt: null })
      .where(eq(adviserClients.id, existingLink.id));
    console.log(`[setup] re-activated adviser link ${existingLink.id}`);
  } else {
    console.log(`[setup] reusing active adviser link ${existingLink.id}`);
  }

  // 4) Advice record (minimal — only NOT NULL columns; everything else uses defaults)
  let [advice] = await db
    .select()
    .from(adviceRecords)
    .where(
      and(eq(adviceRecords.clientId, clientUserId), eq(adviceRecords.adviserId, ADVISER_USER_ID)),
    );
  if (!advice) {
    [advice] = await db
      .insert(adviceRecords)
      .values({
        clientId: clientUserId,
        adviserId: ADVISER_USER_ID,
      })
      .returning();
    console.log(`[setup] created advice_record id=${advice.id}`);
  } else {
    console.log(`[setup] reusing advice_record id=${advice.id}`);
  }

  // 5) Signed fee_consents row (renewal_status=active, future expiry, no withdrawnAt)
  //    The accrual / approve / activate gates all check this row, NOT the request row.
  const yearAhead = new Date();
  yearAhead.setUTCFullYear(yearAhead.getUTCFullYear() + 1);
  const refDay = new Date();
  refDay.setUTCHours(0, 0, 0, 0);
  let [signedConsent] = await db
    .select()
    .from(feeConsents)
    .where(
      and(eq(feeConsents.clientId, clientUserId), eq(feeConsents.adviserId, ADVISER_USER_ID)),
    );
  if (!signedConsent) {
    [signedConsent] = await db
      .insert(feeConsents)
      .values({
        adviceRecordId: advice.id,
        clientId: clientUserId,
        adviserId: ADVISER_USER_ID,
        feeType: "ongoing_service_fee",
        amountType: "fixed",
        amount: "3.0000",
        accountNumber: "AMAX-DRYRUN",
        deductionFrequency: "monthly",
        referenceDay: refDay,
        renewalWindowStart: refDay,
        renewalWindowEnd: yearAhead,
        consentExpiryDate: yearAhead,
        renewalStatus: "active",
        clientSignatureName: "DryRun Client",
      })
      .returning();
    console.log(`[setup] created signed fee_consent id=${signedConsent.id}`);
  } else {
    // Refresh expiry so a long-old fixture re-passes the date gate.
    if (new Date(signedConsent.consentExpiryDate).getTime() <= Date.now()) {
      await db
        .update(feeConsents)
        .set({ consentExpiryDate: yearAhead, renewalStatus: "active", withdrawnAt: null })
        .where(eq(feeConsents.id, signedConsent.id));
      console.log(`[setup] refreshed signed fee_consent id=${signedConsent.id} expiry`);
    } else {
      console.log(`[setup] reusing signed fee_consent id=${signedConsent.id}`);
    }
  }

  // 6) Consent request (status='consented' iff signed_fee_consent_id IS NOT NULL — DB CHECK)
  let [request] = await db
    .select()
    .from(feeConsentRequests)
    .where(
      and(
        eq(feeConsentRequests.clientUserId, clientUserId),
        eq(feeConsentRequests.adviserUserId, ADVISER_USER_ID),
      ),
    );
  if (!request) {
    [request] = await db
      .insert(feeConsentRequests)
      .values({
        adviserUserId: ADVISER_USER_ID,
        clientUserId,
        adviceRecordId: advice.id,
        feeType: "ongoing_service_fee",
        amountType: "fixed",
        amount: "3.0000",
        accountNumber: "AMAX-DRYRUN",
        deductionFrequency: "monthly",
        proposedReferenceDay: refDay,
        proposedRenewalWindowStart: refDay,
        proposedRenewalWindowEnd: yearAhead,
        proposedConsentExpiryDate: yearAhead,
        status: "consented",
        signedFeeConsentId: signedConsent.id,
        respondedAt: new Date(),
      })
      .returning();
    console.log(`[setup] created fee_consent_request id=${request.id}`);
  } else {
    console.log(`[setup] reusing fee_consent_request id=${request.id}`);
  }

  // 7) Active fee rule (fixed $3 monthly → daily accrual = $0.10; 80/20 split).
  //    NOTE: adviser_fee_rules.fee_consent_id is an FK into fee_consents (the
  //    SIGNED consent), NOT into fee_consent_requests — the column name in
  //    Drizzle is misleadingly identical to a column on the requests table.
  let [rule] = await db
    .select()
    .from(adviserFeeRules)
    .where(eq(adviserFeeRules.feeConsentId, signedConsent.id));
  if (!rule) {
    [rule] = await db
      .insert(adviserFeeRules)
      .values({
        feeConsentId: signedConsent.id,
        clientUserId,
        adviserUserId: ADVISER_USER_ID,
        feeType: "ongoing_service_fee",
        amountType: "fixed",
        fixedAmount: "3.0000",
        currency: "AUD",
        adviserSplitBps: 8000,
        platformSplitBps: 2000,
        status: "active",
        accountNumber: "AMAX-DRYRUN",
        effectiveDate: refDay,
      })
      .returning();
    console.log(`[setup] created adviser_fee_rule id=${rule.id} status=active`);
  } else if (rule.status !== "active") {
    await db
      .update(adviserFeeRules)
      .set({ status: "active", pausedAt: null, pausedReason: null })
      .where(eq(adviserFeeRules.id, rule.id));
    console.log(`[setup] re-activated adviser_fee_rule id=${rule.id} (was ${rule.status})`);
  } else {
    console.log(`[setup] reusing active adviser_fee_rule id=${rule.id}`);
  }

  return { clientUserId, feeRuleId: rule.id, feeConsentId: request.id };
}

async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = (await r.json()) as { token?: string; error?: string };
  if (!r.ok || !body.token) {
    throw new Error(`login(${username}) failed: HTTP ${r.status} ${JSON.stringify(body)}`);
  }
  return body.token;
}

async function snapshot(label: string, clientUserId: number): Promise<void> {
  const wRow = await db.execute<{
    balance: string;
    available_balance: string;
  }>(sql`
    SELECT balance::text AS balance, available_balance::text AS available_balance
      FROM wallets WHERE user_id = ${clientUserId} AND currency = 'AUD'
  `);
  const lRow = await db.execute<{ ledger_sum: string }>(sql`
    SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END), 0)::text AS ledger_sum
      FROM ledger_entries WHERE user_id = ${clientUserId} AND currency = 'AUD'
  `);
  const wallet = (wRow as any).rows?.[0];
  const ledgerSum = (lRow as any).rows?.[0]?.ledger_sum ?? "0";
  const cached = Number(wallet?.balance ?? 0);
  const ledger = Number(ledgerSum);
  const drift = Math.abs(cached - ledger);
  const verdict = drift < 0.0000001 ? "MATCH" : `DRIFT=${drift.toFixed(8)}`;
  console.log(
    `[snapshot ${label}] AUD wallet.balance=${cached.toFixed(8)} ledger_sum=${ledger.toFixed(8)} → ${verdict}`,
  );
  if (drift >= 0.0000001) {
    throw new Error(`[snapshot ${label}] wallet ↔ ledger mismatch: ${verdict}`);
  }
}

interface StepResult {
  http: number;
  body: any;
}

async function callJson(
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: any,
  idemKey?: string,
): Promise<StepResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (idemKey) headers["Idempotency-Key"] = idemKey;
  const r = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await r.json();
  } catch {
    parsed = null;
  }
  return { http: r.status, body: parsed };
}

async function main() {
  console.log("=".repeat(72));
  console.log(" MANUAL END-TO-END DRY RUN");
  console.log("=".repeat(72));

  const { clientUserId, feeRuleId, feeConsentId } = await setup();
  console.log(
    `[setup] DONE — clientUserId=${clientUserId} feeRuleId=${feeRuleId} feeConsentId=${feeConsentId}`,
  );

  const [clientToken, adminToken] = await Promise.all([
    login(DRY_USERNAME, DRY_PASSWORD),
    login(ADMIN_USERNAME, ADMIN_PASSWORD),
  ]);
  console.log("[auth] both client + admin sessions established");

  await snapshot("initial", clientUserId);

  // ----- step 1: deposit $50 AUD ----------------------------------------------
  console.log("\n----- STEP 1: deposit $50 AUD -----");
  const stamp = Date.now();
  const dep = await callJson(
    "POST",
    "/api/deposit",
    clientToken,
    { currency: "AUD", amount: 50, description: "Manual dry-run deposit" },
    `dryrun-${stamp}-deposit`,
  );
  console.log(`HTTP ${dep.http}  body=${JSON.stringify(dep.body)}`);
  if (dep.http !== 200) throw new Error(`step 1 deposit failed: HTTP ${dep.http}`);
  await snapshot("post-deposit", clientUserId);

  // ----- step 2a: run accrual cycle for today --------------------------------
  console.log("\n----- STEP 2a: run accrual cycle for today -----");
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  const todayIso = todayUtc.toISOString().slice(0, 10);
  const acc = await callJson("POST", "/api/admin/fee-accruals/run", adminToken, {
    accrualDate: todayIso,
  });
  console.log(`HTTP ${acc.http}  body=${JSON.stringify(acc.body)}`);
  if (acc.http !== 200) throw new Error(`step 2a accrual failed: HTTP ${acc.http}`);

  // ----- step 2b: roll up accruals into pending deductions -------------------
  console.log("\n----- STEP 2b: generate pending deductions for today -----");
  const tomorrow = new Date(todayUtc.getTime() + 24 * 3600 * 1000);
  const gen = await callJson("POST", "/api/admin/fee-deductions/generate", adminToken, {
    periodStart: todayUtc.toISOString(),
    periodEnd: tomorrow.toISOString(),
  });
  console.log(`HTTP ${gen.http}  body=${JSON.stringify(gen.body)}`);
  if (gen.http !== 200) throw new Error(`step 2b generate failed: HTTP ${gen.http}`);
  await snapshot("post-accrual+generate", clientUserId);

  // ----- step 2c: locate the new client's pending deduction ------------------
  const list = await callJson(
    "GET",
    `/api/admin/fee-deductions?clientUserId=${clientUserId}&status=pending_approval&limit=10`,
    adminToken,
  );
  console.log(`[step 2c] HTTP ${list.http}  total=${list.body?.total}`);
  const items: any[] = list.body?.items ?? [];
  if (items.length === 0) {
    throw new Error(`step 2c no pending deduction for client ${clientUserId} — nothing to approve`);
  }
  const deduction = items[0];
  console.log(
    `[step 2c] deduction id=${deduction.id} totalAccrued=${deduction.totalAccrued} ` +
      `adviser=${deduction.adviserShareTotal} platform=${deduction.platformShareTotal}`,
  );

  // ----- step 3: approve the deduction (this is the chokepoint that posts to ledger) --
  console.log("\n----- STEP 3: approve pending deduction -----");
  const apr = await callJson(
    "POST",
    `/api/admin/fee-deductions/${deduction.id}/approve`,
    adminToken,
    {},
  );
  console.log(`HTTP ${apr.http}  body=${JSON.stringify(apr.body)}`);
  if (apr.http !== 200) throw new Error(`step 3 approve failed: HTTP ${apr.http}`);
  await snapshot("post-approve", clientUserId);

  // ----- step 4: withdraw $50 AUD --------------------------------------------
  console.log("\n----- STEP 4: withdraw $50 AUD -----");
  const wd = await callJson(
    "POST",
    "/api/withdraw",
    clientToken,
    { currency: "AUD", amount: 50, description: "Manual dry-run withdrawal" },
    `dryrun-${stamp}-withdraw`,
  );
  console.log(`HTTP ${wd.http}  body=${JSON.stringify(wd.body)}`);
  if (wd.http === 200) {
    console.log("[step 4] withdrawal succeeded");
  } else {
    // EXPECTED branch: $50 deposit minus $0.10 fee leaves $49.90, so a $50 withdraw
    // SHOULD trip the insufficient-funds guard — that's correct, defensive behaviour.
    console.log(
      `[step 4] withdrawal of $50 was REFUSED (HTTP ${wd.http}) — this is the EXPECTED ` +
        `insufficient-funds guard since the post-approval balance is $49.90, not $50.`,
    );
    // The withdrawal handler ALSO applies a flat fiat-wire fee — for AUD that's
    // $35 (see WITHDRAWAL_FEES in server/routes.ts handleWithdraw). The check is
    // available >= amount + fee. So to actually drain the residual we have to
    // request `available - 35`. This is the CORRECT, defensive behaviour, not a
    // bug — we simply prove the happy path also works with the real balance.
    const AUD_WIRE_FEE = 35;
    const drainRow = await db.execute<{ available_balance: string }>(sql`
      SELECT available_balance::text AS available_balance FROM wallets
       WHERE user_id = ${clientUserId} AND currency = 'AUD'
    `);
    const avail = Number((drainRow as any).rows?.[0]?.available_balance ?? "0");
    const principal = Number((avail - AUD_WIRE_FEE).toFixed(2));
    if (principal > 0) {
      console.log(
        `[step 4b] retrying with principal $${principal.toFixed(2)} ` +
          `(available $${avail.toFixed(2)} − $${AUD_WIRE_FEE} AUD wire fee)`,
      );
      const wd2 = await callJson(
        "POST",
        "/api/withdraw",
        clientToken,
        {
          currency: "AUD",
          amount: principal,
          description: "Manual dry-run withdrawal (residual)",
        },
        `dryrun-${stamp}-withdraw-residual`,
      );
      console.log(`HTTP ${wd2.http}  body=${JSON.stringify(wd2.body)}`);
      if (wd2.http !== 200) {
        throw new Error(`step 4b residual withdrawal failed: HTTP ${wd2.http}`);
      }
    } else {
      console.log(
        `[step 4b] residual ($${avail.toFixed(2)}) is below the $${AUD_WIRE_FEE} AUD ` +
          `wire-fee floor — leaving funds in the wallet (not a bug, that's the floor)`,
      );
    }
  }
  await snapshot("post-withdraw", clientUserId);

  console.log("\n" + "=".repeat(72));
  console.log(" DRY RUN COMPLETE — running GO/NO-GO check next");
  console.log("=".repeat(72));
}

main()
  .then(async () => {
    // Hand off to the launch check.
    const r = spawnSync("npx", ["tsx", "scripts/go-no-go-check.ts"], {
      stdio: "inherit",
      env: process.env,
    });
    await pool.end();
    process.exit(r.status ?? 0);
  })
  .catch(async (err) => {
    console.error("[dry-run] FAILED:", err?.message ?? err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
