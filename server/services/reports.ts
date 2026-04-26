import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { eq, desc, and } from "drizzle-orm";
import { db } from "../db";
import {
  reportRequests,
  users,
  userInvestments,
  investmentProducts,
  transactions,
  feeConsents,
  adviserClients,
} from "@shared/schema";
import { getUserCurrencyBalance } from "./ledger";

export const REPORTS_DIR = path.resolve(process.cwd(), ".local/reports");
const EXPIRY_DAYS = 30;
const TXN_LIMIT = 100;

export type ReportResult =
  | { status: "ready"; downloadUrl: string; filePath: string }
  | { status: "failed"; failureReason: string };

function ensureDir(): void {
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }
}

function fmtMoney(amount: string | number | null | undefined, currency = "AUD"): string {
  if (amount === null || amount === undefined) return "—";
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-AU", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-AU", { year: "numeric", month: "short", day: "2-digit" });
}

// ---------------------------------------------------------------------------
// Main entry. Loads the row, regenerates link enforcement (defense in depth),
// gathers data, streams a PDF to disk, and updates the row to ready/failed.
// Throws nothing; returns a tagged union the caller can audit.
// ---------------------------------------------------------------------------
export async function generateReportPdf(reportId: number): Promise<ReportResult> {
  ensureDir();

  // Load the request row
  const [row] = await db
    .select()
    .from(reportRequests)
    .where(eq(reportRequests.id, reportId))
    .limit(1);

  if (!row) {
    return { status: "failed", failureReason: "Report request not found" };
  }

  // Defense in depth: re-verify the adviser-client link still exists & is active.
  // This protects against a link being deactivated between request and generation.
  const [link] = await db
    .select()
    .from(adviserClients)
    .where(
      and(
        eq(adviserClients.adviserUserId, row.adviserUserId),
        eq(adviserClients.clientUserId, row.clientUserId),
        eq(adviserClients.isActive, true),
      ),
    )
    .limit(1);

  if (!link) {
    const failureReason = "Adviser-client link is not active";
    await db
      .update(reportRequests)
      .set({ status: "failed", failureReason })
      .where(eq(reportRequests.id, reportId));
    return { status: "failed", failureReason };
  }

  try {
    // Mark generating so the bell-icon notification can show progress
    await db
      .update(reportRequests)
      .set({ status: "generating" })
      .where(eq(reportRequests.id, reportId));

    // ---- Load client + data slices -------------------------------------------
    const [client] = await db
      .select()
      .from(users)
      .where(eq(users.id, row.clientUserId))
      .limit(1);

    if (!client) {
      throw new Error("Client user not found");
    }

    const wantsHoldings = row.reportType === "portfolio_summary" || row.reportType === "full_statement";
    const wantsTxns = row.reportType === "transaction_history" || row.reportType === "full_statement";
    const wantsFees = row.reportType === "fee_summary" || row.reportType === "full_statement";

    const holdings = wantsHoldings
      ? await db
          .select({
            productName: investmentProducts.name,
            productCategory: investmentProducts.category,
            investedAmount: userInvestments.investedAmount,
            currentValue: userInvestments.currentValue,
            totalReturn: userInvestments.totalReturn,
            returnPercent: userInvestments.returnPercent,
            status: userInvestments.status,
            investmentDate: userInvestments.investmentDate,
            maturityDate: userInvestments.maturityDate,
          })
          .from(userInvestments)
          .innerJoin(investmentProducts, eq(investmentProducts.id, userInvestments.productId))
          .where(eq(userInvestments.userId, row.clientUserId))
          .orderBy(desc(userInvestments.investmentDate))
      : [];

    // Cash balances are LEDGER-DERIVED (per Session 12 requirement). The
    // ledger is the single source of truth for cash; product current value
    // continues to come from `userInvestments` (product NAV is its own truth).
    const cashAud = wantsHoldings ? await getUserCurrencyBalance(row.clientUserId, "AUD") : "0";
    const cashUsd = wantsHoldings ? await getUserCurrencyBalance(row.clientUserId, "USD") : "0";

    const txns = wantsTxns
      ? await db
          .select()
          .from(transactions)
          .where(eq(transactions.userId, row.clientUserId))
          .orderBy(desc(transactions.createdAt))
          .limit(TXN_LIMIT)
      : [];

    const fees = wantsFees
      ? await db
          .select({
            id: feeConsents.id,
            feeType: feeConsents.feeType,
            amountType: feeConsents.amountType,
            amount: feeConsents.amount,
            deductionFrequency: feeConsents.deductionFrequency,
            consentedAt: feeConsents.consentedAt,
            consentExpiryDate: feeConsents.consentExpiryDate,
            renewalStatus: feeConsents.renewalStatus,
          })
          .from(feeConsents)
          .where(eq(feeConsents.clientId, row.clientUserId))
          .orderBy(desc(feeConsents.consentedAt))
      : [];

    // ---- Render PDF ----------------------------------------------------------
    const filePath = path.join(REPORTS_DIR, `${reportId}.pdf`);
    await renderPdf(filePath, {
      reportId,
      reportType: row.reportType,
      notes: row.notes,
      client: {
        firstName: client.firstName,
        lastName: client.lastName,
        email: client.email,
        kycStatus: client.kycStatus,
      },
      holdings,
      cashAud,
      cashUsd,
      txns,
      fees,
    });

    const generatedAt = new Date();
    const expiresAt = new Date(generatedAt.getTime() + EXPIRY_DAYS * 86_400_000);
    const downloadUrl = `/api/adviser/reports/${reportId}/download`;

    await db
      .update(reportRequests)
      .set({
        status: "ready",
        downloadUrl,
        generatedAt,
        expiresAt,
        failureReason: null,
      })
      .where(eq(reportRequests.id, reportId));

    return { status: "ready", downloadUrl, filePath };
  } catch (err) {
    const failureReason = err instanceof Error ? err.message : "Unknown generation error";
    console.error(`[reports] generation failed for #${reportId}:`, err);
    await db
      .update(reportRequests)
      .set({ status: "failed", failureReason })
      .where(eq(reportRequests.id, reportId));
    return { status: "failed", failureReason };
  }
}

