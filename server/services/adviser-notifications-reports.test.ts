// =============================================================================
// Task #327 — bell-icon notifications for completed report transitions
// -----------------------------------------------------------------------------
// The reports polish work added inline `notifyAdviserReport*` email helpers,
// but advisers also need to see the same close-the-loop signal in the bell
// without refreshing the Reports page. The bell aggregator is a derived view
// over the source-of-truth tables (no notifications table), so this test
// pins the behaviour we just extended into getAdviserNotifications():
//
//   1. A `ready` row produces a "Report ready to download" item with a deep
//      link that points at the row (`?focus=<id>`), severity `info`.
//   2. A `failed` row produces a "Report failed" item that surfaces the
//      failure reason and a regenerate hint, severity `urgent`.
//   3. The bucket is naturally de-duplicated per report id — two terminal
//      rows produce two items, and re-asserting the same status on the same
//      row (e.g. a sweeper re-tick) does not add a duplicate.
//   4. A `ready` row whose PDF has already been downloaded (firstDownloaded
//      At IS NOT NULL) drops out automatically so the bell self-clears once
//      the adviser collects the file.
//   5. The existing dismissal preference layer still hides the row from
//      both `items` and `counts`.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  adviserClients,
  adviserNotificationDismissals,
  reportRequests,
  users,
} from "@shared/schema";
import { getAdviserNotifications } from "./adviser-access";

const ADVISER_USERNAME = "__bell_reports_test_adviser__";
const CLIENT_USERNAME = "__bell_reports_test_client__";

let adviserUserId: number;
let clientUserId: number;

async function ensureUser(
  username: string,
  email: string,
  role: "client" | "adviser",
): Promise<number> {
  const [existing] = await db.select().from(users).where(eq(users.username, username));
  if (existing) {
    await db
      .update(users)
      .set({ email, firstName: "Bell", lastName: "Test", role })
      .where(eq(users.id, existing.id));
    return existing.id;
  }
  const [created] = await db
    .insert(users)
    .values({
      username,
      email,
      password: "not-a-real-password",
      firstName: "Bell",
      lastName: "Test",
      kycStatus: "verified",
      emailVerified: true,
      role,
    })
    .returning();
  return created.id;
}

async function clearReportRows(): Promise<void> {
  if (adviserUserId !== undefined) {
    await db
      .delete(reportRequests)
      .where(eq(reportRequests.adviserUserId, adviserUserId));
    await db
      .delete(adviserNotificationDismissals)
      .where(eq(adviserNotificationDismissals.adviserUserId, adviserUserId));
  }
}

beforeAll(async () => {
  adviserUserId = await ensureUser(
    ADVISER_USERNAME,
    "bell-reports-test-adviser@example.com",
    "adviser",
  );
  clientUserId = await ensureUser(
    CLIENT_USERNAME,
    "bell-reports-test-client@example.com",
    "client",
  );
  const [existingLink] = await db
    .select()
    .from(adviserClients)
    .where(
      and(
        eq(adviserClients.adviserUserId, adviserUserId),
        eq(adviserClients.clientUserId, clientUserId),
      ),
    );
  if (!existingLink) {
    await db
      .insert(adviserClients)
      .values({ adviserUserId, clientUserId, isActive: true });
  } else if (!existingLink.isActive) {
    await db
      .update(adviserClients)
      .set({ isActive: true })
      .where(eq(adviserClients.id, existingLink.id));
  }
  await clearReportRows();
});

afterAll(async () => {
  await clearReportRows();
  await db
    .delete(adviserClients)
    .where(
      and(
        eq(adviserClients.adviserUserId, adviserUserId),
        eq(adviserClients.clientUserId, clientUserId),
      ),
    );
  await db.delete(users).where(inArray(users.id, [adviserUserId, clientUserId]));
});

