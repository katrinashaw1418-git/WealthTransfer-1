import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Bot, Lightbulb, TrendingUp, AlertTriangle, Info } from "lucide-react";
import { useAiRecommendations } from "@/hooks/use-portfolio";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { apiFetch } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { BenchmarkDerivationPopover } from "@/components/ai-advisory/benchmark-derivation";

// Task #401 — minimal shape of `/api/portfolio/real-metrics` actually consumed
// by the dashboard's allocation snapshot. The full payload (sharpe, drawdown,
// CAGR, period returns, etc.) is intentionally not modelled here — we only
// need the allocation comparison + benchmark-source fields to decide whether
// to render the snapshot and to draw the four bucket rows. Server source of
// truth lives in `server/portfolio-real-metrics-route.ts`.
interface RealMetricsAllocationResponse {
  rebalancingBenchmarkType?: string;
  hasAllocationData?: boolean;
  currentAllocation?: {
    fiat?: number;
    crypto?: number;
    stablecoin?: number;
    investment?: number;
  };
  benchmarkAllocation?: {
    fiat?: number;
    crypto?: number;
    stablecoin?: number;
    investment?: number;
  };
}

export default function AiAdvisoryPanel() {
  const { data: recommendations, isLoading } = useAiRecommendations();
  const queryClient = useQueryClient();

  // Task #401 — surface the same risk-profile → platform-bucket benchmark
  // mapping that lives on /ai-advisory directly on the dashboard. We only
  // render the allocation snapshot (and its per-bucket derivation popovers)
  // when the backend has resolved a `risk_profile_personalised` benchmark,
  // so equal-weight illustrative comparisons don't get a misleading
  // "derived from your risk profile" explanation. The popover copy itself
  // is shared via `@/components/ai-advisory/benchmark-derivation` so the
  // dashboard and Market Insights page cannot drift apart.
  const { data: realMetrics, isLoading: metricsLoading } = useQuery<RealMetricsAllocationResponse>({
    queryKey: ["/api/portfolio/real-metrics"],
    queryFn: async () =>
      (await apiFetch("/api/portfolio/real-metrics")).json() as Promise<RealMetricsAllocationResponse>,
  });
  const currentAllocation = realMetrics?.currentAllocation;
  const benchmarkAllocation = realMetrics?.benchmarkAllocation;
  const showAllocationSnapshot =
    !metricsLoading
    && realMetrics?.rebalancingBenchmarkType === "risk_profile_personalised"
    && realMetrics?.hasAllocationData === true
    && currentAllocation != null
    && benchmarkAllocation != null;

  const markAsReadMutation = useMutation({
    mutationFn: (id: number) => api.markRecommendationAsRead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-recommendations"] });
    },
  });

  const getRecommendationIcon = (type: string) => {
    switch (type) {
      case "rebalancing":
        return Lightbulb;
      case "opportunity":
        return TrendingUp;
      case "risk_warning":
        return AlertTriangle;
      default:
        return Lightbulb;
    }
  };

  const getRecommendationColor = (severity: string) => {
    switch (severity) {
      case "info":
        return "bg-blue-50 border-blue-200";
      case "warning":
        return "bg-yellow-50 border-yellow-200";
      case "alert":
        return "bg-red-50 border-red-200";
      default:
        return "bg-blue-50 border-blue-200";
    }
  };

  const getIconColor = (severity: string) => {
    switch (severity) {
      case "info":
        return "text-blue-600";
      case "warning":
        return "text-yellow-600";
      case "alert":
        return "text-red-600";
      default:
        return "text-blue-600";
    }
  };

  const getTitleColor = (severity: string) => {
    switch (severity) {
      case "info":
        return "text-blue-900";
      case "warning":
        return "text-yellow-900";
      case "alert":
        return "text-red-900";
      default:
        return "text-blue-900";
    }
  };

  const getDescriptionColor = (severity: string) => {
    switch (severity) {
      case "info":
        return "text-blue-700";
      case "warning":
        return "text-yellow-700";
      case "alert":
        return "text-red-700";
      default:
        return "text-blue-700";
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg flex items-center justify-center">
              <Bot className="w-4 h-4 text-white" />
            </div>
            <div>
              <CardTitle>Market Insights</CardTitle>
              <p className="text-sm text-gray-500">General information only</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-4 bg-gray-50 rounded-lg">
              <Skeleton className="h-4 w-3/4 mb-2" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3 mt-1" />
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg flex items-center justify-center">
            <Bot className="w-4 h-4 text-white" />
          </div>
          <div>
            <CardTitle>Market Insights</CardTitle>
            <p className="text-sm text-gray-500">General information only — not personal advice</p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Task #493 — execution-disabled strip rendered at the top of the
           dashboard's market-insights card so the platform-wide block is the
           first thing a client sees on the panel, mirroring the strip that
           lives at the top of the standalone Market Insights page. The
           gray "general in nature" footer below the recommendations is
           preserved separately (preservation rule). Copy and condition
           are unchanged. */}
        <div
          className="mb-4 bg-red-50 border border-red-300 rounded-lg p-3"
          data-testid="banner-execution-disabled-dashboard"
        >
          <p className="font-semibold text-red-900 text-sm mb-0.5">Execution disabled</p>
          <p className="text-xs text-red-800">
            Acting on any AI-generated insight is currently disabled platform-wide. Execution will only be authorised after a licensed adviser issues a Statement of Advice (SOA), you accept the advice in writing, and a valid Designated Benefits Funded Ongoing Fee (DBFO) consent is recorded. Until then, any "apply" action will be rejected by the platform.
          </p>
        </div>

        {/* Task #401 — risk-profile allocation snapshot. Mirrors the
           per-row "How is this benchmark derived?" popovers from the
           Allocation comparison card on /ai-advisory so the four
           platform buckets (fiat, crypto, stablecoin, investment) and
           the five risk-profile classes (cash, bonds, equities,
           alternatives, crypto) have a single, consistent explanation
           wherever they are surfaced. Only rendered for the
           personalised variant — equal-weight illustrative comparisons
           never get the "derived from your risk profile" copy. */}
        {showAllocationSnapshot ? (
          <div
            className="mb-4 rounded-lg border border-gray-200 bg-white p-3"
            data-testid="block-allocation-snapshot-dashboard"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-gray-900">Allocation vs. risk-profile benchmark</p>
              <Badge
                variant="outline"
                className="text-[10px] border-blue-200 text-blue-700 bg-blue-50"
                data-testid="badge-benchmark-source-dashboard"
              >
                From your risk profile
              </Badge>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200 text-[10px] uppercase text-gray-500">
                  <th className="text-left font-medium py-1.5">Asset class</th>
                  <th className="text-right font-medium py-1.5">Current</th>
                  <th className="text-right font-medium py-1.5">Benchmark</th>
                  <th className="text-right font-medium py-1.5">Diff</th>
                </tr>
              </thead>
              <tbody>
                {(["fiat", "crypto", "stablecoin", "investment"] as const).map((cls) => {
                  const current = Number(currentAllocation?.[cls] ?? 0);
                  const benchmark = Number(benchmarkAllocation?.[cls] ?? 0);
                  const diff = +(current - benchmark).toFixed(1);
                  const diffColor =
                    Math.abs(diff) < 0.1
                      ? "text-gray-500"
                      : diff > 0
                        ? "text-amber-700"
                        : "text-blue-700";
                  const label =
                    cls === "fiat" ? "Fiat"
                      : cls === "crypto" ? "Crypto"
                      : cls === "stablecoin" ? "Stablecoin"
                      : "Investment";
                  return (
                    <tr
                      key={cls}
                      className="border-b border-gray-100 last:border-b-0"
                      data-testid={`row-allocation-dashboard-${cls}`}
                    >
                      <td className="py-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-gray-900">{label}</span>
                          <BenchmarkDerivationPopover assetClass={cls} />
                        </div>
                      </td>
                      <td
                        className="py-1.5 text-right font-medium text-gray-900"
                        data-testid={`text-current-dashboard-${cls}`}
                      >
                        {current.toFixed(1)}%
                      </td>
                      <td
                        className="py-1.5 text-right font-medium text-gray-700"
                        data-testid={`text-benchmark-dashboard-${cls}`}
                      >
                        {benchmark.toFixed(1)}%
                      </td>
                      <td
                        className={`py-1.5 text-right font-medium ${diffColor}`}
                        data-testid={`text-diff-dashboard-${cls}`}
                      >
                        {diff > 0 ? "+" : ""}{diff.toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="space-y-4">
          {recommendations?.map((recommendation: any) => {
            const Icon = getRecommendationIcon(recommendation.type);
            
            return (
              <div
                key={recommendation.id}
                className={`p-4 rounded-lg border ${getRecommendationColor(recommendation.severity)}`}
              >
                <div className="flex items-start space-x-3">
                  <Icon className={`w-4 h-4 mt-1 ${getIconColor(recommendation.severity)}`} />
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1">
                      <h4 className={`font-medium ${getTitleColor(recommendation.severity)}`}>
                        {recommendation.title}
                      </h4>
                      {!recommendation.isRead && (
                        <Badge variant="secondary" className="text-xs">General</Badge>
                      )}
                    </div>
                    <p className={`text-sm ${getDescriptionColor(recommendation.severity)}`}>
                      {recommendation.description}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex items-start space-x-2">
            <Info className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-gray-500">
              These insights are general in nature and do not constitute personal financial advice. 
              Contact your adviser before acting on any market commentary.
            </p>
          </div>
        </div>
        
        <Button
          className="w-full mt-4 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600"
          onClick={() => {
            window.location.pathname = "/ai-advisory";
          }}
        >
          View Market Insights
        </Button>
      </CardContent>
    </Card>
  );
}
