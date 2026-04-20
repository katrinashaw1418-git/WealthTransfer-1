import { useState, useEffect, useRef } from "react";
import { useLocation, Link } from "wouter";
import { trackEvent } from "@/lib/funnel";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, ArrowLeft, CheckCircle2 } from "lucide-react";
import darkBlueLogo from "@assets/AMAX_LOGO_BLUE_1776427512999.jpg";

export default function Apply() {
  const [, navigate] = useLocation();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState("Australia");
  const [accountType, setAccountType] = useState("");
  const [entityName, setEntityName] = useState("");
  const [abn, setAbn] = useState("");
  const [intendedUse, setIntendedUse] = useState("");
  const [consentOwn, setConsentOwn] = useState(false);
  const [consentAml, setConsentAml] = useState(false);
  const [consentContact, setConsentContact] = useState(false);
  const [consentAdvice, setConsentAdvice] = useState(false);

  const isEntity = ["company", "trust", "smsf"].includes(accountType);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // Email verification step that runs *after* application submit, *before* approval
  const [verifyStep, setVerifyStep] = useState(false);
  const [otp, setOtp] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendNotice, setResendNotice] = useState<string | null>(null);

  const applyStartedFired = useRef(false);
  useEffect(() => {
    if (applyStartedFired.current) return;
    applyStartedFired.current = true;
    trackEvent("apply_started");
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!consentOwn || !consentAml || !consentContact || !consentAdvice) {
      setError("Please confirm all compliance acknowledgements before submitting.");
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName,
          email,
          phone,
          country,
          accountType,
          entityName: isEntity ? entityName : undefined,
          abn: isEntity ? abn : undefined,
          intendedUse,
          consentOwnBehalf: consentOwn,
          consentAmlCtf: consentAml,
          consentContact: consentContact,
          consentGeneralAdvice: consentAdvice,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to submit application");
      }
      trackEvent("apply_submitted", { accountType, country });
      setVerifyStep(true);
    } catch (err: any) {
      setError(err.message || "Failed to submit application. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setOtpError(null);
    if (otp.trim().length !== 6) {
      setOtpError("Please enter the 6-digit code from your email.");
      return;
    }
    setVerifying(true);
    try {
      const res = await fetch("/api/applications/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, otp: otp.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Verification failed");
      trackEvent("apply_email_verified", { accountType });
      setSubmitted(true);
    } catch (err: any) {
      setOtpError(err.message || "Verification failed. Please try again.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleResendOtp() {
    setResendNotice(null);
    setOtpError(null);
    setResending(true);
    try {
      const res = await fetch("/api/applications/resend-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not resend code");
      setResendNotice("A new code has been sent to your email.");
    } catch (err: any) {
      setOtpError(err.message || "Could not resend code.");
    } finally {
      setResending(false);
    }
  }

  if (verifyStep && !submitted) {
    return (
      <div className="min-h-screen bg-blue-50 flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6">
          <div className="flex items-center justify-center gap-3 mb-2">
            <img src={darkBlueLogo} alt="AMAX Wealth" className="w-10 h-10 rounded-lg" />
            <span className="text-2xl font-bold text-blue-900">AMAX WEALTH</span>
          </div>

          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold text-blue-900">Verify your email</h1>
            <p className="text-sm text-blue-700">
              We've sent a 6-digit code to <span className="font-semibold">{email}</span>.
              Enter it below to complete your application. Your application is not submitted for review until your email is verified.
            </p>
          </div>

          <Card className="bg-white border-blue-100 shadow-sm">
            <CardContent className="pt-6">
              <form onSubmit={handleVerifyOtp} className="space-y-4">
                {otpError && (
                  <Alert variant="destructive">
                    <AlertDescription>{otpError}</AlertDescription>
                  </Alert>
                )}
                {resendNotice && (
                  <Alert>
                    <AlertDescription>{resendNotice}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <Label htmlFor="otp">Verification code</Label>
                  <Input
                    id="otp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="123456"
                    className="text-center text-xl tracking-[0.4em] font-semibold"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={verifying || otp.length !== 6}
                  className="w-full bg-sky-500 hover:bg-sky-600 text-white font-semibold"
                >
                  {verifying ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying...</> : "Verify & Submit Application"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={resending}
                  onClick={handleResendOtp}
                  className="w-full text-sky-600 hover:text-sky-700"
                >
                  {resending ? "Sending..." : "Didn't get the code? Resend"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <p className="text-xs text-center text-gray-500">
            The code expires in 24 hours. Check your spam folder if you don't see the email.
          </p>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-blue-50 flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6 text-center">
          <div className="flex items-center justify-center gap-3 mb-4">
            <img src={darkBlueLogo} alt="AMAX Wealth" className="w-10 h-10 rounded-lg" />
            <span className="text-2xl font-bold text-blue-900">AMAX WEALTH</span>
          </div>

          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-10 h-10 text-green-600" />
          </div>

          <h1 className="text-3xl font-bold text-blue-900">Application received</h1>
          <p className="text-blue-700">
            Your application is under review. If approved, you will receive an invitation to complete onboarding.
          </p>
          <p className="text-sm text-gray-500">Typical review time: 1–2 business days</p>

          <Card className="bg-white border-blue-100 shadow-sm">
            <CardContent className="pt-6">
              <p className="text-sm text-blue-700 mb-4">
                Access is subject to eligibility, compliance, and verification checks.
              </p>
              <Button
                className="w-full bg-sky-500 hover:bg-sky-600 text-white font-semibold"
                onClick={() => navigate("/application-status?email=" + encodeURIComponent(email))}
              >
                Check Application Status
              </Button>
            </CardContent>
          </Card>

          <div className="text-center space-y-3">
            <p className="text-sm text-blue-900">
              Already approved?{" "}
              <Link href="/login" className="underline hover:text-blue-700">
                Sign in
              </Link>
            </p>
            <Link href="/" className="inline-flex items-center gap-2 text-sm text-blue-900 hover:text-blue-700">
              <ArrowLeft className="w-4 h-4" />
              Back to Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-blue-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-3 mb-4">
            <img src={darkBlueLogo} alt="AMAX Wealth" className="w-10 h-10 rounded-lg" />
            <span className="text-2xl font-bold text-blue-900">AMAX WEALTH</span>
          </div>
          <h1 className="text-3xl font-bold text-blue-900">Apply for Access</h1>
          <p className="text-blue-700">
            Submit your details for eligibility and compliance review.
            <br />
            Approved applicants will be invited to complete onboarding.
          </p>
        </div>

        <Card className="bg-white border-blue-100 shadow-sm">
          <CardContent className="pt-6">
            <form onSubmit={handleSubmit} className="space-y-5">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div>
                <p className="text-sm font-semibold text-blue-900 mb-3">Basic details</p>
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="fullName" className="text-blue-900">Full legal name *</Label>
                    <Input
                      id="fullName"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="As per your government-issued ID"
                      required
                      className="bg-white border-blue-200 text-blue-900 placeholder:text-gray-400 focus:border-blue-500"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email" className="text-blue-900">Email address *</Label>
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="john@example.com"
                      required
                      className="bg-white border-blue-200 text-blue-900 placeholder:text-gray-400 focus:border-blue-500"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="phone" className="text-blue-900">Mobile number *</Label>
                      <Input
                        id="phone"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder="+61 4XX XXX XXX"
                        required
                        className="bg-white border-blue-200 text-blue-900 placeholder:text-gray-400 focus:border-blue-500"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="country" className="text-blue-900">Country of residence *</Label>
                      <Select value={country} onValueChange={setCountry}>
                        <SelectTrigger className="bg-white border-blue-200 text-blue-900">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Australia">Australia</SelectItem>
                          <SelectItem value="New Zealand">New Zealand</SelectItem>
                          <SelectItem value="Hong Kong">Hong Kong</SelectItem>
                          <SelectItem value="Singapore">Singapore</SelectItem>
                          <SelectItem value="United Kingdom">United Kingdom</SelectItem>
                          <SelectItem value="United States">United States</SelectItem>
                          <SelectItem value="Canada">Canada</SelectItem>
                          <SelectItem value="Other">Other</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <p className="text-sm font-semibold text-blue-900 mb-3">Account type</p>
                <Select value={accountType} onValueChange={setAccountType}>
                  <SelectTrigger className="bg-white border-blue-200 text-blue-900">
                    <SelectValue placeholder="Select account type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="personal">Personal</SelectItem>
                    <SelectItem value="joint">Joint</SelectItem>
                    <SelectItem value="company">Company</SelectItem>
                    <SelectItem value="trust">Trust</SelectItem>
                    <SelectItem value="smsf">SMSF (Self-Managed Super Fund)</SelectItem>
                  </SelectContent>
                </Select>

                {isEntity && (
                  <div className="grid grid-cols-2 gap-3 mt-3">
                    <div className="space-y-2">
                      <Label htmlFor="entityName" className="text-blue-900">
                        {accountType === "trust" ? "Trust name" : accountType === "smsf" ? "Fund name" : "Entity name"}
                      </Label>
                      <Input
                        id="entityName"
                        value={entityName}
                        onChange={(e) => setEntityName(e.target.value)}
                        placeholder="Company Pty Ltd"
                        className="bg-white border-blue-200 text-blue-900 placeholder:text-gray-400 focus:border-blue-500"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="abn" className="text-blue-900">ABN / Registration</Label>
                      <Input
                        id="abn"
                        value={abn}
                        onChange={(e) => setAbn(e.target.value)}
                        placeholder="XX XXX XXX XXX"
                        className="bg-white border-blue-200 text-blue-900 placeholder:text-gray-400 focus:border-blue-500"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div>
                <p className="text-sm font-semibold text-blue-900 mb-3">Intended use</p>
                <Select value={intendedUse} onValueChange={setIntendedUse}>
                  <SelectTrigger className="bg-white border-blue-200 text-blue-900">
                    <SelectValue placeholder="Select intended use" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="wealth_management">Wealth management</SelectItem>
                    <SelectItem value="long_term_investing">Long-term investing</SelectItem>
                    <SelectItem value="portfolio_diversification">Portfolio diversification</SelectItem>
                    <SelectItem value="private_market_access">Private market access</SelectItem>
                    <SelectItem value="smsf_investing">SMSF investing</SelectItem>
                    <SelectItem value="trust_entity_investing">Trust / entity investing</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <p className="text-sm font-semibold text-blue-900 mb-3">Compliance pre-screen</p>
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="consentOwn"
                      checked={consentOwn}
                      onCheckedChange={(checked) => setConsentOwn(checked === true)}
                      className="mt-0.5 border-sky-300 data-[state=checked]:bg-sky-500 data-[state=checked]:text-white"
                    />
                    <Label htmlFor="consentOwn" className="text-sm text-blue-700 leading-snug cursor-pointer">
                      I confirm I am acting on my own behalf or as an authorised representative
                    </Label>
                  </div>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="consentAml"
                      checked={consentAml}
                      onCheckedChange={(checked) => setConsentAml(checked === true)}
                      className="mt-0.5 border-sky-300 data-[state=checked]:bg-sky-500 data-[state=checked]:text-white"
                    />
                    <Label htmlFor="consentAml" className="text-sm text-blue-700 leading-snug cursor-pointer">
                      I understand access is subject to AML/CTF and regulatory checks
                    </Label>
                  </div>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="consentContact"
                      checked={consentContact}
                      onCheckedChange={(checked) => setConsentContact(checked === true)}
                      className="mt-0.5 border-sky-300 data-[state=checked]:bg-sky-500 data-[state=checked]:text-white"
                    />
                    <Label htmlFor="consentContact" className="text-sm text-blue-700 leading-snug cursor-pointer">
                      I agree to be contacted for onboarding if approved
                    </Label>
                  </div>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="consentAdvice"
                      checked={consentAdvice}
                      onCheckedChange={(checked) => setConsentAdvice(checked === true)}
                      className="mt-0.5 border-sky-300 data-[state=checked]:bg-sky-500 data-[state=checked]:text-white"
                    />
                    <Label htmlFor="consentAdvice" className="text-sm text-blue-700 leading-snug cursor-pointer">
                      I acknowledge that this platform provides general information only and does not constitute personal financial advice.
                    </Label>
                  </div>
                </div>
              </div>

              <div className="rounded-md border border-blue-200 bg-blue-50/60 p-3 text-xs text-blue-800 leading-relaxed">
                <p className="font-semibold text-blue-900 mb-1">Identity verification</p>
                We will attempt to verify your identity electronically using your Australian driver licence or passport.
                If electronic verification is unsuccessful, you may be asked to provide additional identification documents during onboarding.
              </div>

              <div className="rounded-md border border-blue-200 bg-white p-3 text-[11px] text-blue-700 leading-relaxed">
                <p className="font-semibold text-blue-900 mb-1">General advice disclaimer</p>
                This platform provides access to investment opportunities and general information only.
                Nothing on this platform constitutes personal financial advice, and it does not take into account your objectives, financial situation, or needs.
                You should consider whether any investment is appropriate for you and seek independent advice if required.
              </div>

              <Button
                type="submit"
                disabled={isLoading || !accountType || !intendedUse}
                className="w-full bg-sky-500 hover:bg-sky-600 text-white font-semibold h-11"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  "Submit Application"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-xs text-center text-gray-500">
          Access is subject to eligibility, compliance, and verification checks.
        </p>

        <div className="text-center space-y-3">
          <p className="text-sm text-blue-900">
            Already have an account?{" "}
            <Link href="/login" className="underline hover:text-blue-700">
              Sign in
            </Link>
          </p>
          <p className="text-sm text-blue-900">
            Already applied?{" "}
            <Link href="/application-status" className="underline hover:text-blue-700">
              Check status
            </Link>
          </p>
          <Link href="/" className="inline-flex items-center gap-2 text-sm text-blue-900 hover:text-blue-700">
            <ArrowLeft className="w-4 h-4" />
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
