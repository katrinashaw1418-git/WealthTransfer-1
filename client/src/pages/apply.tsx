import { useState } from "react";
import { useLocation, Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, ArrowLeft, CheckCircle2 } from "lucide-react";
import darkBlueLogo from "@assets/DARK_BLUE_LOGO_1776310673148.jpg";

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
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!consentOwn || !consentAml || !consentContact) {
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
          entityName: accountType === "business" ? entityName : undefined,
          abn: accountType === "business" ? abn : undefined,
          intendedUse,
          consentOwnBehalf: consentOwn,
          consentAmlCtf: consentAml,
          consentContact: consentContact,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to submit application");
      }
      setSubmitted(true);
    } catch (err: any) {
      setError(err.message || "Failed to submit application. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6 text-center">
          <div className="flex items-center justify-center gap-3 mb-4">
            <img src={darkBlueLogo} alt="AMAX Wealth" className="w-10 h-10 rounded-lg" />
            <span className="text-2xl font-bold text-white">AMAX WEALTH</span>
          </div>

          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-10 h-10 text-green-600" />
          </div>

          <h1 className="text-3xl font-bold text-white">Application received</h1>
          <p className="text-slate-300">
            Your application is under review. If approved, you will receive an invitation to complete onboarding.
          </p>
          <p className="text-sm text-slate-400">Typical review time: 1–2 business days</p>

          <Card className="bg-slate-800 border-slate-700">
            <CardContent className="pt-6">
              <p className="text-sm text-slate-300 mb-4">
                Access is subject to eligibility, compliance, and verification checks.
              </p>
              <Button
                className="w-full bg-white hover:bg-slate-100 text-slate-900 font-semibold"
                onClick={() => navigate("/application-status?email=" + encodeURIComponent(email))}
              >
                Check Application Status
              </Button>
            </CardContent>
          </Card>

          <div className="text-center space-y-3">
            <p className="text-sm text-white">
              Already approved?{" "}
              <Link href="/login" className="underline hover:text-slate-300">
                Sign in
              </Link>
            </p>
            <Link href="/" className="inline-flex items-center gap-2 text-sm text-white hover:text-slate-300">
              <ArrowLeft className="w-4 h-4" />
              Back to Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-3 mb-4">
            <img src={darkBlueLogo} alt="AMAX Wealth" className="w-10 h-10 rounded-lg" />
            <span className="text-2xl font-bold text-white">AMAX WEALTH</span>
          </div>
          <h1 className="text-3xl font-bold text-white">Apply for Access</h1>
          <p className="text-slate-300">
            Submit your details for eligibility and compliance review.
            <br />
            Approved applicants will be invited to complete onboarding.
          </p>
        </div>

        <Card className="bg-slate-800 border-slate-700">
          <CardContent className="pt-6">
            <form onSubmit={handleSubmit} className="space-y-5">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div>
                <p className="text-sm font-semibold text-white mb-3">Basic details</p>
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="fullName" className="text-white">Full legal name *</Label>
                    <Input
                      id="fullName"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="As per your government-issued ID"
                      required
                      className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-400 focus:border-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email" className="text-white">Email address *</Label>
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="john@example.com"
                      required
                      className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-400 focus:border-white"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="phone" className="text-white">Mobile number *</Label>
                      <Input
                        id="phone"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder="+61 4XX XXX XXX"
                        required
                        className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-400 focus:border-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="country" className="text-white">Country of residence *</Label>
                      <Select value={country} onValueChange={setCountry}>
                        <SelectTrigger className="bg-slate-700 border-slate-600 text-white">
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
                <p className="text-sm font-semibold text-white mb-3">Account type</p>
                <Select value={accountType} onValueChange={setAccountType}>
                  <SelectTrigger className="bg-slate-700 border-slate-600 text-white">
                    <SelectValue placeholder="Select account type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="personal">Personal</SelectItem>
                    <SelectItem value="business">Business</SelectItem>
                  </SelectContent>
                </Select>

                {accountType === "business" && (
                  <div className="grid grid-cols-2 gap-3 mt-3">
                    <div className="space-y-2">
                      <Label htmlFor="entityName" className="text-white">Entity name</Label>
                      <Input
                        id="entityName"
                        value={entityName}
                        onChange={(e) => setEntityName(e.target.value)}
                        placeholder="Company Pty Ltd"
                        className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-400 focus:border-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="abn" className="text-white">ABN / Registration</Label>
                      <Input
                        id="abn"
                        value={abn}
                        onChange={(e) => setAbn(e.target.value)}
                        placeholder="XX XXX XXX XXX"
                        className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-400 focus:border-white"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div>
                <p className="text-sm font-semibold text-white mb-3">Intended use</p>
                <Select value={intendedUse} onValueChange={setIntendedUse}>
                  <SelectTrigger className="bg-slate-700 border-slate-600 text-white">
                    <SelectValue placeholder="Select intended use" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="personal_transfers">Personal transfers</SelectItem>
                    <SelectItem value="fx_exchange">FX / currency exchange</SelectItem>
                    <SelectItem value="digital_assets">Digital asset transactions</SelectItem>
                    <SelectItem value="investment">Investment / treasury</SelectItem>
                    <SelectItem value="business_payments">Business payments</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <p className="text-sm font-semibold text-white mb-3">Compliance pre-screen</p>
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="consentOwn"
                      checked={consentOwn}
                      onCheckedChange={(checked) => setConsentOwn(checked === true)}
                      className="mt-0.5 border-slate-500 data-[state=checked]:bg-white data-[state=checked]:text-slate-900"
                    />
                    <Label htmlFor="consentOwn" className="text-sm text-slate-300 leading-snug cursor-pointer">
                      I confirm I am acting on my own behalf or as an authorised representative
                    </Label>
                  </div>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="consentAml"
                      checked={consentAml}
                      onCheckedChange={(checked) => setConsentAml(checked === true)}
                      className="mt-0.5 border-slate-500 data-[state=checked]:bg-white data-[state=checked]:text-slate-900"
                    />
                    <Label htmlFor="consentAml" className="text-sm text-slate-300 leading-snug cursor-pointer">
                      I understand access is subject to AML/CTF and regulatory checks
                    </Label>
                  </div>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="consentContact"
                      checked={consentContact}
                      onCheckedChange={(checked) => setConsentContact(checked === true)}
                      className="mt-0.5 border-slate-500 data-[state=checked]:bg-white data-[state=checked]:text-slate-900"
                    />
                    <Label htmlFor="consentContact" className="text-sm text-slate-300 leading-snug cursor-pointer">
                      I agree to be contacted for onboarding if approved
                    </Label>
                  </div>
                </div>
              </div>

              <Button
                type="submit"
                disabled={isLoading || !accountType || !intendedUse}
                className="w-full bg-white hover:bg-slate-100 text-slate-900 font-semibold h-11"
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

        <p className="text-xs text-center text-slate-400">
          Access is subject to eligibility, compliance, and verification checks.
        </p>

        <div className="text-center space-y-3">
          <p className="text-sm text-white">
            Already have an account?{" "}
            <Link href="/login" className="underline hover:text-slate-300">
              Sign in
            </Link>
          </p>
          <p className="text-sm text-white">
            Already applied?{" "}
            <Link href="/application-status" className="underline hover:text-slate-300">
              Check status
            </Link>
          </p>
          <Link href="/" className="inline-flex items-center gap-2 text-sm text-white hover:text-slate-300">
            <ArrowLeft className="w-4 h-4" />
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
