import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Shield,
  Phone,
  MessageSquare,
  ExternalLink,
  Download,
  Upload,
} from "lucide-react";

const allocationData = [
  { asset: "Cash allocation (fiat)", current: 47, benchmark: 30, diff: -17 },
  { asset: "Digital asset exposure", current: 1, benchmark: 10, diff: 9 },
  { asset: "USD-denominated digital", current: 2, benchmark: 25, diff: 23 },
  { asset: "Investment products", current: 50, benchmark: 30, diff: -20 },
];

const activityData = [
  { date: "4 Aug 2025", ref: "TXN-003", name: "Corporate Credit Fund", desc: "Instruction via external fund manager", amount: "USD 25,000", status: "Settled" },
  { date: "4 Aug 2025", ref: "TXN-002", name: "Bitcoin Tracker Fund", desc: "Instruction via external fund manager", amount: "USD 25,000", status: "Settled" },
  { date: "2 Aug 2025", ref: "TXN-001", name: "Bitcoin Tracker Fund", desc: "Instruction via external fund manager", amount: "USD 500,000", status: "Settled" },
];

const kycSteps = [
  { num: 1, title: "Identity verification", desc: "Completed 2 Aug 2025", status: "completed" },
  { num: 2, title: "AML screening", desc: "Passed 2 Aug 2025", status: "completed" },
  { num: 3, title: "Source of funds declaration", desc: "Submitted — pending compliance review", status: "pending" },
  { num: 4, title: "Risk assessment", desc: "Not yet commenced", status: "not_started" },
];

const documents = [
  { name: "Government-issued ID", desc: "Verified", status: "Verified", color: "bg-green-100 text-green-700" },
  { name: "Proof of address", desc: "Utility bill or bank statement", status: "Verified", color: "bg-green-100 text-green-700" },
  { name: "Source of funds declaration", desc: "Under review", status: "Under review", color: "bg-amber-100 text-amber-700" },
  { name: "Wholesale investor certificate", desc: "Required — s761GA accountant-certified", status: "Required", color: "bg-amber-100 text-amber-700", hasUpload: true },
  { name: "Signed risk disclosure", desc: "Acknowledged 2 Aug 2025", status: "Signed", color: "bg-green-100 text-green-700" },
];

const regulatoryRows = [
  { label: "AMAX Wealth Pty Ltd", value: "Authorised Representative — AFSL" },
  { label: "AMAX Global Pty Ltd", value: "AUSTRAC — DCE & Remittance" },
  { label: "Client classification", value: "Wholesale — s761G" },
  { label: "Dispute resolution", value: "AFCA member — 1800 931 678" },
  { label: "Record keeping", value: "s912A — 7-year minimum" },
  { label: "Privacy", value: "Privacy Act 1988 (Cth)" },
];

const soaItems = [
  { title: "Initial SOA — portfolio strategy", desc: "Requested 2 Aug 2025 · Pending adviser review", status: "Pending", color: "bg-amber-100 text-amber-700" },
  { title: "Risk questionnaire acknowledgement", desc: "Completed 2 Aug 2025", status: "Complete", color: "bg-green-100 text-green-700" },
  { title: "Fact-find submission", desc: "Submitted 2 Aug 2025", status: "Complete", color: "bg-green-100 text-green-700" },
];

