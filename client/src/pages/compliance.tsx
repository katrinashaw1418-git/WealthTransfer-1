import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Check, Lock, Loader2, X } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type {
  ComplianceOverview,
  ComplianceStep,
  ComplianceStepStatus,
  ComplianceTierPill,
  ComplianceWholesalePill,
} from "@shared/schema";

const SUMSUB_SDK_URL =
  "https://static.sumsub.com/idensic/static/sns-websdk-builder.js";

type SumsubTokenResponse = { token: string; userId: string; expiresIn: number };

type SumsubBuilderInstance = {
  withConf: (conf: Record<string, unknown>) => SumsubBuilderInstance;
  withOptions: (opts: Record<string, unknown>) => SumsubBuilderInstance;
  on: (event: string, cb: (...args: unknown[]) => void) => SumsubBuilderInstance;
  build: () => { launch: (selector: string) => void; destroy?: () => void };
};

declare global {
  interface Window {
    snsWebSdk?: {
      init: (
        token: string,
        onTokenExpired: () => Promise<string>,
      ) => SumsubBuilderInstance;
    };
  }
}

let sumsubSdkPromise: Promise<void> | null = null;

function loadSumsubSdk(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.snsWebSdk) return Promise.resolve();
  if (sumsubSdkPromise) return sumsubSdkPromise;
  sumsubSdkPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SUMSUB_SDK_URL}"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error("Failed to load Sumsub WebSDK")),
      );
      return;
    }
    const script = document.createElement("script");
    script.src = SUMSUB_SDK_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      sumsubSdkPromise = null;
      reject(new Error("Failed to load Sumsub WebSDK"));
    };
    document.head.appendChild(script);
  });
  return sumsubSdkPromise;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function tierToneClass(tone: ComplianceTierPill["tone"]): string {
  switch (tone) {
    case "green":
      return "bg-green-50 text-green-700 border-green-200 hover:bg-green-50";
    case "amber":
      return "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-50";
    case "gray":
      return "bg-gray-100 text-gray-700 border-gray-200 hover:bg-gray-100";
    case "blue":
    default:
      return "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-50";
  }
}

function wholesalePillClass(state: ComplianceWholesalePill["state"]): string {
  if (state === "completed_wholesale" || state === "completed") {
    return "bg-green-50 text-green-700 border-green-200 hover:bg-green-50";
  }
  return "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-50";
}

function sidebarStepClasses(status: ComplianceStepStatus): {
  badge: string;
  text: string;
} {
  switch (status) {
    case "completed":
      return {
        badge: "bg-green-50 text-green-600 border border-green-200",
        text: "text-green-600",
      };
    case "rejected":
      return {
        badge: "bg-red-50 text-red-600 border border-red-200",
        text: "text-red-600",
      };
    case "review":
    case "in_progress":
      return {
        badge: "bg-amber-50 text-amber-600 border border-amber-200",
        text: "text-amber-600",
      };
    case "locked":
      return {
        badge: "bg-gray-100 text-gray-400 border border-gray-200",
        text: "text-gray-400",
      };
    case "action_required":
    default:
      return {
        badge: "bg-blue-50 text-blue-600 border border-blue-200",
        text: "text-blue-600",
      };
  }
}

function sumsubMainBadge(status: ComplianceStepStatus): {
  className: string;
  label: string;
} {
  switch (status) {
    case "completed":
      return {
        className:
          "bg-green-50 text-green-700 border-green-200 hover:bg-green-50",
        label: "Done",
      };
    case "review":
    case "in_progress":
      return {
        className:
          "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-50",
        label: "Under review",
      };
    case "rejected":
      return {
        className: "bg-red-50 text-red-700 border-red-200 hover:bg-red-50",
        label: "Rejected",
      };
    case "action_required":
    default:
      return {
        className: "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-50",
        label: "Action required",
      };
  }
}

