// =============================================================================
// Task #343 — Shared fee-consent PDF builder.
// -----------------------------------------------------------------------------
// Originally lived inline in server/admin-routes.ts (Task #293/#302/#318). It
// was lifted out so the new client-facing download routes (so a client can
// retain their own copy of an executed consent — RG175) can render the SAME
// artefact through the SAME code path. Keeping admin and client on a single
// builder is the only durable way to guarantee the two surfaces never drift.
//
// What lives here:
//   - AMAX licensee disclosure constants (env-sourced; placeholders stamp a
//     visible DRAFT watermark — same behaviour as the original closure).
//   - Formatters / drawing helpers / supersede-chain walker / appendix loader.
//   - renderConsentPdf(data) — pure PDFKit renderer over a ConsentPdfData.
//   - Two high-level entry points used by routes:
//       * buildFeeConsentRequestPdf({ id, exportedByUserId, purpose, requireOwnerUserId? })
//       * buildFeeConsentPdf({ id, exportedByUserId, purpose, requireOwnerUserId? })
//     Both: load the row → optional ownership gate (403) → join supporting
//     rows → render → apply Task #318 per-download watermark → return the
//     buffer + filename + clientUserId/adviserUserId so the caller can write
//     audit rows + content headers itself.
//
// What stays in the routes:
//   - Auth (requireAuth / role check), audit log writes, and response stream.
//     Each surface writes its OWN audit rows (admin: fee_consent_*_pdf_exported
//     + document.download; client: fee_consent_*_pdf_exported_by_client +
//     document.download) so the audit trail tells you who pulled it.
// =============================================================================

import { and, asc, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import { db } from "../db";
import {
  auditLogs,
  feeConsents,
  feeConsentRequests,
  users,
  adviserProfiles,
} from "@shared/schema";
import {
  applyDocumentWatermark,
  type WatermarkPurpose,
} from "./document-watermark";
import { resolveWatermarkNames } from "./watermark-context";

// -----------------------------------------------------------------------------
// Licensee identity disclosure (sourced from env at module load).
// -----------------------------------------------------------------------------
const AMAX_LICENSEE_NAME =
  process.env.AMAX_LICENSEE_NAME?.trim() || "AMAX Wealth Pty Ltd";
const AMAX_PLATFORM_NAME =
  process.env.AMAX_PLATFORM_NAME?.trim() || "AMAX Wealth";
const AMAX_LICENSEE_AFSL =
  process.env.AMAX_LICENSEE_AFSL?.trim() || "AFSL [PLACEHOLDER]";
const AMAX_LICENSEE_ABN =
  process.env.AMAX_LICENSEE_ABN?.trim() || "ABN [PLACEHOLDER]";
const AMAX_LICENSEE_ADDRESS =
  process.env.AMAX_LICENSEE_ADDRESS?.trim() ||
  "[Registered office address — PLACEHOLDER, see compliance]";
const AMAX_LICENSEE_CONTACT =
  process.env.AMAX_LICENSEE_CONTACT?.trim() ||
  "[Compliance contact — PLACEHOLDER, see compliance]";

function isLicenseeDisclosurePending(): boolean {
  return (
    AMAX_LICENSEE_AFSL.includes("PLACEHOLDER") ||
    AMAX_LICENSEE_ABN.includes("PLACEHOLDER") ||
    AMAX_LICENSEE_ADDRESS.includes("PLACEHOLDER") ||
    AMAX_LICENSEE_CONTACT.includes("PLACEHOLDER")
  );
}

// -----------------------------------------------------------------------------
// Standardised AMAX consent legal language.
// -----------------------------------------------------------------------------
const AMAX_CONSENT_LEGAL_PARAGRAPHS = [
  "I authorise AMAX Wealth Pty Ltd (the licensee) and my adviser to deduct the fees described in this document from the nominated account on the schedule shown above. I confirm that I have read, understood and agreed to the fees, the basis on which they are calculated, and the frequency at which they will be deducted.",
  "I acknowledge that this consent is given in connection with ongoing personal advice provided to me. I understand that under the Corporations Act 2001 (Cth) and ASIC Regulatory Guide 175 my consent must be renewed at least every twelve months and that no fee may be deducted after the consent expiry date shown above unless I provide a fresh written consent.",
  "I may withdraw this consent at any time by notifying my adviser or the licensee in writing. Withdrawal takes effect from the next scheduled deduction following receipt of the notice. Fees already deducted in accordance with this consent prior to withdrawal will not be refunded automatically.",
  "I acknowledge that this consent does not authorise the licensee or my adviser to deduct any fee that has not been clearly described in this document, and that any change to the fee type, amount, calculation method or frequency requires a fresh written consent.",
  "I confirm that I have been given a Statement of Advice (or Record of Advice as applicable) and a Financial Services Guide that disclose the fees described in this document, and that I have had the opportunity to ask my adviser any questions I had about them before signing.",
];

// -----------------------------------------------------------------------------
// Formatters
// -----------------------------------------------------------------------------
function fmtDate(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (!(v instanceof Date) && typeof v !== "string" && typeof v !== "number") {
    return "—";
  }
  try {
    return new Date(v).toLocaleString("en-AU", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(v);
  }
}

function fmtUtcStamp(v: Date | string | null | undefined): string {
  if (!v) return "—";
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function fmtFeeAmount(amountType: string, amount: string | number | null): string {
  if (amount === null || amount === undefined || amount === "") return "—";
  const s = String(amount);
  if (amountType === "percentage") return `${s}%`;
  if (amountType === "calculation_method") return s;
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });
}

// -----------------------------------------------------------------------------
// Drawing helpers (chrome, sections, KV pairs, signature box, appendix).
// -----------------------------------------------------------------------------
function drawConsentChromeText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  options: PDFKit.Mixins.TextOptions,
): void {
  const margins = doc.page.margins;
  const saved = { top: margins.top, bottom: margins.bottom };
  margins.top = 0;
  margins.bottom = 0;
  try {
    doc.text(text, x, y, { lineBreak: false, ...options });
  } finally {
    margins.top = saved.top;
    margins.bottom = saved.bottom;
  }
}

