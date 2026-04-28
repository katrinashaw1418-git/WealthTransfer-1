// =============================================================================
// Task #318 — Document watermark utility
// =============================================================================
// Every PDF the platform serves to a client or adviser must carry an
// unambiguous mark of who downloaded it, who they downloaded it about, why,
// and when (UTC). The mark serves two compliance purposes:
//
//   1. A leaked PDF can be traced back to the exact (client, adviser,
//      download instant, purpose) tuple — the footer line is forensic
//      metadata.
//   2. A diagonal "CONFIDENTIAL" band on every page makes accidental
//      sharing visually obvious; a screenshot or print still carries
//      the warning.
//
// The utility is buffer-in / buffer-out:
//
//   const watermarked = await applyDocumentWatermark(originalPdf, {
//     clientName: "Jane Citizen",
//     adviserName: "Sam Adviser",
//     downloadedAtUtc: new Date(),    // pinned to the request timestamp,
//                                     // NOT generation time, so every
//                                     // download produces a uniquely
//                                     // attributable PDF.
//     purpose: "report_download",
//   });
//
// This contract works for BOTH platform-generated PDFs (built with pdfkit)
// AND client-uploaded PDFs streamed back from object storage. Internally we
// use `pdf-lib` to load any conforming PDF, walk its pages, and overlay the
// band + footer.
//
// The footer string format is locked by the regulator-facing spec:
//
//     Confidential — generated for <clientName> by <adviserName>
//     on <YYYY-MM-DD HH:mm UTC> · purpose: <purpose>
//     · AMAX Wealth · Not for distribution
//
// The exported helper `formatWatermarkFooter` is the pure-text contract
// that the test suite locks down so a typo in the visible string is caught
// at CI time rather than after a regulator reads a leaked PDF.
// =============================================================================

import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

// Canonical purpose values. The audit row's `purpose` field MUST match one
// of these strings — they are the same enum the regulator-facing surface
// queries. Keep this list narrow; new purposes must be added deliberately,
// not silently introduced by a typo at a call site.
export type WatermarkPurpose =
  | "report_download"
  | "client_document_download"
  | "fee_consent_download"
  | "fee_consent_request_download"
  | "consent_pdf_download"
  | "wealth_planner_export"
  | "signed_document_download";

export interface WatermarkContext {
  clientName: string;
  adviserName: string;
  // Pinned to the request instant, not the document generation instant.
  // Two downloads of the same stored PDF produce two distinguishable
  // watermarked outputs.
  downloadedAtUtc: Date;
  purpose: WatermarkPurpose;
}

// The visible policy strip rendered by the document-management UIs (adviser
// panel + client wealth-planner page). Kept here so the server-side
// watermark constant and the client-side disclosure stay in sync — both
// surfaces must quote the same policy or the regulator surface fragments.
export const RETENTION_POLICY_STRIP_TEXT =
  "Documents are retained for 7 years from creation per Corporations Act s912G. Deletion is locked while the retention window is active.";

// Format a Date as `YYYY-MM-DD HH:mm UTC`. We deliberately use UTC (not the
// adviser's local zone) so a leaked PDF always carries an absolute, audit-
// reconstructable instant — no ambiguity about which timezone "10:30"
// refers to. Seconds are dropped: minute precision is sufficient for
// forensic attribution and keeps the footer compact.
export function formatWatermarkTimestamp(d: Date): string {
  const iso = d.toISOString(); // e.g. 2026-04-27T12:34:56.789Z
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  return `${date} ${time} UTC`;
}

// Pure-text formatter. Exported so tests can lock the exact string without
// having to spin up a real PDFDocument and parse the rendered output.
export function formatWatermarkFooter(ctx: WatermarkContext): string {
  const ts = formatWatermarkTimestamp(ctx.downloadedAtUtc);
  // Sanitise to a single line — a stray newline in clientName / adviserName
  // would corrupt the footer layout. We collapse whitespace runs to a
  // single space so a copy-pasted name with embedded \n still renders
  // cleanly.
  const client =
    ctx.clientName.replace(/\s+/g, " ").trim() || "(unknown client)";
  const adviser =
    ctx.adviserName.replace(/\s+/g, " ").trim() || "(unknown adviser)";
  return `Confidential — generated for ${client} by ${adviser} on ${ts} · purpose: ${ctx.purpose} · AMAX Wealth · Not for distribution`;
}

// Apply the watermark to every page of an existing PDF buffer. Returns a
// fresh buffer containing the same PDF with a diagonal CONFIDENTIAL band
// and a forensic footer line on each page. The original bytes are NOT
// mutated.
//
// This is the canonical entry point used by ALL download/preview endpoints
// just before they stream the response. It works on buffers produced by
// pdfkit (our reports + admin exports) AND on client-uploaded PDFs pulled
// from object storage.
//
// Errors: if the buffer is not a parseable PDF (e.g. a corrupted upload),
// pdf-lib throws — the caller is expected to surface a 500 rather than
// silently serving an unwatermarked file. We deliberately do NOT swallow
// the error: an unmarked PDF leaving the platform is a worse outcome than
// a failed download.
export async function applyDocumentWatermark(
  pdfBuffer: Buffer,
  ctx: WatermarkContext,
): Promise<Buffer> {
  const footer = formatWatermarkFooter(ctx);
  // ignoreEncryption keeps us robust if a client uploads a PDF with the
  // (rarely-used) "owner password" set — we still mark it before serving.
  const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  // Standard 14 fonts are embedded by reference, not as glyph subsets,
  // so the output PDF stays small even for multi-page documents.
  const bandFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const footerFont = await doc.embedFont(StandardFonts.Helvetica);

  // Theme: slate-900 at 12% opacity for the band (matches our pdfkit
  // generator), slate-600 at full opacity for the footer.
  const bandColor = rgb(0x0f / 255, 0x17 / 255, 0x2a / 255);
  const footerColor = rgb(0x47 / 255, 0x55 / 255, 0x69 / 255);

  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();

    // -------- Diagonal semi-transparent band ---------------------------
    // Rotate around the page centre at -30 degrees, the conventional
    // watermark angle. We approximate horizontal centring by measuring
    // the rendered text width.
    const bandText = "CONFIDENTIAL";
    const bandSize = 72;
    const bandWidth = bandFont.widthOfTextAtSize(bandText, bandSize);
    page.drawText(bandText, {
      x: width / 2 - bandWidth / 2,
      y: height / 2 - bandSize / 2,
      size: bandSize,
      font: bandFont,
      color: bandColor,
      opacity: 0.12,
      rotate: degrees(30),
    });

    // -------- Forensic footer line --------------------------------------
    // Pinned to the very bottom of the page (below any content footer the
    // generator may have already drawn). We centre it horizontally and
    // truncate visually by relying on the text width — pdf-lib does not
    // wrap by default, which is the desired behaviour: a long footer is
    // visibly clipped, not silently wrapped into the page body.
    const footerSize = 7;
    const footerWidth = footerFont.widthOfTextAtSize(footer, footerSize);
    page.drawText(footer, {
      x: Math.max(28, width / 2 - footerWidth / 2),
      y: 14,
      size: footerSize,
      font: footerFont,
      color: footerColor,
      opacity: 1,
    });
  }

  const out = await doc.save();
  // pdf-lib returns a Uint8Array; the rest of our HTTP layer expects
  // Node's Buffer, which is a subclass of Uint8Array but with a
  // different prototype. Wrap before returning so consumers can call
  // .toString("latin1") etc.
  return Buffer.from(out);
}
