import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, Lock } from "lucide-react";

const sumsubSidebarSteps = [
  {
    label: "SUMSUB",
    title: "Identity verification",
    desc: "Completed 2 Aug 2025",
    status: "completed" as const,
  },
  {
    label: "SUMSUB",
    title: "AML / PEP screening",
    desc: "Completed 2 Aug 2025",
    status: "completed" as const,
  },
  {
    label: "SUMSUB + AMAX",
    title: "Source of funds",
    desc: "Awaiting AMAX review · 1–2 business days",
    status: "pending" as const,
  },
];

const amaxSidebarSteps = [
  {
    letter: "A",
    label: "AMAX",
    title: "Risk assessment",
    desc: "Your action required",
    status: "action" as const,
  },
  {
    letter: "B",
    label: "AMAX + LEGAL",
    title: "Wholesale certification",
    desc: "Locked — complete risk assessment first",
    status: "locked" as const,
  },
];

const sumsubSteps = [
  {
    title: "Identity document",
    desc: "Government-issued ID verified — passport",
    status: "done" as const,
  },
  {
    title: "Liveness check",
    desc: "Selfie biometric match completed",
    status: "done" as const,
  },
  {
    title: "AML / PEP screening",
    desc: "Politically exposed persons and sanctions check — clear",
    status: "done" as const,
  },
  {
    title: "Source of funds declaration",
    desc: "Declaration submitted — under AMAX compliance review",
    helper: "No further action required from you · Typically 1–2 business days",
    status: "review" as const,
  },
];