function drawConsentDraftWatermark(doc: PDFKit.PDFDocument): void {
  if (!isLicenseeDisclosurePending()) return;
  doc.save();
  doc.opacity(0.10);
  doc.fillColor("#b91c1c").fontSize(72).font("Helvetica-Bold");
  doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
  doc.text(
    "DRAFT — PLACEHOLDER LICENSEE DISCLOSURE",
    0,
    doc.page.height / 2 - 36,
    {
      width: doc.page.width,
      align: "center",
      lineBreak: false,
    },
  );
  doc.restore();
}

function drawConsentDraftFooterDisclaimer(doc: PDFKit.PDFDocument): void {
  if (!isLicenseeDisclosurePending()) return;
  const left = 50;
  const right = doc.page.width - 50;
  const y = doc.page.height - 62;
  drawConsentChromeText(
    doc,
    "DRAFT — Licensee AFSL / ABN / address / contact are PLACEHOLDER values; do not distribute to clients or regulators until compliance-approved values are configured (set AMAX_LICENSEE_AFSL, AMAX_LICENSEE_ABN, AMAX_LICENSEE_ADDRESS, AMAX_LICENSEE_CONTACT).",
    left,
    y,
    {
      width: right - left,
      align: "center",
    },
  );
}

function drawConsentLetterhead(
  doc: PDFKit.PDFDocument,
  documentRef: string,
): void {
  const left = 50;
  const right = doc.page.width - 50;
  const yTop = 28;
  doc.save();
  doc.fillColor("#0f172a").fontSize(13).font("Helvetica-Bold");
  drawConsentChromeText(doc, AMAX_PLATFORM_NAME.toUpperCase(), left, yTop, {});
  doc.fillColor("#475569").fontSize(8).font("Helvetica");
  drawConsentChromeText(
    doc,
    `${AMAX_LICENSEE_NAME} · ${AMAX_LICENSEE_AFSL} · ${AMAX_LICENSEE_ABN}`,
    left,
    yTop + 16,
    {},
  );
  doc.fillColor("#0f172a").fontSize(9).font("Helvetica-Bold");
  drawConsentChromeText(doc, documentRef, left, yTop, {
    width: right - left,
    align: "right",
  });
  doc.fillColor("#64748b").fontSize(8).font("Helvetica");
  drawConsentChromeText(doc, "Fee Consent Document", left, yTop + 14, {
    width: right - left,
    align: "right",
  });
  doc
    .moveTo(left, yTop + 32)
    .lineTo(right, yTop + 32)
    .strokeColor("#cbd5e1")
    .lineWidth(0.6)
    .stroke();
  doc.restore();
}

function drawConsentFooter(
  doc: PDFKit.PDFDocument,
  pageNum: number,
  pageCount: number,
  generatedAt: Date,
): void {
  const left = 50;
  const right = doc.page.width - 50;
  const y = doc.page.height - 48;
  doc.save();
  doc
    .moveTo(left, y)
    .lineTo(right, y)
    .strokeColor("#cbd5e1")
    .lineWidth(0.5)
    .stroke();
  doc.fillColor("#64748b").fontSize(7.5).font("Helvetica");
  drawConsentChromeText(
    doc,
    `${AMAX_LICENSEE_NAME} · ${AMAX_LICENSEE_ADDRESS}`,
    left,
    y + 6,
    { width: right - left, align: "left" },
  );
  drawConsentChromeText(doc, AMAX_LICENSEE_CONTACT, left, y + 16, {
    width: right - left,
    align: "left",
  });
  drawConsentChromeText(doc, `Page ${pageNum} of ${pageCount}`, left, y + 6, {
    width: right - left,
    align: "right",
  });
  drawConsentChromeText(
    doc,
    `Generated ${fmtUtcStamp(generatedAt)}`,
    left,
    y + 16,
    { width: right - left, align: "right" },
  );
  doc.restore();
}

function drawConsentSectionHeading(
  doc: PDFKit.PDFDocument,
  title: string,
): void {
  if (doc.y > doc.page.height - 140) doc.addPage();
  doc.moveDown(0.4);
  doc.x = 50;
  doc
    .fillColor("#0f172a")
    .fontSize(11)
    .font("Helvetica-Bold")
    .text(title, 50, doc.y);
  doc
    .moveTo(50, doc.y + 2)
    .lineTo(doc.page.width - 50, doc.y + 2)
    .strokeColor("#cbd5e1")
    .lineWidth(0.4)
    .stroke();
  doc.x = 50;
  doc.moveDown(0.3);
}

