import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/contexts/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Loader2, Shield, Mail, CheckCircle2,
  ArrowRight, ArrowLeft, ChevronRight, X,
  TrendingUp, Bitcoin, Check,
} from "lucide-react";
import { GoogleLogin } from "@react-oauth/google";
import { SiGoogle } from "react-icons/si";

const GOOGLE_ENABLED = Boolean(import.meta.env.VITE_GOOGLE_CLIENT_ID);

type Step = "method" | "details" | "verify" | "services";

const COUNTRY_CODES: { code: string; dial: string; flag: string; name: string }[] = [
  { code: "AU", dial: "+61",  flag: "🇦🇺", name: "Australia" },
  { code: "NZ", dial: "+64",  flag: "🇳🇿", name: "New Zealand" },
  { code: "US", dial: "+1",   flag: "🇺🇸", name: "United States" },
  { code: "GB", dial: "+44",  flag: "🇬🇧", name: "United Kingdom" },
  { code: "CA", dial: "+1",   flag: "🇨🇦", name: "Canada" },
  { code: "CN", dial: "+86",  flag: "🇨🇳", name: "China" },
  { code: "HK", dial: "+852", flag: "🇭🇰", name: "Hong Kong" },
  { code: "TW", dial: "+886", flag: "🇹🇼", name: "Taiwan" },
  { code: "SG", dial: "+65",  flag: "🇸🇬", name: "Singapore" },
  { code: "MY", dial: "+60",  flag: "🇲🇾", name: "Malaysia" },
  { code: "JP", dial: "+81",  flag: "🇯🇵", name: "Japan" },
  { code: "KR", dial: "+82",  flag: "🇰🇷", name: "South Korea" },
  { code: "IN", dial: "+91",  flag: "🇮🇳", name: "India" },
  { code: "ID", dial: "+62",  flag: "🇮🇩", name: "Indonesia" },
  { code: "PH", dial: "+63",  flag: "🇵🇭", name: "Philippines" },
  { code: "TH", dial: "+66",  flag: "🇹🇭", name: "Thailand" },
  { code: "VN", dial: "+84",  flag: "🇻🇳", name: "Vietnam" },
  { code: "AE", dial: "+971", flag: "🇦🇪", name: "United Arab Emirates" },
  { code: "DE", dial: "+49",  flag: "🇩🇪", name: "Germany" },
  { code: "FR", dial: "+33",  flag: "🇫🇷", name: "France" },
  { code: "IT", dial: "+39",  flag: "🇮🇹", name: "Italy" },
  { code: "ES", dial: "+34",  flag: "🇪🇸", name: "Spain" },
  { code: "CH", dial: "+41",  flag: "🇨🇭", name: "Switzerland" },
];

const SERVICES = [
  {
    value: "fx",
    icon: TrendingUp,
    title: "FX & Transfers",
    description: "Send and receive international payments at live exchange rates with full AUD settlement.",
  },
  {
    value: "digital-asset-fx",
    icon: Bitcoin,
    title: "Digital Assets",
    description: "Exchange and transfer Bitcoin, Ethereum and supported stablecoins.",
  },
];

