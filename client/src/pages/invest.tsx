import { useState, useMemo, useEffect, useRef } from "react";
import { trackEvent } from "@/lib/funnel";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Lock,
  Mail,
  Shield,
  Sparkles,
} from "lucide-react";
import {
  PROFILE_OPTIONS,
  GOAL_OPTIONS,
  RISK_OPTIONS,
  HORIZON_OPTIONS,
  CAPITAL_OPTIONS,
  getRecommendation,
  type WizardAnswers,
  type ProfileType,
  type RiskTolerance,
  type TimeHorizon,
  type CapitalRange,
} from "@shared/recommendation-engine";

const STEP_TITLES = [
  "Investor profile",
  "Investment goals",
  "Risk & horizon",
  "Capital range",
  "Your recommendation",
];

const TOTAL_STEPS = 5;

function StepShell({
  step,
  title,
  subtitle,
  children,
  onBack,
  onNext,
  nextLabel,
  nextDisabled,
}: {
  step: number;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
}) {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs uppercase tracking-wider text-sky-700 font-semibold">
            Step {step} of {TOTAL_STEPS}
          </span>
          <span className="text-xs text-gray-500">{STEP_TITLES[step - 1]}</span>
        </div>
        <Progress value={(step / TOTAL_STEPS) * 100} className="h-1.5" />
      </div>

      <h1 className="text-3xl md:text-4xl font-bold text-sky-900 mb-2">{title}</h1>
      {subtitle && <p className="text-gray-600 mb-8">{subtitle}</p>}

      <div className="mb-10">{children}</div>

      <div className="flex items-center justify-between">
        {onBack ? (
          <Button variant="ghost" onClick={onBack} className="text-sky-900">
            <ArrowLeft className="w-4 h-4 mr-2" /> Back
          </Button>
        ) : (
          <div />
        )}
        {onNext && (
          <Button
            onClick={onNext}
            disabled={nextDisabled}
            className="bg-sky-500 hover:bg-sky-600 text-white font-semibold"
            data-testid="button-next"
          >
            {nextLabel ?? "Continue"} <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        )}
      </div>
    </div>
  );
}