function drawConsentKvPairs(
  doc: PDFKit.PDFDocument,
  rows: Array<[string, string]>,
): void {
  const left = 50;
  const labelWidth = 160;
  const valueLeft = left + labelWidth + 10;
  const valueWidth = doc.page.width - 50 - valueLeft;
  doc.fillColor("#0f172a").fontSize(9.5).font("Helvetica");
  for (const [label, value] of rows) {
    if (doc.y > doc.page.height - 90) doc.addPage();
    const startY = doc.y;
    doc
      .fillColor("#475569")
      .font("Helvetica-Bold")
      .text(label, left, startY, { width: labelWidth, lineBreak: false });
    doc
      .fillColor("#0f172a")
      .font("Helvetica")
      .text(value || "—", valueLeft, startY, { width: valueWidth });
    doc.moveDown(0.15);
  }
}

function drawConsentLegalBlock(doc: PDFKit.PDFDocument): void {
  drawConsentSectionHeading(doc, "Authority and acknowledgements");
  doc.fillColor("#1e293b").fontSize(9).font("Helvetica");
  AMAX_CONSENT_LEGAL_PARAGRAPHS.forEach((p, i) => {
    if (doc.y > doc.page.height - 110) doc.addPage();
    doc.text(`${i + 1}. ${p}`, 50, doc.y, {
      width: doc.page.width - 100,
      align: "justify",
    });
    doc.moveDown(0.4);
  });
}

function drawConsentSignatureBox(
  doc: PDFKit.PDFDocument,
  signature: { name: string; signedAt: Date | null; ipAddress: string | null } | null,
): void {
  drawConsentSectionHeading(doc, "Client signature");
  const left = 50;
  const right = doc.page.width - 50;
  const boxTop = doc.y + 4;
  const boxHeight = 110;
  if (boxTop + boxHeight > doc.page.height - 90) {
    doc.addPage();
  }
  const top = doc.y + 4;
  doc.save();
  doc
    .roundedRect(left, top, right - left, boxHeight, 4)
    .strokeColor("#94a3b8")
    .lineWidth(0.8)
    .stroke();

  if (signature) {
    doc
      .fillColor("#0f172a")
      .fontSize(20)
      .font("Helvetica-Oblique")
      .text(signature.name, left + 16, top + 16, {
        width: right - left - 32,
        lineBreak: false,
      });
    doc
      .fillColor("#64748b")
      .fontSize(8)
      .font("Helvetica")
      .text(
        "Electronic signature captured by AMAX Wealth client portal.",
        left + 16,
        top + 50,
        { width: right - left - 32, lineBreak: false },
      );

    const detailsTop = top + boxHeight - 38;
    const colWidth = (right - left - 32) / 3;
    doc
      .fillColor("#475569")
      .fontSize(7.5)
      .font("Helvetica-Bold")
      .text("SIGNED BY", left + 16, detailsTop, { width: colWidth, lineBreak: false });
    doc
      .fillColor("#0f172a")
      .fontSize(9)
      .font("Helvetica")
      .text(signature.name, left + 16, detailsTop + 10, {
        width: colWidth,
        lineBreak: false,
      });

    doc
      .fillColor("#475569")
      .fontSize(7.5)
      .font("Helvetica-Bold")
      .text("SIGNED AT", left + 16 + colWidth, detailsTop, {
        width: colWidth,
        lineBreak: false,
      });
    doc
      .fillColor("#0f172a")
      .fontSize(9)
      .font("Helvetica")
      .text(fmtUtcStamp(signature.signedAt), left + 16 + colWidth, detailsTop + 10, {
        width: colWidth,
        lineBreak: false,
      });

    doc
      .fillColor("#475569")
      .fontSize(7.5)
      .font("Helvetica-Bold")
      .text("FROM IP ADDRESS", left + 16 + colWidth * 2, detailsTop, {
        width: colWidth,
        lineBreak: false,
      });
    doc
      .fillColor("#0f172a")
      .fontSize(9)
      .font("Helvetica")
      .text(signature.ipAddress ?? "—", left + 16 + colWidth * 2, detailsTop + 10, {
        width: colWidth,
        lineBreak: false,
      });
  } else {
    doc
      .fillColor("#94a3b8")
      .fontSize(11)
      .font("Helvetica-Oblique")
      .text("Awaiting client signature", left + 16, top + boxHeight / 2 - 6, {
        width: right - left - 32,
        align: "center",
        lineBreak: false,
      });
  }
  doc.restore();
  doc.y = top + boxHeight + 6;
}

const CONSENT_APPENDIX_AUDIT_CAP = 500;

