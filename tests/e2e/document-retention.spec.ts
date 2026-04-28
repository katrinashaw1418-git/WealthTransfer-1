// Task #331 — E2E cover for the documents retention UI added by Task #318.
// The 423 server contract is already covered by
// server/services/document-retention.test.ts (vitest+supertest); this spec
// guards the React surface that vitest can't see: the policy strip, the
// per-row Lock chip + tooltip, and the disabled Delete button on the
// adviser side, plus the matching disclosure (and intentional absence of a
// Delete button) on the client side.

import { test, expect, type Page } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../server/db";
import { users, adviserClients, clientDocuments } from "../../shared/schema";
import { signToken } from "../../server/auth";

// Mirror of RETENTION_POLICY_TEXT in the adviser panel and client page.
// Hard-coded so a wording drift between the two surfaces fails this test.
const RETENTION_POLICY_TEXT =
  "Documents are retained for 7 years from creation per Corporations Act s912G. Deletion is locked while the retention window is active.";

let adviserId: number;
let clientId: number;
let lockedDocId: number;
let unlockedDocId: number;
let adviserToken: string;
let clientToken: string;

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

  const [adviser] = await db
    .insert(users)
    .values({
      username: `t331-adv-${stamp}`,
      email: `t331-adv-${stamp}@example.test`,
      password: "x",
      firstName: "E2E",
      lastName: "Adviser",
      role: "adviser",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  const [client] = await db
    .insert(users)
    .values({
      username: `t331-cli-${stamp}`,
      email: `t331-cli-${stamp}@example.test`,
      password: "x",
      firstName: "E2E",
      lastName: "Client",
      role: "client",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();

  adviserId = adviser.id;
  clientId = client.id;

  await db.insert(adviserClients).values({
    adviserUserId: adviserId,
    clientUserId: clientId,
    isActive: true,
  });

  const [locked] = await db
    .insert(clientDocuments)
    .values({
      clientId,
      documentType: "fact_find",
      fileName: "t331-locked.pdf",
      storageKey: `client-documents/${clientId}/t331-locked-${stamp}.pdf`,
      mimeType: "application/pdf",
      fileSizeBytes: 2048,
      uploadedByUserId: adviserId,
      deletionLocked: true,
      retentionUntil: new Date(Date.now() + 365 * 86_400_000),
    })
    .returning();
  lockedDocId = locked.id;

  const [unlocked] = await db
    .insert(clientDocuments)
    .values({
      clientId,
      documentType: "correspondence",
      fileName: "t331-unlocked.pdf",
      storageKey: `client-documents/${clientId}/t331-unlocked-${stamp}.pdf`,
      mimeType: "application/pdf",
      fileSizeBytes: 1024,
      uploadedByUserId: adviserId,
      deletionLocked: false,
      retentionUntil: new Date(Date.now() - 86_400_000),
    })
    .returning();
  unlockedDocId = unlocked.id;

  adviserToken = signToken({
    userId: adviserId,
    username: adviser.username,
    email: adviser.email,
    role: "adviser",
  });
  clientToken = signToken({
    userId: clientId,
    username: client.username,
    email: client.email,
    role: "client",
  });
});

test.afterAll(async () => {
  // Delete the rows we created. We do NOT delete the seeded users:
  // every page load writes audit_logs entries that FK back to those users,
  // and audit_logs is enforced as truly append-only by a DB trigger
  // (see shared/schema.ts ~line 244). The seeded usernames carry a per-run
  // stamp so they don't collide; cleanup-fixture-rows.ts is the canonical
  // bulk tool for fixture residue.
  await db
    .delete(clientDocuments)
    .where(inArray(clientDocuments.id, [lockedDocId, unlockedDocId]));
  await db
    .delete(adviserClients)
    .where(eq(adviserClients.clientUserId, clientId));
});

// Inject the JWT into localStorage before the SPA boots so the auth context
// reads it on first render (see client/src/contexts/auth.tsx → TOKEN_KEY).
async function loginViaToken(page: Page, token: string): Promise<void> {
  await page.addInitScript((jwt) => {
    window.localStorage.setItem("amax_jwt", jwt);
  }, token);
}

test("adviser: locked doc shows policy strip, Lock chip + tooltip, disabled Delete", async ({
  page,
}) => {
  await loginViaToken(page, adviserToken);
  await page.goto(`/adviser/clients/${clientId}`);
  await expect(page.getByTestId("page-adviser-client-detail")).toBeVisible();

  await page.getByTestId("tab-planner").click();
  await page.getByTestId("tab-wp-documents").click();

  const strip = page.getByTestId("strip-retention-policy");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText(RETENTION_POLICY_TEXT);

  const lockChip = page.getByTestId(`badge-document-locked-${lockedDocId}`);
  await expect(lockChip).toBeVisible();
  await expect(lockChip).toContainText(/Locked/i);

  const deleteBtn = page.getByTestId(`button-delete-document-${lockedDocId}`);
  await expect(deleteBtn).toBeVisible();
  await expect(deleteBtn).toBeDisabled();

  // Radix renders tooltip content into a portal with role="tooltip" — assert
  // on text rather than a testid because Radix doesn't forward testids onto
  // the floating content node.
  await lockChip.hover();
  const adviserTooltip = page.getByRole("tooltip");
  await expect(adviserTooltip).toBeVisible();
  await expect(adviserTooltip).toContainText(RETENTION_POLICY_TEXT);
});

test("adviser: unlocked doc (deletion_locked=false, retention past) shows enabled Delete", async ({
  page,
}) => {
  await loginViaToken(page, adviserToken);
  await page.goto(`/adviser/clients/${clientId}`);
  await expect(page.getByTestId("page-adviser-client-detail")).toBeVisible();

  await page.getByTestId("tab-planner").click();
  await page.getByTestId("tab-wp-documents").click();

  await expect(page.getByTestId(`row-document-${unlockedDocId}`)).toBeVisible();
  await expect(
    page.getByTestId(`badge-document-locked-${unlockedDocId}`),
  ).toHaveCount(0);

  const deleteBtn = page.getByTestId(
    `button-delete-document-${unlockedDocId}`,
  );
  await expect(deleteBtn).toBeVisible();
  await expect(deleteBtn).toBeEnabled();
});

test("client: locked doc shows policy strip and Lock chip + tooltip; no Delete affordance", async ({
  page,
}) => {
  await loginViaToken(page, clientToken);
  await page.goto("/client/wealth-planner");
  await expect(page.getByTestId("page-client-wealth-planner")).toBeVisible();

  await page.getByTestId("tab-client-documents").click();

  const strip = page.getByTestId("strip-retention-policy");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText(RETENTION_POLICY_TEXT);

  const lockChip = page.getByTestId(`badge-document-locked-${lockedDocId}`);
  await expect(lockChip).toBeVisible();
  await expect(lockChip).toContainText(/Locked/i);

  await lockChip.hover();
  const clientTooltip = page.getByRole("tooltip");
  await expect(clientTooltip).toBeVisible();
  await expect(clientTooltip).toContainText(RETENTION_POLICY_TEXT);

  // Client surface is intentionally view-only — uploads + deletes are
  // adviser-only actions gated by assertAdviserClientLink, and the client
  // page renders a Download button instead of Delete (see the Task #318
  // comment at client/src/pages/client/wealth-planner.tsx:74). Asserting
  // the Delete testid is absent locks that contract in.
  await expect(
    page.getByTestId(`button-delete-document-${lockedDocId}`),
  ).toHaveCount(0);
  await expect(
    page.getByTestId(`button-delete-document-${unlockedDocId}`),
  ).toHaveCount(0);
});
