// =============================================================================
// Task #495 — Account-activity PDF export.
// -----------------------------------------------------------------------------
// Builds a PDF mirror of the existing CSV /api/transactions/export endpoint.
// The visual chrome (per-page AFSL header, AMAX brand watermark, generation
// footer) is intentionally close to the adviser-side report PDFs in
// `server/services/reports.ts` so a regulator inspecting either document
// recognises the same licensee identity strip.
//
// Forensic per-recipient marking is handled separately by
// `applyDocumentWatermark` from `server/services/document-watermark.ts` —
// this module returns an *unwatermarked* buffer; the route applies the
// watermark just before streaming the response, so two downloads of the
// same window produce two distinguishable artefacts.
// =============================================================================

import PDFDocument from "pdfkit";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db } from "../db";
import { transactions, users, adviserClients } from "@shared/schema";

// Licensee identity is read from the same env vars `services/reports.ts` and
// `services/fee-consent-pdf.ts` already use, so a single set of compliance-
// approved values flows through every PDF surface. Re-deriving here (rather
// than importing from reports.ts) keeps this module self-contained and
// avoids tugging the adviser-side report machinery into the request graph.
const AMAX_LICENSEE_NAME =
  process.env.AMAX_LICENSEE_NAME?.trim() || "AMAX Wealth Pty Ltd";
const AMAX_PLATFORM_NAME =
  process.env.AMAX_PLATFORM_NAME?.trim() || "AMAX Wealth";
const AMAX_LICENSEE_AFSL =
  process.env.AMAX_LICENSEE_AFSL?.trim() || "AFSL [PLACEHOLDER]";
const AMAX_LICENSEE_ABN =
  process.env.AMAX_LICENSEE_ABN?.trim() || "ABN [PLACEHOLDER]";

// Hard cap on rows rendered into the PDF. Beyond this we emit a "truncated"
// note in the cover band and direct the user back to CSV — pdfkit holds the
// whole document in memory, so a runaway window must not be allowed to
// blow the response handler. CSV stays the canonical "give me everything"
// surface.
export const ACCOUNT_ACTIVITY_PDF_MAX_ROWS = 2000;

const TYPE_LABEL: Record<string, string> = {
  deposit: "Inflow",
  withdrawal: "Outflow",
  exchange: "Conversion",
  transfer: "Transfer",
  crypto_buy: "Acquisition",
  crypto_sell: "Disposal",
  adviser_fee_deduction: "Fee deduction",
  adviser_fee_deduction_reversal: "Fee reversal",
};

function fmtDateLine(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-AU", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function fmtDateTimeUtc(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function formatAccountNumber(userId: number): string {
  return `AMX-${String(userId).padStart(7, "0")}`;
}

export interface AccountActivityPdfInput {
  userId: number;
  // Inclusive window. The route is responsible for converting query
  // strings into Date objects (matching the CSV export's parsing).
  fromDate: Date;
  toDate: Date;
  // Human-readable period descriptor — "FY 2025–26", "YTD 2026", "1 Jul
  // 2025 – 28 Apr 2026", etc. Rendered into the cover band so a printed
  // page is unambiguous about what window the data covers.
  periodLabel: string;
  // Pinned to the request instant so the cover and footer carry the same
  // timestamp across the document.
  generatedAt: Date;
}

export interface AccountActivityPdfResult {
  buffer: Buffer;
  rowCount: number;
  truncated: boolean;
  clientName: string;
  adviserName: string;
}

/**
 * Build the PDF buffer. Caller is responsible for applying
 * `applyDocumentWatermark` (forensic per-recipient stamping) before
 * streaming the response. The buffer returned here already carries the
 * AMAX brand watermark + per-page header/footer.
 */