function drawConsentAuditAppendix(
  doc: PDFKit.PDFDocument,
  chain: Array<{ ref: string; label: string; status: string; when: Date | null }>,
  events: Array<{
    when: Date | null;
    action: string;
    actorUserId: number | null;
    ipAddress: string | null;
    summary: string;
  }>,
  eventsTruncated: boolean,
): void {
  doc.addPage();
  doc.fillColor("#0f172a").fontSize(14).font("Helvetica-Bold").text("Audit Appendix");
  doc.moveDown(0.2);
  doc
    .fillColor("#64748b")
    .fontSize(9)
    .font("Helvetica")
    .text(
      "Supersede chain and lifecycle events for this consent artefact. " +
        "Sourced from the platform audit log; values are immutable once written.",
    );
  doc.moveDown(0.5);

  drawConsentSectionHeading(doc, "Supersede chain");
  if (chain.length === 0) {
    doc
      .fillColor("#64748b")
      .fontSize(9)
      .font("Helvetica-Oblique")
      .text("No supersede chain — this is a standalone consent artefact.", 50, doc.y);
    doc.moveDown(0.4);
  } else {
    const left = 50;
    const right = doc.page.width - 50;
    const cols = [70, 100, 120, right - left - 290];
    const headers = ["Reference", "Status", "When", "Role in chain"];
    let y = doc.y;
    doc.fillColor("#475569").fontSize(8.5).font("Helvetica-Bold");
    let x = left;
    headers.forEach((h, i) => {
      doc.text(h, x, y, { width: cols[i], lineBreak: false });
      x += cols[i];
    });
    doc
      .moveTo(left, y + 12)
      .lineTo(right, y + 12)
      .strokeColor("#cbd5e1")
      .lineWidth(0.4)
      .stroke();
    y += 16;
    doc.fillColor("#0f172a").fontSize(9).font("Helvetica");
    for (const link of chain) {
      if (y > doc.page.height - 100) {
        doc.addPage();
        y = 96;
      }
      x = left;
      doc.text(link.ref, x, y, { width: cols[0], lineBreak: false });
      x += cols[0];
      doc.text(link.status, x, y, { width: cols[1], lineBreak: false });
      x += cols[1];
      doc.text(fmtUtcStamp(link.when), x, y, { width: cols[2], lineBreak: false });
      x += cols[2];
      doc.text(link.label, x, y, { width: cols[3] });
      y += 14;
    }
    doc.y = y + 4;
  }

  drawConsentSectionHeading(doc, "Lifecycle events");
  if (events.length === 0) {
    doc
      .fillColor("#64748b")
      .fontSize(9)
      .font("Helvetica-Oblique")
      .text("No lifecycle audit events recorded for this artefact.", 50, doc.y);
    doc.moveDown(0.4);
    return;
  }
  const left = 50;
  const right = doc.page.width - 50;
  const cols = [120, 170, 70, right - left - 360];
  const headers = ["When (UTC)", "Action", "Actor", "Detail"];
  let y = doc.y;
  doc.fillColor("#475569").fontSize(8.5).font("Helvetica-Bold");
  let x = left;
  headers.forEach((h, i) => {
    doc.text(h, x, y, { width: cols[i], lineBreak: false });
    x += cols[i];
  });
  doc
    .moveTo(left, y + 12)
    .lineTo(right, y + 12)
    .strokeColor("#cbd5e1")
    .lineWidth(0.4)
    .stroke();
  y += 16;
  doc.fillColor("#0f172a").fontSize(8.5).font("Helvetica");
  for (const e of events) {
    const detail = `${e.summary}${e.ipAddress ? ` · IP ${e.ipAddress}` : ""}`;
    const detailH = doc.heightOfString(detail, { width: cols[3] });
    const rowH = Math.max(14, detailH + 4);
    if (y + rowH > doc.page.height - 90) {
      doc.addPage();
      y = 96;
    }
    x = left;
    doc.text(fmtUtcStamp(e.when), x, y, { width: cols[0], lineBreak: false });
    x += cols[0];
    doc.text(e.action, x, y, { width: cols[1], lineBreak: false });
    x += cols[1];
    doc.text(
      e.actorUserId === null ? "system" : `#${e.actorUserId}`,
      x,
      y,
      { width: cols[2], lineBreak: false },
    );
    x += cols[2];
    doc.text(detail, x, y, { width: cols[3] });
    y += rowH;
  }
  doc.y = y;
  if (eventsTruncated) {
    doc.moveDown(0.4);
    doc.x = 50;
    doc
      .fillColor("#b91c1c")
      .fontSize(8.5)
      .font("Helvetica-Bold")
      .text(
        `Note: appendix truncated at ${CONSENT_APPENDIX_AUDIT_CAP} entries. ` +
          "Older events exist in the audit log; export the audit log directly " +
          "for the full history.",
        50,
        doc.y,
        { width: doc.page.width - 100 },
      );
  }
}