function StepDots({ step }: { step: Step }) {
  const order: Step[] = ["method", "details", "verify", "services"];
  const labels = ["Method", "Details", "Verify", "Services"];
  const idx = order.indexOf(step);
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {order.map((s, i) => (
        <div key={s} className="flex items-center gap-2">
          <div className={`flex items-center justify-center rounded-full transition-all duration-300 ${
            i < idx
              ? "w-7 h-7 bg-green-500 text-white text-xs font-bold"
              : i === idx
              ? "w-7 h-7 bg-white text-slate-900 text-xs font-bold"
              : "w-6 h-6 bg-slate-700 text-slate-500 text-xs"
          }`}>
            {i < idx ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
          </div>
          <span className={`text-xs hidden sm:block ${i === idx ? "text-white font-medium" : "text-slate-600"}`}>
            {labels[i]}
          </span>
          {i < order.length - 1 && (
            <div className={`w-6 h-px mx-0.5 ${i < idx ? "bg-green-500" : "bg-slate-700"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

export default function Register() {
  const { refreshUser } = useAuth();
  const [, navigate] = useLocation();

  const [step, setStep] = useState<Step>("method");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [socialNotice, setSocialNotice] = useState<"google" | null>(null);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName]   = useState("");
  const [email, setEmail]         = useState("");
  const [mobileDial, setMobileDial] = useState("+61");
  const [mobile, setMobile]         = useState("");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [otpDigits, setOtpDigits] = useState(["", "", "", "", "", ""]);
  const [isVerifying, setIsVerifying] = useState(false);
  const [resendSent, setResendSent] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [devOtp, setDevOtp] = useState<string | null>(null);

  function handleOtpChange(idx: number, val: string) {
    if (!/^[0-9]?$/.test(val)) return;
    const next = [...otpDigits];
    next[idx] = val;
    setOtpDigits(next);
    setError(null);
    if (val && idx < 5) {
      (document.getElementById(`otp-reg-${idx + 1}`) as HTMLInputElement)?.focus();
    }
  }

  function handleOtpKeyDown(idx: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !otpDigits[idx] && idx > 0) {
      (document.getElementById(`otp-reg-${idx - 1}`) as HTMLInputElement)?.focus();
    }
    if (e.key === "ArrowLeft" && idx > 0) {
      (document.getElementById(`otp-reg-${idx - 1}`) as HTMLInputElement)?.focus();
    }
    if (e.key === "ArrowRight" && idx < 5) {
      (document.getElementById(`otp-reg-${idx + 1}`) as HTMLInputElement)?.focus();
    }
  }

  function handleOtpPaste(e: React.ClipboardEvent) {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (pasted.length === 6) {
      e.preventDefault();
      setOtpDigits(pasted.split(""));
      (document.getElementById(`otp-reg-5`) as HTMLInputElement)?.focus();
    }
  }

  async function handleVerifyOtp() {
    const code = otpDigits.join("");
    if (code.length < 6) { setError("Please enter all 6 digits."); return; }
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
      setStep("services");
    } catch (err: any) {
      setError(err.message || "Invalid code. Please try again.");
    } finally {
      setIsVerifying(false);
    }
  }

  async function handleResend() {
    setResendLoading(true);
    setResendSent(false);
    setError(null);
    try {
      const res = await fetch("/api/auth/resend-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not resend the code. Please try again.");
      }
      setOtpDigits(["", "", "", "", "", ""]);
      setResendSent(true);
      setTimeout(() => setResendSent(false), 10000);
    } catch (err: any) {
      setError(err.message || "Could not resend the code.");
    } finally {
      setResendLoading(false);
    }
  }

  function toggleService(v: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(v) ? next.delete(v) : next.add(v);
      return next;
    });
  }

  async function handleDetailsSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!firstName.trim() || !lastName.trim()) { setError("Please enter your full name."); return; }
    const mobileDigits = mobile.replace(/\D/g, "");
    if (!mobileDigits || mobileDigits.length < 6) {
      setError("Please enter a valid mobile number.");
      return;
    }
    const fullPhone = `${mobileDial}${mobileDigits}`;
    setIsLoading(true);
    try {
      const res = await fetch("/api/auth/phone/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: fullPhone,
          email: email.trim(),
          firstName: firstName.trim(),
          lastName: lastName.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Registration failed");
      // SECURITY: token is only issued after OTP verification — see /api/auth/verify-otp
      if (data.devOtp) setDevOtp(data.devOtp);
      setOtpDigits(["", "", "", "", "", ""]);
      setStep("verify");
    } catch (err: any) {
      setError(err.message || "Registration failed. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleServicesSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (selected.size === 0) { setError("Please select at least one service."); return; }
    navigate("/compliance");
  }

  const socialNotices: Record<string, string> = {
    google: "Google sign-in is coming soon. Please use email registration for now.",
  };

  async function handleGoogleCredential(credential: string) {
    setIsLoading(true);
    setError(null);
    setSocialNotice(null);
    try {
      const res = await fetch("/api/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential, mode: "register" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Google sign-in failed");
      localStorage.setItem("amax_jwt", data.token);
      await refreshUser();
      if (data.createdNew) {
        setStep("services");
      } else {
        navigate(data?.user?.kycStatus === "verified" ? "/dashboard" : "/compliance");
      }
    } catch (err: any) {
      setError(err.message || "Google sign-in failed. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: "#002366" }}>
      <div className="w-full max-w-md">

        {/* Logo */}
        <div className="text-center mb-6">
          <div className="flex items-center justify-center gap-3 mb-4">
            <img src="/amax-global-fx-logo.png" alt="AMAX Global FX" className="h-10 w-auto" />
          </div>
          <StepDots step={step} />
        </div>

        {/* ── METHOD SELECTION ─────────────────────────────────────────────── */}
        {step === "method" && (
          <div className="bg-white border border-slate-200 shadow-xl rounded-2xl p-6 space-y-4">
            <div className="mb-1">
              <h2 className="text-xl font-bold text-slate-900">Create your account</h2>
              <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">
                Secure access to FX, multi-currency accounts, digital assets, and investment services.
              </p>
              <p className="text-sm text-slate-600 mt-3">
                Already have an account?{" "}
                <Link href="/login" className="text-[#002366] font-medium underline underline-offset-2 hover:text-[#012a6e]">Sign in</Link>
              </p>
            </div>

            {socialNotice && (
              <Alert className="bg-amber-50 border-amber-200 text-amber-800">
                <AlertDescription className="flex items-start justify-between gap-2">
                  <span className="text-sm">{socialNotices[socialNotice]}</span>
                  <button onClick={() => setSocialNotice(null)} className="shrink-0 mt-0.5">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </AlertDescription>
              </Alert>
            )}

            {/* Email — primary */}
            <button
              onClick={() => { setSocialNotice(null); setStep("details"); }}
              className="w-full h-11 flex items-center justify-center gap-2 px-4 rounded-md bg-[#002366] text-white hover:bg-[#012a6e] transition-all font-semibold text-sm"
            >
              <Mail className="w-5 h-5" />
              <span>Continue with Email</span>
            </button>

            {/* Google */}
            {GOOGLE_ENABLED ? (
              <div className="w-full flex justify-center">
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
                  text="continue_with"
                  shape="rectangular"
                  width="400"
                />
              </div>
            ) : (
              <button
                onClick={() => setSocialNotice("google")}
                className="w-full h-11 flex items-center justify-center gap-2 px-4 rounded-md bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 transition-all font-medium text-sm"
              >
                <SiGoogle className="w-5 h-5" />
                <span>Continue with Google</span>
                <span className="ml-1 text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded font-medium">soon</span>
              </button>
            )}

            <p className="text-xs text-slate-500 text-center leading-relaxed pt-2">
              By creating an account, you agree to our{" "}
              <Link href="/terms" className="underline text-slate-600 hover:text-slate-800">Terms</Link>
              {" "}and{" "}
              <Link href="/privacy-policy" className="underline text-slate-600 hover:text-slate-800">Privacy Policy</Link>.
              Identity verification is required to activate regulated services.
            </p>
          </div>
        )}

        {/* ── DETAILS ──────────────────────────────────────────────────────── */}
        {step === "details" && (
          <div className="bg-white border border-slate-200 shadow-xl rounded-2xl p-6 space-y-5">
            <div className="flex items-center gap-3">
              <button
                onClick={() => { setError(null); setStep("method"); }}
                className="w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-600 hover:text-slate-900 transition-all"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <div>
                <h2 className="text-xl font-bold text-slate-900">Enter your details</h2>
                <p className="text-xs text-slate-600">We'll email you a verification code next.</p>
              </div>
            </div>

            <form onSubmit={handleDetailsSubmit} className="space-y-4">
              {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="firstName" className="text-slate-700 text-sm">First name</Label>
                  <Input id="firstName" value={firstName} onChange={e => setFirstName(e.target.value)}
                    placeholder="Jane" required autoComplete="given-name"
                    className="bg-white border-slate-300 text-slate-900 placeholder:text-slate-400 focus:border-[#002366]" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lastName" className="text-slate-700 text-sm">Last name</Label>
                  <Input id="lastName" value={lastName} onChange={e => setLastName(e.target.value)}
                    placeholder="Smith" required autoComplete="family-name"
                    className="bg-white border-slate-300 text-slate-900 placeholder:text-slate-400 focus:border-[#002366]" />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-slate-700 text-sm">Email address</Label>
                <Input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="jane@example.com" required autoComplete="email"
                  className="bg-white border-slate-300 text-slate-900 placeholder:text-slate-400 focus:border-[#002366]" />
                <p className="text-xs text-slate-500">Your verification code will be sent to this email address.</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="mobile" className="text-slate-700 text-sm">Mobile number</Label>
                <div className="flex gap-2">
                  <Select value={mobileDial} onValueChange={setMobileDial}>
                    <SelectTrigger
                      className="w-[130px] bg-white border-slate-300 text-slate-900 focus:border-[#002366]"
                      aria-label="Country code"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-white border-slate-200 text-slate-900 max-h-72">
                      {COUNTRY_CODES.map(c => (
                        <SelectItem
                          key={`${c.code}-${c.dial}`}
                          value={c.dial}
                          className="text-slate-900 focus:bg-slate-100 focus:text-slate-900"
                        >
                          <span className="inline-flex items-center gap-2">
                            <span className="text-base leading-none">{c.flag}</span>
                            <span className="font-mono text-sm">{c.dial}</span>
                            <span className="text-xs text-slate-500">{c.name}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input id="mobile" type="tel" value={mobile} onChange={e => setMobile(e.target.value)}
                    placeholder="412 345 678" required autoComplete="tel-national"
                    className="flex-1 bg-white border-slate-300 text-slate-900 placeholder:text-slate-400 focus:border-[#002366]" />
                </div>
                <p className="text-xs text-slate-500">Used for account contact and compliance records.</p>
              </div>

              <Button type="submit" disabled={isLoading} className="w-full bg-[#002366] hover:bg-[#012a6e] text-white font-semibold">
                {isLoading
                  ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending code…</>
                  : <>Send verification code <ArrowRight className="w-4 h-4 ml-1" /></>}
              </Button>
            </form>
          </div>
        )}

        {/* ── EMAIL VERIFICATION ───────────────────────────────────────────── */}
        {step === "verify" && (
          <div className="bg-white border border-slate-200 shadow-xl rounded-2xl p-6 space-y-6 text-center">
            <div className="flex flex-col items-center gap-3">
              <div className="w-16 h-16 rounded-full bg-[#002366]/10 border border-[#002366]/20 flex items-center justify-center">
                <Mail className="w-8 h-8 text-[#002366]" />
              </div>
              <h2 className="text-xl font-bold text-slate-900">Verify your email</h2>
              <p className="text-sm text-slate-600 max-w-xs">
                We sent a 6-digit verification code to{" "}
                <span className="text-slate-900 font-medium">{email}</span>.
              </p>
              <p className="text-xs text-slate-500">Please enter the code below to continue.</p>
            </div>

            <div className="flex justify-center gap-2" onPaste={handleOtpPaste}>
              {otpDigits.map((d, i) => (
                <input
                  key={i}
                  id={`otp-reg-${i}`}
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

            {devOtp && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm">
                <p className="text-amber-700 font-semibold text-xs uppercase tracking-wider mb-1">Demo mode — email not sent</p>
                <p className="text-slate-900 font-mono text-2xl tracking-widest font-bold">{devOtp}</p>
                <p className="text-amber-700/80 text-xs mt-1">Configure GMAIL_USER & GMAIL_APP_PASSWORD to send real emails.</p>
              </div>
            )}

            {error && <p className="text-sm text-red-600">{error}</p>}
            {resendSent && <p className="text-sm text-green-600">New code sent — check your inbox.</p>}

            <Button
              className="w-full bg-[#002366] hover:bg-[#012a6e] text-white font-semibold"
              onClick={handleVerifyOtp}
              disabled={isVerifying || otpDigits.join("").length < 6}
            >
              {isVerifying ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying…</> : <>Verify and continue <ArrowRight className="w-4 h-4 ml-1" /></>}
            </Button>

            <Button
              type="button"
              variant="outline"
              className="w-full border-[#002366]/30 text-[#002366] hover:bg-[#002366]/5 hover:text-[#002366] font-medium"
              onClick={handleResend}
              disabled={resendLoading}
            >
              {resendLoading
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending…</>
                : <><Mail className="w-4 h-4 mr-2" />Send verification code again</>}
            </Button>

            <div className="text-center">
              <button
                className="text-xs text-slate-500 underline hover:text-slate-700"
                onClick={() => { setError(null); setOtpDigits(["", "", "", "", "", ""]); setStep("details"); }}
              >
                Change email address
              </button>
            </div>
          </div>
        )}

        {/* ── SERVICE SELECTION ────────────────────────────────────────────── */}
        {step === "services" && (
          <div className="bg-white border border-slate-200 shadow-xl rounded-2xl p-6 space-y-5">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Select your services</h2>
              <p className="text-xs text-slate-600 mt-1">
                This helps us tailor your account setup and meet regulatory requirements.
              </p>
            </div>

            <form onSubmit={handleServicesSubmit} className="space-y-4">
              {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

              <div className="space-y-3">
                {SERVICES.map(({ value, icon: Icon, title, description }) => {
                  const active = selected.has(value);
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => toggleService(value)}
                      className={`w-full text-left flex items-start gap-4 p-4 rounded-xl border-2 transition-all ${
                        active
                          ? "border-[#002366] bg-[#002366]/5"
                          : "border-slate-200 bg-slate-50 hover:border-slate-300"
                      }`}
                    >
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-all ${
                        active ? "bg-[#002366] text-white" : "bg-slate-200 text-slate-600"
                      }`}>
                        <Icon className="w-5 h-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-semibold mb-1 ${active ? "text-[#002366]" : "text-slate-900"}`}>
                          {title}
                        </div>
                        <div className="text-xs text-slate-600 leading-relaxed">{description}</div>
                      </div>
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-all ${
                        active ? "border-[#002366] bg-[#002366]" : "border-slate-300"
                      }`}>
                        {active && <Check className="w-3 h-3 text-white" />}
                      </div>
                    </button>
                  );
                })}
              </div>

              <Button type="submit" className="w-full bg-[#002366] hover:bg-[#012a6e] text-white font-semibold mt-2">
                Continue <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            </form>
          </div>
        )}

        <div className="text-center mt-6">
          <Link href="/" className="inline-flex items-center gap-1.5 text-white/70 hover:text-white text-sm transition-colors">
            <ArrowLeft className="w-4 h-4" /> Back to home
          </Link>
        </div>

        <div className="flex items-center gap-2 text-white/60 text-xs justify-center mt-4">
          <Shield className="w-3.5 h-3.5" />
          <span>256-bit encryption · AUSTRAC-registered · ABN 54 690 827 608</span>
        </div>

      </div>
    </div>
  );
}
