import nodemailer from "nodemailer";

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;

export const emailConfigured = !!(GMAIL_USER && GMAIL_PASS);

const FROM_HEADER = '"AMAX Wealth" <info@amaxglobal.com.au>';
const REPLY_TO = "info@amaxglobal.com.au";

function createTransport() {
  if (!emailConfigured) return null;
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
}

export async function sendVerificationEmail(
  to: string,
  firstName: string,
  token: string,
  otp: string,
  baseUrl: string
): Promise<{ sent: boolean; preview?: string }> {
  const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${token}`;

  if (!emailConfigured) {
    console.log(`[email] OTP for ${to}: ${otp}`);
    console.log(`[email] Verification URL (not sent — GMAIL not configured): ${verifyUrl}`);
    return { sent: false, preview: verifyUrl };
  }

  const transport = createTransport()!;
  try {
    await transport.sendMail({
    from: FROM_HEADER,
    replyTo: REPLY_TO,
    to,
    subject: "Your AMAX Wealth verification code",
    html: `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:16px;border:1px solid #334155;overflow:hidden">
        <tr><td style="padding:32px 40px 0;text-align:center">
          <span style="font-size:22px;font-weight:700;color:#fff;letter-spacing:2px">AMAX WEALTH</span>
        </td></tr>
        <tr><td style="padding:24px 40px">
          <h1 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 12px">Verify your email address</h1>
          <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 24px">
            Hi ${firstName}, welcome to AMAX Wealth. Use the 6-digit code below to verify your email address and activate your account.
          </p>
          <div style="background:#0f172a;border:2px solid #0ea5e9;border-radius:14px;padding:28px 20px;text-align:center;margin:0 0 28px">
            <p style="color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:2px;margin:0 0 12px">Your verification code</p>
            <div style="font-size:42px;font-weight:800;letter-spacing:12px;color:#fff;font-family:'Courier New',monospace">${otp}</div>
            <p style="color:#64748b;font-size:12px;margin:12px 0 0">This code expires in 24 hours</p>
          </div>
          <p style="color:#94a3b8;font-size:13px;margin:0 0 16px;text-align:center">— or click the button below —</p>
          <div style="text-align:center;margin:0 0 28px">
            <a href="${verifyUrl}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px">
              Verify my email →
            </a>
          </div>
          <p style="color:#64748b;font-size:12px;margin:0">If you didn't create an account, you can safely ignore this email.</p>
        </td></tr>
        <tr><td style="padding:20px 40px;border-top:1px solid #334155;text-align:center">
          <p style="color:#475569;font-size:11px;margin:0">
            AMAX GLOBAL Pty Ltd &nbsp;·&nbsp; ABN 54 690 827 608 &nbsp;·&nbsp; AUSTRAC Registered<br>
            Level 2, 8-12 King Street, Rockdale NSW 2216 &nbsp;·&nbsp; +61 2 8320 1908
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    text: `Hi ${firstName},\n\nYour AMAX Wealth verification code is: ${otp}\n\nOr verify via link:\n${verifyUrl}\n\nThis code expires in 24 hours.\n\nAMAX GLOBAL Pty Ltd`,
    });
    return { sent: true };
  } catch (err: any) {
    // SMTP credentials/connection failed. Surface the OTP to server logs as a dev
    // fallback and re-throw so the caller can report the real status to the client.
    console.error(`[email] SMTP send FAILED for ${to}:`, err?.message || err);
    console.log(`[email] DEV FALLBACK — OTP for ${to}: ${otp}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Registration invite delivery (Session 14 follow-up)
//
// Used by the admin invite endpoints to deliver a one-time activation link to
// the invited address. Returns a structured result rather than throwing so the
// caller can:
//   1. write an audit_logs row reflecting the attempt (success/failure), and
//   2. still surface the raw link to the admin as a manual fallback.
// ---------------------------------------------------------------------------
export type InviteRole = "client" | "adviser" | "admin";

const ROLE_LABEL: Record<InviteRole, string> = {
  client: "AMAX Wealth client",
  adviser: "AMAX Wealth adviser",
  admin: "AMAX Wealth administrator",
};

function formatExpiry(expiresAt: Date): string {
  try {
    return expiresAt.toLocaleString("en-AU", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Australia/Sydney",
    }) + " (Sydney)";
  } catch {
    return expiresAt.toISOString();
  }
}

export async function sendInviteEmail(
  to: string,
  role: InviteRole,
  inviteLink: string,
  expiresAt: Date,
): Promise<{ sent: boolean; error?: string }> {
  if (!emailConfigured) {
    const msg = "SMTP not configured (GMAIL_USER / GMAIL_APP_PASSWORD missing)";
    // Deliberately do NOT log the inviteLink — it carries a single-use
    // activation token. Admins can recover it from the 5xx response body.
    console.warn(`[email] Invite NOT sent to ${to} — ${msg}`);
    return { sent: false, error: msg };
  }

  const transport = createTransport()!;
  const roleLabel = ROLE_LABEL[role];
  const expiryHuman = formatExpiry(expiresAt);

  try {
    await transport.sendMail({
      from: FROM_HEADER,
      replyTo: REPLY_TO,
      to,
      subject: "Your AMAX Wealth registration invitation",
      html: `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:16px;border:1px solid #334155;overflow:hidden">
        <tr><td style="padding:32px 40px 0;text-align:center">
          <span style="font-size:22px;font-weight:700;color:#fff;letter-spacing:2px">AMAX WEALTH</span>
        </td></tr>
        <tr><td style="padding:24px 40px">
          <h1 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 12px">You're invited</h1>
          <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 20px">
            An AMAX Wealth administrator has invited you to register as a ${roleLabel}.
            Click the button below to set up your account. This invitation is single-use
            and expires on <strong style="color:#e2e8f0">${expiryHuman}</strong>.
          </p>
          <div style="text-align:center;margin:0 0 24px">
            <a href="${inviteLink}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px">
              Activate my account →
            </a>
          </div>
          <p style="color:#94a3b8;font-size:13px;margin:0 0 8px">
            If the button doesn't work, copy and paste this link into your browser:
          </p>
          <p style="color:#0ea5e9;font-size:12px;word-break:break-all;margin:0 0 24px">
            ${inviteLink}
          </p>
          <p style="color:#64748b;font-size:12px;margin:0">
            If you didn't expect this invitation, you can safely ignore this email — the link
            will expire automatically and cannot be reused.
          </p>
        </td></tr>
        <tr><td style="padding:20px 40px;border-top:1px solid #334155;text-align:center">
          <p style="color:#475569;font-size:11px;margin:0">
            AMAX GLOBAL Pty Ltd &nbsp;·&nbsp; ABN 54 690 827 608 &nbsp;·&nbsp; AUSTRAC Registered<br>
            Level 2, 8-12 King Street, Rockdale NSW 2216 &nbsp;·&nbsp; +61 2 8320 1908
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
      text:
        `You've been invited to register as a ${roleLabel} on AMAX Wealth.\n\n` +
        `Activate your account here:\n${inviteLink}\n\n` +
        `This invitation is single-use and expires on ${expiryHuman}.\n\n` +
        `If you didn't expect this invitation, you can safely ignore this email.\n\n` +
        `AMAX GLOBAL Pty Ltd`,
    });
    return { sent: true };
  } catch (err: any) {
    const msg = err?.message || String(err) || "SMTP send failed";
    console.error(`[email] Invite SMTP send FAILED for ${to}:`, msg);
    return { sent: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Insufficient-funds notification (Task #64)
//
// Sent to a client when the daily sweep retries an `insufficient_funds` adviser
// fee deduction and finds the wallet balance is still short. The body shows
// the required total and the current available balance so the client can top
// up by a known amount.
//
// Returns a structured result instead of throwing so the sweep cron can:
//   - record `clientNotifiedAt` only when the dispatch actually succeeded, and
//   - keep iterating across remaining deductions even if one email fails
//     (e.g. a single bad recipient address shouldn't kill the whole sweep).
//
// When SMTP is not configured (dev / preview) we log a one-line summary and
// return `{ sent: false }` — the sweep still updates the tracking columns so
// the admin UI can show "notification was attempted (logs only)".
// ---------------------------------------------------------------------------
function formatMoney(amount: number | string, currency: string): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export async function sendInsufficientFundsEmail(args: {
  to: string;
  firstName: string;
  deductionId: number;
  required: number | string;
  available: number | string;
  currency: string;
  shortfall: number | string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<{ sent: boolean; error?: string }> {
  const {
    to,
    firstName,
    deductionId,
    required,
    available,
    currency,
    shortfall,
    periodStart,
    periodEnd,
  } = args;

  const requiredStr = formatMoney(required, currency);
  const availableStr = formatMoney(available, currency);
  const shortfallStr = formatMoney(shortfall, currency);
  const periodStr = `${periodStart.toLocaleDateString("en-AU", { dateStyle: "medium" })} – ${periodEnd.toLocaleDateString("en-AU", { dateStyle: "medium" })}`;

  if (!emailConfigured) {
    // No PII / token in this line so it is safe to log.
    console.log(
      `[email] Insufficient-funds notice NOT sent to ${to} — SMTP not configured ` +
        `(deduction #${deductionId}, required=${requiredStr}, available=${availableStr})`,
    );
    return {
      sent: false,
      error: "SMTP not configured (GMAIL_USER / GMAIL_APP_PASSWORD missing)",
    };
  }

  const transport = createTransport()!;
  try {
    await transport.sendMail({
      from: FROM_HEADER,
      replyTo: REPLY_TO,
      to,
      subject: `Action required: top up to cover your AMAX Wealth adviser fee`,
      html: `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px">
    <tr><td align="center">
      <table width="540" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:16px;border:1px solid #334155;overflow:hidden">
        <tr><td style="padding:32px 40px 0;text-align:center">
          <span style="font-size:22px;font-weight:700;color:#fff;letter-spacing:2px">AMAX WEALTH</span>
        </td></tr>
        <tr><td style="padding:24px 40px">
          <h1 style="color:#fff;font-size:20px;font-weight:700;margin:0 0 12px">Your adviser fee couldn't be deducted</h1>
          <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 20px">
            Hi ${firstName}, we tried to settle your adviser fee for the period
            <strong style="color:#e2e8f0">${periodStr}</strong> but your wallet balance
            is currently short. We'll keep retrying daily — no action is required immediately,
            but topping up will let the deduction settle on the next attempt.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;border:1px solid #334155;border-radius:12px;margin:0 0 24px">
            <tr><td style="padding:16px 20px;border-bottom:1px solid #1f2937">
              <span style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:1px">Required</span><br>
              <span style="color:#fff;font-size:18px;font-weight:700">${requiredStr}</span>
            </td></tr>
            <tr><td style="padding:16px 20px;border-bottom:1px solid #1f2937">
              <span style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:1px">Available now</span><br>
              <span style="color:#fff;font-size:18px;font-weight:700">${availableStr}</span>
            </td></tr>
            <tr><td style="padding:16px 20px">
              <span style="color:#fb923c;font-size:12px;text-transform:uppercase;letter-spacing:1px">Top up at least</span><br>
              <span style="color:#fb923c;font-size:20px;font-weight:800">${shortfallStr}</span>
            </td></tr>
          </table>
          <p style="color:#94a3b8;font-size:13px;line-height:1.6;margin:0 0 8px">
            Reference: deduction #${deductionId}
          </p>
          <p style="color:#64748b;font-size:12px;margin:0">
            If you believe this is in error, reply to this email and our team will look into it.
          </p>
        </td></tr>
        <tr><td style="padding:20px 40px;border-top:1px solid #334155;text-align:center">
          <p style="color:#475569;font-size:11px;margin:0">
            AMAX GLOBAL Pty Ltd &nbsp;·&nbsp; ABN 54 690 827 608 &nbsp;·&nbsp; AUSTRAC Registered<br>
            Level 2, 8-12 King Street, Rockdale NSW 2216 &nbsp;·&nbsp; +61 2 8320 1908
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
      text:
        `Hi ${firstName},\n\n` +
        `We tried to settle your AMAX Wealth adviser fee for ${periodStr} but your ` +
        `wallet balance is currently short. We'll keep retrying daily.\n\n` +
        `  Required:      ${requiredStr}\n` +
        `  Available now: ${availableStr}\n` +
        `  Top up at least: ${shortfallStr}\n\n` +
        `Reference: deduction #${deductionId}\n\n` +
        `If you believe this is in error, reply to this email and our team will look into it.\n\n` +
        `AMAX GLOBAL Pty Ltd`,
    });
    return { sent: true };
  } catch (err: any) {
    const msg = err?.message || String(err) || "SMTP send failed";
    console.error(
      `[email] Insufficient-funds SMTP send FAILED for ${to} (deduction #${deductionId}):`,
      msg,
    );
    return { sent: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Adviser report notifications (Task #344)
//
// Three short transactional emails close the lifecycle loop on adviser
// report requests:
//
//   1. sendReportReadyEmail        — fired the moment the PDF flips to ready
//   2. sendReportFailedEmail       — fired on generation/sweeper failure
//   3. sendReportExpiringSoonEmail — one-shot reminder ~24h before expiresAt
//                                    for any still-undownloaded `ready` row
//
// Each returns a structured result rather than throwing so the caller can
// stamp its debounce column (e.g. report_requests.readyNotifiedAt) and
// keep iterating across remaining rows even if one address bounces.
//
// When SMTP is not configured (dev / preview) we log a one-line summary and
// return `{ sent: false }` — the caller still updates its tracking column so
// the audit trail records "notification was attempted (logs only)" and we
// don't re-page on every cron tick.
// ---------------------------------------------------------------------------

function reportTypeLabel(reportType: string): string {
  return reportType.replace(/_/g, " ");
}

function reportDeepLink(reportId: number, baseUrl?: string | null): string {
  // Path-only fallback when no public base URL is configured. The path is
  // recognised by the adviser SPA which scrolls/highlights the matching
  // row (existing /adviser/reports route).
  const path = `/adviser/reports?report=${reportId}`;
  const base = (baseUrl ?? process.env.APP_BASE_URL ?? "").replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

function fmtExpiry(expiresAt: Date): string {
  try {
    return expiresAt.toLocaleString("en-AU", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Australia/Sydney",
    }) + " (Sydney)";
  } catch {
    return expiresAt.toISOString();
  }
}

export async function sendReportReadyEmail(args: {
  to: string;
  firstName: string;
  reportId: number;
  reportType: string;
  clientName: string;
  expiresAt: Date | null;
  baseUrl?: string | null;
}): Promise<{ sent: boolean; error?: string }> {
  const { to, firstName, reportId, reportType, clientName, expiresAt, baseUrl } = args;
  const link = reportDeepLink(reportId, baseUrl);
  const typeLabel = reportTypeLabel(reportType);
  const expiryLine = expiresAt
    ? `The PDF stays available until ${fmtExpiry(expiresAt)}.`
    : `The PDF will remain available for the standard retention window.`;

  if (!emailConfigured) {
    console.log(
      `[email] Report-ready notice NOT sent to ${to} — SMTP not configured ` +
        `(report #${reportId}, type=${reportType}, client=${clientName})`,
    );
    return {
      sent: false,
      error: "SMTP not configured (GMAIL_USER / GMAIL_APP_PASSWORD missing)",
    };
  }

  const transport = createTransport()!;
  try {
    await transport.sendMail({
      from: FROM_HEADER,
      replyTo: REPLY_TO,
      to,
      subject: `Report ready: ${typeLabel} for ${clientName}`,
      html: `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px">
    <tr><td align="center">
      <table width="540" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:16px;border:1px solid #334155;overflow:hidden">
        <tr><td style="padding:32px 40px 0;text-align:center">
          <span style="font-size:22px;font-weight:700;color:#fff;letter-spacing:2px">AMAX WEALTH</span>
        </td></tr>
        <tr><td style="padding:24px 40px">
          <h1 style="color:#fff;font-size:20px;font-weight:700;margin:0 0 12px">Your report is ready</h1>
          <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 20px">
            Hi ${firstName}, the <strong style="color:#e2e8f0">${typeLabel}</strong> report you requested for
            <strong style="color:#e2e8f0">${clientName}</strong> has finished generating and is ready to download.
          </p>
          <div style="text-align:center;margin:0 0 24px">
            <a href="${link}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px">
              Open report →
            </a>
          </div>
          <p style="color:#94a3b8;font-size:13px;margin:0 0 8px">${expiryLine}</p>
          <p style="color:#64748b;font-size:12px;margin:0">Reference: report #${reportId}</p>
        </td></tr>
        <tr><td style="padding:20px 40px;border-top:1px solid #334155;text-align:center">
          <p style="color:#475569;font-size:11px;margin:0">
            AMAX GLOBAL Pty Ltd &nbsp;·&nbsp; ABN 54 690 827 608 &nbsp;·&nbsp; AUSTRAC Registered<br>
            Level 2, 8-12 King Street, Rockdale NSW 2216 &nbsp;·&nbsp; +61 2 8320 1908
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
      text:
        `Hi ${firstName},\n\n` +
        `Your ${typeLabel} report for ${clientName} is ready to download.\n\n` +
        `Open it here: ${link}\n\n` +
        `${expiryLine}\n\n` +
        `Reference: report #${reportId}\n\n` +
        `AMAX GLOBAL Pty Ltd`,
    });
    return { sent: true };
  } catch (err: any) {
    const msg = err?.message || String(err) || "SMTP send failed";
    console.error(
      `[email] Report-ready SMTP send FAILED for ${to} (report #${reportId}):`,
      msg,
    );
    return { sent: false, error: msg };
  }
}

export async function sendReportFailedEmail(args: {
  to: string;
  firstName: string;
  reportId: number;
  reportType: string;
  clientName: string;
  failureReason: string;
  baseUrl?: string | null;
}): Promise<{ sent: boolean; error?: string }> {
  const { to, firstName, reportId, reportType, clientName, failureReason, baseUrl } = args;
  const link = reportDeepLink(reportId, baseUrl);
  const typeLabel = reportTypeLabel(reportType);
  const reason = (failureReason || "unknown error").slice(0, 500);

  if (!emailConfigured) {
    console.log(
      `[email] Report-failed notice NOT sent to ${to} — SMTP not configured ` +
        `(report #${reportId}, type=${reportType}, client=${clientName}, reason=${reason})`,
    );
    return {
      sent: false,
      error: "SMTP not configured (GMAIL_USER / GMAIL_APP_PASSWORD missing)",
    };
  }

  const transport = createTransport()!;
  try {
    await transport.sendMail({
      from: FROM_HEADER,
      replyTo: REPLY_TO,
      to,
      subject: `Report failed: ${typeLabel} for ${clientName}`,
      html: `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px">
    <tr><td align="center">
      <table width="540" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:16px;border:1px solid #334155;overflow:hidden">
        <tr><td style="padding:32px 40px 0;text-align:center">
          <span style="font-size:22px;font-weight:700;color:#fff;letter-spacing:2px">AMAX WEALTH</span>
        </td></tr>
        <tr><td style="padding:24px 40px">
          <h1 style="color:#fff;font-size:20px;font-weight:700;margin:0 0 12px">Your report didn't generate</h1>
          <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 16px">
            Hi ${firstName}, we tried to generate your <strong style="color:#e2e8f0">${typeLabel}</strong> report for
            <strong style="color:#e2e8f0">${clientName}</strong> but the job did not complete.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;border:1px solid #334155;border-radius:12px;margin:0 0 24px">
            <tr><td style="padding:16px 20px">
              <span style="color:#fb923c;font-size:12px;text-transform:uppercase;letter-spacing:1px">Reason</span><br>
              <span style="color:#fb923c;font-size:14px;font-weight:600">${reason}</span>
            </td></tr>
          </table>
          <div style="text-align:center;margin:0 0 24px">
            <a href="${link}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px">
              Open Reports →
            </a>
          </div>
          <p style="color:#94a3b8;font-size:13px;margin:0 0 8px">
            You can retry generation from the Reports page.
          </p>
          <p style="color:#64748b;font-size:12px;margin:0">Reference: report #${reportId}</p>
        </td></tr>
        <tr><td style="padding:20px 40px;border-top:1px solid #334155;text-align:center">
          <p style="color:#475569;font-size:11px;margin:0">
            AMAX GLOBAL Pty Ltd &nbsp;·&nbsp; ABN 54 690 827 608 &nbsp;·&nbsp; AUSTRAC Registered<br>
            Level 2, 8-12 King Street, Rockdale NSW 2216 &nbsp;·&nbsp; +61 2 8320 1908
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
      text:
        `Hi ${firstName},\n\n` +
        `Your ${typeLabel} report for ${clientName} did not generate.\n\n` +
        `Reason: ${reason}\n\n` +
        `Open the Reports page to retry: ${link}\n\n` +
        `Reference: report #${reportId}\n\n` +
        `AMAX GLOBAL Pty Ltd`,
    });
    return { sent: true };
  } catch (err: any) {
    const msg = err?.message || String(err) || "SMTP send failed";
    console.error(
      `[email] Report-failed SMTP send FAILED for ${to} (report #${reportId}):`,
      msg,
    );
    return { sent: false, error: msg };
  }
}

export async function sendReportExpiringSoonEmail(args: {
  to: string;
  firstName: string;
  reportId: number;
  reportType: string;
  clientName: string;
  expiresAt: Date;
  baseUrl?: string | null;
}): Promise<{ sent: boolean; error?: string }> {
  const { to, firstName, reportId, reportType, clientName, expiresAt, baseUrl } = args;
  const link = reportDeepLink(reportId, baseUrl);
  const typeLabel = reportTypeLabel(reportType);
  const expiryStr = fmtExpiry(expiresAt);

  if (!emailConfigured) {
    console.log(
      `[email] Report-expiring-soon notice NOT sent to ${to} — SMTP not configured ` +
        `(report #${reportId}, type=${reportType}, client=${clientName}, expiresAt=${expiresAt.toISOString()})`,
    );
    return {
      sent: false,
      error: "SMTP not configured (GMAIL_USER / GMAIL_APP_PASSWORD missing)",
    };
  }

  const transport = createTransport()!;
  try {
    await transport.sendMail({
      from: FROM_HEADER,
      replyTo: REPLY_TO,
      to,
      subject: `Report expiring soon: ${typeLabel} for ${clientName}`,
      html: `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px">
    <tr><td align="center">
      <table width="540" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:16px;border:1px solid #334155;overflow:hidden">
        <tr><td style="padding:32px 40px 0;text-align:center">
          <span style="font-size:22px;font-weight:700;color:#fff;letter-spacing:2px">AMAX WEALTH</span>
        </td></tr>
        <tr><td style="padding:24px 40px">
          <h1 style="color:#fff;font-size:20px;font-weight:700;margin:0 0 12px">Your report expires in 24 hours</h1>
          <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 20px">
            Hi ${firstName}, the <strong style="color:#e2e8f0">${typeLabel}</strong> report you generated for
            <strong style="color:#e2e8f0">${clientName}</strong> hasn't been downloaded yet and will be removed
            on <strong style="color:#e2e8f0">${expiryStr}</strong>. Download it now if you still need it —
            you can always regenerate later.
          </p>
          <div style="text-align:center;margin:0 0 24px">
            <a href="${link}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px">
              Download report →
            </a>
          </div>
          <p style="color:#64748b;font-size:12px;margin:0">Reference: report #${reportId}</p>
        </td></tr>
        <tr><td style="padding:20px 40px;border-top:1px solid #334155;text-align:center">
          <p style="color:#475569;font-size:11px;margin:0">
            AMAX GLOBAL Pty Ltd &nbsp;·&nbsp; ABN 54 690 827 608 &nbsp;·&nbsp; AUSTRAC Registered<br>
            Level 2, 8-12 King Street, Rockdale NSW 2216 &nbsp;·&nbsp; +61 2 8320 1908
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
      text:
        `Hi ${firstName},\n\n` +
        `Your ${typeLabel} report for ${clientName} hasn't been downloaded yet and ` +
        `will expire on ${expiryStr}.\n\n` +
        `Download it here: ${link}\n\n` +
        `Reference: report #${reportId}\n\n` +
        `AMAX GLOBAL Pty Ltd`,
    });
    return { sent: true };
  } catch (err: any) {
    const msg = err?.message || String(err) || "SMTP send failed";
    console.error(
      `[email] Report-expiring-soon SMTP send FAILED for ${to} (report #${reportId}):`,
      msg,
    );
    return { sent: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Fee-consent request notifications (Task #301)
//
// Fired the moment a fresh client-facing fee-consent request appears in the
// client's queue, so a "pending" row stops sitting unseen until the next
// login. Two trigger flavours share one renderer because the body is almost
// identical — the subject line and lead paragraph differ so the client can
// tell, at a glance, whether this is brand-new or a replacement for a live
// consent that an admin just superseded.
//
// The deep link points at the client SPA's existing /client/fee-consents
// page; an optional `?request=:id` query string is included for forward
// compatibility (a future task can wire the page to scroll/highlight that
// row). The link uses APP_BASE_URL when configured, or a relative path so
// preview environments still produce something the SPA can navigate to.
//
// Returns a structured result rather than throwing so the caller can:
//   1. write an audit_logs row reflecting the attempt (success/failure), and
//   2. keep iterating across remaining recipients if one address bounces.
//
// When SMTP is not configured (dev / preview) we log a one-line summary and
// return `{ sent: false }` so the caller still records "notification was
// attempted (logs only)" in the audit trail.
// ---------------------------------------------------------------------------
export type FeeConsentRequestEmailTrigger = "new_request" | "supersede";

function feeConsentSignDeepLink(
  requestId: number,
  baseUrl?: string | null,
): string {
  const path = `/client/fee-consents?request=${requestId}`;
  const base = (baseUrl ?? process.env.APP_BASE_URL ?? "").replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

export async function sendFeeConsentRequestEmail(args: {
  to: string;
  firstName: string;
  requestId: number;
  feeType: string;
  trigger: FeeConsentRequestEmailTrigger;
  adviserName?: string | null;
  baseUrl?: string | null;
}): Promise<{ sent: boolean; error?: string; signLink: string }> {
  const { to, firstName, requestId, feeType, trigger, adviserName, baseUrl } =
    args;
  const signLink = feeConsentSignDeepLink(requestId, baseUrl);
  const feeLabel = feeType.replace(/_/g, " ");
  const adviserLabel = (adviserName ?? "").trim() || "your adviser";
  const isSupersede = trigger === "supersede";
  const subject = isSupersede
    ? `Action required: review the replacement ${feeLabel} consent for your AMAX Wealth account`
    : `Action required: review and sign your ${feeLabel} consent on AMAX Wealth`;
  const heading = isSupersede
    ? "A replacement fee consent is waiting for your signature"
    : "A new fee consent is waiting for your signature";
  const lead = isSupersede
    ? `Hi ${firstName}, an AMAX Wealth administrator has replaced your existing ${feeLabel} consent and ${adviserLabel} has sent through a fresh request that needs your review and signature. The previous consent has been marked as superseded — no fees will be deducted under the new request until you sign.`
    : `Hi ${firstName}, ${adviserLabel} has sent you a new ${feeLabel} consent to review and sign. No fees will be deducted until you sign.`;

  if (!emailConfigured) {
    console.log(
      `[email] Fee-consent-request notice NOT sent to ${to} — SMTP not configured ` +
        `(request #${requestId}, feeType=${feeType}, trigger=${trigger})`,
    );
    return {
      sent: false,
      error: "SMTP not configured (GMAIL_USER / GMAIL_APP_PASSWORD missing)",
      signLink,
    };
  }

  const transport = createTransport()!;
  try {
    await transport.sendMail({
      from: FROM_HEADER,
      replyTo: REPLY_TO,
      to,
      subject,
      html: `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px">
    <tr><td align="center">
      <table width="540" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:16px;border:1px solid #334155;overflow:hidden">
        <tr><td style="padding:32px 40px 0;text-align:center">
          <span style="font-size:22px;font-weight:700;color:#fff;letter-spacing:2px">AMAX WEALTH</span>
        </td></tr>
        <tr><td style="padding:24px 40px">
          <h1 style="color:#fff;font-size:20px;font-weight:700;margin:0 0 12px">${heading}</h1>
          <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 20px">${lead}</p>
          <div style="text-align:center;margin:0 0 24px">
            <a href="${signLink}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px">
              Review &amp; sign →
            </a>
          </div>
          <p style="color:#94a3b8;font-size:13px;margin:0 0 8px">
            If the button doesn't work, copy and paste this link into your browser:
          </p>
          <p style="color:#0ea5e9;font-size:12px;word-break:break-all;margin:0 0 16px">
            ${signLink}
          </p>
          <p style="color:#64748b;font-size:12px;margin:0">Reference: fee-consent request #${requestId}</p>
        </td></tr>
        <tr><td style="padding:20px 40px;border-top:1px solid #334155;text-align:center">
          <p style="color:#475569;font-size:11px;margin:0">
            AMAX GLOBAL Pty Ltd &nbsp;·&nbsp; ABN 54 690 827 608 &nbsp;·&nbsp; AUSTRAC Registered<br>
            Level 2, 8-12 King Street, Rockdale NSW 2216 &nbsp;·&nbsp; +61 2 8320 1908
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
      text:
        `${lead}\n\n` +
        `Review and sign: ${signLink}\n\n` +
        `Reference: fee-consent request #${requestId}\n\n` +
        `AMAX GLOBAL Pty Ltd`,
    });
    return { sent: true, signLink };
  } catch (err: any) {
    const msg = err?.message || String(err) || "SMTP send failed";
    console.error(
      `[email] Fee-consent-request SMTP send FAILED for ${to} (request #${requestId}):`,
      msg,
    );
    return { sent: false, error: msg, signLink };
  }
}