// -----------------------------------------------------------------------------
// Supersede-chain walker (DFS-with-memo across both link types).
// -----------------------------------------------------------------------------
async function buildConsentSupersedeChain(opts: {
  kind: "consent" | "request";
  id: number;
}): Promise<{
  chain: Array<{ ref: string; label: string; status: string; when: Date | null }>;
  requestIds: number[];
  consentIds: number[];
}> {
  const requestIds = new Set<number>();
  const consentIds = new Set<number>();

  async function visitRequest(id: number): Promise<void> {
    if (requestIds.has(id)) return;
    requestIds.add(id);
    const [row] = await db
      .select()
      .from(feeConsentRequests)
      .where(eq(feeConsentRequests.id, id))
      .limit(1);
    if (!row) return;
    if (row.supersedesRequestId) await visitRequest(row.supersedesRequestId);
    if (row.signedFeeConsentId) await visitConsent(row.signedFeeConsentId);
  }

  async function visitConsent(id: number): Promise<void> {
    if (consentIds.has(id)) return;
    consentIds.add(id);
    const [row] = await db
      .select()
      .from(feeConsents)
      .where(eq(feeConsents.id, id))
      .limit(1);
    if (!row) return;
    const [signingReq] = await db
      .select({ id: feeConsentRequests.id })
      .from(feeConsentRequests)
      .where(eq(feeConsentRequests.signedFeeConsentId, id))
      .limit(1);
    if (signingReq) await visitRequest(signingReq.id);
    if (row.supersededByRequestId) await visitRequest(row.supersededByRequestId);
  }

  if (opts.kind === "request") await visitRequest(opts.id);
  else await visitConsent(opts.id);

  const requestIdList = Array.from(requestIds);
  const consentIdList = Array.from(consentIds);
  const reqRows =
    requestIdList.length > 0
      ? await db
          .select()
          .from(feeConsentRequests)
          .where(inArray(feeConsentRequests.id, requestIdList))
      : [];
  const conRows =
    consentIdList.length > 0
      ? await db
          .select()
          .from(feeConsents)
          .where(inArray(feeConsents.id, consentIdList))
      : [];

  type Entry = {
    ref: string;
    label: string;
    status: string;
    when: Date | null;
    sortKey: number;
  };
  const entries: Entry[] = [];
  for (const r of reqRows) {
    const isAudit = opts.kind === "request" && r.id === opts.id;
    entries.push({
      ref: `FCR-${r.id}`,
      status: r.status,
      when: r.createdAt,
      label: isAudit
        ? "Fee consent request (THIS DOCUMENT)"
        : `Fee consent request · ${r.feeType}`,
      sortKey: r.createdAt?.getTime() ?? 0,
    });
  }
  for (const c of conRows) {
    const isAudit = opts.kind === "consent" && c.id === opts.id;
    entries.push({
      ref: `FC-${c.id}`,
      status: c.renewalStatus,
      when: c.consentedAt,
      label: isAudit
        ? "Signed consent (THIS DOCUMENT)"
        : `Signed consent · ${c.feeType}`,
      sortKey: c.consentedAt?.getTime() ?? 0,
    });
  }
  entries.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
    return a.ref.startsWith("FCR-") && b.ref.startsWith("FC-")
      ? -1
      : a.ref.startsWith("FC-") && b.ref.startsWith("FCR-")
        ? 1
        : 0;
  });

  return {
    chain: entries.map(({ sortKey, ...rest }) => rest),
    requestIds: requestIdList,
    consentIds: consentIdList,
  };
}

function summariseConsentAuditAction(
  action: string,
  metadata: unknown,
): string {
  const md = (metadata && typeof metadata === "object" ? metadata : {}) as Record<
    string,
    unknown
  >;
  switch (action) {
    case "fee_consent_requested":
      return "Adviser requested a new fee consent from the client";
    case "fee_consent_signed":
      return `Client signed the consent${md.signatureName ? ` (${String(md.signatureName)})` : ""}`;
    case "fee_consent_created":
      return "Executed fee consent record created from the signed request";
    case "fee_consent_declined":
      return `Client declined the request${md.reason ? ` — ${String(md.reason)}` : ""}`;
    case "fee_consent_request_withdrawn":
      return `Adviser withdrew the request${md.reason ? ` — ${String(md.reason)}` : ""}`;
    case "fee_consent_request_revoked_by_admin":
      return `Admin revoked the pending request${md.reason ? ` — ${String(md.reason)}` : ""}`;
    case "fee_consent_superseded_by_admin":
      return `Admin superseded the live consent${md.reason ? ` — ${String(md.reason)}` : ""}`;
    case "fee_consent_request_created_by_admin_supersede":
      return "Admin created a replacement request as part of a supersede";
    case "fee_consent_request_pdf_exported":
    case "fee_consent_pdf_exported":
      return "Admin downloaded the consent PDF for record-keeping";
    case "fee_consent_request_pdf_exported_by_client":
    case "fee_consent_pdf_exported_by_client":
      return "Client downloaded their own copy of the consent PDF";
    default:
      return action;
  }
}

async function loadConsentAuditEvents(opts: {
  requestIds: number[];
  consentIds: number[];
}): Promise<{
  events: Array<{
    when: Date | null;
    action: string;
    actorUserId: number | null;
    ipAddress: string | null;
    summary: string;
  }>;
  truncated: boolean;
}> {
  if (opts.requestIds.length === 0 && opts.consentIds.length === 0) {
    return { events: [], truncated: false };
  }
  const conds: SQL[] = [];
  if (opts.requestIds.length > 0) {
    conds.push(
      and(
        eq(auditLogs.entityType, "fee_consent_request"),
        inArray(auditLogs.entityId, opts.requestIds.map(String)),
      )!,
    );
  }
  if (opts.consentIds.length > 0) {
    conds.push(
      and(
        eq(auditLogs.entityType, "fee_consent"),
        inArray(auditLogs.entityId, opts.consentIds.map(String)),
      )!,
    );
  }
  const where = conds.length === 1 ? conds[0] : or(...conds)!;
  const rows = await db
    .select({
      action: auditLogs.action,
      userId: auditLogs.userId,
      ipAddress: auditLogs.ipAddress,
      createdAt: auditLogs.createdAt,
      metadata: auditLogs.metadata,
    })
    .from(auditLogs)
    .where(where)
    .orderBy(asc(auditLogs.createdAt))
    .limit(CONSENT_APPENDIX_AUDIT_CAP + 1);
  const truncated = rows.length > CONSENT_APPENDIX_AUDIT_CAP;
  const kept = truncated ? rows.slice(0, CONSENT_APPENDIX_AUDIT_CAP) : rows;
  return {
    events: kept.map((r) => ({
      when: r.createdAt,
      action: r.action,
      actorUserId: r.userId,
      ipAddress: r.ipAddress,
      summary: summariseConsentAuditAction(r.action, r.metadata),
    })),
    truncated,
  };
}