// ---------------------------------------------------------------------------
// PDF rendering. Streamed so memory is bounded.
// ---------------------------------------------------------------------------
interface RenderInput {
  reportId: number;
  reportType: string;
  notes: string | null;
  client: { firstName: string; lastName: string; email: string; kycStatus: string };
  holdings: Array<{
    productName: string;
    productCategory: string;
    investedAmount: string;
    currentValue: string;
    totalReturn: string | null;
    returnPercent: string | null;
    status: string;
    investmentDate: Date | null;
    maturityDate: Date | null;
  }>;
  cashAud: string;
  cashUsd: string;
  txns: Array<{
    id: number;
    type: string;
    fromCurrency: string | null;
    toCurrency: string | null;
    amount: string;
    fee: string;
    status: string;
    description: string;
    createdAt: Date | null;
  }>;
  fees: Array<{
    id: number;
    feeType: string;
    amountType: string;
    amount: string | null;
    deductionFrequency: string;
    consentedAt: Date | null;
    consentExpiryDate: Date | null;
    renewalStatus: string;
  }>;
}

const REPORT_TYPE_LABEL: Record<string, string> = {
  portfolio_summary: "Portfolio Summary",
  fee_summary: "Fee Summary",
  transaction_history: "Transaction History",
  full_statement: "Full Statement",
};