function OptionCard({
  selected,
  onClick,
  title,
  desc,
  testId,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  desc?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`w-full text-left p-5 rounded-lg border-2 transition-all ${
        selected
          ? "border-sky-500 bg-sky-50 ring-2 ring-sky-200"
          : "border-gray-200 bg-white hover:border-sky-300 hover:bg-sky-50/50"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-sky-900">{title}</p>
          {desc && <p className="text-sm text-gray-600 mt-0.5">{desc}</p>}
        </div>
        {selected && (
          <div className="flex-shrink-0 w-6 h-6 rounded-full bg-sky-500 flex items-center justify-center">
            <Check className="w-4 h-4 text-white" />
          </div>
        )}
      </div>
    </button>
  );
}

export default function Invest() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [step, setStep] = useState(1);
  // Guard against React 18 StrictMode double-invoke firing duplicate events.
  const lastViewedStep = useRef<number | null>(null);
  useEffect(() => {
    if (lastViewedStep.current === step) return;
    lastViewedStep.current = step;
    trackEvent("flow_a_step_view", { step });
    if (step === 5) trackEvent("flow_a_recommendation_view");
  }, [step]);
  const [profileType, setProfileType] = useState<ProfileType | null>(null);
  const [goals, setGoals] = useState<string[]>([]);
  const [riskTolerance, setRiskTolerance] = useState<RiskTolerance | null>(null);
  const [timeHorizon, setTimeHorizon] = useState<TimeHorizon | null>(null);
  const [capitalRange, setCapitalRange] = useState<CapitalRange | null>(null);

  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [emailSaved, setEmailSaved] = useState(false);

  const recommendation = useMemo(() => {
    if (!profileType || !riskTolerance || !timeHorizon || !capitalRange) return null;
    const answers: WizardAnswers = {
      profileType,
      goals,
      riskTolerance,
      timeHorizon,
      capitalRange,
    };
    return getRecommendation(answers);
  }, [profileType, goals, riskTolerance, timeHorizon, capitalRange]);

  const leadMutation = useMutation({
    mutationFn: async () => {
      if (!recommendation || !riskTolerance || !timeHorizon || !capitalRange || !profileType) {
        throw new Error("Incomplete profile");
      }
      const res = await apiRequest("POST", "/api/leads", {
        email,
        profileType,
        goals,
        riskTolerance,
        timeHorizon,
        capitalRange,
        recommendedStrategy: recommendation.strategy,
        privateAccess: recommendation.privateAccess,
        website,
      });
      return res.json();
    },
    onSuccess: () => {
      setEmailSaved(true);
      trackEvent("lead_captured", {
        profileType,
        riskTolerance,
        timeHorizon,
        capitalRange,
        privateAccess: recommendation?.privateAccess,
      });
      toast({
        title: "Profile saved",
        description: "We've saved your profile. You'll receive your summary shortly.",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't save",
        description: err?.message ?? "Please try again in a moment.",
        variant: "destructive",
      });
    },
  });

  const handleAccountCreate = () => {
    // Stash answers so the apply / onboarding flow can prefill or reference them
    try {
      sessionStorage.setItem(
        "amax_flow_a_profile",
        JSON.stringify({
          profileType,
          goals,
          riskTolerance,
          timeHorizon,
          capitalRange,
          recommendedStrategy: recommendation?.strategy,
          privateAccess: recommendation?.privateAccess,
          email,
        })
      );
    } catch {}
    navigate("/apply");
  };

  // ---------------- STEP 1 ----------------
  if (step === 1) {
    return (
      <div className="min-h-screen bg-gray-50">
        <PublicHeader />
        <StepShell
          step={1}
          title="Tell us who you're investing as"
          subtitle="This helps us match you to the right structures and eligibility."
          onNext={() => { trackEvent("flow_a_step_complete", { step: 1 }); setStep(2); }}
          nextDisabled={!profileType}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {PROFILE_OPTIONS.map((opt) => (
              <OptionCard
                key={opt.value}
                selected={profileType === opt.value}
                onClick={() => setProfileType(opt.value)}
                title={opt.label}
                desc={opt.desc}
                testId={`option-profile-${opt.value}`}
              />
            ))}
          </div>
        </StepShell>
        <PublicFooter />
      </div>
    );
  }

  // ---------------- STEP 2 ----------------
  if (step === 2) {
    return (
      <div className="min-h-screen bg-gray-50">
        <PublicHeader />
        <StepShell
          step={2}
          title="What are you trying to achieve?"
          subtitle="Pick all that apply. We'll weight the recommendation accordingly."
          onBack={() => setStep(1)}
          onNext={() => { trackEvent("flow_a_step_complete", { step: 2 }); setStep(3); }}
          nextDisabled={goals.length === 0}
        >
          <div className="flex flex-wrap gap-2">
            {GOAL_OPTIONS.map((opt) => {
              const active = goals.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  data-testid={`option-goal-${opt.value}`}
                  onClick={() =>
                    setGoals((g) =>
                      g.includes(opt.value) ? g.filter((x) => x !== opt.value) : [...g, opt.value]
                    )
                  }
                  className={`px-4 py-2 rounded-full border-2 text-sm font-medium transition-all ${
                    active
                      ? "border-sky-500 bg-sky-500 text-white"
                      : "border-gray-300 bg-white text-gray-700 hover:border-sky-300"
                  }`}
                >
                  {active && <Check className="w-3.5 h-3.5 inline mr-1.5" />}
                  {opt.label}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-gray-500 mt-4">
            {goals.length === 0 ? "Select at least one." : `${goals.length} selected`}
          </p>
        </StepShell>
        <PublicFooter />
      </div>
    );
  }

  // ---------------- STEP 3 ----------------
  if (step === 3) {
    return (
      <div className="min-h-screen bg-gray-50">
        <PublicHeader />
        <StepShell
          step={3}
          title="Risk and time horizon"
          subtitle="Both matter — short horizons should generally avoid high-risk allocations."
          onBack={() => setStep(2)}
          onNext={() => { trackEvent("flow_a_step_complete", { step: 3 }); setStep(4); }}
          nextDisabled={!riskTolerance || !timeHorizon}
        >
          <div className="space-y-8">
            <div>
              <p className="text-sm font-semibold text-sky-900 mb-3">Risk tolerance</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {RISK_OPTIONS.map((opt) => (
                  <OptionCard
                    key={opt.value}
                    selected={riskTolerance === opt.value}
                    onClick={() => setRiskTolerance(opt.value)}
                    title={opt.label}
                    desc={opt.desc}
                    testId={`option-risk-${opt.value}`}
                  />
                ))}
              </div>
            </div>
            <div>
              <p className="text-sm font-semibold text-sky-900 mb-3">Time horizon</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {HORIZON_OPTIONS.map((opt) => (
                  <OptionCard
                    key={opt.value}
                    selected={timeHorizon === opt.value}
                    onClick={() => setTimeHorizon(opt.value)}
                    title={opt.label}
                    desc={opt.desc}
                    testId={`option-horizon-${opt.value}`}
                  />
                ))}
              </div>
            </div>
          </div>
        </StepShell>
        <PublicFooter />
      </div>
    );
  }

  // ---------------- STEP 4 ----------------
  if (step === 4) {
    return (
      <div className="min-h-screen bg-gray-50">
        <PublicHeader />
        <StepShell
          step={4}
          title="How much are you looking to invest?"
          subtitle="At $100,000+ our private-deal pipeline typically becomes relevant, subject to wholesale-investor verification."
          onBack={() => setStep(3)}
          onNext={() => { trackEvent("flow_a_step_complete", { step: 4 }); setStep(5); }}
          nextDisabled={!capitalRange}
          nextLabel="See my recommendation"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {CAPITAL_OPTIONS.map((opt) => (
              <OptionCard
                key={opt.value}
                selected={capitalRange === opt.value}
                onClick={() => setCapitalRange(opt.value)}
                title={opt.label}
                desc={opt.desc}
                testId={`option-capital-${opt.value}`}
              />
            ))}
          </div>
        </StepShell>
        <PublicFooter />
      </div>
    );
  }

  // ---------------- STEP 5 ----------------
  if (!recommendation) {
    // Safety net — should never hit
    setStep(1);
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <PublicHeader />
      <div className="max-w-3xl mx-auto px-6 py-12">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs uppercase tracking-wider text-sky-700 font-semibold">
              Step 5 of {TOTAL_STEPS}
            </span>
            <span className="text-xs text-gray-500">Your recommendation</span>
          </div>
          <Progress value={100} className="h-1.5" />
        </div>

        {/* Recommendation card */}
        <Card className="border-sky-200 shadow-sm mb-6" data-testid="recommendation-card">
          <CardContent className="p-8">
            <Badge className="bg-sky-100 text-sky-900 mb-4">Indicative profile</Badge>
            <h1 className="text-3xl md:text-4xl font-bold text-sky-900 mb-3">
              {recommendation.strategy}
            </h1>
            <p className="text-gray-700 mb-6">{recommendation.summary}</p>

            {recommendation.caveat && (
              <div className="bg-amber-50 border border-amber-200 rounded-md p-4 mb-6">
                <p className="text-sm text-amber-900">
                  <strong>Note:</strong> {recommendation.caveat}
                </p>
              </div>
            )}

            <div>
              <p className="text-xs uppercase tracking-wider text-gray-500 font-semibold mb-3">
                Indicative allocation
              </p>
              <div className="space-y-2">
                {recommendation.allocation.map((slice) => (
                  <div key={slice.label}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-700">{slice.label}</span>
                      <span className="font-semibold text-sky-900">{slice.pct}%</span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-sky-500"
                        style={{ width: `${slice.pct}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Private access — gold-bordered, capital-gated */}
        {recommendation.privateAccess && (
          <Card
            className="border-2 border-amber-400 bg-gradient-to-br from-amber-50 to-white mb-6"
            data-testid="private-access-card"
          >
            <CardContent className="p-8">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                  <Sparkles className="w-6 h-6 text-amber-600" />
                </div>
                <div>
                  <Badge className="bg-amber-500 text-white mb-2">Private deal flow available</Badge>
                  <h2 className="text-xl font-bold text-sky-900 mb-2">
                    Private-deal pipeline available to verified wholesale investors
                  </h2>
                  <p className="text-gray-700 mb-3">
                    At your indicated capital range, our private-deal pipeline becomes
                    relevant — first-mortgage credit, real estate co-investments, and selective
                    venture allocations are typically offered in this segment, subject to
                    wholesale-investor verification.
                  </p>
                  <p className="text-xs text-gray-500">
                    General information only. Eligibility is determined after wholesale-investor
                    verification under s761G/s761GA of the Corporations Act 2001 (Cth). This is
                    not personal advice.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Featured deal — only when capital >= $100k */}
        {recommendation.showFeaturedDeal && (
          <Card
            className="bg-sky-900 text-white border-sky-900 mb-6"
            data-testid="featured-deal-card"
          >
            <CardContent className="p-8">
              <Badge className="bg-amber-500 text-white mb-3">Currently open</Badge>
              <h3 className="text-2xl font-bold mb-2">Islington Senior Credit — Tranche II</h3>
              <p className="text-sky-100 mb-4">
                Senior secured first-mortgage facility on a settled UK residential portfolio.
                Targeting a 9.5% net IRR over a 24-month term.
              </p>
              <div className="grid grid-cols-3 gap-4 mb-4">
                <div>
                  <p className="text-xs text-sky-300">Target net IRR</p>
                  <p className="text-lg font-semibold">9.5%</p>
                </div>
                <div>
                  <p className="text-xs text-sky-300">Term</p>
                  <p className="text-lg font-semibold">24 mo</p>
                </div>
                <div>
                  <p className="text-xs text-sky-300">Min. investment</p>
                  <p className="text-lg font-semibold">$100k</p>
                </div>
              </div>
              <p className="text-xs text-sky-300">
                Indicative only. Available to verified wholesale investors after account opening.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Email capture — appears under recommendation, not alongside */}
        {!emailSaved ? (
          <Card className="border-gray-200 mb-6">
            <CardContent className="p-6">
              <div className="flex items-start gap-3 mb-4">
                <Mail className="w-5 h-5 text-sky-700 mt-0.5" />
                <div>
                  <p className="font-semibold text-sky-900">Send me this profile + relevant opportunities</p>
                  <p className="text-sm text-gray-600 mt-0.5">
                    We'll email a copy of this profile and notify you of deal flow that matches. No spam.
                  </p>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="input-email"
                  className="flex-1"
                />
                {/* Honeypot — hidden from real users */}
                <input
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  style={{ position: "absolute", left: "-9999px", width: 1, height: 1 }}
                  aria-hidden="true"
                />
                <Button
                  onClick={() => leadMutation.mutate()}
                  disabled={!email || leadMutation.isPending || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)}
                  className="bg-sky-500 hover:bg-sky-600 text-white"
                  data-testid="button-save-email"
                >
                  {leadMutation.isPending ? "Saving..." : "Email me this summary"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-green-200 bg-green-50 mb-6">
            <CardContent className="p-6 flex items-center gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0" />
              <div>
                <p className="font-semibold text-green-900">Profile saved</p>
                <p className="text-sm text-green-800">
                  We've saved your profile to <strong>{email}</strong>. You'll receive your summary shortly.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Account creation handoff */}
        <Card className="bg-sky-50 border-sky-200">
          <CardContent className="p-6">
            <div className="flex items-start gap-3 mb-4">
              <Shield className="w-5 h-5 text-sky-700 mt-0.5" />
              <div>
                <p className="font-semibold text-sky-900">Continue to wholesale investor application</p>
                <p className="text-sm text-gray-700 mt-0.5">
                  Open an account to access your dashboard, complete fact-find &amp; KYC, and view live deal terms.
                </p>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <Button
                onClick={handleAccountCreate}
                className="bg-sky-500 hover:bg-sky-600 text-white font-semibold"
                data-testid="button-apply"
              >
                Continue to application <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
              <Button
                variant="ghost"
                onClick={() => setStep(1)}
                className="text-sky-900"
              >
                <ArrowLeft className="w-4 h-4 mr-2" /> Start over
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Disclaimer */}
        <div className="mt-8 p-4 bg-gray-100 rounded-md">
          <p className="text-xs text-gray-600 leading-relaxed">
            <Lock className="w-3 h-3 inline mr-1" />
            <strong>General information only.</strong> This recommendation is generated from the
            information you provided and does not constitute personal financial product advice. AMAX
            Wealth is an Authorised Representative under AFSL. Investment products are available only
            to verified wholesale investors as defined under s761G/s761GA of the Corporations Act
            2001 (Cth). Past performance is not indicative of future results.
          </p>
        </div>
      </div>
      <PublicFooter />
    </div>
  );
}

function PublicHeader() {
  const [, navigate] = useLocation();
  return (
    <header className="bg-white border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        <button
          onClick={() => navigate("/")}
          className="flex items-center gap-2"
          data-testid="link-home"
        >
          <span className="text-xl font-bold text-sky-900">AMAX WEALTH</span>
        </button>
        <Button
          variant="ghost"
          onClick={() => navigate("/login")}
          className="text-sky-900"
        >
          Sign in
        </Button>
      </div>
    </header>
  );
}

function PublicFooter() {
  return (
    <footer className="border-t border-gray-200 mt-16 py-6">
      <div className="max-w-7xl mx-auto px-6">
        <p className="text-xs text-gray-500 text-center">
          AMAX Wealth — Authorised Representative under AFSL. Wholesale clients only.
        </p>
      </div>
    </footer>
  );
}