// -----------------------------------------------------------------------------
// Renderer
// -----------------------------------------------------------------------------
interface ConsentPdfData {
  documentRef: string;
  documentTitle: string;
  isSigned: boolean;
  status: string;
  generatedAt: Date;
  exportedByUserId: number;
  parties: {
    adviserUserId: number | null;
    adviserUsername: string;
    adviserAfsl: string | null;
    adviserAuthRep: string | null;
    clientUserId: number;
    clientUsername: string;
    adviceRecordId: number | null;
  };
  feeTerms: {
    feeType: string;
    amountType: string;
    amount: string | null;
    calculationMethod: string | null;
    accountNumber: string;
    accountName: string | null;
    deductionFrequency: string;
    referenceDay: Date | null;
    renewalWindowStart: Date | null;
    renewalWindowEnd: Date | null;
    consentExpiryDate: Date | null;
  };
  signature: { name: string; signedAt: Date | null; ipAddress: string | null } | null;
  requestNote: string | null;
  declineReason: string | null;
  lifecycle: Array<[string, string]>;
  chain: Array<{ ref: string; label: string; status: string; when: Date | null }>;
  auditEvents: Array<{
    when: Date | null;
    action: string;
    actorUserId: number | null;
    ipAddress: string | null;
    summary: string;
  }>;
  auditEventsTruncated: boolean;
}

function renderConsentPdf(data: ConsentPdfData): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    try {
      const PDFDocument = (await import("pdfkit")).default;
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 80, bottom: 70, left: 50, right: 50 },
        bufferPages: true,
        info: {
          Title: `${data.documentTitle} ${data.documentRef}`,
          Author: `${AMAX_LICENSEE_NAME} (${AMAX_LICENSEE_AFSL})`,
          Subject: data.isSigned
            ? "Signed fee consent"
            : "Fee consent request (pre-signature)",
        },
      });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc
        .fillColor("#0f172a")
        .fontSize(16)
        .font("Helvetica-Bold")
        .text(data.documentTitle);
      doc
        .fillColor("#64748b")
        .fontSize(9.5)
        .font("Helvetica")
        .text(`Document reference: ${data.documentRef} · Status: ${data.status}`);
      doc
        .fillColor("#64748b")
        .fontSize(9.5)
        .font("Helvetica")
        .text(
          `Generated ${fmtUtcStamp(data.generatedAt)} · Exported by user #${data.exportedByUserId}`,
        );
      doc.moveDown(0.5);

      drawConsentSectionHeading(doc, "Parties");
      drawConsentKvPairs(doc, [
        ["Licensee", `${AMAX_LICENSEE_NAME} (${AMAX_LICENSEE_AFSL})`],
        [
          "Adviser (Authorised Rep.)",
          `${data.parties.adviserUsername}` +
            (data.parties.adviserUserId !== null
              ? ` (user #${data.parties.adviserUserId})`
              : "") +
            (data.parties.adviserAuthRep ? ` · AR ${data.parties.adviserAuthRep}` : "") +
            (data.parties.adviserAfsl && data.parties.adviserAfsl !== AMAX_LICENSEE_AFSL
              ? ` · ${data.parties.adviserAfsl}`
              : ""),
        ],
        [
          "Client",
          `${data.parties.clientUsername} (user #${data.parties.clientUserId})`,
        ],
        [
          "Linked advice record",
          data.parties.adviceRecordId
            ? `#${data.parties.adviceRecordId}`
            : "— (legacy, pre-Task #293)",
        ],
      ]);

      drawConsentSectionHeading(doc, "Fee terms");
      drawConsentKvPairs(doc, [
        ["Fee type", data.feeTerms.feeType],
        ["Amount type", data.feeTerms.amountType],
        ["Amount", fmtFeeAmount(data.feeTerms.amountType, data.feeTerms.amount)],
        ["Calculation method", data.feeTerms.calculationMethod ?? "—"],
        [
          "Nominated account",
          `${data.feeTerms.accountNumber}` +
            (data.feeTerms.accountName ? ` (${data.feeTerms.accountName})` : ""),
        ],
        ["Deduction frequency", data.feeTerms.deductionFrequency],
        ["Reference day", fmtDate(data.feeTerms.referenceDay)],
        [
          "Renewal window",
          `${fmtDate(data.feeTerms.renewalWindowStart)}  →  ${fmtDate(data.feeTerms.renewalWindowEnd)}`,
        ],
        ["Consent expiry", fmtDate(data.feeTerms.consentExpiryDate)],
      ]);

      if (data.requestNote) {
        drawConsentSectionHeading(doc, "Adviser note to client");
        doc
          .fillColor("#0f172a")
          .fontSize(9.5)
          .font("Helvetica")
          .text(data.requestNote, 50, doc.y, {
            width: doc.page.width - 100,
            align: "left",
          });
        doc.moveDown(0.3);
      }

      drawConsentLegalBlock(doc);
      drawConsentSignatureBox(doc, data.signature);

      if (data.declineReason) {
        drawConsentSectionHeading(doc, "Decline reason");
        doc
          .fillColor("#0f172a")
          .fontSize(9.5)
          .font("Helvetica")
          .text(data.declineReason, 50, doc.y, {
            width: doc.page.width - 100,
            align: "left",
          });
        doc.moveDown(0.3);
      }

      if (data.lifecycle.length > 0) {
        drawConsentSectionHeading(doc, "Lifecycle");
        drawConsentKvPairs(doc, data.lifecycle);
      }

      drawConsentAuditAppendix(
        doc,
        data.chain,
        data.auditEvents,
        data.auditEventsTruncated,
      );

      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        drawConsentDraftWatermark(doc);
        drawConsentLetterhead(doc, data.documentRef);
        drawConsentFooter(doc, i - range.start + 1, range.count, data.generatedAt);
        drawConsentDraftFooterDisclaimer(doc);
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// -----------------------------------------------------------------------------
// High-level entry points consumed by routes.
// -----------------------------------------------------------------------------
export interface ConsentPdfArtefact {
  buf: Buffer;
  filename: string;
  clientUserId: number;
  adviserUserId: number | null;
  downloadedAtUtc: Date;
}

