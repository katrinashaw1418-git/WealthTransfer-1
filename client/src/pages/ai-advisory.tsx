import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { ExternalLink } from "lucide-react";

const allocationData = [
  { asset: "Cash allocation (fiat)", current: 47, benchmark: 30, diff: -17 },
  { asset: "Digital asset exposure", current: 1, benchmark: 10, diff: 9 },
  { asset: "USD-denominated digital", current: 2, benchmark: 25, diff: 23 },
  { asset: "Investment products", current: 50, benchmark: 30, diff: -20 },
];

const soaItems = [
  { title: "Initial SOA — portfolio strategy", desc: "Requested 2 Aug 2025 · Pending adviser review", status: "Pending", color: "bg-amber-100 text-amber-700" },
  { title: "Risk questionnaire acknowledgement", desc: "Completed 2 Aug 2025", status: "Complete", color: "bg-green-100 text-green-700" },
  { title: "Fact-find submission", desc: "Submitted 2 Aug 2025", status: "Complete", color: "bg-green-100 text-green-700" },
];

function getRiskLabel(v: number) {
  if (v <= 20) return "Conservative";
  if (v <= 40) return "Moderately Conservative";
  if (v <= 60) return "Moderate";
  if (v <= 80) return "Moderately Aggressive";
  return "Aggressive";
}