export async function buildAccountActivityPdf(
  input: AccountActivityPdfInput,
): Promise<AccountActivityPdfResult> {
  // Resolve client identity — reuses the same `users` columns the CSV
  // export's filename slug pulls from, so the two surfaces agree on who
  // owns the record set.
  const [userRow] = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);

  const clientName =
    [userRow?.firstName, userRow?.lastName].filter(Boolean).join(" ").trim() ||
    userRow?.username ||
    userRow?.email ||
    `Client #${input.userId}`;

  // Adviser lookup. A client may have no active adviser link yet — in
  // that case we render the AMAX platform identity in place of the adviser
  // line so the header strip stays well-formed and the watermark still has
  // a usable name field.
  const [advLink] = await db
    .select({
      adviserUserId: adviserClients.adviserUserId,
    })
    .from(adviserClients)
    .where(
      and(
        eq(adviserClients.clientUserId, input.userId),
        eq(adviserClients.isActive, true),
      ),
    )
    .limit(1);

  let adviserName = `${AMAX_PLATFORM_NAME} platform`;
  if (advLink?.adviserUserId) {
    const [adviserRow] = await db
      .select({
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        username: users.username,
      })
      .from(users)
      .where(eq(users.id, advLink.adviserUserId))
      .limit(1);
    const resolved =
      [adviserRow?.firstName, adviserRow?.lastName]
        .filter(Boolean)
        .join(" ")
        .trim() ||
      adviserRow?.username ||
      adviserRow?.email ||
      "";
    if (resolved) adviserName = resolved;
  }

  // Pull rows in the inclusive window, capped at MAX_ROWS+1 so we can
  // detect a truncated render and surface that in the cover band.
  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, input.userId),
        gte(transactions.createdAt, input.fromDate),
        lte(transactions.createdAt, input.toDate),
      ),
    )
    .orderBy(asc(transactions.createdAt), asc(transactions.id))
    .limit(ACCOUNT_ACTIVITY_PDF_MAX_ROWS + 1);

  const truncated = rows.length > ACCOUNT_ACTIVITY_PDF_MAX_ROWS;
  const renderRows = truncated
    ? rows.slice(0, ACCOUNT_ACTIVITY_PDF_MAX_ROWS)
    : rows;

  const buffer = await renderPdf({
    input,
    clientName,
    adviserName,
    rows: renderRows,
    truncated,
  });

  return {
    buffer,
    rowCount: renderRows.length,
    truncated,
    clientName,
    adviserName,
  };
}

interface RenderArgs {
  input: AccountActivityPdfInput;
  clientName: string;
  adviserName: string;
  rows: Array<typeof transactions.$inferSelect>;
  truncated: boolean;
}