interface BuildOpts {
  id: number;
  exportedByUserId: number;
  // Watermark "purpose" string shown in the per-download footer; mirrors the
  // existing admin paths ("fee_consent_request_download" /
  // "fee_consent_download"). Client routes pass the same purpose so the
  // footer reads the same regardless of which surface generated it.
  purpose: WatermarkPurpose;
  // Optional ownership gate. When provided, the row's clientUserId / clientId
  // must equal this value or a 403 is thrown. The client-facing routes pass
  // req.userId here so the guarantee matches the ownership boundary the
  // existing list endpoints already enforce (see server/client-fee-consents.test.ts).
  requireOwnerUserId?: number;
}

function makeError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

export async function buildFeeConsentRequestPdf(
  opts: BuildOpts,
): Promise<ConsentPdfArtefact> {
  const [row] = await db
    .select()
    .from(feeConsentRequests)
    .where(eq(feeConsentRequests.id, opts.id))
    .limit(1);
  if (!row) {
    throw makeError(404, "Fee consent request not found");
  }
  if (
    opts.requireOwnerUserId !== undefined &&
    row.clientUserId !== opts.requireOwnerUserId
  ) {
    throw makeError(403, "Not your fee consent request");
  }

  const [adviser, client, adviserProfile] = await Promise.all([
    db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, row.adviserUserId))
      .limit(1),
    db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, row.clientUserId))
      .limit(1),
    db
      .select({
        afslNumber: adviserProfiles.afslNumber,
        authorisedRepNumber: adviserProfiles.authorisedRepNumber,
      })
      .from(adviserProfiles)
      .where(eq(adviserProfiles.userId, row.adviserUserId))
      .limit(1),
  ]);

  const { chain, requestIds, consentIds } = await buildConsentSupersedeChain({
    kind: "request",
    id: row.id,
  });
  const auditResult = await loadConsentAuditEvents({ requestIds, consentIds });
  const generatedAt = new Date();

  let signature: ConsentPdfData["signature"] = null;
  if (row.signedFeeConsentId) {
    const [signedConsent] = await db
      .select({
        clientSignatureName: feeConsents.clientSignatureName,
        consentedAt: feeConsents.consentedAt,
      })
      .from(feeConsents)
      .where(eq(feeConsents.id, row.signedFeeConsentId))
      .limit(1);
    const [ipRow] = await db
      .select({ ipAddress: auditLogs.ipAddress })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "fee_consent"),
          eq(auditLogs.entityId, String(row.signedFeeConsentId)),
          eq(auditLogs.action, "fee_consent_created"),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    if (signedConsent) {
      signature = {
        name: signedConsent.clientSignatureName,
        signedAt: signedConsent.consentedAt,
        ipAddress: ipRow?.ipAddress ?? null,
      };
    }
  }

  const buf = await renderConsentPdf({
    documentRef: `FCR-${row.id}`,
    documentTitle: "AMAX Wealth — Fee Consent Request",
    isSigned: !!row.signedFeeConsentId,
    status: row.status,
    generatedAt,
    exportedByUserId: opts.exportedByUserId,
    parties: {
      adviserUserId: row.adviserUserId,
      adviserUsername: adviser[0]?.username ?? "—",
      adviserAfsl: adviserProfile[0]?.afslNumber ?? null,
      adviserAuthRep: adviserProfile[0]?.authorisedRepNumber ?? null,
      clientUserId: row.clientUserId,
      clientUsername: client[0]?.username ?? "—",
      adviceRecordId: row.adviceRecordId,
    },
    feeTerms: {
      feeType: row.feeType,
      amountType: row.amountType,
      amount: row.amount === null ? null : String(row.amount),
      calculationMethod: row.calculationMethod,
      accountNumber: row.accountNumber,
      accountName: row.accountName,
      deductionFrequency: row.deductionFrequency,
      referenceDay: row.proposedReferenceDay,
      renewalWindowStart: row.proposedRenewalWindowStart,
      renewalWindowEnd: row.proposedRenewalWindowEnd,
      consentExpiryDate: row.proposedConsentExpiryDate,
    },
    signature,
    requestNote: row.requestNote,
    declineReason: row.declineReason,
    lifecycle: [
      ["Request created", fmtDate(row.createdAt)],
      ["Client responded", fmtDate(row.respondedAt)],
      [
        "Signed → consent",
        row.signedFeeConsentId ? `FC-${row.signedFeeConsentId}` : "—",
      ],
      [
        "Supersedes prior request",
        row.supersedesRequestId ? `FCR-${row.supersedesRequestId}` : "—",
      ],
    ],
    chain,
    auditEvents: auditResult.events,
    auditEventsTruncated: auditResult.truncated,
  });

  const downloadedAtUtc = new Date();
  const names = await resolveWatermarkNames(row.clientUserId, row.adviserUserId);
  const watermarked = await applyDocumentWatermark(buf, {
    clientName: names.clientName,
    adviserName: names.adviserName,
    downloadedAtUtc,
    purpose: opts.purpose,
  });

  return {
    buf: watermarked,
    filename: `amax-fee-consent-request-${row.id}.pdf`,
    clientUserId: row.clientUserId,
    adviserUserId: row.adviserUserId,
    downloadedAtUtc,
  };
}

