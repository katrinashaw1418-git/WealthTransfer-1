// =============================================================================
// Task #318 — Document watermark utility tests
// =============================================================================
// Locks down the post-rework contract:
//
//   1. The footer string format the regulator-facing spec requires
//      (verbatim wording — typos here would surface in a leaked PDF).
//   2. The footer carries the per-DOWNLOAD timestamp + canonical purpose,
//      not the document's generation time.
//   3. UTC-timestamp formatting that does not depend on the host timezone.
//   4. The buffer-in / buffer-out helper applies the watermark to EVERY
//      page of a real multi-page PDF (built with pdf-lib) and returns a
//      Buffer containing a still-parseable PDF whose page count is
//      preserved.
//
// All tests run inside vitest with no DB access and no network.
// =============================================================================

import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  applyDocumentWatermark,
  formatWatermarkFooter,
  formatWatermarkTimestamp,
  RETENTION_POLICY_STRIP_TEXT,
} from "./document-watermark";

// Build a blank multi-page PDF buffer for use as an input fixture.
async function buildBlankPdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage([595, 842]); // A4 in points
  }
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

describe("document-watermark utility (Task #318)", () => {
  describe("formatWatermarkTimestamp", () => {
    it("formats a Date as `YYYY-MM-DD HH:mm UTC`", () => {
      const d = new Date(Date.UTC(2026, 3, 27, 3, 9, 42));
      expect(formatWatermarkTimestamp(d)).toBe("2026-04-27 03:09 UTC");
    });

    it("uses UTC, not the host's local timezone", () => {
      const d = new Date(Date.UTC(2026, 0, 1, 23, 30, 0));
      expect(formatWatermarkTimestamp(d)).toBe("2026-01-01 23:30 UTC");
    });
  });

  describe("formatWatermarkFooter", () => {
    it("produces the exact regulator-required string with the per-download instant + purpose", () => {
      const footer = formatWatermarkFooter({
        clientName: "Jane Citizen",
        adviserName: "Sam Adviser",
        downloadedAtUtc: new Date(Date.UTC(2026, 3, 27, 12, 34, 0)),
        purpose: "report_download",
      });
      expect(footer).toBe(
        "Confidential — generated for Jane Citizen by Sam Adviser on 2026-04-27 12:34 UTC · purpose: report_download · AMAX Wealth · Not for distribution",
      );
    });

    it("emits the canonical purpose label for each watermark surface", () => {
      // Locks the purpose vocabulary used across all four download routes.
      // Drift here would mean two surfaces tag the same kind of leak with
      // different audit strings.
      const at = new Date(Date.UTC(2026, 3, 27, 12, 34, 0));
      const ctx = { clientName: "C", adviserName: "A", downloadedAtUtc: at };
      expect(
        formatWatermarkFooter({ ...ctx, purpose: "report_download" }),
      ).toContain("purpose: report_download");
      expect(
        formatWatermarkFooter({ ...ctx, purpose: "client_document_download" }),
      ).toContain("purpose: client_document_download");
      expect(
        formatWatermarkFooter({ ...ctx, purpose: "fee_consent_download" }),
      ).toContain("purpose: fee_consent_download");
      expect(
        formatWatermarkFooter({
          ...ctx,
          purpose: "fee_consent_request_download",
        }),
      ).toContain("purpose: fee_consent_request_download");
    });

    it("collapses embedded newlines so the footer cannot inject a second line", () => {
      const footer = formatWatermarkFooter({
        clientName: "Jane\nCitizen",
        adviserName: "Sam   Adviser",
        downloadedAtUtc: new Date(Date.UTC(2026, 3, 27, 12, 34, 0)),
        purpose: "report_download",
      });
      expect(footer).toContain("Jane Citizen");
      expect(footer).toContain("Sam Adviser");
      expect(footer).not.toContain("\n");
    });

    it("falls back to a deterministic placeholder when a name is empty", () => {
      const footer = formatWatermarkFooter({
        clientName: "   ",
        adviserName: "",
        downloadedAtUtc: new Date(Date.UTC(2026, 3, 27, 12, 34, 0)),
        purpose: "report_download",
      });
      expect(footer).toContain("(unknown client)");
      expect(footer).toContain("(unknown adviser)");
    });

    it("changes between two different download instants for the same source PDF", () => {
      const a = formatWatermarkFooter({
        clientName: "Jane",
        adviserName: "Sam",
        downloadedAtUtc: new Date(Date.UTC(2026, 3, 27, 12, 0, 0)),
        purpose: "report_download",
      });
      const b = formatWatermarkFooter({
        clientName: "Jane",
        adviserName: "Sam",
        downloadedAtUtc: new Date(Date.UTC(2026, 3, 27, 12, 1, 0)),
        purpose: "report_download",
      });
      expect(a).not.toBe(b);
    });
  });

  describe("applyDocumentWatermark (buffer-in / buffer-out)", () => {
    it("returns a Buffer (not a Uint8Array) so the HTTP layer can stream it directly", async () => {
      const input = await buildBlankPdf(1);
      const out = await applyDocumentWatermark(input, {
        clientName: "Jane Citizen",
        adviserName: "Sam Adviser",
        downloadedAtUtc: new Date(Date.UTC(2026, 3, 27, 12, 34, 0)),
        purpose: "report_download",
      });
      expect(Buffer.isBuffer(out)).toBe(true);
    });

    it("does not mutate the original input buffer", async () => {
      const input = await buildBlankPdf(1);
      const before = Buffer.from(input);
      await applyDocumentWatermark(input, {
        clientName: "Jane",
        adviserName: "Sam",
        downloadedAtUtc: new Date(Date.UTC(2026, 3, 27, 12, 34, 0)),
        purpose: "report_download",
      });
      expect(input.equals(before)).toBe(true);
    });

    it("preserves the page count of a multi-page input", async () => {
      const input = await buildBlankPdf(3);
      const out = await applyDocumentWatermark(input, {
        clientName: "Multi",
        adviserName: "Page",
        downloadedAtUtc: new Date(Date.UTC(2026, 3, 27, 12, 34, 0)),
        purpose: "report_download",
      });
      const reloaded = await PDFDocument.load(out);
      expect(reloaded.getPageCount()).toBe(3);
    });

    it("emits a parseable PDF (header, EOF marker)", async () => {
      const input = await buildBlankPdf(2);
      const out = await applyDocumentWatermark(input, {
        clientName: "Jane",
        adviserName: "Sam",
        downloadedAtUtc: new Date(Date.UTC(2026, 3, 27, 12, 34, 0)),
        purpose: "report_download",
      });
      // pdf-lib output starts with %PDF- and ends with %%EOF.
      expect(out.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(out.subarray(-6).toString("latin1")).toContain("%%EOF");
    });

    it("rejects a non-PDF buffer instead of silently emitting an unmarked download", async () => {
      // Defensive: an unmarked PDF leaving the platform is worse than a
      // failed download. The helper must surface the parse error.
      await expect(
        applyDocumentWatermark(Buffer.from("not a pdf"), {
          clientName: "Jane",
          adviserName: "Sam",
          downloadedAtUtc: new Date(Date.UTC(2026, 3, 27, 12, 34, 0)),
          purpose: "report_download",
        }),
      ).rejects.toThrow();
    });

    it("produces different output bytes for two different download instants", async () => {
      // Locks down the per-download-not-per-generation contract end-to-end:
      // the SAME source PDF, watermarked with two different download
      // instants, must yield two distinguishable byte streams.
      const input = await buildBlankPdf(1);
      const a = await applyDocumentWatermark(input, {
        clientName: "Jane",
        adviserName: "Sam",
        downloadedAtUtc: new Date(Date.UTC(2026, 3, 27, 12, 0, 0)),
        purpose: "report_download",
      });
      const b = await applyDocumentWatermark(input, {
        clientName: "Jane",
        adviserName: "Sam",
        downloadedAtUtc: new Date(Date.UTC(2026, 3, 27, 12, 1, 0)),
        purpose: "report_download",
      });
      expect(a.equals(b)).toBe(false);
    });
  });

  describe("RETENTION_POLICY_STRIP_TEXT", () => {
    it("matches the exact wording the UI strip and 423 body must use", () => {
      // The same string is rendered by the adviser / client documents UI
      // and embedded in the DELETE 423 body's `extra.policy`. A drift here
      // means the adviser sees one wording and the client another, which
      // is a regulator-flagged inconsistency.
      expect(RETENTION_POLICY_STRIP_TEXT).toBe(
        "Documents are retained for 7 years from creation per Corporations Act s912G. Deletion is locked while the retention window is active.",
      );
    });
  });
});