export default function Compliance() {
  return (
    <div className="min-h-screen bg-[#faf8f5] p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              AMAX Wealth — KYC &amp; compliance centre
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Identity verification powered by Sumsub · Investment suitability by AMAX
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              data-testid="badge-tier-status"
              className="bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-50 px-3 py-1 rounded-full font-medium"
            >
              Tier 1 verified
            </Badge>
            <Badge
              data-testid="badge-wholesale-status"
              className="bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-50 px-3 py-1 rounded-full font-medium"
            >
              Wholesale upgrade in progress
            </Badge>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
          {/* Sidebar */}
          <aside className="space-y-6">
            {/* Overall progress */}
            <Card className="bg-white border border-gray-200 shadow-none">
              <CardContent className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-gray-700">Overall progress</p>
                  <p className="text-2xl font-bold text-gray-900">50%</p>
                </div>
                <div
                  className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden"
                  data-testid="progress-overall"
                >
                  <div className="h-full bg-green-500 rounded-full" style={{ width: "50%" }} />
                </div>
                <div className="text-sm leading-relaxed">
                  <span className="text-green-600">2 complete</span>
                  <span className="text-gray-400"> · </span>
                  <span className="text-blue-600">1 action required</span>
                  <span className="text-gray-400"> · </span>
                  <span className="text-amber-600">1 under review</span>
                </div>
              </CardContent>
            </Card>

            {/* Sumsub steps */}
            <div className="space-y-3">
              <p className="text-xs font-semibold tracking-wider text-gray-500">
                SUMSUB — IDENTITY &amp; AML
              </p>
              <Card className="bg-white border border-gray-200 shadow-none">
                <CardContent className="p-2">
                  {sumsubSidebarSteps.map((step, i) => (
                    <div
                      key={i}
                      data-testid={`sidebar-sumsub-step-${i}`}
                      className="flex items-start gap-3 p-3"
                    >
                      <div
                        className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                          step.status === "completed"
                            ? "bg-green-50 text-green-600 border border-green-200"
                            : "bg-amber-50 text-amber-600 border border-amber-200"
                        }`}
                      >
                        {step.status === "completed" ? (
                          <Check className="w-4 h-4" />
                        ) : (
                          <span className="text-sm font-bold leading-none">!</span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold tracking-wider text-gray-400 uppercase">
                          {step.label}
                        </p>
                        <p className="text-sm font-medium text-gray-900">{step.title}</p>
                        <p
                          className={`text-xs ${
                            step.status === "completed" ? "text-green-600" : "text-amber-600"
                          }`}
                        >
                          {step.desc}
                        </p>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>

            {/* AMAX steps */}
            <div className="space-y-3">
              <p className="text-xs font-semibold tracking-wider text-gray-500">
                AMAX — SUITABILITY &amp; CLASSIFICATION
              </p>
              <Card className="bg-white border border-gray-200 shadow-none">
                <CardContent className="p-2">
                  {amaxSidebarSteps.map((step, i) => (
                    <div
                      key={i}
                      data-testid={`sidebar-amax-step-${i}`}
                      className={`flex items-start gap-3 p-3 rounded-md ${
                        step.status === "action" ? "bg-green-50/60" : ""
                      }`}
                    >
                      <div
                        className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                          step.status === "action"
                            ? "bg-green-600 text-white"
                            : "bg-gray-100 text-gray-400 border border-gray-200"
                        }`}
                      >
                        {step.letter}
                      </div>
                      <div className="min-w-0">
                        <p
                          className={`text-[10px] font-semibold tracking-wider uppercase ${
                            step.status === "action" ? "text-gray-500" : "text-gray-400"
                          }`}
                        >
                          {step.label}
                        </p>
                        <p
                          className={`text-sm font-medium ${
                            step.status === "action" ? "text-gray-900" : "text-gray-400"
                          }`}
                        >
                          {step.title}
                        </p>
                        <p
                          className={`text-xs ${
                            step.status === "action" ? "text-blue-600" : "text-gray-400"
                          }`}
                        >
                          {step.desc}
                        </p>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>

            {/* Wholesale classification footer */}
            <div className="space-y-2 px-1">
              <p className="text-xs font-semibold tracking-wider text-gray-500">
                WHOLESALE CLASSIFICATION
              </p>
              <div className="text-sm text-gray-600 space-y-1 leading-relaxed">
                <p>s761G Corporations Act 2001 (Cth)</p>
                <p>
                  Current tier: <span className="text-gray-900">Tier 1 — Verified</span>
                </p>
                <p>Wholesale upgrade: pending steps A &amp; B</p>
                <p>Re-verification due: 2 Aug 2026 · 89 days</p>
              </div>
            </div>
          </aside>

          {/* Main panel */}
          <main className="space-y-6">
            {/* Gating banner */}
            <div
              data-testid="banner-gating"
              className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-gray-700"
            >
              Investment limits remain restricted until risk assessment is completed. Full
              wholesale product access unlocks after both AMAX steps are verified.
            </div>

            {/* Sumsub card */}
            <Card className="bg-white border border-gray-200 shadow-none overflow-hidden">
              <div
                className="bg-gray-900 text-white px-5 py-4 flex items-center justify-between"
                data-testid="header-sumsub-card"
              >
                <div>
                  <p className="font-semibold">Sumsub</p>
                  <p className="text-xs text-gray-300">
                    Identity &amp; AML verification for AMAX Wealth
                  </p>
                </div>
                <Badge className="bg-amber-300 text-amber-900 hover:bg-amber-300 px-3 py-1 rounded-full font-medium border-0">
                  Session active
                </Badge>
              </div>

              <CardContent className="p-0">
                <div className="divide-y divide-gray-100">
                  {sumsubSteps.map((step, i) => (
                    <div
                      key={i}
                      data-testid={`sumsub-step-${i}`}
                      className="flex items-start justify-between gap-4 px-5 py-4"
                    >
                      <div className="flex items-start gap-3 min-w-0">
                        <div
                          className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
                            step.status === "done"
                              ? "bg-green-50 text-green-600 border border-green-200"
                              : "bg-amber-50 text-amber-600 border border-amber-200"
                          }`}
                        >
                          {step.status === "done" ? (
                            <Check className="w-4 h-4" />
                          ) : (
                            <span className="text-sm font-bold leading-none">!</span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900">{step.title}</p>
                          <p className="text-sm text-gray-500">{step.desc}</p>
                          {step.helper && (
                            <p className="text-xs text-blue-600 mt-1">{step.helper}</p>
                          )}
                        </div>
                      </div>
                      <Badge
                        className={`flex-shrink-0 px-3 py-1 rounded-full border font-medium ${
                          step.status === "done"
                            ? "bg-green-50 text-green-700 border-green-200 hover:bg-green-50"
                            : "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-50"
                        }`}
                      >
                        {step.status === "done" ? "Done" : "Under review"}
                      </Badge>
                    </div>
                  ))}
                </div>

                {/* Audit footer */}
                <div
                  className="grid grid-cols-1 sm:grid-cols-3 gap-4 px-5 py-4 bg-[#faf8f5] border-t border-gray-100"
                  data-testid="footer-sumsub-audit"
                >
                  <div>
                    <p className="text-xs text-gray-500">KYC provider</p>
                    <p className="text-sm font-medium text-gray-900">Sumsub</p>
                    <p className="text-xs text-gray-500">WebSDK · Tier 2 flow</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Applicant ID</p>
                    <p className="text-sm font-medium text-gray-900 font-mono">AMAX-W-00042</p>
                    <p className="text-xs text-gray-500">Created 2 Aug 2025</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Last verified</p>
                    <p className="text-sm font-medium text-gray-900">2 Aug 2025</p>
                    <p className="text-xs text-gray-500">AUSTRAC audit logged</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* AMAX suitability card */}
            <Card className="bg-white border border-gray-200 shadow-none overflow-hidden">
              <div
                className="px-5 py-4 flex items-center justify-between border-b border-gray-100"
                data-testid="header-amax-card"
              >
                <div>
                  <p className="font-semibold text-gray-900">AMAX — Investment suitability</p>
                  <p className="text-xs text-gray-500">
                    Internal steps managed by AMAX Wealth · Not part of Sumsub flow
                  </p>
                </div>
                <Badge className="bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-50 px-3 py-1 rounded-full font-medium">
                  2 steps
                </Badge>
              </div>

              <CardContent className="p-0">
                {/* Step A */}
                <div
                  className="flex items-start justify-between gap-4 px-5 py-5 border-b border-gray-100"
                  data-testid="amax-step-a"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 bg-blue-50 text-blue-700 border border-blue-200">
                      A
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900">Risk assessment questionnaire</p>
                      <p className="text-sm text-gray-500 mt-1">
                        Investment experience, objectives, and risk tolerance. Required before
                        investment limit increases.
                      </p>
                      <p className="text-xs text-gray-500 mt-2">
                        Estimated time: 5–8 minutes · Save and continue later available
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    className="flex-shrink-0"
                    data-testid="button-complete-questionnaire"
                  >
                    Complete questionnaire
                  </Button>
                </div>

                {/* Step B */}
                <div
                  className="flex items-start justify-between gap-4 px-5 py-5"
                  data-testid="amax-step-b"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 bg-gray-100 text-gray-400 border border-gray-200">
                      B
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-gray-400">
                        Wholesale investor certification
                      </p>
                      <p className="text-sm text-gray-400 mt-1">
                        Accountant certificate required — s761G(7) net assets ≥ $2.5M or gross
                        income ≥ $250,000 for prior 2 years. Locked until risk assessment is
                        complete.
                      </p>
                    </div>
                  </div>
                  <Badge
                    className="bg-gray-100 text-gray-500 border border-gray-200 hover:bg-gray-100 px-3 py-1 rounded-full font-medium flex-shrink-0 flex items-center gap-1"
                    data-testid="badge-step-b-locked"
                  >
                    <Lock className="w-3 h-3" />
                    Locked
                  </Badge>
                </div>

                {/* Footer classification */}
                <div
                  className="px-5 py-4 bg-[#faf8f5] border-t border-gray-100 space-y-2"
                  data-testid="footer-amax-classification"
                >
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-sm text-gray-700">Current classification</p>
                    <Badge className="bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-50 px-3 py-1 rounded-full font-medium">
                      Tier 1 — Verified
                    </Badge>
                  </div>
                  <p className="text-xs text-gray-500 leading-relaxed">
                    Wholesale classification (Tier 2) unlocks after steps A and B are verified by
                    AMAX compliance. You will be notified by email when classification is updated.
                  </p>
                </div>
              </CardContent>
            </Card>
          </main>
        </div>
      </div>
    </div>
  );
}