async function renderPdf(filePath: string, data: RenderInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 64, bottom: 64, left: 56, right: 56 },
      bufferPages: true,
      info: {
        Title: `${REPORT_TYPE_LABEL[data.reportType] ?? data.reportType} — ${data.client.firstName} ${data.client.lastName}`,
        Author: "AMAX Wealth (Authorised Representative)",
        Subject: `Report request #${data.reportId}`,
      },
    });

    const stream = fs.createWriteStream(filePath);
    stream.on("finish", () => resolve());
    stream.on("error", reject);
    doc.on("error", reject);
    doc.pipe(stream);

    // Header band
    doc.fillColor("#0f172a").fontSize(20).font("Helvetica-Bold").text("AMAX WEALTH", { continued: true });
    doc.fillColor("#64748b").fontSize(10).font("Helvetica").text("   Authorised Representative under AFSL");
    doc.moveDown(0.3);
    doc.fillColor("#0f172a").fontSize(16).font("Helvetica-Bold").text(REPORT_TYPE_LABEL[data.reportType] ?? data.reportType);
    doc.moveDown(0.2);
    doc.fillColor("#64748b").fontSize(10).font("Helvetica")
      .text(`For ${data.client.firstName} ${data.client.lastName} · ${data.client.email}`);
    doc.text(`Generated ${fmtDate(new Date())} · Report #${data.reportId}`);
    if (data.notes) {
      doc.moveDown(0.3);
      doc.fillColor("#475569").fontSize(9).font("Helvetica-Oblique").text(`Note: ${data.notes}`);
    }
    doc.moveDown(0.6);

    // Draft watermark on every page
    drawDraftWatermark(doc);

    // Sections
    if (data.holdings.length > 0 || data.cashAud !== "0" || data.cashUsd !== "0") {
      drawHoldingsSection(doc, data);
    }
    if (data.fees.length > 0 || data.reportType === "fee_summary" || data.reportType === "full_statement") {
      drawFeesSection(doc, data);
    }
    if (data.txns.length > 0 || data.reportType === "transaction_history" || data.reportType === "full_statement") {
      drawTxnsSection(doc, data);
    }

    drawDisclosurePage(doc);

    // Page numbers + footer (added after all content via bufferPages)
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fillColor("#94a3b8").fontSize(8).font("Helvetica");
      const footer = `Draft — placeholder regulatory details. Page ${i - range.start + 1} of ${range.count}.`;
      doc.text(footer, 56, doc.page.height - 40, { width: doc.page.width - 112, align: "center" });
    }

    doc.end();
  });
}

function drawDraftWatermark(doc: PDFKit.PDFDocument): void {
  // Light diagonal "DRAFT" across the page background of page 1.
  // Subsequent pages get the footer line; the bold watermark stays on cover.
  doc.save();
  doc.fillColor("#e2e8f0").fontSize(80).font("Helvetica-Bold");
  doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
  doc.text("DRAFT", 0, doc.page.height / 2 - 40, {
    width: doc.page.width,
    align: "center",
  });
  doc.restore();
}

function sectionHeading(doc: PDFKit.PDFDocument, title: string): void {
  if (doc.y > doc.page.height - 180) doc.addPage();
  doc.moveDown(0.5);
  doc.fillColor("#0f172a").fontSize(13).font("Helvetica-Bold").text(title);
  doc.moveTo(56, doc.y + 2).lineTo(doc.page.width - 56, doc.y + 2).strokeColor("#cbd5e1").lineWidth(0.5).stroke();
  doc.moveDown(0.5);
}