function renderPdf(args: RenderArgs): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        // Top margin leaves room for the per-page header band drawn in
        // the bufferedPages pass below — same offset as the adviser
        // report PDFs so the licensee strip lines up identically.
        margins: { top: 96, bottom: 80, left: 56, right: 56 },
        bufferPages: true,
        info: {
          Title: `Account Activity — ${args.clientName} (${args.input.periodLabel})`,
          Author: `${AMAX_LICENSEE_NAME} (${AMAX_LICENSEE_AFSL}) — operated as ${AMAX_PLATFORM_NAME}`,
          Subject: `Account activity statement for the period ${args.input.periodLabel}`,
        },
      });

      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      drawCover(doc, args);
      drawTransactionsTable(doc, args);

      // Per-page chrome painted AFTER the body so bufferedPageRange is
      // final. Watermark first → header → footer so the licensee strip
      // sits cleanly on top of the brand mark.
      const range = doc.bufferedPageRange();
      const totalPages = range.count;
      for (let i = range.start; i < range.start + totalPages; i++) {
        doc.switchToPage(i);
        drawAmaxBrandWatermark(doc);
        drawPageHeader(doc, args);
        drawPageFooter(doc, args, i - range.start + 1, totalPages);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawCover(doc: PDFKit.PDFDocument, args: RenderArgs): void {
  doc
    .fillColor("#0f172a")
    .fontSize(18)
    .font("Helvetica-Bold")
    .text("Account Activity Statement");
  doc.moveDown(0.2);
  doc
    .fillColor("#64748b")
    .fontSize(10)
    .font("Helvetica")
    .text(`For ${args.clientName} · ${formatAccountNumber(args.input.userId)}`);
  doc.text(
    `Period: ${args.input.periodLabel} (${fmtDateLine(args.input.fromDate)} – ${fmtDateLine(args.input.toDate)})`,
  );
  doc.text(`Generated ${fmtDateTimeUtc(args.input.generatedAt)}`);
  if (args.truncated) {
    doc.moveDown(0.3);
    doc
      .fillColor("#b45309")
      .fontSize(9)
      .font("Helvetica-Bold")
      .text(
        `Showing the first ${ACCOUNT_ACTIVITY_PDF_MAX_ROWS} records — for the complete record set use the CSV export.`,
      );
  }
  doc.moveDown(0.6);
  doc
    .fillColor("#475569")
    .fontSize(9)
    .font("Helvetica-Oblique")
    .text(
      "All records are maintained under s912A of the Corporations Act 2001 (Cth) and retained for a minimum of 7 years. Transaction instructions are executed via external custodians and fund managers. AMAX Wealth does not hold client funds.",
    );
  doc.moveDown(0.6);
}

function drawTransactionsTable(
  doc: PDFKit.PDFDocument,
  args: RenderArgs,
): void {
  if (args.rows.length === 0) {
    doc
      .fillColor("#475569")
      .fontSize(11)
      .font("Helvetica")
      .text(
        "No transactions recorded in this period. Account activity reflects all settled and pending movements between AMAX-tracked wallets, exchanges, and external custodians.",
      );
    return;
  }

  doc.moveDown(0.2);
  doc.fillColor("#0f172a").fontSize(13).font("Helvetica-Bold").text("Transactions");
  doc.moveDown(0.3);

  const startX = 56;
  const rightX = doc.page.width - 56;
  const usable = rightX - startX;
  const cols = [
    { key: "date", label: "Date", w: 0.16, align: "left" as const },
    { key: "type", label: "Type", w: 0.13, align: "left" as const },
    { key: "desc", label: "Description", w: 0.29, align: "left" as const },
    { key: "from", label: "From", w: 0.07, align: "left" as const },
    { key: "to", label: "To", w: 0.07, align: "left" as const },
    { key: "amount", label: "Amount", w: 0.12, align: "right" as const },
    { key: "fee", label: "Fee", w: 0.08, align: "right" as const },
    { key: "status", label: "Status", w: 0.08, align: "left" as const },
  ];
  const colX: number[] = [];
  let acc = startX;
  for (const c of cols) {
    colX.push(acc);
    acc += c.w * usable;
  }

  const drawHeaderRow = () => {
    doc.fillColor("#475569").fontSize(8.5).font("Helvetica-Bold");
    cols.forEach((c, i) => {
      doc.text(c.label, colX[i], doc.y, {
        width: c.w * usable - 4,
        align: c.align,
        lineBreak: false,
        continued: i < cols.length - 1,
      });
    });
    doc.text("", { lineBreak: true });
    const y = doc.y + 1;
    doc
      .moveTo(startX, y)
      .lineTo(rightX, y)
      .strokeColor("#e2e8f0")
      .lineWidth(0.5)
      .stroke();
    doc.moveDown(0.4);
  };

  drawHeaderRow();
  doc.fillColor("#0f172a").fontSize(8.5).font("Helvetica");

  for (const r of args.rows) {
    // New page guard — keep ~80px of bottom margin so the footer band
    // never collides with the last row.
    if (doc.y > doc.page.height - 110) {
      doc.addPage();
      drawHeaderRow();
      doc.fillColor("#0f172a").fontSize(8.5).font("Helvetica");
    }

    const created = r.createdAt
      ? new Date(r.createdAt as unknown as string | Date)
      : null;
    const dateStr = created
      ? created.toLocaleDateString("en-AU", {
          year: "numeric",
          month: "short",
          day: "2-digit",
        })
      : "—";

    const cells: Record<string, string> = {
      date: dateStr,
      type: TYPE_LABEL[r.type] ?? r.type,
      desc: (r.description ?? "").toString(),
      from: (r.fromCurrency ?? "").toString(),
      to: (r.toCurrency ?? "").toString(),
      amount: r.amount != null ? String(r.amount) : "",
      fee: r.fee != null ? String(r.fee) : "",
      status: (r.status ?? "").toString(),
    };

    cols.forEach((c, i) => {
      doc.text(cells[c.key] ?? "", colX[i], doc.y, {
        width: c.w * usable - 4,
        align: c.align,
        lineBreak: false,
        ellipsis: true,
        continued: i < cols.length - 1,
      });
    });
    doc.text("", { lineBreak: true });
  }
}

// Faint diagonal "AMAX" band — same brand mark as the adviser report PDFs.
function drawAmaxBrandWatermark(doc: PDFKit.PDFDocument): void {
  doc.save();
  doc.opacity(0.08);
  doc.fillColor("#0f172a").fontSize(120).font("Helvetica-Bold");
  doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
  doc.text("AMAX", 0, doc.page.height / 2 - 60, {
    width: doc.page.width,
    align: "center",
    lineBreak: false,
  });
  doc.restore();
}

function drawPageHeader(doc: PDFKit.PDFDocument, args: RenderArgs): void {
  const left = 56;
  const right = doc.page.width - 56;
  const yTop = 32;
  doc.save();
  doc
    .fillColor("#0f172a")
    .fontSize(11)
    .font("Helvetica-Bold")
    .text(AMAX_PLATFORM_NAME.toUpperCase(), left, yTop, { lineBreak: false });
  doc
    .fillColor("#64748b")
    .fontSize(8)
    .font("Helvetica")
    .text(
      `${AMAX_LICENSEE_NAME} · ${AMAX_LICENSEE_AFSL} · ${AMAX_LICENSEE_ABN}`,
      left + 110,
      yTop + 2,
      { lineBreak: false },
    );

  const accountNo = formatAccountNumber(args.input.userId);
  const clientLine = `${args.clientName} · ${accountNo}`;
  const adviserLine = `Adviser: ${args.adviserName}`;
  doc
    .fillColor("#0f172a")
    .fontSize(9)
    .font("Helvetica-Bold")
    .text(clientLine, left, yTop, {
      width: right - left,
      align: "right",
      lineBreak: false,
    });
  doc
    .fillColor("#64748b")
    .fontSize(8)
    .font("Helvetica")
    .text(adviserLine, left, yTop + 12, {
      width: right - left,
      align: "right",
      lineBreak: false,
    });
  doc
    .moveTo(left, yTop + 28)
    .lineTo(right, yTop + 28)
    .strokeColor("#e2e8f0")
    .lineWidth(0.5)
    .stroke();
  doc.restore();
  doc.y = 96;
}

function drawPageFooter(
  doc: PDFKit.PDFDocument,
  args: RenderArgs,
  pageNum: number,
  pageCount: number,
): void {
  const left = 56;
  const right = doc.page.width - 56;
  const yProvenance = doc.page.height - 56;
  const yMeta = doc.page.height - 38;
  doc.save();
  doc
    .moveTo(left, yProvenance - 6)
    .lineTo(right, yProvenance - 6)
    .strokeColor("#e2e8f0")
    .lineWidth(0.5)
    .stroke();

  const provenance = [
    args.input.periodLabel,
    args.clientName,
    `${args.adviserName} · ${AMAX_PLATFORM_NAME}`,
    "Generated by AMAX platform",
  ].join(" · ");
  doc
    .fillColor("#475569")
    .fontSize(7.5)
    .font("Helvetica")
    .text(provenance, left, yProvenance, {
      width: right - left,
      align: "center",
      lineBreak: false,
      ellipsis: true,
    });

  doc.fillColor("#94a3b8").fontSize(8).font("Helvetica");
  doc.text(
    `Generated ${fmtDateTimeUtc(args.input.generatedAt)}`,
    left,
    yMeta,
    {
      width: (right - left) / 2,
      align: "left",
      lineBreak: false,
    },
  );
  doc.text(`Page ${pageNum} of ${pageCount}`, left, yMeta, {
    width: right - left,
    align: "center",
    lineBreak: false,
  });
  doc.text("Confidential — not for distribution", left, yMeta, {
    width: right - left,
    align: "right",
    lineBreak: false,
  });
  doc.restore();
}

// =============================================================================
// Period-slug helpers — kept here so the filename pattern lives next to the
// PDF builder. Both the CSV preset path and the PDF route use these.
// =============================================================================

const PERIOD_SLUG_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidPeriodSlug(slug: string): boolean {
  return PERIOD_SLUG_RE.test(slug);
}

export function buildAccountActivityFilename(
  periodSlug: string,
  ext: "pdf" | "csv",
): string {
  // Caller is responsible for validating periodSlug; we still defensively
  // strip anything not in the allowlist so a bypass cannot inject a CRLF
  // into the Content-Disposition header.
  const safe = periodSlug.replace(/[^A-Za-z0-9._-]/g, "");
  return `AMAX-account-activity-${safe || "period"}.${ext}`;
}