export default function AiAdvisory() {
  const [riskScore, setRiskScore] = useState(60);

  const { data: realMetrics, isLoading: metricsLoading } = useQuery({
    queryKey: ["/api/portfolio/real-metrics"],
    queryFn: async () => (await apiFetch("/api/portfolio/real-metrics")).json(),
  });

  const { data: recommendations, isLoading: recsLoading } = useQuery({
    queryKey: ["/api/ai-recommendations"],
  });

  const insightCount = (recommendations as any[])?.length || 3;
  const portfolioHealth = realMetrics?.diversificationScore ? Math.round(realMetrics.diversificationScore) : 71;
  const cagr = realMetrics?.cagr != null ? realMetrics.cagr : 7.2;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Market Insights</h1>
        <p className="text-gray-500 text-sm">AI-generated general information — not personal financial product advice</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-5">
            <p className="text-xs font-medium text-gray-500 uppercase">RISK SCORE</p>
            <p className="text-2xl font-bold">{riskScore} / 100</p>
            <p className="text-sm text-gray-500">{getRiskLabel(riskScore)} — self-assessed</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-xs font-medium text-gray-500 uppercase">PORTFOLIO HEALTH</p>
            <p className="text-2xl font-bold">{metricsLoading ? "—" : portfolioHealth} / 100</p>
            <p className="text-sm text-gray-500">HHI diversification score</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-xs font-medium text-gray-500 uppercase">REALISED CAGR</p>
            <p className={`text-2xl font-bold ${cagr >= 0 ? "text-green-600" : "text-red-600"}`}>
              {cagr >= 0 ? "+" : ""}{cagr.toFixed(1)}%
            </p>
            <p className="text-sm text-gray-500">From transaction history</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-xs font-medium text-gray-500 uppercase">INSIGHTS</p>
            <p className="text-2xl font-bold">{insightCount}</p>
            <p className="text-sm text-gray-500">General information only</p>
          </CardContent>
        </Card>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
        <p className="font-semibold text-gray-900 mb-1">General information only — not personal financial product advice</p>
        <p className="text-sm text-gray-600">
          AI-generated insights below are general market commentary. They do not take into account your personal financial situation. To receive personal advice, request a Statement of Advice from your adviser.
        </p>
      </div>

      <div className="bg-red-50 border border-red-300 rounded-lg p-4">
        <p className="font-semibold text-red-900 mb-1">Execution disabled</p>
        <p className="text-sm text-red-800">
          Acting on any AI-generated insight is currently disabled platform-wide. Execution will only be authorised after a licensed adviser issues a Statement of Advice (SOA), you accept the advice in writing, and a valid Designated Benefits Funded Ongoing Fee (DBFO) consent is recorded. Until then, any "apply" action will be rejected by the platform.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardContent className="p-6 space-y-4">
            <div>
              <p className="font-semibold text-gray-900">Risk questionnaire</p>
              <p className="text-sm text-gray-500">Self-assessed — general context only</p>
            </div>
            <div>
              <p className="text-lg font-semibold">{getRiskLabel(riskScore)} ({riskScore}/100)</p>
              <Slider
                value={[riskScore]}
                onValueChange={(v) => setRiskScore(v[0])}
                min={0}
                max={100}
                step={1}
                className="my-3"
              />
              <div className="flex justify-between text-xs text-gray-400">
                <span>Conservative</span>
                <span>Moderate</span>
                <span>Aggressive</span>
              </div>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-gray-600">Investment horizon</span><span className="font-medium">5–10 years</span></div>
              <div className="flex justify-between"><span className="text-gray-600">Primary goal</span><span className="font-medium">Growth</span></div>
              <div className="flex justify-between"><span className="text-gray-600">Last updated</span><span className="font-medium">2 minutes ago</span></div>
            </div>
            <p className="text-xs text-gray-400">Self-assessed profile is for general context only. A licensed adviser must conduct a full fact-find before providing personal advice.</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6 space-y-4">
            <div>
              <p className="font-semibold text-gray-900">General market insights</p>
              <p className="text-sm text-gray-500">AI-generated — general information only</p>
            </div>

            <InsightCard
              title="Bond allocation — general context"
              text="Government bonds and high-grade corporates are commonly used for income stability. Allocations typically range 30–70% depending on risk objectives."
            />
            <InsightCard
              title="Capital preservation — general context"
              text="Treasury securities and stable value funds are typically used where capital preservation is the primary objective."
            />
            <InsightCard
              title="Medium-term horizons — general context"
              text="A 5–10 year horizon is often associated with moderate growth blended with defensive assets. Appropriate mix depends on individual circumstances."
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-6 space-y-4">
          <p className="font-semibold text-gray-900">Allocation comparison — illustrative only</p>
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <p className="text-sm text-gray-600">Not a suggestion to act. Any rebalancing must be discussed with your adviser and documented in a Statement of Advice.</p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-gray-500">
                  <th className="text-left py-2 font-medium">Asset class</th>
                  <th className="text-left py-2 font-medium">Current</th>
                  <th className="text-left py-2 font-medium">Illustrative benchmark</th>
                  <th className="text-left py-2 font-medium">Difference</th>
                </tr>
              </thead>
              <tbody>
                {allocationData.map((row, i) => (
                  <tr key={i} className="border-b border-gray-100">
                    <td className="py-3 text-gray-900">{row.asset}</td>
                    <td className="py-3">{row.current}%</td>
                    <td className="py-3">{row.benchmark}%</td>
                    <td className={`py-3 ${row.diff > 0 ? "text-green-600" : row.diff < 0 ? "text-red-600" : ""}`}>
                      {row.diff > 0 ? "+" : ""}{row.diff}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Button variant="outline" size="sm" className="text-blue-600 border-blue-200">
            Discuss rebalancing with adviser <ExternalLink className="w-3 h-3 ml-1" />
          </Button>
        </CardContent>
      </Card>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-5 space-y-3">
        <p className="font-semibold text-blue-900">Want personalised advice?</p>
        <p className="text-sm text-blue-800">
          To receive advice tailored to your financial situation, your adviser must prepare a Statement of Advice (SOA). This is a legal requirement under Australian financial services law. Your adviser will review your fact-find before making any personal observations.
        </p>
        <Button variant="outline" className="border-blue-300 text-blue-700">
          Request a Statement of Advice <ExternalLink className="w-3 h-3 ml-1" />
        </Button>
      </div>

      <Card>
        <CardContent className="p-6 space-y-4">
          <p className="font-semibold text-gray-900">Statements of Advice</p>
          {soaItems.map((item, i) => (
            <div key={i} className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
              <div>
                <p className="font-medium text-gray-900">{item.title}</p>
                <p className="text-sm text-gray-500">{item.desc}</p>
              </div>
              <Badge className={item.color}>{item.status}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>

    </div>
  );
}

function InsightCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="border rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between">
        <p className="font-medium text-gray-900 text-sm">{title}</p>
        <Badge variant="outline" className="text-xs">General</Badge>
      </div>
      <p className="text-sm text-gray-600">{text}</p>
      <div className="flex gap-2 pt-1">
        <Button variant="outline" size="sm" className="text-xs">Learn more <ExternalLink className="w-3 h-3 ml-1" /></Button>
        <Button variant="outline" size="sm" className="text-xs">Discuss with adviser <ExternalLink className="w-3 h-3 ml-1" /></Button>
      </div>
    </div>
  );
}