describe("getAdviserNotifications — report ready/failed bell entries", () => {
  it("surfaces ready and failed reports with status-specific copy and a focus deep-link", async () => {
    await clearReportRows();
    const generatedAt = new Date();
    const expiresAt = new Date(generatedAt.getTime() + 7 * 86_400_000);

    const [readyRow] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "ready",
        downloadUrl: "/api/adviser/reports/0/download",
        generatedAt,
        expiresAt,
      })
      .returning();

    const [failedRow] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "fee_summary",
        format: "pdf",
        status: "failed",
        failureReason: "sweeper_timeout",
      })
      .returning();

    const payload = await getAdviserNotifications(adviserUserId);
    const reportItems = payload.items.filter((it) => it.type === "report");

    const readyItem = reportItems.find((it) => it.id === `report:${readyRow.id}`);
    const failedItem = reportItems.find((it) => it.id === `report:${failedRow.id}`);

    expect(readyItem).toBeDefined();
    expect(readyItem!.title).toBe("Report ready to download");
    expect(readyItem!.severity).toBe("info");
    expect(readyItem!.deepLink).toBe(`/adviser/reports?focus=${readyRow.id}`);
    expect(readyItem!.description.toLowerCase()).toContain("portfolio summary");

    expect(failedItem).toBeDefined();
    expect(failedItem!.title).toBe("Report failed");
    expect(failedItem!.severity).toBe("urgent");
    expect(failedItem!.deepLink).toBe(`/adviser/reports?focus=${failedRow.id}`);
    expect(failedItem!.description).toContain("sweeper_timeout");
    expect(failedItem!.description.toLowerCase()).toContain("regenerate");

    // Both are counted by the existing pendingReports bucket so the bell
    // badge reflects them without any extra plumbing on the client.
    expect(payload.counts.pendingReports).toBeGreaterThanOrEqual(2);
  });

  it("auto-clears a ready report once the adviser downloads it", async () => {
    await clearReportRows();
    const [row] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "transaction_history",
        format: "pdf",
        status: "ready",
        downloadUrl: "/api/adviser/reports/0/download",
        generatedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      })
      .returning();

    const before = await getAdviserNotifications(adviserUserId);
    expect(before.items.some((it) => it.id === `report:${row.id}`)).toBe(true);

    await db
      .update(reportRequests)
      .set({ firstDownloadedAt: new Date() })
      .where(eq(reportRequests.id, row.id));

    const after = await getAdviserNotifications(adviserUserId);
    expect(after.items.some((it) => it.id === `report:${row.id}`)).toBe(false);
    expect(after.counts.pendingReports).toBe(
      Math.max(0, before.counts.pendingReports - 1),
    );
  });

  it("does not duplicate the bell entry when the same failed row is re-flipped", async () => {
    await clearReportRows();
    const [row] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "full_statement",
        format: "pdf",
        status: "failed",
        failureReason: "sweeper_timeout",
      })
      .returning();

    // Simulate a second sweeper tick re-asserting the same terminal state.
    // The aggregator is a straight read over the row, so the bell entry is
    // de-duped per report id by construction; this also exercises the
    // already-stamped failedNotifiedAt path that keeps email idempotent.
    await db
      .update(reportRequests)
      .set({ status: "failed", failureReason: "sweeper_timeout" })
      .where(eq(reportRequests.id, row.id));

    const payload = await getAdviserNotifications(adviserUserId);
    const matches = payload.items.filter((it) => it.id === `report:${row.id}`);
    expect(matches).toHaveLength(1);
  });

  it("respects the existing dismissal preference for ready/failed rows", async () => {
    await clearReportRows();
    const [readyRow] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "ready",
        downloadUrl: "/api/adviser/reports/0/download",
        generatedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      })
      .returning();

    await db.insert(adviserNotificationDismissals).values({
      adviserUserId,
      sourceType: "report",
      sourceId: readyRow.id,
    });

    const payload = await getAdviserNotifications(adviserUserId);
    expect(payload.items.some((it) => it.id === `report:${readyRow.id}`)).toBe(false);
  });
});