export async function buildFeeConsentPdf(
  opts: BuildOpts,
): Promise<ConsentPdfArtefact> {
  const [row] = await db
    .select()
    .from(feeConsents)
    .where(eq(feeConsents.id, opts.id))
    .limit(1);
  if (!row) {
    throw makeError(404, "Fee consent not found");
  }
  if (
    opts.requireOwnerUserId !== undefined &&
    row.clientId !== opts.requireOwnerUserId
  ) {
    throw makeError(403, "Not your fee consent");
  }

  const [adviser, client, adviserProfile] = await Promise.all([
    row.adviserId
      ? db
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, row.adviserId))
          .limit(1)
      : Promise.resolve([]),
    db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, row.clientId))
      .limit(1),
    row.adviserId
      ? db
          .select({
            afslNumber: adviserProfiles.afslNumber,
            authorisedRepNumber: adviserProfiles.authorisedRepNumber,
          })
          .from(adviserProfiles)
          .where(eq(adviserProfiles.userId, row.adviserId))
          .limit(1)
      : Promise.resolve([]),
  ]);

  const [ipRow] = await db
    .select({ ipAddress: auditLogs.ipAddress })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.entityType, "fee_consent"),
        eq(auditLogs.entityId, String(row.id)),
        eq(auditLogs.action, "fee_consent_created"),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);

  const { chain, requestIds, consentIds } = await buildConsentSupersedeChain({
    kind: "consent",
    id: row.id,
  });
  const auditResult = await loadConsentAuditEvents({ requestIds, consentIds });
  const generatedAt = new Date();

  const buf = await renderConsentPdf({
    documentRef: `FC-${row.id}`,
    documentTitle: "AMAX Wealth — Fee Consent",
    isSigned: true,
    status: row.renewalStatus,
    generatedAt,
    exportedByUserId: opts.exportedByUserId,
    parties: {
      adviserUserId: row.adviserId,
      adviserUsername: adviser[0]?.username ?? "—",
      adviserAfsl: adviserProfile[0]?.afslNumber ?? null,
      adviserAuthRep: adviserProfile[0]?.authorisedRepNumber ?? null,
      clientUserId: row.clientId,
      clientUsername: client[0]?.username ?? "—",
      adviceRecordId: row.adviceRecordId,
    },
    feeTerms: {
      feeType: row.feeType,
      amountType: row.amountType,
      amount: row.amount === null ? null : String(row.amount),
      calculationMethod: row.calculationMethod,
      accountNumber: row.accountNumber,
      accountName: row.accountName,
      deductionFrequency: row.deductionFrequency,
      referenceDay: row.referenceDay,
      renewalWindowStart: row.renewalWindowStart,
      renewalWindowEnd: row.renewalWindowEnd,
      consentExpiryDate: row.consentExpiryDate,
    },
    signature: {
      name: row.clientSignatureName,
      signedAt: row.consentedAt,
      ipAddress: ipRow?.ipAddress ?? null,
    },
    requestNote: null,
    declineReason: null,
    lifecycle: [
      ["Consent signed", fmtDate(row.consentedAt)],
      ["Withdrawn at", fmtDate(row.withdrawnAt)],
      [
        "Superseded by request",
        row.supersededByRequestId ? `FCR-${row.supersededByRequestId}` : "—",
      ],
      ["Superseded at", fmtDate(row.supersededAt)],
      ["Superseded reason", row.supersededReason ?? "—"],
    ],
    chain,
    auditEvents: auditResult.events,
    auditEventsTruncated: auditResult.truncated,
  });

  const downloadedAtUtc = new Date();
  const names = await resolveWatermarkNames(row.clientId, row.adviserId ?? null);
  const watermarked = await applyDocumentWatermark(buf, {
    clientName: names.clientName,
    adviserName: names.adviserName,
    downloadedAtUtc,
    purpose: opts.purpose,
  });

  return {
    buf: watermarked,
    filename: `amax-fee-consent-${row.id}.pdf`,
    clientUserId: row.clientId,
    adviserUserId: row.adviserId,
    downloadedAtUtc,
  };
}
