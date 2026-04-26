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