function drawHoldingsSection(doc: PDFKit.PDFDocument, data: RenderInput): void {
  sectionHeading(doc, "Holdings & Cash");

  // Table header
  const startX = 56;
  const colWidths = [180, 90, 90, 70, 60];
  const headers = ["Product", "Invested", "Current value", "Return", "Status"];
  let y = doc.y;

  doc.fillColor("#475569").fontSize(9).font("Helvetica-Bold");
  let x = startX;
  headers.forEach((h, i) => {
    doc.text(h, x, y, { width: colWidths[i], align: i === 0 ? "left" : "right" });
    x += colWidths[i];
  });
  doc.moveTo(startX, y + 14).lineTo(doc.page.width - 56, y + 14).strokeColor("#e2e8f0").stroke();
  y += 18;

  doc.fillColor("#0f172a").fontSize(9).font("Helvetica");
  let totalInvested = 0;
  let totalCurrent = 0;
  data.holdings.forEach((h) => {
    if (y > doc.page.height - 100) {
      doc.addPage();
      y = 64;
    }
    x = startX;
    doc.text(h.productName, x, y, { width: colWidths[0], align: "left" });
    x += colWidths[0];
    doc.text(fmtMoney(h.investedAmount), x, y, { width: colWidths[1], align: "right" });
    x += colWidths[1];
    doc.text(fmtMoney(h.currentValue), x, y, { width: colWidths[2], align: "right" });
    x += colWidths[2];
    doc.text(`${h.returnPercent ?? "—"}%`, x, y, { width: colWidths[3], align: "right" });
    x += colWidths[3];
    doc.text(h.status, x, y, { width: colWidths[4], align: "right" });
    totalInvested += Number(h.investedAmount) || 0;
    totalCurrent += Number(h.currentValue) || 0;
    y += 14;
  });

  // Totals row
  if (data.holdings.length > 0) {
    doc.moveTo(startX, y).lineTo(doc.page.width - 56, y).strokeColor("#cbd5e1").stroke();
    y += 4;
    doc.fillColor("#0f172a").font("Helvetica-Bold");
    x = startX;
    doc.text("Totals", x, y, { width: colWidths[0], align: "left" });
    x += colWidths[0];
    doc.text(fmtMoney(totalInvested), x, y, { width: colWidths[1], align: "right" });
    x += colWidths[1];
    doc.text(fmtMoney(totalCurrent), x, y, { width: colWidths[2], align: "right" });
    y += 18;
  } else {
    doc.fillColor("#64748b").fontSize(9).font("Helvetica-Oblique").text("No invested products on record.", startX, y);
    y += 14;
  }
  doc.y = y;

  // Cash subsection (LEDGER-DERIVED)
  doc.moveDown(0.6);
  doc.fillColor("#0f172a").fontSize(11).font("Helvetica-Bold").text("Cash balances");
  doc.fillColor("#64748b").fontSize(8).font("Helvetica-Oblique")
    .text("Source: derived from ledger entries (sum of credits − debits).");
  doc.moveDown(0.3);
  doc.fillColor("#0f172a").fontSize(10).font("Helvetica");
  doc.text(`AUD: ${fmtMoney(data.cashAud, "AUD")}`);
  doc.text(`USD: ${fmtMoney(data.cashUsd, "USD")}`);
  doc.moveDown(0.5);
}

function drawFeesSection(doc: PDFKit.PDFDocument, data: RenderInput): void {
  sectionHeading(doc, "Fee Consents");

  if (data.fees.length === 0) {
    doc.fillColor("#64748b").fontSize(9).font("Helvetica-Oblique")
      .text("No fee consents on record. (No fee deductions are recorded — the fee engine is not yet operative.)");
    doc.moveDown(0.5);
    return;
  }

  const startX = 56;
  const colWidths = [110, 70, 80, 80, 80, 60];
  const headers = ["Fee type", "Amount", "Type", "Frequency", "Consented", "Status"];
  let y = doc.y;

  doc.fillColor("#475569").fontSize(9).font("Helvetica-Bold");
  let x = startX;
  headers.forEach((h, i) => {
    doc.text(h, x, y, { width: colWidths[i], align: i === 0 ? "left" : "right" });
    x += colWidths[i];
  });
  doc.moveTo(startX, y + 14).lineTo(doc.page.width - 56, y + 14).strokeColor("#e2e8f0").stroke();
  y += 18;

  doc.fillColor("#0f172a").fontSize(9).font("Helvetica");
  data.fees.forEach((f) => {
    if (y > doc.page.height - 100) { doc.addPage(); y = 64; }
    x = startX;
    doc.text(f.feeType, x, y, { width: colWidths[0], align: "left" });
    x += colWidths[0];
    const amountText = f.amount
      ? f.amountType === "percentage"
        ? `${f.amount}%`
        : fmtMoney(f.amount)
      : "—";
    doc.text(amountText, x, y, { width: colWidths[1], align: "right" });
    x += colWidths[1];
    doc.text(f.amountType, x, y, { width: colWidths[2], align: "right" });
    x += colWidths[2];
    doc.text(f.deductionFrequency, x, y, { width: colWidths[3], align: "right" });
    x += colWidths[3];
    doc.text(fmtDate(f.consentedAt), x, y, { width: colWidths[4], align: "right" });
    x += colWidths[4];
    doc.text(f.renewalStatus, x, y, { width: colWidths[5], align: "right" });
    y += 14;
  });
  doc.y = y;
  doc.moveDown(0.4);
  doc.fillColor("#64748b").fontSize(8).font("Helvetica-Oblique")
    .text("Fee deductions are not yet operative; the fee engine is gated.");
  doc.moveDown(0.5);
}