function MainStepIcon({ status }: { status: ComplianceStepStatus }) {
  if (status === "completed") {
    return (
      <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 bg-green-50 text-green-600 border border-green-200">
        <Check className="w-4 h-4" />
      </div>
    );
  }
  if (status === "rejected") {
    return (
      <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 bg-red-50 text-red-600 border border-red-200">
        <span className="text-sm font-bold leading-none">!</span>
      </div>
    );
  }
  return (
    <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 bg-amber-50 text-amber-600 border border-amber-200">
      <span className="text-sm font-bold leading-none">!</span>
    </div>
  );
}

function SidebarStepIcon({ status }: { status: ComplianceStepStatus }) {
  const classes = sidebarStepClasses(status);
  if (status === "completed") {
    return (
      <div
        className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${classes.badge}`}
      >
        <Check className="w-4 h-4" />
      </div>
    );
  }
  if (status === "locked") {
    return (
      <div
        className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${classes.badge}`}
      >
        <Lock className="w-3.5 h-3.5" />
      </div>
    );
  }
  return (
    <div
      className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${classes.badge}`}
    >
      <span className="text-sm font-bold leading-none">!</span>
    </div>
  );
}

function ComplianceSkeleton() {
  return (
    <div className="min-h-screen bg-[#faf8f5] p-6" data-testid="compliance-loading">
      <div className="max-w-7xl mx-auto space-y-6">
        <Skeleton className="h-10 w-1/2" />
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    </div>
  );
}

export default function Compliance() {
  const { toast } = useToast();
  const { data, isLoading, isError } = useQuery<ComplianceOverview>({
    queryKey: ["/api/compliance/overview"],
  });

  const [sdkOpen, setSdkOpen] = useState(false);
  const [sdkLaunching, setSdkLaunching] = useState(false);
  const sdkContainerRef = useRef<HTMLDivElement | null>(null);
  const sdkInstanceRef = useRef<{ destroy?: () => void } | null>(null);

  const tokenMutation = useMutation<SumsubTokenResponse>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/kyc/sumsub-token");
      return (await res.json()) as SumsubTokenResponse;
    },
  });

  const refreshOverview = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/compliance/overview"] });
  };

  const closeSdk = () => {
    if (sdkInstanceRef.current?.destroy) {
      try {
        sdkInstanceRef.current.destroy();
      } catch {
        // ignore destroy errors — modal is closing anyway
      }
    }
    sdkInstanceRef.current = null;
    setSdkOpen(false);
    refreshOverview();
  };

  const launchSdk = async () => {
    setSdkLaunching(true);
    setSdkOpen(true);
    try {
      const [tokenResult] = await Promise.all([
        tokenMutation.mutateAsync(),
        loadSumsubSdk(),
      ]);
      if (!window.snsWebSdk) throw new Error("Sumsub WebSDK unavailable");
      if (!sdkContainerRef.current) {
        // Container hasn't mounted yet — wait one frame for the modal to render.
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
      if (!sdkContainerRef.current) {
        throw new Error("Sumsub container unavailable");
      }
      sdkContainerRef.current.id = "sumsub-websdk-container";
      const builder = window.snsWebSdk
        .init(tokenResult.token, async () => {
          const next = await tokenMutation.mutateAsync();
          return next.token;
        })
        .withConf({ lang: "en" })
        .withOptions({ addViewportTag: false, adaptIframeHeight: true })
        .on("idCheck.onApplicantSubmitted", () => refreshOverview())
        .on("idCheck.onApplicantStatusChanged", () => refreshOverview())
        .on("idCheck.onError", () => refreshOverview());
      const instance = builder.build();
      sdkInstanceRef.current = instance;
      instance.launch("#sumsub-websdk-container");
    } catch (err: unknown) {
      let description = "Couldn't start identity verification. Please try again.";
      if (err && typeof err === "object" && "message" in err) {
        const msg = (err as { message?: unknown }).message;
        if (typeof msg === "string" && msg.length > 0) description = msg;
      }
      // Surface the not-configured case from the API with a clearer message.
      if (
        err &&
        typeof err === "object" &&
        "status" in err &&
        (err as { status?: unknown }).status === 503
      ) {
        description =
          "Identity verification isn't configured yet. Please contact support.";
      }
      toast({
        title: "Verification unavailable",
        description,
        variant: "destructive",
      });
      setSdkOpen(false);
    } finally {
      setSdkLaunching(false);
    }
  };

  useEffect(() => {
    return () => {
      if (sdkInstanceRef.current?.destroy) {
        try {
          sdkInstanceRef.current.destroy();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  if (isLoading) return <ComplianceSkeleton />;

  if (isError || !data) {
    return (
      <div className="min-h-screen bg-[#faf8f5] p-6" data-testid="compliance-error">
        <div className="max-w-3xl mx-auto bg-white border border-red-200 rounded-lg p-6 text-sm text-red-700">
          We couldn't load your KYC &amp; compliance status. Please refresh the page,
          or contact support if this keeps happening.
        </div>
      </div>
    );
  }

  const sumsubSidebarSteps: Array<{
    label: string;
    title: string;
    step: ComplianceStep;
  }> = [
    { label: "SUMSUB", title: "Identity verification", step: data.sumsub.steps.identity },
    { label: "SUMSUB", title: "AML / PEP screening", step: data.sumsub.steps.amlPep },
    { label: "SUMSUB + AMAX", title: "Source of funds", step: data.sumsub.steps.sourceOfFunds },
  ];

  const amaxSidebarSteps: Array<{
    letter: string;
    label: string;
    title: string;
    step: ComplianceStep;
  }> = [
    {
      letter: "A",
      label: "AMAX",
      title: "Risk assessment",
      step: data.amax.riskAssessment,
    },
    {
      letter: "B",
      label: "AMAX + LEGAL",
      title: "Wholesale certification",
      step: data.amax.wholesaleCertification,
    },
  ];

  const sumsubSteps: Array<{
    title: string;
    desc: string;
    helper?: string;
    step: ComplianceStep;
  }> = [
    {
      title: "Identity document",
      desc: data.sumsub.steps.identity.description,
      step: data.sumsub.steps.identity,
    },
    {
      title: "Liveness check",
      desc: data.sumsub.steps.liveness.description,
      step: data.sumsub.steps.liveness,
    },
    {
      title: "AML / PEP screening",
      desc: data.sumsub.steps.amlPep.description,
      step: data.sumsub.steps.amlPep,
    },
    {
      title: "Source of funds declaration",
      desc: data.sumsub.steps.sourceOfFunds.description,
      helper:
        data.sumsub.steps.sourceOfFunds.status === "review"
          ? "No further action required from you · Typically 1–2 business days"
          : undefined,
      step: data.sumsub.steps.sourceOfFunds,
    },
  ];

  const sessionBadgeLabel =
    data.sumsub.sessionState === "verified"
      ? "Verified"
      : data.sumsub.sessionState === "rejected"
        ? "Rejected"
        : data.sumsub.sessionState === "session_active"
          ? "Session active"
          : "Not started";

  const sessionBadgeClass =
    data.sumsub.sessionState === "verified"
      ? "bg-green-300 text-green-900 hover:bg-green-300"
      : data.sumsub.sessionState === "rejected"
        ? "bg-red-300 text-red-900 hover:bg-red-300"
        : data.sumsub.sessionState === "session_active"
          ? "bg-amber-300 text-amber-900 hover:bg-amber-300"
          : "bg-gray-200 text-gray-700 hover:bg-gray-200";

  const reverificationLine =
    data.classification.reverificationDueAt
      ? `Re-verification due: ${formatDate(data.classification.reverificationDueAt)}${
          data.classification.remainingDays !== null
            ? ` · ${
                data.classification.remainingDays >= 0
                  ? `${data.classification.remainingDays} days`
                  : `overdue by ${Math.abs(data.classification.remainingDays)} days`
              }`
            : ""
        }`
      : "Re-verification due: pending verification";

  const stepCount = amaxSidebarSteps.length;

  const showLaunchCta = data.sumsub.sessionState !== "verified";
  const launchLabel =
    data.sumsub.sessionState === "session_active"
      ? "Continue identity verification"
      : data.sumsub.sessionState === "rejected"
        ? "Restart identity verification"
        : "Start identity verification";

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
              className={`px-3 py-1 rounded-full font-medium border ${tierToneClass(data.tier.tone)}`}
            >
              {data.tier.label}
            </Badge>
            {data.wholesaleUpgrade.label && (
              <Badge
                data-testid="badge-wholesale-status"
                className={`px-3 py-1 rounded-full font-medium border ${wholesalePillClass(data.wholesaleUpgrade.state)}`}
              >
                {data.wholesaleUpgrade.label}
              </Badge>
            )}
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
                  <p
                    className="text-2xl font-bold text-gray-900"
                    data-testid="text-progress-percent"
                  >
                    {data.progress.percent}%
                  </p>
                </div>
                <div
                  className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden"
                  data-testid="progress-overall"
                >
                  <div
                    className="h-full bg-green-500 rounded-full"
                    style={{ width: `${data.progress.percent}%` }}
                  />
                </div>
                <div className="text-sm leading-relaxed" data-testid="text-progress-counter">
                  <span className="text-green-600">{data.progress.complete} complete</span>
                  <span className="text-gray-400"> · </span>
                  <span className="text-blue-600">
                    {data.progress.actionRequired} action required
                  </span>
                  <span className="text-gray-400"> · </span>
                  <span className="text-amber-600">
                    {data.progress.underReview} under review
                  </span>
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
                  {sumsubSidebarSteps.map((row, i) => {
                    const classes = sidebarStepClasses(row.step.status);
                    return (
                      <div
                        key={row.step.key}
                        data-testid={`sidebar-sumsub-step-${i}`}
                        className="flex items-start gap-3 p-3"
                      >
                        <SidebarStepIcon status={row.step.status} />
                        <div className="min-w-0">
                          <p className="text-[10px] font-semibold tracking-wider text-gray-400 uppercase">
                            {row.label}
                          </p>
                          <p className="text-sm font-medium text-gray-900">{row.title}</p>
                          <p className={`text-xs ${classes.text}`}>{row.step.description}</p>
                        </div>
                      </div>
                    );
                  })}
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
                  {amaxSidebarSteps.map((row, i) => {
                    const isActionable = row.step.status === "action_required";
                    const isCompleted = row.step.status === "completed";
                    return (
                      <div
                        key={row.step.key}
                        data-testid={`sidebar-amax-step-${i}`}
                        className={`flex items-start gap-3 p-3 rounded-md ${
                          isActionable ? "bg-green-50/60" : ""
                        }`}
                      >
                        <div
                          className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                            isActionable
                              ? "bg-green-600 text-white"
                              : isCompleted
                                ? "bg-green-50 text-green-700 border border-green-200"
                                : "bg-gray-100 text-gray-400 border border-gray-200"
                          }`}
                        >
                          {row.letter}
                        </div>
                        <div className="min-w-0">
                          <p
                            className={`text-[10px] font-semibold tracking-wider uppercase ${
                              isActionable || isCompleted ? "text-gray-500" : "text-gray-400"
                            }`}
                          >
                            {row.label}
                          </p>
                          <p
                            className={`text-sm font-medium ${
                              isActionable || isCompleted ? "text-gray-900" : "text-gray-400"
                            }`}
                          >
                            {row.title}
                          </p>
                          <p
                            className={`text-xs ${
                              isActionable
                                ? "text-blue-600"
                                : isCompleted
                                  ? "text-green-600"
                                  : "text-gray-400"
                            }`}
                          >
                            {row.step.description}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            </div>

            {/* Wholesale classification footer */}
            <div className="space-y-2 px-1" data-testid="footer-wholesale-classification">
              <p className="text-xs font-semibold tracking-wider text-gray-500">
                WHOLESALE CLASSIFICATION
              </p>
              <div className="text-sm text-gray-600 space-y-1 leading-relaxed">
                <p>s761G Corporations Act 2001 (Cth)</p>
                <p>
                  Current tier:{" "}
                  <span className="text-gray-900">{data.classification.currentTierLabel}</span>
                </p>
                <p>{data.classification.wholesaleUpgradeNote}</p>
                <p>{reverificationLine}</p>
              </div>
            </div>
          </aside>

          {/* Main panel */}
          <main className="space-y-6">
            {/* Gating banner */}
            {data.wholesaleUpgrade.state !== "completed_wholesale" && (
              <div
                data-testid="banner-gating"
                className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-gray-700"
              >
                Investment limits remain restricted until risk assessment is completed. Full
                wholesale product access unlocks after both AMAX steps are verified.
              </div>
            )}

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
                <Badge
                  className={`px-3 py-1 rounded-full font-medium border-0 ${sessionBadgeClass}`}
                  data-testid="badge-sumsub-session"
                >
                  {sessionBadgeLabel}
                </Badge>
              </div>

              <CardContent className="p-0">
                <div className="divide-y divide-gray-100">
                  {sumsubSteps.map((row, i) => {
                    const badge = sumsubMainBadge(row.step.status);
                    return (
                      <div
                        key={row.step.key}
                        data-testid={`sumsub-step-${i}`}
                        className="flex items-start justify-between gap-4 px-5 py-4"
                      >
                        <div className="flex items-start gap-3 min-w-0">
                          <MainStepIcon status={row.step.status} />
                          <div className="min-w-0">
                            <p className="font-medium text-gray-900">{row.title}</p>
                            <p className="text-sm text-gray-500">{row.desc}</p>
                            {row.helper && (
                              <p className="text-xs text-blue-600 mt-1">{row.helper}</p>
                            )}
                          </div>
                        </div>
                        <Badge
                          className={`flex-shrink-0 px-3 py-1 rounded-full border font-medium ${badge.className}`}
                        >
                          {badge.label}
                        </Badge>
                      </div>
                    );
                  })}
                </div>

                {showLaunchCta && (
                  <div
                    className="flex items-center justify-between gap-4 px-5 py-4 border-t border-gray-100 bg-white"
                    data-testid="row-sumsub-launch"
                  >
                    <div className="text-sm text-gray-600">
                      Complete identity verification through Sumsub to progress your
                      classification.
                    </div>
                    <Button
                      onClick={launchSdk}
                      disabled={sdkLaunching}
                      data-testid="button-launch-sumsub"
                      className="flex-shrink-0"
                    >
                      {sdkLaunching ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Loading…
                        </>
                      ) : (
                        launchLabel
                      )}
                    </Button>
                  </div>
                )}

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
                    <p
                      className="text-sm font-medium text-gray-900 font-mono"
                      data-testid="text-sumsub-applicant-id"
                    >
                      {data.sumsub.applicantId}
                    </p>
                    <p className="text-xs text-gray-500">
                      Created {formatDate(data.sumsub.createdAt)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Last verified</p>
                    <p
                      className="text-sm font-medium text-gray-900"
                      data-testid="text-sumsub-last-verified"
                    >
                      {data.sumsub.lastVerifiedAt
                        ? formatDate(data.sumsub.lastVerifiedAt)
                        : "Not yet verified"}
                    </p>
                    <p className="text-xs text-gray-500">
                      {data.sumsub.lastVerifiedAt
                        ? "AUSTRAC audit logged"
                        : "Pending AUSTRAC audit"}
                    </p>
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
                  {stepCount} steps
                </Badge>
              </div>

              <CardContent className="p-0">
                {/* Step A — Risk assessment */}
                <div
                  className="flex items-start justify-between gap-4 px-5 py-5 border-b border-gray-100"
                  data-testid="amax-step-a"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                        data.amax.riskAssessment.status === "completed"
                          ? "bg-green-50 text-green-700 border border-green-200"
                          : "bg-blue-50 text-blue-700 border border-blue-200"
                      }`}
                    >
                      A
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900">Risk assessment questionnaire</p>
                      <p className="text-sm text-gray-500 mt-1">
                        Investment experience, objectives, and risk tolerance. Required before
                        investment limit increases.
                      </p>
                      <p className="text-xs text-gray-500 mt-2">
                        {data.amax.riskAssessment.description}
                      </p>
                    </div>
                  </div>
                  {data.amax.riskAssessment.status === "completed" ? (
                    <div className="flex flex-col items-end gap-2 flex-shrink-0">
                      <Badge
                        className="bg-green-50 text-green-700 border border-green-200 hover:bg-green-50 px-3 py-1 rounded-full font-medium"
                        data-testid="badge-step-a-completed"
                      >
                        Completed
                      </Badge>
                      <Link href="/risk-assessment">
                        <Button
                          variant="outline"
                          size="sm"
                          data-testid="button-review-answers"
                        >
                          Review answers
                        </Button>
                      </Link>
                    </div>
                  ) : (
                    <Link href="/risk-assessment">
                      <Button
                        variant="outline"
                        className="flex-shrink-0"
                        data-testid="button-complete-questionnaire"
                      >
                        {data.amax.riskAssessment.status === "in_progress"
                          ? "Continue questionnaire"
                          : "Complete questionnaire"}
                      </Button>
                    </Link>
                  )}
                </div>

                {/* Step B — Wholesale certification */}
                <div
                  className="flex items-start justify-between gap-4 px-5 py-5"
                  data-testid="amax-step-b"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                        data.amax.wholesaleCertification.status === "completed"
                          ? "bg-green-50 text-green-700 border border-green-200"
                          : data.amax.wholesaleCertification.status === "action_required"
                            ? "bg-blue-50 text-blue-700 border border-blue-200"
                            : "bg-gray-100 text-gray-400 border border-gray-200"
                      }`}
                    >
                      B
                    </div>
                    <div className="min-w-0">
                      <p
                        className={`font-medium ${
                          data.amax.wholesaleCertification.status === "locked"
                            ? "text-gray-400"
                            : "text-gray-900"
                        }`}
                      >
                        Wholesale investor certification
                      </p>
                      <p
                        className={`text-sm mt-1 ${
                          data.amax.wholesaleCertification.status === "locked"
                            ? "text-gray-400"
                            : "text-gray-500"
                        }`}
                      >
                        Accountant certificate required — s761G(7) net assets ≥ $2.5M or gross
                        income ≥ $250,000 for prior 2 years.
                      </p>
                      <p className="text-xs text-gray-500 mt-2">
                        {data.amax.wholesaleCertification.description}
                      </p>
                    </div>
                  </div>
                  {data.amax.wholesaleCertification.status === "completed" ? (
                    <Badge
                      className="bg-green-50 text-green-700 border border-green-200 hover:bg-green-50 px-3 py-1 rounded-full font-medium flex-shrink-0"
                      data-testid="badge-step-b-completed"
                    >
                      Completed
                    </Badge>
                  ) : data.amax.wholesaleCertification.status === "locked" ? (
                    <Badge
                      className="bg-gray-100 text-gray-500 border border-gray-200 hover:bg-gray-100 px-3 py-1 rounded-full font-medium flex-shrink-0 flex items-center gap-1"
                      data-testid="badge-step-b-locked"
                    >
                      <Lock className="w-3 h-3" />
                      Locked
                    </Badge>
                  ) : (
                    <Button
                      variant="outline"
                      className="flex-shrink-0"
                      data-testid="button-upload-certification"
                    >
                      Upload certification
                    </Button>
                  )}
                </div>

                {/* Footer classification */}
                <div
                  className="px-5 py-4 bg-[#faf8f5] border-t border-gray-100 space-y-2"
                  data-testid="footer-amax-classification"
                >
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-sm text-gray-700">Current classification</p>
                    <Badge
                      className={`px-3 py-1 rounded-full font-medium border ${tierToneClass(data.tier.tone)}`}
                    >
                      {data.classification.currentTierLabel}
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

      {sdkOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          data-testid="sumsub-modal"
        >
          <div className="bg-white rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden shadow-xl">
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
              <p className="font-semibold text-gray-900">Identity verification</p>
              <button
                type="button"
                onClick={closeSdk}
                className="text-gray-500 hover:text-gray-900"
                aria-label="Close verification"
                data-testid="button-close-sumsub"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {sdkLaunching && (
                <div className="flex items-center justify-center py-16 text-sm text-gray-500">
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Loading verification…
                </div>
              )}
              <div ref={sdkContainerRef} id="sumsub-websdk-container" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
