import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/contexts/auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Mail, CheckCircle2, XCircle, ArrowLeft, ArrowRight } from "lucide-react";
import darkBlueLogo from "@assets/AMAX_LOGO_BLUE_1776427512999.jpg";

type LinkStatus = "success" | "expired" | "invalid" | "already" | "error";

export default function VerifyEmail() {
  const [, navigate] = useLocation();
  const { refreshUser, user, isAuthenticated } = useAuth();

  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const linkStatus = (params.get("status") as LinkStatus | null) || null;
  const emailParam = params.get("email") || "";
  const pendingMode = params.get("pending") === "1";

  // Escape hatch: if the signed-in user is already verified (e.g. their application
  // was approved-and-verified, or they were backfilled), don't trap them on this
  // page — the API would reject any new OTP attempt anyway.
  useEffect(() => {
    if (isAuthenticated && user?.emailVerified) {
      navigate("/onboarding", { replace: true });
    }
  }, [isAuthenticated, user, navigate]);

  const [email, setEmail] = useState(emailParam);
  const [otpDigits, setOtpDigits] = useState(["", "", "", "", "", ""]);
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSent, setResendSent] = useState(false);
  const [devOtp, setDevOtp] = useState<string | null>(null);

  useEffect(() => {
    // signup.tsx may stash the dev-mode OTP in sessionStorage
    const stored = sessionStorage.getItem("amax_dev_otp");
    if (stored) {
      setDevOtp(stored);
      sessionStorage.removeItem("amax_dev_otp");
    }
  }, []);

  function setDigit(idx: number, val: string) {
    if (!/^[0-9]?$/.test(val)) return;
    const next = [...otpDigits];
    next[idx] = val;
    setOtpDigits(next);
    setError(null);
    if (val && idx < 5) {
      (document.getElementById(`otp-${idx + 1}`) as HTMLInputElement)?.focus();
    }
  }
  function onKeyDown(idx: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !otpDigits[idx] && idx > 0) {
      (document.getElementById(`otp-${idx - 1}`) as HTMLInputElement)?.focus();
    }
  }
  function onPaste(e: React.ClipboardEvent) {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (pasted.length === 6) {
      e.preventDefault();
      setOtpDigits(pasted.split(""));
      (document.getElementById(`otp-5`) as HTMLInputElement)?.focus();
    }
  }

  async function handleVerify() {
    const code = otpDigits.join("");
    if (code.length < 6) {
      setError("Please enter all 6 digits.");
      return;
    }
    if (!email) {
      setError("Email address is missing. Please return to signup.");
      return;
    }
    setIsVerifying(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), otp: code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Verification failed");
      localStorage.setItem("amax_jwt", data.token);
      await refreshUser();
      navigate("/onboarding", { replace: true });
    } catch (err: any) {
      setError(err.message || "Invalid code. Please try again.");
    } finally {
      setIsVerifying(false);
    }
  }

  async function handleResend() {
    if (!email) {
      setError("Enter your email first.");
      return;
    }
    setResendLoading(true);
    setResendSent(false);
    setError(null);
    try {
      const res = await fetch("/api/auth/resend-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const data = await res.json().catch(() => ({}));
      setOtpDigits(["", "", "", "", "", ""]);
      setResendSent(true);
      if (data?.devOtp) setDevOtp(data.devOtp);
      setTimeout(() => setResendSent(false), 10000);
    } catch {
      setError("Failed to resend. Please try again.");
    } finally {
      setResendLoading(false);
    }
  }

  // ───── Link-click status display (GET /api/auth/verify-email redirects here) ─────
  if (linkStatus && !pendingMode) {
    const config: Record<LinkStatus, { icon: React.ReactNode; title: string; body: string; ok: boolean }> = {
      success: {
        icon: <CheckCircle2 className="w-10 h-10 text-green-600" />,
        title: "Email verified",
        body: "Your email address has been verified. You can now sign in to your account.",
        ok: true,
      },
      already: {
        icon: <CheckCircle2 className="w-10 h-10 text-green-600" />,
        title: "Already verified",
        body: "This email address has already been verified. Sign in to access your account.",
        ok: true,
      },
      expired: {
        icon: <XCircle className="w-10 h-10 text-amber-600" />,
        title: "Link expired",
        body: "This verification link has expired. Request a new code below.",
        ok: false,
      },
      invalid: {
        icon: <XCircle className="w-10 h-10 text-red-600" />,
        title: "Invalid link",
        body: "This verification link isn't valid. It may have already been used.",
        ok: false,
      },
      error: {
        icon: <XCircle className="w-10 h-10 text-red-600" />,
        title: "Something went wrong",
        body: "We couldn't verify your email. Please try again or contact support.",
        ok: false,
      },
    };
    const c = config[linkStatus];

    return (
      <div className="min-h-screen bg-blue-50 flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center">
            <div className="flex items-center justify-center gap-3 mb-4">
              <img src={darkBlueLogo} alt="AMAX Wealth" className="w-10 h-10 rounded-lg" />
              <span className="text-2xl font-bold text-blue-900">AMAX WEALTH</span>
            </div>
          </div>
          <Card className="bg-white border-blue-100 shadow-sm">
            <CardContent className="pt-8 pb-8 text-center space-y-4">
              <div className="flex justify-center">{c.icon}</div>
              <h1 className="text-2xl font-bold text-blue-900">{c.title}</h1>
              <p className="text-blue-700 max-w-sm mx-auto">{c.body}</p>
              {c.ok ? (
                <Button onClick={() => navigate("/login")} className="bg-sky-500 hover:bg-sky-600 text-white font-semibold">
                  Sign in <ArrowRight className="w-4 h-4 ml-1" />
                </Button>
              ) : linkStatus === "expired" && emailParam ? (
                <Button onClick={handleResend} disabled={resendLoading} className="bg-sky-500 hover:bg-sky-600 text-white font-semibold">
                  {resendLoading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending…</> : "Send a new code"}
                </Button>
              ) : (
                <Button onClick={() => navigate("/login")} variant="outline" className="border-blue-200 text-blue-900">
                  Back to sign in
                </Button>
              )}
              {resendSent && <p className="text-sm text-green-600">A new code has been sent.</p>}
            </CardContent>
          </Card>
          <Link href="/" className="flex items-center justify-center gap-2 text-sm text-blue-900 hover:text-blue-700">
            <ArrowLeft className="w-4 h-4" /> Back to Home
          </Link>
        </div>
      </div>
    );
  }

  // ───── Interactive OTP entry (post-signup) ─────
  return (
    <div className="min-h-screen bg-blue-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <div className="flex items-center justify-center gap-3 mb-4">
            <img src={darkBlueLogo} alt="AMAX Wealth" className="w-10 h-10 rounded-lg" />
            <span className="text-2xl font-bold text-blue-900">AMAX WEALTH</span>
          </div>
        </div>

        <Card className="bg-white border-blue-100 shadow-sm">
          <CardContent className="pt-8 pb-6 text-center space-y-5">
            <div className="flex flex-col items-center gap-3">
              <div className="w-16 h-16 rounded-full bg-sky-50 border border-sky-200 flex items-center justify-center">
                <Mail className="w-8 h-8 text-sky-600" />
              </div>
              <h1 className="text-2xl font-bold text-blue-900">Check your inbox</h1>
              <p className="text-sm text-blue-700 max-w-xs">
                We've sent a 6-digit code to{" "}
                <span className="text-blue-900 font-semibold">{email || "your email"}</span>. Enter it below to activate your account.
              </p>
            </div>

            {!email && (
              <div className="text-left space-y-1.5">
                <label className="text-blue-900 text-sm font-medium">Email address</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full px-3 py-2 rounded-md bg-white border border-blue-200 text-blue-900 placeholder:text-gray-400 focus:border-sky-500 focus:outline-none"
                />
              </div>
            )}

            <div className="flex justify-center gap-2" onPaste={onPaste}>
              {otpDigits.map((d, i) => (
                <input
                  key={i}
                  id={`otp-${i}`}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={d}
                  onChange={(e) => setDigit(i, e.target.value)}
                  onKeyDown={(e) => onKeyDown(i, e)}
                  autoFocus={i === 0}
                  className="w-11 h-14 text-center text-2xl font-bold bg-white border border-blue-200 rounded-xl text-blue-900 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/30 transition-all"
                />
              ))}
            </div>

            {devOtp && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
                <p className="text-amber-800 font-semibold text-xs uppercase tracking-wider mb-1">Demo mode — email not configured</p>
                <p className="text-amber-900 font-mono text-2xl tracking-widest font-bold">{devOtp}</p>
                <p className="text-amber-700 text-xs mt-1">Configure GMAIL_USER & GMAIL_APP_PASSWORD to send real emails.</p>
              </div>
            )}

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {resendSent && <p className="text-sm text-green-600">New code sent — check your inbox.</p>}

            <Button
              onClick={handleVerify}
              disabled={isVerifying || otpDigits.join("").length < 6}
              className="w-full bg-sky-500 hover:bg-sky-600 text-white font-semibold h-11"
            >
              {isVerifying ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying…</> : <>Verify my account <ArrowRight className="w-4 h-4 ml-1" /></>}
            </Button>

            <p className="text-xs text-blue-700">
              Didn't receive a code? Check spam or{" "}
              <button
                type="button"
                onClick={handleResend}
                disabled={resendLoading}
                className="text-sky-700 underline hover:text-sky-800 disabled:opacity-50"
              >
                {resendLoading ? "Sending…" : "resend the code"}
              </button>
            </p>
          </CardContent>
        </Card>

        <Link href="/" className="flex items-center justify-center gap-2 text-sm text-blue-900 hover:text-blue-700">
          <ArrowLeft className="w-4 h-4" /> Back to Home
        </Link>
      </div>
    </div>
  );
}