const riskItems = [
  { num: 1, title: "Market risk", text: "Investment values fluctuate with market conditions including interest rate changes, economic developments, geopolitical events, and investor sentiment." },
  { num: 2, title: "Currency risk", text: "Multi-currency investments are exposed to foreign exchange fluctuations. Changes in exchange rates can materially affect the value of your holdings when converted to your base currency." },
  { num: 3, title: "Liquidity risk", text: "Some products have lock-up periods or limited redemption windows. Always maintain sufficient liquid reserves outside your AMAX Wealth investments." },
  { num: 4, title: "Credit risk", text: "Fixed-income products are subject to the credit risk of the issuer. A downgrade or default may result in partial or total loss of invested capital." },
  { num: 5, title: "Concentration risk", text: "Concentrating investments in a single asset class, sector, or geography increases vulnerability to adverse events. A diversified portfolio aligned to your risk tolerance is generally encouraged." },
  { num: 6, title: "Technology and digital asset risk", text: "Digital assets carry additional risks including regulatory uncertainty, technological failures, and extreme price volatility. These products are for wholesale investors only and carry the possibility of total loss." },
  { num: 7, title: "AI-generated content limitations", text: "AI tools on this platform provide general information only. They do not constitute regulated financial product advice under the Corporations Act 2001 (Cth)." },
  { num: 8, title: "Regulatory risk", text: "Changes in law, tax treatment, or regulatory requirements may adversely affect your investments. AMAX Wealth will notify clients of material changes." },
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
      <div className="overflow-x-auto">
        <Tabs defaultValue="insights" className="space-y-6">
          <TabsList className="inline-flex h-auto gap-1 bg-slate-700 p-1 rounded-lg min-w-max">
            <TabsTrigger value="insights" className="text-white data-[state=active]:bg-white data-[state=active]:text-gray-900 min-w-[120px]">Market Insights</TabsTrigger>
            <TabsTrigger value="adviser" className="text-white data-[state=active]:bg-white data-[state=active]:text-gray-900 min-w-[120px]">Adviser &amp; SOA</TabsTrigger>
            <TabsTrigger value="activity" className="text-white data-[state=active]:bg-white data-[state=active]:text-gray-900 min-w-[100px]">Activity</TabsTrigger>
            <TabsTrigger value="compliance" className="text-white data-[state=active]:bg-white data-[state=active]:text-gray-900 min-w-[120px]">Compliance</TabsTrigger>
            <TabsTrigger value="risk-disclosure" className="text-white data-[state=active]:bg-white data-[state=active]:text-gray-900 min-w-[130px]">Risk disclosure</TabsTrigger>
          </TabsList>

          <TabsContent value="insights">
            <MarketInsightsTab
              riskScore={riskScore}
              setRiskScore={setRiskScore}
              portfolioHealth={portfolioHealth}
              cagr={cagr}
              insightCount={insightCount}
              metricsLoading={metricsLoading}
            />
          </TabsContent>

          <TabsContent value="adviser">
            <AdviserTab />
          </TabsContent>

          <TabsContent value="activity">
            <ActivityTab />
          </TabsContent>

          <TabsContent value="compliance">
            <ComplianceMiniTab />
          </TabsContent>

          <TabsContent value="risk-disclosure">
            <RiskDisclosureTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function MarketInsightsTab({
  riskScore,
  setRiskScore,
  portfolioHealth,
  cagr,
  insightCount,
  metricsLoading,
}: {
  riskScore: number;
  setRiskScore: (v: number) => void;
  portfolioHealth: number;
  cagr: number;
  insightCount: number;
  metricsLoading: boolean;
}) {
  return (
    <div className="space-y-6">
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
        <p className="font-semibold text-amber-900 mb-1">General information only — not personal financial product advice</p>
        <p className="text-sm text-amber-800">
          AI-generated insights below are general market commentary. They do not take into account your personal financial situation. To receive personal advice, request a Statement of Advice from your adviser.
        </p>
      </div>

      <Button variant="outline">Request a Statement of Advice <ExternalLink className="w-3 h-3 ml-1" /></Button>

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
            <p className="text-sm text-amber-800">Not a suggestion to act. Any rebalancing must be discussed with your adviser and documented in a Statement of Advice.</p>
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

function AdviserTab() {
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="p-6">
          <p className="font-semibold text-gray-900 mb-1">Your adviser</p>
          <p className="text-sm text-gray-500 mb-4">Licensed financial adviser — AMAX Wealth</p>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-slate-200 rounded-full flex items-center justify-center text-slate-600 font-semibold">AW</div>
            <div>
              <p className="font-semibold">AMAX Wealth Adviser</p>
              <p className="text-sm text-gray-500">+61 2 8320 1908 · Licensed under AFSL arrangements</p>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <Button variant="outline" size="sm"><Phone className="w-3 h-3 mr-1" />Call</Button>
            <Button variant="outline" size="sm"><MessageSquare className="w-3 h-3 mr-1" />Message</Button>
          </div>
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

function ActivityTab() {
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="p-6 space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="font-semibold text-gray-900">Account activity</p>
              <p className="text-sm text-gray-500">All investment instructions — AMAX Wealth does not hold client funds</p>
            </div>
            <Button variant="outline" size="sm">Export <ExternalLink className="w-3 h-3 ml-1" /></Button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-gray-500">
                  <th className="text-left py-2 font-medium">Date</th>
                  <th className="text-left py-2 font-medium">Ref</th>
                  <th className="text-left py-2 font-medium">Description</th>
                  <th className="text-right py-2 font-medium">Amount</th>
                  <th className="text-right py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {activityData.map((row, i) => (
                  <tr key={i} className="border-b border-gray-100">
                    <td className="py-4 text-gray-600">{row.date}</td>
                    <td className="py-4 text-gray-400 text-xs">{row.ref}</td>
                    <td className="py-4">
                      <p className="font-medium text-gray-900">{row.name}</p>
                      <p className="text-xs text-gray-500">{row.desc}</p>
                    </td>
                    <td className="py-4 text-right font-medium">{row.amount}</td>
                    <td className="py-4 text-right">
                      <Badge className="bg-green-100 text-green-700">{row.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-gray-50 border rounded-lg p-3 text-xs text-gray-500">
            All transactions are logged for regulatory compliance. Records maintained under s912A Corporations Act 2001 (Cth) — 7-year minimum retention. AMAX Wealth does not hold client funds.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ComplianceMiniTab() {
  return (
    <div className="space-y-6">
      <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center gap-4">
        <Badge className="bg-green-600 text-white px-3 py-1">Tier 2 verified — wholesale investor</Badge>
        <div>
          <p className="font-semibold text-gray-900">Wholesale client classification</p>
          <p className="text-sm text-gray-600">Verified under Corporations Act 2001 (Cth) s761G — must be re-verified periodically</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardContent className="p-6 space-y-4">
            <div>
              <p className="font-semibold text-gray-900">KYC status</p>
              <p className="text-sm text-gray-500">Verification progress</p>
            </div>
            {kycSteps.map((step) => (
              <div key={step.num} className="flex items-start gap-3">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 ${
                  step.status === "completed" ? "bg-green-100 text-green-700" : step.status === "pending" ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"
                }`}>{step.num}</div>
                <div>
                  <p className="font-medium text-gray-900 text-sm">{step.title}</p>
                  <p className="text-xs text-gray-500">{step.desc}</p>
                </div>
              </div>
            ))}
            <Button variant="outline" size="sm" className="w-full">Continue KYC <ExternalLink className="w-3 h-3 ml-1" /></Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6 space-y-3">
            <div>
              <p className="font-semibold text-gray-900">Documents</p>
              <p className="text-sm text-gray-500">Upload and manage compliance documents</p>
            </div>
            {documents.map((doc, i) => (
              <div key={i} className="flex items-center justify-between py-2">
                <div>
                  <p className="font-medium text-gray-900 text-sm">{doc.name}</p>
                  <p className="text-xs text-gray-500">{doc.desc}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Badge className={doc.color + " text-xs"}>{doc.status}</Badge>
                  {doc.hasUpload && (
                    <Button variant="outline" size="sm" className="text-xs">
                      Upload <ExternalLink className="w-3 h-3 ml-1" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-6 space-y-1">
          <p className="font-semibold text-gray-900 mb-3">Regulatory status</p>
          {regulatoryRows.map((row, i) => (
            <div key={i} className="flex justify-between items-center py-3 border-b border-gray-100 last:border-0">
              <span className="font-medium text-gray-900 text-sm">{row.label}</span>
              <span className="text-sm text-gray-600 text-right">{row.value}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function RiskDisclosureTab() {
  return (
    <div className="space-y-6">
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
        <p className="text-sm text-amber-800 italic">
          All investments carry risk. The value of your investments can go down as well as up. You may receive back less than you invest. Past performance is not a reliable indicator of future results.
        </p>
      </div>

      <Card>
        <CardContent className="p-6 space-y-6">
          {riskItems.map((item) => (
            <div key={item.num} className="pb-4 border-b border-gray-100 last:border-0 last:pb-0">
              <div className="flex items-start gap-3">
                <span className="text-blue-600 font-semibold text-sm mt-0.5">{item.num}</span>
                <div>
                  <p className="font-semibold text-gray-900 mb-1">{item.title}</p>
                  <p className="text-sm text-gray-700">{item.text}</p>
                </div>
              </div>
            </div>
          ))}

          <div className="flex items-center justify-between pt-4 border-t border-gray-200 text-sm text-gray-500">
            <span>Disclosure acknowledged · Last updated January 2025 · Australian law applies</span>
            <span>Signed 2 Aug 2025</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
