import { useState, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Save,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { RiskAssessmentResponse, RiskAssessmentAnswers } from "@shared/schema";

const STEPS = [
  {
    key: "experience" as const,
    label: "Investment experience",
    short: "Experience",
    intro: "Tell us about your background as an investor so we can match products to your familiarity.",
  },
  {
    key: "objectives" as const,
    label: "Investment objectives",
    short: "Objectives",
    intro: "Help us understand what you're investing for and how soon you'll need access to the money.",
  },
  {
    key: "riskTolerance" as const,
    label: "Risk tolerance",
    short: "Risk tolerance",
    intro: "These questions calibrate how much short-term volatility your portfolio should be allowed to carry.",
  },
];

const PRODUCT_OPTIONS = [
  { value: "shares", label: "Listed shares" },
  { value: "etfs", label: "ETFs and managed funds" },
  { value: "bonds", label: "Bonds and fixed income" },
  { value: "property", label: "Direct or fund-based property" },
  { value: "crypto", label: "Cryptocurrency" },
  { value: "private_credit", label: "Private credit / private equity" },
  { value: "derivatives", label: "Options or other derivatives" },
];

const YEARS_OPTIONS = [
  { value: "lt2", label: "Less than 2 years" },
  { value: "2to5", label: "2 to 5 years" },
  { value: "5to10", label: "5 to 10 years" },
  { value: "10plus", label: "More than 10 years" },
];

const COMPLEX_OPTIONS = [
  { value: "none", label: "None — I prefer plain-vanilla products" },
  { value: "some", label: "Some — I've held one or two complex products" },
  { value: "extensive", label: "Extensive — I've actively managed complex strategies" },
];

const OBJECTIVE_OPTIONS = [
  { value: "capital_preservation", label: "Capital preservation — protect what I have" },
  { value: "income", label: "Steady income — regular distributions" },
  { value: "balanced", label: "Balanced — modest growth with some income" },
  { value: "growth", label: "Capital growth — primarily long-term appreciation" },
  { value: "aggressive_growth", label: "Aggressive growth — maximise returns, accept large swings" },
];

const HORIZON_OPTIONS = [
  { value: "lt1", label: "Less than 1 year" },
  { value: "1to3", label: "1 to 3 years" },
  { value: "3to5", label: "3 to 5 years" },
  { value: "5to10", label: "5 to 10 years" },
  { value: "10plus", label: "More than 10 years" },
];

const LIQUIDITY_OPTIONS = [
  { value: "high", label: "High — I may need access within 30 days" },
  { value: "medium", label: "Medium — I may need access within 6 months" },
  { value: "low", label: "Low — I can lock funds away for 1+ years" },
];

const MAX_LOSS_OPTIONS = [
  { value: "lt5", label: "Less than 5%" },
  { value: "5to10", label: "Between 5% and 10%" },
  { value: "10to20", label: "Between 10% and 20%" },
  { value: "20to30", label: "Between 20% and 30%" },
  { value: "gt30", label: "More than 30%" },
];

const DOWNTURN_OPTIONS = [
  { value: "sell_all", label: "Sell everything to stop further losses" },
  { value: "sell_some", label: "Trim my exposure to reduce risk" },
  { value: "hold", label: "Hold — stay the course" },
  { value: "buy_more", label: "Buy more while prices are lower" },
];

const ATTITUDE_OPTIONS = [
  { value: "very_conservative", label: "Very conservative — capital safety is paramount" },
  { value: "conservative", label: "Conservative — small fluctuations OK" },
  { value: "moderate", label: "Moderate — balanced view of risk and reward" },
  { value: "aggressive", label: "Aggressive — willing to accept large swings for higher returns" },
  { value: "very_aggressive", label: "Very aggressive — chase the highest possible return" },
];

type Answers = Required<RiskAssessmentAnswers>;

function emptyAnswers(): Answers {
  return {
    experience: { yearsInvesting: "", productTypes: [], complexProductsExperience: "" },
    objectives: { primaryObjective: "", investmentHorizon: "", liquidityNeeds: "" },
    riskTolerance: { maxAcceptableLoss: "", downturnReaction: "", riskAttitude: "" },
  };
}

function isStepComplete(answers: Answers, idx: number): boolean {
  if (idx === 0) {
    const e = answers.experience ?? {};
    return !!e.yearsInvesting && !!e.complexProductsExperience && (e.productTypes ?? []).length > 0;
  }
  if (idx === 1) {
    const o = answers.objectives ?? {};
    return !!o.primaryObjective && !!o.investmentHorizon && !!o.liquidityNeeds;
  }
  const r = answers.riskTolerance ?? {};
  return !!r.maxAcceptableLoss && !!r.downturnReaction && !!r.riskAttitude;
}

export default function RiskAssessment() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data, isLoading } = useQuery<{ response: RiskAssessmentResponse | null }>({
    queryKey: ["/api/risk-assessment"],
  });

  const [answers, setAnswers] = useState<Answers>(emptyAnswers);
  const [currentStep, setCurrentStep] = useState(0);
  const [hydrated, setHydrated] = useState(false);

  // Seed local state from the server's saved progress exactly once.
  useEffect(() => {
    if (hydrated || isLoading) return;
    const saved = data?.response;
    if (saved) {
      const base = emptyAnswers();
      setAnswers({
        experience: { ...base.experience, ...(saved.answers?.experience ?? {}) },
        objectives: { ...base.objectives, ...(saved.answers?.objectives ?? {}) },
        riskTolerance: { ...base.riskTolerance, ...(saved.answers?.riskTolerance ?? {}) },
      });
      const resumeAt = Math.min(Math.max(saved.currentStep ?? 0, 0), STEPS.length - 1);
      setCurrentStep(resumeAt);
    }
    setHydrated(true);
  }, [data, isLoading, hydrated]);

  const isComplete = data?.response?.status === "complete";

  const saveMutation = useMutation({
    mutationFn: async (payload: { answers: Answers; currentStep: number }) => {
      const res = await apiRequest("PUT", "/api/risk-assessment", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/risk-assessment"] });
    },
  });

  const submitMutation = useMutation({
    mutationFn: async (finalAnswers: Answers) => {
      const res = await apiRequest("POST", "/api/risk-assessment/submit", finalAnswers);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/risk-assessment"] });
      toast({
        title: "Risk assessment submitted",
        description: "Step A is complete. Step B (wholesale certification) is now unlocked.",
      });
      navigate("/compliance");
    },
    onError: (err: any) => {
      toast({
        title: "Could not submit",
        description: err?.message || "Please review your answers and try again.",
        variant: "destructive",
      });
    },
  });

  const allStepsComplete = useMemo(
    () => STEPS.every((_, i) => isStepComplete(answers, i)),
    [answers],
  );
  const currentStepComplete = isStepComplete(answers, currentStep);
  const progressPct = isComplete
    ? 100
    : Math.round(((currentStep + (currentStepComplete ? 1 : 0)) / STEPS.length) * 100);

  function updateExperience(patch: Partial<Answers["experience"]>) {
    setAnswers((prev) => ({ ...prev, experience: { ...prev.experience, ...patch } }));
  }
  function updateObjectives(patch: Partial<Answers["objectives"]>) {
    setAnswers((prev) => ({ ...prev, objectives: { ...prev.objectives, ...patch } }));
  }
  function updateRiskTolerance(patch: Partial<Answers["riskTolerance"]>) {
    setAnswers((prev) => ({ ...prev, riskTolerance: { ...prev.riskTolerance, ...patch } }));
  }
  function toggleProduct(value: string, checked: boolean) {
    const current = new Set(answers.experience.productTypes ?? []);
    if (checked) current.add(value);
    else current.delete(value);
    updateExperience({ productTypes: Array.from(current) });
  }

  async function handleSaveAndExit() {
    if (isComplete) {
      navigate("/compliance");
      return;
    }
    try {
      await saveMutation.mutateAsync({ answers, currentStep });
      toast({
        title: "Progress saved",
        description: "You can pick up where you left off any time.",
      });
      navigate("/compliance");
    } catch (err: any) {
      toast({
        title: "Could not save",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
    }
  }

  async function handleNext() {
    if (!currentStepComplete) return;
    const nextStep = currentStep + 1;
    try {
      await saveMutation.mutateAsync({ answers, currentStep: nextStep });
    } catch {
      // Non-fatal — we still let the user advance locally so they don't lose
      // their place because of a transient save failure. Errors surface via
      // the mutation's isError state on the next save attempt.
    }
    setCurrentStep(nextStep);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleBack() {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function handleSubmit() {
    if (!allStepsComplete) return;
    submitMutation.mutate(answers);
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#faf8f5] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-gray-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#faf8f5] p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => navigate("/compliance")}
            className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
            data-testid="link-back-to-compliance"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to compliance centre
          </button>
          <div>
            <p className="text-xs font-semibold tracking-wider text-gray-500 uppercase">
              AMAX — Step A
            </p>
            <h1 className="text-2xl font-bold text-gray-900">
              Risk assessment questionnaire
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Investment experience, objectives, and risk tolerance · Estimated time 5–8 minutes
            </p>
          </div>
        </div>

        {/* Progress */}
        <Card className="bg-white border border-gray-200 shadow-none">
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-gray-700">
                {isComplete
                  ? "Submitted"
                  : `Step ${currentStep + 1} of ${STEPS.length} · ${STEPS[currentStep].label}`}
              </p>
              <p className="text-sm font-semibold text-gray-900" data-testid="text-progress-pct">
                {progressPct}%
              </p>
            </div>
            <div
              className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden"
              data-testid="progress-questionnaire"
            >
              <div
                className="h-full bg-green-500 rounded-full transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              {STEPS.map((step, i) => {
                const done = isStepComplete(answers, i) || isComplete;
                const active = i === currentStep && !isComplete;
                return (
                  <div
                    key={step.key}
                    data-testid={`step-pill-${i}`}
                    className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium border ${
                      active
                        ? "bg-blue-50 text-blue-700 border-blue-200"
                        : done
                          ? "bg-green-50 text-green-700 border-green-200"
                          : "bg-gray-50 text-gray-500 border-gray-200"
                    }`}
                  >
                    {done ? <Check className="w-3 h-3" /> : <span>{i + 1}</span>}
                    {step.short}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {isComplete && (
          <Card
            className="bg-green-50 border border-green-200 shadow-none"
            data-testid="banner-already-complete"
          >
            <CardContent className="p-5 flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-green-100 text-green-700 flex items-center justify-center flex-shrink-0">
                <Check className="w-4 h-4" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900">
                  Risk assessment already submitted
                </p>
                <p className="text-sm text-gray-600 mt-1">
                  Your answers were submitted on{" "}
                  {data?.response?.submittedAt
                    ? new Date(data.response.submittedAt).toLocaleDateString()
                    : "a previous date"}
                  . Step B (wholesale certification) is now unlocked on the compliance page.
                </p>
                <Button
                  className="mt-3"
                  variant="outline"
                  onClick={() => navigate("/compliance")}
                  data-testid="button-back-to-compliance"
                >
                  Return to compliance
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step content */}
        <Card className="bg-white border border-gray-200 shadow-none">
          <CardContent className="p-6 space-y-6">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                {STEPS[currentStep].label}
              </h2>
              <p className="text-sm text-gray-500 mt-1">{STEPS[currentStep].intro}</p>
            </div>

            {currentStep === 0 && (
              <div className="space-y-6" data-testid="section-experience">
                <RadioQuestion
                  testId="question-years-investing"
                  label="How long have you been actively investing?"
                  value={answers.experience.yearsInvesting ?? ""}
                  onChange={(v) => updateExperience({ yearsInvesting: v })}
                  options={YEARS_OPTIONS}
                  disabled={isComplete}
                />
                <CheckboxQuestion
                  testId="question-product-types"
                  label="Which products have you personally invested in? (Select all that apply.)"
                  selected={answers.experience.productTypes ?? []}
                  onToggle={toggleProduct}
                  options={PRODUCT_OPTIONS}
                  disabled={isComplete}
                />
                <RadioQuestion
                  testId="question-complex-products"
                  label="How much experience do you have with complex investment products?"
                  value={answers.experience.complexProductsExperience ?? ""}
                  onChange={(v) => updateExperience({ complexProductsExperience: v })}
                  options={COMPLEX_OPTIONS}
                  disabled={isComplete}
                />
              </div>
            )}

            {currentStep === 1 && (
              <div className="space-y-6" data-testid="section-objectives">
                <RadioQuestion
                  testId="question-primary-objective"
                  label="What is the primary objective for your AMAX portfolio?"
                  value={answers.objectives.primaryObjective ?? ""}
                  onChange={(v) => updateObjectives({ primaryObjective: v })}
                  options={OBJECTIVE_OPTIONS}
                  disabled={isComplete}
                />
                <RadioQuestion
                  testId="question-investment-horizon"
                  label="Over what time horizon do you expect to stay invested?"
                  value={answers.objectives.investmentHorizon ?? ""}
                  onChange={(v) => updateObjectives({ investmentHorizon: v })}
                  options={HORIZON_OPTIONS}
                  disabled={isComplete}
                />
                <RadioQuestion
                  testId="question-liquidity"
                  label="How quickly might you need to access these funds?"
                  value={answers.objectives.liquidityNeeds ?? ""}
                  onChange={(v) => updateObjectives({ liquidityNeeds: v })}
                  options={LIQUIDITY_OPTIONS}
                  disabled={isComplete}
                />
              </div>
            )}

            {currentStep === 2 && (
              <div className="space-y-6" data-testid="section-risk-tolerance">
                <RadioQuestion
                  testId="question-max-loss"
                  label="What is the maximum drop in portfolio value you could tolerate in a single year?"
                  value={answers.riskTolerance.maxAcceptableLoss ?? ""}
                  onChange={(v) => updateRiskTolerance({ maxAcceptableLoss: v })}
                  options={MAX_LOSS_OPTIONS}
                  disabled={isComplete}
                />
                <RadioQuestion
                  testId="question-downturn-reaction"
                  label="If your portfolio fell 25% over a few months, what would you most likely do?"
                  value={answers.riskTolerance.downturnReaction ?? ""}
                  onChange={(v) => updateRiskTolerance({ downturnReaction: v })}
                  options={DOWNTURN_OPTIONS}
                  disabled={isComplete}
                />
                <RadioQuestion
                  testId="question-risk-attitude"
                  label="Which statement best describes your overall attitude to risk?"
                  value={answers.riskTolerance.riskAttitude ?? ""}
                  onChange={(v) => updateRiskTolerance({ riskAttitude: v })}
                  options={ATTITUDE_OPTIONS}
                  disabled={isComplete}
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Footer actions */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            variant="outline"
            onClick={handleSaveAndExit}
            disabled={saveMutation.isPending || isComplete}
            data-testid="button-save-and-exit"
          >
            {saveMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Save className="w-4 h-4 mr-2" />
            )}
            Save and continue later
          </Button>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={handleBack}
              disabled={currentStep === 0}
              data-testid="button-back"
            >
              <ChevronLeft className="w-4 h-4 mr-1" />
              Back
            </Button>
            {currentStep < STEPS.length - 1 ? (
              <Button
                onClick={handleNext}
                disabled={!currentStepComplete || isComplete || saveMutation.isPending}
                data-testid="button-next"
              >
                Next
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            ) : (
              <Button
                onClick={handleSubmit}
                disabled={!allStepsComplete || isComplete || submitMutation.isPending}
                data-testid="button-submit-questionnaire"
              >
                {submitMutation.isPending && (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                )}
                Submit risk assessment
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RadioQuestion({
  label,
  value,
  onChange,
  options,
  testId,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  testId: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3" data-testid={testId}>
      <Label className="text-sm font-medium text-gray-900">{label}</Label>
      <RadioGroup value={value} onValueChange={onChange} disabled={disabled} className="space-y-2">
        {options.map((opt) => {
          const id = `${testId}-${opt.value}`;
          return (
            <div
              key={opt.value}
              className="flex items-start gap-3 p-3 border border-gray-200 rounded-md hover:bg-gray-50"
            >
              <RadioGroupItem
                value={opt.value}
                id={id}
                className="mt-0.5"
                data-testid={`${testId}-option-${opt.value}`}
              />
              <Label htmlFor={id} className="text-sm text-gray-700 leading-snug cursor-pointer">
                {opt.label}
              </Label>
            </div>
          );
        })}
      </RadioGroup>
    </div>
  );
}

function CheckboxQuestion({
  label,
  selected,
  onToggle,
  options,
  testId,
  disabled,
}: {
  label: string;
  selected: string[];
  onToggle: (value: string, checked: boolean) => void;
  options: { value: string; label: string }[];
  testId: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3" data-testid={testId}>
      <Label className="text-sm font-medium text-gray-900">{label}</Label>
      <div className="space-y-2">
        {options.map((opt) => {
          const id = `${testId}-${opt.value}`;
          const checked = selected.includes(opt.value);
          return (
            <div
              key={opt.value}
              className="flex items-start gap-3 p-3 border border-gray-200 rounded-md hover:bg-gray-50"
            >
              <Checkbox
                id={id}
                checked={checked}
                disabled={disabled}
                onCheckedChange={(c) => onToggle(opt.value, c === true)}
                className="mt-0.5"
                data-testid={`${testId}-option-${opt.value}`}
              />
              <Label htmlFor={id} className="text-sm text-gray-700 leading-snug cursor-pointer">
                {opt.label}
              </Label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