function drawTxnsSection(doc: PDFKit.PDFDocument, data: RenderInput): void {
  sectionHeading(doc, `Transactions (last ${data.txns.length})`);

  if (data.txns.length === 0) {
    doc.fillColor("#64748b").fontSize(9).font("Helvetica-Oblique")
      .text("No transactions on record.");
    doc.moveDown(0.5);
    return;
  }

  const startX = 56;
  const colWidths = [80, 90, 90, 60, 170];
  const headers = ["Date", "Type", "Amount", "Status", "Description"];
  let y = doc.y;

  doc.fillColor("#475569").fontSize(9).font("Helvetica-Bold");
  let x = startX;
  headers.forEach((h, i) => {
    doc.text(h, x, y, { width: colWidths[i], align: i === 4 ? "left" : i === 0 || i === 1 ? "left" : "right" });
    x += colWidths[i];
  });
  doc.moveTo(startX, y + 14).lineTo(doc.page.width - 56, y + 14).strokeColor("#e2e8f0").stroke();
  y += 18;

  doc.fillColor("#0f172a").fontSize(9).font("Helvetica");
  data.txns.forEach((t) => {
    if (y > doc.page.height - 100) { doc.addPage(); y = 64; }
    x = startX;
    doc.text(fmtDate(t.createdAt), x, y, { width: colWidths[0], align: "left" });
    x += colWidths[0];
    doc.text(t.type, x, y, { width: colWidths[1], align: "left" });
    x += colWidths[1];
    const cur = t.toCurrency || t.fromCurrency || "AUD";
    doc.text(fmtMoney(t.amount, cur), x, y, { width: colWidths[2], align: "right" });
    x += colWidths[2];
    doc.text(t.status, x, y, { width: colWidths[3], align: "right" });
    x += colWidths[3];
    doc.text((t.description || "").slice(0, 60), x, y, { width: colWidths[4], align: "left" });
    y += 14;
  });
  doc.y = y;
  doc.moveDown(0.5);
}

function drawDisclosurePage(doc: PDFKit.PDFDocument): void {
  doc.addPage();
  doc.fillColor("#0f172a").fontSize(13).font("Helvetica-Bold").text("Important disclosures");
  doc.moveDown(0.4);
  doc.fillColor("#334155").fontSize(9).font("Helvetica");
  const lines = [
    "This document is a draft generated by the AMAX Wealth platform. Regulatory details on this page are placeholder content and must be replaced with the licensee's final wording before client delivery.",
    "",
    "AMAX Wealth operates as an Authorised Representative under an Australian Financial Services Licence (AFSL). This report is general information only and does not constitute personal advice. It does not consider your objectives, financial situation or needs.",
    "",
    "Cash balances shown in this report are derived directly from the platform's ledger (sum of credits minus debits per currency). Invested-product current values reflect the latest unit price recorded against each product and may not match real-time custodian valuations.",
    "",
    "No fee deductions have been executed by this platform. Fee consents shown record the client's authorisation only; the fee engine itself remains gated.",
    "",
    "For questions, contact your adviser or write to compliance@amaxwealth.com.au.",
  ];
  lines.forEach((l) => {
    if (l === "") doc.moveDown(0.4);
    else doc.text(l, { align: "justify" });
  });
}
