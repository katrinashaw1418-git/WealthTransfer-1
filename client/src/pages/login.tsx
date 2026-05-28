import { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/contexts/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Shield, Mail, ArrowLeft, ArrowRight, CheckCircle2 } from "lucide-react";
import { GoogleLogin } from "@react-oauth/google";

const GOOGLE_ENABLED = Boolean(import.meta.env.VITE_GOOGLE_CLIENT_ID);

export default function Login() {
  const { login, isAuthenticated, refreshUser } = useAuth();
  const [, navigate] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);

  async function handleGoogleCredential(credential: string) {
    setIsGoogleLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential, mode: "login" }),
      });
      const data = await res.json();
      if (res.status === 404 && data?.code === "NO_ACCOUNT") {
        setError("No account found for this Google email. Please sign up first.");
        setTimeout(() => navigate("/register"), 1800);
        return;
      }
      if (!res.ok) throw new Error(data.error || "Google sign-in failed");
      localStorage.setItem("amax_jwt", data.token);
      await refreshUser();
      navigate(data?.user?.kycStatus === "verified" ? "/dashboard" : "/compliance");
    } catch (err: any) {
      setError(err.message || "Google sign-in failed. Please try again.");
    } finally {
      setIsGoogleLoading(false);
    }
  }

  // Email verification / passwordless sign-in state.
  // `unverifiedEmail` is set in two scenarios:
  //   1. Password login was blocked because the email is not yet verified, OR
  //   2. The user chose "Email me a sign-in code" (passwordless login).
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [otpDigits, setOtpDigits] = useState(["", "", "", "", "", ""]);
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSent, setResendSent] = useState(false);
  const [passwordlessMode, setPasswordlessMode] = useState(false);
  const [emailForCode, setEmailForCode] = useState("");
  const [requestingCode, setRequestingCode] = useState(false);

  useEffect(() => {
    if (isAuthenticated) {
      navigate("/dashboard");
    }
  }, [isAuthenticated]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      await login(username, password);
    } catch (err: any) {
      if (err.code === "email_not_verified") {
        setUnverifiedEmail(err.email || "");
        setOtpDigits(["", "", "", "", "", ""]);
        setOtpError(null);
      } else {
        setError(err.message || "Login failed. Please try again.");
      }
    } finally {
      setIsLoading(false);
    }
  }

  function handleOtpChange(idx: number, val: string) {
    if (!/^[0-9]?$/.test(val)) return;
    const next = [...otpDigits];
    next[idx] = val;
    setOtpDigits(next);
    setOtpError(null);
    if (val && idx < 5) {
      (document.getElementById(`otp-login-${idx + 1}`) as HTMLInputElement)?.focus();
    }
  }

  function handleOtpKeyDown(idx: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !otpDigits[idx] && idx > 0) {
      (document.getElementById(`otp-login-${idx - 1}`) as HTMLInputElement)?.focus();
    }
    if (e.key === "ArrowLeft" && idx > 0) {
      (document.getElementById(`otp-login-${idx - 1}`) as HTMLInputElement)?.focus();
    }
    if (e.key === "ArrowRight" && idx < 5) {
      (document.getElementById(`otp-login-${idx + 1}`) as HTMLInputElement)?.focus();
    }
  }

  function handleOtpPaste(e: React.ClipboardEvent) {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (pasted.length === 6) {
      e.preventDefault();
      setOtpDigits(pasted.split(""));
      (document.getElementById(`otp-login-5`) as HTMLInputElement)?.focus();
    }
  }

  async function handleVerifyOtp() {
    const code = otpDigits.join("");
    if (code.length < 6) { setOtpError("Please enter all 6 digits."); return; }
    setIsVerifyingOtp(true);
    setOtpError(null);
    try {
      const res = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: unverifiedEmail, otp: code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Verification failed");
      localStorage.setItem("amax_jwt", data.token);
      window.location.href = "/dashboard";
    } catch (err: any) {
      setOtpError(err.message || "Invalid code. Please try again.");
    } finally {
      setIsVerifyingOtp(false);
    }
  }

  async function handleResend() {
    if (!unverifiedEmail) return;
    setResendLoading(true);
    setResendSent(false);
    setOtpError(null);
    try {
      const res = await fetch("/api/auth/resend-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: unverifiedEmail }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not resend the code.");
      }
      setOtpDigits(["", "", "", "", "", ""]);
      setResendSent(true);
      setTimeout(() => setResendSent(false), 10000);
    } catch (err: any) {
      setOtpError(err.message || "Could not resend the code.");
    } finally {
      setResendLoading(false);
    }
  }

  // Passwordless: request a sign-in code for an email
  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    if (!emailForCode.trim()) return;
    setError(null);
    setRequestingCode(true);
    try {
      const res = await fetch("/api/auth/resend-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailForCode.trim().toLowerCase() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not send sign-in code.");
      }
      setUnverifiedEmail(emailForCode.trim().toLowerCase());
      setOtpDigits(["", "", "", "", "", ""]);
      setOtpError(null);
    } catch (err: any) {
      setError(err.message || "Could not send sign-in code.");
    } finally {
      setRequestingCode(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: "#002366" }}>
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-3 mb-4">
            <img src="/amax-global-fx-logo.png" alt="AMAX Global FX" className="h-10 w-auto" />
          </div>
          <h1 className="text-3xl font-bold text-white">Welcome back</h1>
          <p className="text-slate-400">Sign in to your wealth management platform</p>
        </div>

        {/* ── PASSWORDLESS REQUEST-CODE SCREEN ── */}
        {passwordlessMode && !unverifiedEmail ? (
          <Card className="bg-white border-slate-200 shadow-xl">
            <CardHeader>
              <CardTitle className="text-slate-900">Sign in with email code</CardTitle>
              <CardDescription className="text-slate-600">
                Enter your email and we'll send you a 6-digit sign-in code.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleRequestCode} className="space-y-4">
                {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
                <div className="space-y-2">
                  <Label htmlFor="emailForCode" className="text-slate-300">Email address</Label>
                  <Input
                    id="emailForCode"
                    type="email"
                    value={emailForCode}
                    onChange={(e) => setEmailForCode(e.target.value)}
                    placeholder="you@example.com"
                    required
                    autoComplete="email"
                    className="bg-white border-slate-300 text-slate-900 placeholder:text-slate-400 focus:border-[#002366]"
                  />
                </div>
                <Button type="submit" disabled={requestingCode} className="w-full bg-white hover:bg-slate-100 text-slate-900 font-semibold">
                  {requestingCode
                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending code…</>
                    : <>Send sign-in code <ArrowRight className="w-4 h-4 ml-1" /></>}
                </Button>
                <button
                  type="button"
                  onClick={() => { setPasswordlessMode(false); setError(null); }}
                  className="w-full text-xs text-slate-400 hover:text-white transition-colors"
                >
                  ← Back to password sign-in
                </button>
              </form>
            </CardContent>
          </Card>
        ) : unverifiedEmail ? (
          <div className="bg-white border border-slate-200 shadow-xl rounded-2xl p-6 space-y-6 text-center">
            <div className="flex flex-col items-center gap-3">
              <div className="w-16 h-16 rounded-full bg-[#002366]/10 border border-[#002366]/20 flex items-center justify-center">
                <Mail className="w-8 h-8 text-[#002366]" />
              </div>
              <h2 className="text-xl font-bold text-slate-900">
                {passwordlessMode ? "Enter your sign-in code" : "Verify your email"}
              </h2>
              <p className="text-sm text-slate-600 max-w-xs">
                {passwordlessMode
                  ? <>We sent a 6-digit sign-in code to <span className="text-slate-900 font-medium">{unverifiedEmail}</span>.</>
                  : <>Your account is not yet verified. Enter the 6-digit code sent to <span className="text-slate-900 font-medium">{unverifiedEmail}</span>.</>}
              </p>
            </div>

            <div className="flex justify-center gap-2" onPaste={handleOtpPaste}>
              {otpDigits.map((d, i) => (
                <input
                  key={i}
                  id={`otp-login-${i}`}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={d}
                  onChange={e => handleOtpChange(i, e.target.value)}
                  onKeyDown={e => handleOtpKeyDown(i, e)}
                  autoFocus={i === 0}
                  className="w-11 h-14 text-center text-2xl font-bold bg-white border border-slate-300 rounded-xl text-slate-900 focus:border-[#002366] focus:outline-none focus:ring-2 focus:ring-[#002366]/30 transition-all"
                />
              ))}
            </div>

            {otpError && <p className="text-sm text-red-600">{otpError}</p>}
            {resendSent && (
              <p className="text-sm text-green-600 flex items-center justify-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" /> New code sent — check your inbox.
              </p>
            )}

            <Button
              className="w-full bg-[#002366] hover:bg-[#012a6e] text-white font-semibold"
              onClick={handleVerifyOtp}
              disabled={isVerifyingOtp || otpDigits.join("").length < 6}
            >
              {isVerifyingOtp
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying…</>
                : <>Activate account <ArrowRight className="w-4 h-4 ml-1" /></>}
            </Button>

            <p className="text-xs text-slate-500">
              Didn't receive a code? Check your spam folder or{" "}
              <button
                className="text-[#002366] underline hover:text-[#012a6e]"
                disabled={resendLoading}
                onClick={handleResend}
              >
                {resendLoading ? "Sending…" : "resend the code"}
              </button>
            </p>

            <button
              className="text-xs text-slate-500 hover:text-slate-700 transition-colors"
              onClick={() => setUnverifiedEmail(null)}
            >
              ← Back to sign in
            </button>
          </div>
        ) : (
          /* ── SIGN IN FORM ── */
          <Card className="bg-white border-slate-200 shadow-xl">
            <CardHeader>
              <CardTitle className="text-slate-900">Sign In</CardTitle>
              <CardDescription className="text-slate-600">
                Enter your credentials to access your portfolio
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2">
                  <Label htmlFor="username" className="text-slate-700">Username</Label>
                  <Input
                    id="username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Enter your username"
                    required
                    autoComplete="username"
                    className="bg-white border-slate-300 text-slate-900 placeholder:text-slate-400 focus:border-[#002366]"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password" className="text-slate-700">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    required
                    autoComplete="current-password"
                    className="bg-white border-slate-300 text-slate-900 placeholder:text-slate-400 focus:border-[#002366]"
                  />
                </div>

                <Button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-[#002366] hover:bg-[#012a6e] text-white font-semibold"
                >
                  {isLoading ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Signing in...</>
                  ) : (
                    "Sign In"
                  )}
                </Button>

                {GOOGLE_ENABLED && (
                  <>
                    <div className="relative my-2">
                      <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-slate-200" />
                      </div>
                      <div className="relative flex justify-center text-xs">
                        <span className="bg-white px-2 text-slate-500">or</span>
                      </div>
                    </div>
                    <div className="w-full flex justify-center">
                      {isGoogleLoading ? (
                        <div className="flex items-center justify-center text-sm text-slate-600 py-3">
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />Signing in with Google...
                        </div>
                      ) : (
                        <GoogleLogin
                          onSuccess={(credentialResponse) => {
                            if (credentialResponse.credential) {
                              handleGoogleCredential(credentialResponse.credential);
                            } else {
                              setError("Google sign-in failed — no credential returned.");
                            }
                          }}
                          onError={() => setError("Google sign-in was cancelled or failed.")}
                          theme="outline"
                          size="large"
                          text="signin_with"
                          shape="rectangular"
                          width="400"
                        />
                      )}
                    </div>
                  </>
                )}

                <button
                  type="button"
                  onClick={() => { setError(null); setEmailForCode(""); setPasswordlessMode(true); }}
                  className="w-full text-sm text-[#002366] hover:text-[#012a6e] underline underline-offset-2 transition-colors"
                >
                  Sign in with email code instead
                </button>

                <div className="text-center space-y-2">
                  <Link href="/forgot-password" className="text-sm text-[#002366] hover:text-[#012a6e] transition-colors block font-medium">
                    Forgot your password?
                  </Link>
                  <p className="text-sm text-slate-600">
                    Don't have an account?{" "}
                    <Link href="/register" className="text-[#002366] underline underline-offset-2 hover:text-[#012a6e] font-medium">
                      Create one
                    </Link>
                  </p>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        <div className="text-center">
          <Link href="/" className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white text-sm transition-colors">
            <ArrowLeft className="w-4 h-4" /> Back to home
          </Link>
        </div>

        <div className="flex items-center gap-2 text-slate-500 text-sm justify-center">
          <Shield className="w-4 h-4" />
          <span>256-bit encrypted · JWT authenticated · Audit logged</span>
        </div>
      </div>
    </div>
  );
}
