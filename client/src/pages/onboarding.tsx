import { useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Check,
  Upload,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  FileText,
  Copy,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import darkBlueLogo from "@assets/AMAX_LOGO_BLUE_1776427512999.jpg";

const STEPS = [
  { label: "Identity", short: "Identity" },
  { label: "Wholesale", short: "Wholesale" },
  { label: "Financial", short: "Financial" },
  { label: "Objectives", short: "Objectives" },
  { label: "Risk", short: "Risk" },
  { label: "Review", short: "Review" },
];

function getRiskLabel(value: number) {
  if (value <= 20) return "Conservative";
  if (value <= 40) return "Moderately Conservative";
  if (value <= 60) return "Moderate";
  if (value <= 80) return "Moderately Aggressive";
  return "Aggressive";
}

export default function Onboarding() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [currentStep, setCurrentStep] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [referenceId, setReferenceId] = useState("");

  const [identity, setIdentity] = useState({
    firstName: "",
    lastName: "",
    dateOfBirth: "",
    country: "Australia",
    email: "",
    phone: "",
    address: "",
  });

  const [wholesale, setWholesale] = useState({
    basis: "",
    certificateFile: null as File | null,
  });

  const [financial, setFinancial] = useState({
    annualIncome: "",
    netAssets: "",
    liabilities: "",
    dependants: "0",
    employment: "",
    existingInvestments: "",
  });

  const [objectives, setObjectives] = useState({
    goal: "",
    horizon: "",
    liquidity: "",
  });

  const [risk, setRisk] = useState({
    tolerance: 50,
    experience: "",
    knowledge: "",
  });

  const [consents, setConsents] = useState({
    accuracy: false,
    privacy: false,
    wholesaleDeclaration: false,
  });

  const progress = Math.round(((currentStep + 1) / STEPS.length) * 100);

  const canProceed = () => {
    switch (currentStep) {
      case 0: {
        const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email);
        const phoneValid = identity.phone.length >= 8;
        return !!(identity.firstName && identity.lastName && identity.dateOfBirth && emailValid && phoneValid && identity.address);
      }
      case 1: {
        if (!wholesale.basis) return false;
        if ((wholesale.basis === "net_assets" || wholesale.basis === "gross_income") && !wholesale.certificateFile) return false;
        return true;
      }
      case 2: {
        const incomeNum = parseFloat(financial.annualIncome.replace(/,/g, ""));
        const assetsNum = parseFloat(financial.netAssets.replace(/,/g, ""));
        const liabNum = parseFloat(financial.liabilities.replace(/,/g, ""));
        return !!(financial.annualIncome && financial.netAssets && financial.liabilities && financial.employment && !isNaN(incomeNum) && !isNaN(assetsNum) && !isNaN(liabNum));
      }
      case 3:
        return objectives.goal && objectives.horizon && objectives.liquidity;
      case 4:
        return risk.experience && risk.knowledge;
      case 5:
        return consents.accuracy && consents.privacy && consents.wholesaleDeclaration;
      default:
        return true;
    }
  };

  const handleNext = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleSubmit = () => {
    const year = new Date().getFullYear();
    const num = Math.floor(Math.random() * 90000 + 10000);
    const ref = `AMX-${year}-${num}`;
    setReferenceId(ref);
    try {
      localStorage.setItem(
        "amax_application",
        JSON.stringify({ referenceId: ref, submittedAt: new Date().toISOString(), bannerDismissed: false })
      );
    } catch {}
    setSubmitted(true);
  };

  const copyReference = () => {
    navigator.clipboard.writeText(referenceId).then(() => {
      toast({ title: "Reference copied", description: referenceId });
    });
  };

  if (submitted) {
    return (
      <div className="min-h-screen bg-gray-50">
        <header className="bg-blue-50 px-6 py-4">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img src={darkBlueLogo} alt="AMAX Wealth" className="w-8 h-8 rounded-lg" />
              <span className="text-blue-900 font-semibold">AMAX Wealth — onboarding</span>
            </div>
          </div>
        </header>
        <div className="max-w-2xl mx-auto px-6 py-16 text-center">
          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="w-10 h-10 text-green-600" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-3">Fact-find submitted</h1>
          <p className="text-gray-600 mb-8">Your onboarding information has been received by your adviser.</p>

          <div className="bg-white border-2 border-blue-200 rounded-xl p-6 mb-8 text-left">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Application reference</p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-2xl font-mono font-bold text-blue-900" data-testid="text-reference-id">{referenceId}</span>
              <Button variant="outline" size="sm" onClick={copyReference} data-testid="button-copy-reference">
                <Copy className="w-4 h-4 mr-1.5" />
                Copy
              </Button>
            </div>
            <p className="text-xs text-gray-500 mt-3">
              Save this number. Quote it in any correspondence with your adviser. It will also remain visible at the top of your dashboard.
            </p>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6 text-sm text-blue-800 text-left">
            <strong>What happens next:</strong> Your adviser will review your fact-find and prepare a Statement of Advice (SOA) tailored to your circumstances within <strong>3–5 business days</strong>. Once ready, you will be notified to review and accept it before proceeding with investment instructions.
          </div>

          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-8 text-xs text-gray-600 text-left">
            <strong className="text-gray-700">Important:</strong> AMAX Wealth provides general advice only, prepared without taking into account your personal objectives, financial situation, or needs beyond the information disclosed in this fact-find. Any Statement of Advice issued is personal advice based solely on the information you have provided. AMAX Wealth operates under AFSL obligations and the Corporations Act 2001 (Cth).
          </div>

          <div className="flex gap-4 justify-center">
            <Button onClick={() => navigate("/dashboard")} data-testid="button-go-dashboard">Go to Dashboard</Button>
            <Button variant="outline" onClick={() => navigate("/compliance")}>View Compliance Centre</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-blue-50 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={darkBlueLogo} alt="AMAX Wealth" className="w-8 h-8 rounded-lg" />
            <span className="text-blue-900 font-semibold">AMAX Wealth — onboarding</span>
          </div>
          <span className="text-sm text-blue-700">Progress saved automatically</span>
        </div>
      </header>

      <div className="max-w-4xl mx-auto w-full px-6 py-8 flex-1">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            {STEPS.map((step, i) => (
              <div key={i} className="flex items-center">
                <div className="flex flex-col items-center">
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold border-2 transition-colors ${
                      i < currentStep
                        ? "bg-green-100 border-green-500 text-green-700"
                        : i === currentStep
                        ? "bg-sky-500 border-sky-500 text-white"
                        : "bg-white border-gray-300 text-gray-400"
                    }`}
                  >
                    {i < currentStep ? <Check className="w-5 h-5" /> : i + 1}
                  </div>
                  <span className={`text-xs mt-1.5 ${i <= currentStep ? "text-gray-900 font-medium" : "text-gray-400"}`}>
                    {step.short}
                  </span>
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`w-12 md:w-20 h-0.5 mx-1 mt-[-16px] ${i < currentStep ? "bg-green-500" : "bg-gray-300"}`} />
                )}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between text-xs text-gray-500 mt-2">
            <span>Step {currentStep + 1} of {STEPS.length}</span>
            <span>{progress}% complete</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-1.5 mt-1">
            <div className="bg-green-500 h-1.5 rounded-full transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <Card className="mb-8">
          <CardContent className="p-8">
            {currentStep === 0 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900 mb-2">Identity and contact details</h2>
                  <p className="text-gray-600">
                    Your details are collected for KYC verification under AML/CTF obligations. All information is handled in accordance with the Privacy Act 1988 (Cth).
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label>First name *</Label>
                    <Input
                      placeholder="Given name"
                      value={identity.firstName}
                      onChange={(e) => setIdentity({ ...identity, firstName: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Last name *</Label>
                    <Input
                      placeholder="Family name"
                      value={identity.lastName}
                      onChange={(e) => setIdentity({ ...identity, lastName: e.target.value })}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label>Date of birth *</Label>
                    <Input
                      type="date"
                      placeholder="DD / MM / YYYY"
                      value={identity.dateOfBirth}
                      onChange={(e) => setIdentity({ ...identity, dateOfBirth: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Country of residence *</Label>
                    <Select value={identity.country} onValueChange={(v) => setIdentity({ ...identity, country: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Australia">Australia</SelectItem>
                        <SelectItem value="New Zealand">New Zealand</SelectItem>
                        <SelectItem value="United Kingdom">United Kingdom</SelectItem>
                        <SelectItem value="United States">United States</SelectItem>
                        <SelectItem value="Singapore">Singapore</SelectItem>
                        <SelectItem value="Hong Kong">Hong Kong</SelectItem>
                        <SelectItem value="China">China</SelectItem>
                        <SelectItem value="Other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label>Email address *</Label>
                    <Input
                      type="email"
                      placeholder="your@email.com"
                      value={identity.email}
                      onChange={(e) => setIdentity({ ...identity, email: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Phone number *</Label>
                    <Input
                      placeholder="+61 4XX XXX XXX"
                      value={identity.phone}
                      onChange={(e) => setIdentity({ ...identity, phone: e.target.value })}
                    />
                  </div>
                </div>

                <div>
                  <Label>Residential address *</Label>
                  <Input
                    placeholder="Street address, suburb, state, postcode"
                    value={identity.address}
                    onChange={(e) => setIdentity({ ...identity, address: e.target.value })}
                  />
                  <p className="text-xs text-gray-400 mt-1">Must match your government-issued ID</p>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <p className="text-sm text-blue-800">
                    You will be required to upload a government-issued photo ID and proof of address in the Documents section of your compliance centre after completing onboarding.
                  </p>
                </div>
              </div>
            )}

            {currentStep === 1 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900 mb-2">Wholesale investor verification</h2>
                  <p className="text-gray-600">
                    AMAX Wealth is available to wholesale clients only under the Corporations Act 2001 (Cth) s761G. Select the basis on which you qualify.
                  </p>
                </div>

                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                  <p className="text-sm text-amber-800">
                    <AlertTriangle className="w-4 h-4 inline mr-1 mb-0.5" />
                    Misrepresenting your wholesale investor status is a serious legal matter. If you are unsure whether you qualify, please consult your accountant or financial adviser before proceeding.
                  </p>
                </div>

                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Select your qualification basis</p>
                  <div className="space-y-3">
                    {[
                      { value: "net_assets", label: "Net assets of $2.5M+", desc: "Certified by your accountant within the last 2 years — s761GA" },
                      { value: "gross_income", label: "Gross income $250,000+ p.a.", desc: "For each of the last 2 financial years — s761GA" },
                      { value: "professional", label: "Professional investor", desc: "Financial institution, superannuation fund, registered scheme, or listed entity" },
                      { value: "large_corp", label: "Large corporation", desc: "$25M+ gross assets or 100+ employees" },
                      { value: "smsf", label: "SMSF with $10M+ net assets", desc: "Self-managed superannuation fund" },
                    ].map((option) => (
                      <div
                        key={option.value}
                        className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                          wholesale.basis === option.value ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300"
                        }`}
                        onClick={() => setWholesale({ ...wholesale, basis: option.value })}
                      >
                        <div className="flex items-start gap-3">
                          <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5 flex-shrink-0 ${
                            wholesale.basis === option.value ? "border-blue-500" : "border-gray-300"
                          }`}>
                            {wholesale.basis === option.value && <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />}
                          </div>
                          <div>
                            <p className="font-medium text-gray-900">{option.label}</p>
                            <p className="text-sm text-gray-500">{option.desc}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Accountant certificate</p>
                  <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center bg-gray-50">
                    <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                    <p className="font-medium text-gray-700 mb-1">Upload accountant certificate</p>
                    <p className="text-xs text-gray-500 mb-3">PDF or image — issued within the last 2 years. Required for net assets or income basis.</p>
                    <input
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png"
                      className="hidden"
                      id="cert-upload"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) setWholesale({ ...wholesale, certificateFile: file });
                      }}
                    />
                    <label htmlFor="cert-upload">
                      <Button asChild variant="outline" size="sm">
                        <span>{wholesale.certificateFile ? wholesale.certificateFile.name : "Choose file"}</span>
                      </Button>
                    </label>
                  </div>
                  <p className="text-xs text-gray-400 mt-2">
                    If you qualify as a professional investor or large corporation, a certificate may not be required — your adviser will confirm.
                  </p>
                </div>
              </div>
            )}

            {currentStep === 2 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900 mb-2">Financial situation</h2>
                  <p className="text-gray-600">
                    This information is required under AFSL obligations for your adviser to understand your financial position before providing advice. All figures are approximate.
                  </p>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <p className="text-sm text-blue-800">
                    This information is used solely for the purpose of preparing your Statement of Advice. It is not shared with third parties except as required by law.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label>Annual gross income (AUD) *</Label>
                    <Input
                      placeholder="e.g. 500,000"
                      value={financial.annualIncome}
                      onChange={(e) => setFinancial({ ...financial, annualIncome: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Total net assets (AUD) *</Label>
                    <Input
                      placeholder="e.g. 3,500,000"
                      value={financial.netAssets}
                      onChange={(e) => setFinancial({ ...financial, netAssets: e.target.value })}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label>Total liabilities (AUD) *</Label>
                    <Input
                      placeholder="e.g. 500,000"
                      value={financial.liabilities}
                      onChange={(e) => setFinancial({ ...financial, liabilities: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Number of dependants</Label>
                    <Select value={financial.dependants} onValueChange={(v) => setFinancial({ ...financial, dependants: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                          <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div>
                  <Label>Employment status *</Label>
                  <Select value={financial.employment} onValueChange={(v) => setFinancial({ ...financial, employment: v })}>
                    <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="employed">Employed</SelectItem>
                      <SelectItem value="self_employed">Self-employed</SelectItem>
                      <SelectItem value="business_owner">Business owner</SelectItem>
                      <SelectItem value="retired">Retired</SelectItem>
                      <SelectItem value="not_employed">Not currently employed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label>Existing investments (brief description)</Label>
                  <Textarea
                    placeholder="e.g. Property, shares, superannuation, managed funds — approximate values"
                    value={financial.existingInvestments}
                    onChange={(e) => setFinancial({ ...financial, existingInvestments: e.target.value })}
                    className="min-h-[80px]"
                  />
                </div>
              </div>
            )}

            {currentStep === 3 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900 mb-2">Investment objectives</h2>
                  <p className="text-gray-600">
                    Your investment goals and time horizon help your adviser understand the purpose of your investments and prepare appropriate advice.
                  </p>
                </div>

                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Primary investment goal</p>
                  <div className="space-y-3">
                    {[
                      { value: "growth", label: "Capital growth", desc: "Grow the value of my portfolio over time" },
                      { value: "income", label: "Income generation", desc: "Regular income from dividends, interest, or distributions" },
                      { value: "preservation", label: "Capital preservation", desc: "Protect existing capital with minimal risk" },
                      { value: "balanced", label: "Balanced growth and income", desc: "A mix of growth and regular income" },
                    ].map((option) => (
                      <div
                        key={option.value}
                        className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                          objectives.goal === option.value ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300"
                        }`}
                        onClick={() => setObjectives({ ...objectives, goal: option.value })}
                      >
                        <div className="flex items-start gap-3">
                          <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5 flex-shrink-0 ${
                            objectives.goal === option.value ? "border-blue-500" : "border-gray-300"
                          }`}>
                            {objectives.goal === option.value && <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />}
                          </div>
                          <div>
                            <p className="font-medium text-gray-900">{option.label}</p>
                            <p className="text-sm text-gray-500">{option.desc}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Investment horizon</p>
                  <div className="space-y-3">
                    {[
                      { value: "1-3", label: "1–3 years", desc: "Short term" },
                      { value: "3-5", label: "3–5 years", desc: "Medium term" },
                      { value: "5-10", label: "5–10 years", desc: "Long term" },
                      { value: "10+", label: "10+ years", desc: "Very long term" },
                    ].map((option) => (
                      <div
                        key={option.value}
                        className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                          objectives.horizon === option.value ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300"
                        }`}
                        onClick={() => setObjectives({ ...objectives, horizon: option.value })}
                      >
                        <div className="flex items-start gap-3">
                          <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5 flex-shrink-0 ${
                            objectives.horizon === option.value ? "border-blue-500" : "border-gray-300"
                          }`}>
                            {objectives.horizon === option.value && <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />}
                          </div>
                          <div>
                            <p className="font-medium text-gray-900">{option.label}</p>
                            <p className="text-sm text-gray-500">{option.desc}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <Label>Liquidity needs</Label>
                  <Select value={objectives.liquidity} onValueChange={(v) => setObjectives({ ...objectives, liquidity: v })}>
                    <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="high">High — I may need access to funds at short notice</SelectItem>
                      <SelectItem value="moderate">Moderate — I can lock funds for 1–2 years</SelectItem>
                      <SelectItem value="low">Low — I can lock funds for 3+ years</SelectItem>
                      <SelectItem value="none">No liquidity requirements — long-term lock-up is acceptable</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-gray-400 mt-1">This affects which products may be suitable for your portfolio</p>
                </div>
              </div>
            )}

            {currentStep === 4 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900 mb-2">Risk tolerance and experience</h2>
                  <p className="text-gray-600">
                    Your risk tolerance and investment experience inform the advice your adviser provides. Answer based on your genuine comfort level, not your ideal outcome.
                  </p>
                </div>

                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                  <p className="text-sm text-amber-800">
                    These questions form part of your formal fact-find. Providing inaccurate answers may result in advice that is not appropriate for your circumstances.
                  </p>
                </div>

                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Risk tolerance</p>
                  <p className="text-lg font-semibold text-gray-900 mb-4">{getRiskLabel(risk.tolerance)} ({risk.tolerance}/100)</p>
                  <Slider
                    value={[risk.tolerance]}
                    onValueChange={(v) => setRisk({ ...risk, tolerance: v[0] })}
                    min={0}
                    max={100}
                    step={1}
                    className="mb-2"
                  />
                  <div className="flex justify-between text-xs text-gray-400">
                    <span>Conservative</span>
                    <span>Moderate</span>
                    <span>Aggressive</span>
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Investment experience</p>
                  <div className="space-y-3">
                    {[
                      { value: "none", label: "No experience", desc: "I have not previously invested outside of superannuation" },
                      { value: "limited", label: "Limited experience", desc: "I have invested in managed funds or shares occasionally" },
                      { value: "moderate", label: "Moderate experience", desc: "I regularly invest and understand most financial products" },
                      { value: "sophisticated", label: "Sophisticated investor", desc: "I have extensive experience including alternative and complex investments" },
                    ].map((option) => (
                      <div
                        key={option.value}
                        className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                          risk.experience === option.value ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300"
                        }`}
                        onClick={() => setRisk({ ...risk, experience: option.value })}
                      >
                        <div className="flex items-start gap-3">
                          <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5 flex-shrink-0 ${
                            risk.experience === option.value ? "border-blue-500" : "border-gray-300"
                          }`}>
                            {risk.experience === option.value && <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />}
                          </div>
                          <div>
                            <p className="font-medium text-gray-900">{option.label}</p>
                            <p className="text-sm text-gray-500">{option.desc}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Knowledge level</p>
                  <div className="space-y-3">
                    {[
                      { value: "basic", label: "Basic", desc: "I understand simple investment concepts like shares and bonds" },
                      { value: "intermediate", label: "Intermediate", desc: "I understand diversification, risk-return tradeoffs, and common products" },
                      { value: "advanced", label: "Advanced", desc: "I understand complex products including alternatives, derivatives, and private markets" },
                    ].map((option) => (
                      <div
                        key={option.value}
                        className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                          risk.knowledge === option.value ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300"
                        }`}
                        onClick={() => setRisk({ ...risk, knowledge: option.value })}
                      >
                        <div className="flex items-start gap-3">
                          <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5 flex-shrink-0 ${
                            risk.knowledge === option.value ? "border-blue-500" : "border-gray-300"
                          }`}>
                            {risk.knowledge === option.value && <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />}
                          </div>
                          <div>
                            <p className="font-medium text-gray-900">{option.label}</p>
                            <p className="text-sm text-gray-500">{option.desc}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {currentStep === 5 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900 mb-2">Review and submit</h2>
                  <p className="text-gray-600">
                    Please review your fact-find summary before submitting. Your adviser will use this to prepare your Statement of Advice. You can go back to edit any section.
                  </p>
                </div>

                <div className="space-y-4">
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Identity</p>
                    <div className="space-y-1">
                      <ReviewRow label="Full name" value={identity.firstName && identity.lastName ? `${identity.firstName} ${identity.lastName}` : "—"} />
                      <ReviewRow label="Date of birth" value={identity.dateOfBirth || "—"} />
                      <ReviewRow label="Email" value={identity.email || "—"} />
                      <ReviewRow label="Country" value={identity.country} />
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Wholesale classification</p>
                    <div className="space-y-1">
                      <ReviewRow label="Basis" value={getWholesaleLabel(wholesale.basis)} />
                      <ReviewRow label="Certificate" value={wholesale.certificateFile ? wholesale.certificateFile.name : "Not uploaded"} />
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Financial situation</p>
                    <div className="space-y-1">
                      <ReviewRow label="Annual income" value={financial.annualIncome ? `$${financial.annualIncome}` : "—"} />
                      <ReviewRow label="Net assets" value={financial.netAssets ? `$${financial.netAssets}` : "—"} />
                      <ReviewRow label="Liabilities" value={financial.liabilities ? `$${financial.liabilities}` : "—"} />
                      <ReviewRow label="Dependants" value={financial.dependants} />
                      <ReviewRow label="Employment" value={financial.employment || "—"} />
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Objectives</p>
                    <div className="space-y-1">
                      <ReviewRow label="Primary goal" value={getGoalLabel(objectives.goal)} />
                      <ReviewRow label="Horizon" value={objectives.horizon ? `${objectives.horizon} years` : "—"} />
                      <ReviewRow label="Liquidity needs" value={objectives.liquidity || "—"} />
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Risk profile</p>
                    <div className="space-y-1">
                      <ReviewRow label="Risk score" value={`${getRiskLabel(risk.tolerance)} (${risk.tolerance}/100)`} />
                      <ReviewRow label="Experience" value={risk.experience || "—"} />
                      <ReviewRow label="Knowledge level" value={risk.knowledge || "—"} />
                    </div>
                  </div>
                </div>

                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                  <p className="text-sm text-amber-800">
                    By submitting this fact-find you confirm the information provided is true and accurate to the best of your knowledge. Providing false information may affect the suitability of advice provided and may have legal consequences.
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="flex items-start gap-3 p-4 border rounded-lg">
                    <Checkbox
                      checked={consents.accuracy}
                      onCheckedChange={(v) => setConsents({ ...consents, accuracy: !!v })}
                    />
                    <div>
                      <p className="font-medium text-gray-900 text-sm">I confirm the above information is accurate and complete</p>
                      <p className="text-xs text-gray-500">Required to submit</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 p-4 border rounded-lg">
                    <Checkbox
                      checked={consents.privacy}
                      onCheckedChange={(v) => setConsents({ ...consents, privacy: !!v })}
                    />
                    <div>
                      <p className="font-medium text-gray-900 text-sm">I have read and agree to the Privacy Policy</p>
                      <p className="text-xs text-gray-500">Your information is handled under the Privacy Act 1988 (Cth)</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 p-4 border rounded-lg">
                    <Checkbox
                      checked={consents.wholesaleDeclaration}
                      onCheckedChange={(v) => setConsents({ ...consents, wholesaleDeclaration: !!v })}
                    />
                    <div>
                      <p className="font-medium text-gray-900 text-sm">I confirm I am a wholesale investor as defined under s761G of the Corporations Act 2001 (Cth)</p>
                      <p className="text-xs text-gray-500">Required — misrepresentation carries legal consequences</p>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex items-center justify-between pb-8">
          <Button
            variant="outline"
            onClick={handleBack}
            disabled={currentStep === 0}
          >
            <ChevronLeft className="w-4 h-4 mr-1" />
            Back
          </Button>

          <span className="text-sm text-gray-400">{currentStep + 1}/{STEPS.length}</span>

          {currentStep < STEPS.length - 1 ? (
            <Button onClick={handleNext} disabled={!canProceed()}>
              Continue
              <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          ) : (
            <Button onClick={handleSubmit} disabled={!canProceed()}>
              <FileText className="w-4 h-4 mr-1" />
              Submit Fact-Find
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center py-2 border-b border-gray-100">
      <span className="text-sm text-gray-600">{label}</span>
      <span className="text-sm font-medium text-gray-900">{value}</span>
    </div>
  );
}

function getWholesaleLabel(value: string) {
  const labels: Record<string, string> = {
    net_assets: "Net assets of $2.5M+",
    gross_income: "Gross income $250,000+ p.a.",
    professional: "Professional investor",
    large_corp: "Large corporation",
    smsf: "SMSF with $10M+ net assets",
  };
  return labels[value] || "—";
}

function getGoalLabel(value: string) {
  const labels: Record<string, string> = {
    growth: "Capital growth",
    income: "Income generation",
    preservation: "Capital preservation",
    balanced: "Balanced growth and income",
  };
  return labels[value] || "—";
}
