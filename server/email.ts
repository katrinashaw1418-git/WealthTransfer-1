import nodemailer from "nodemailer";

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;

export const emailConfigured = !!(GMAIL_USER && GMAIL_PASS);

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
    from: '"AMAX Wealth" <info@amaxglobal.com.au>',
    replyTo: "info@amaxglobal.com.au",
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
