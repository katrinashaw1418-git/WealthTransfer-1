import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Shield,
  CheckCircle,
  Clock,
  AlertTriangle,
  Upload,
  Phone,
  MessageSquare,
  ExternalLink,
} from "lucide-react";

const complianceMetrics = [
  { label: "KYC COMPLETION", value: 65, status: "In progress", color: "bg-orange-500" },
  { label: "AML SCREENING", value: 100, status: "Completed", color: "bg-green-500" },
  { label: "DOCUMENT VERIFICATION", value: 50, status: "In progress", color: "bg-orange-500" },
  { label: "RISK ASSESSMENT", value: 0, status: "Pending", color: "bg-gray-300" },
];

const kycSteps = [
  { num: 1, title: "Identity verification", desc: "Government-issued ID verified — completed 2 Aug 2025", status: "completed" },
  { num: 2, title: "AML screening", desc: "PEP and sanctions screening passed — completed 2 Aug 2025", status: "completed" },
  { num: 3, title: "Source of funds declaration", desc: "Declaration submitted — pending review by compliance team", status: "pending" },
  { num: 4, title: "Risk assessment questionnaire", desc: "Not yet commenced — required before investment limit increases", status: "not_started" },
];

const documents = [
  { name: "Government-issued ID", desc: "Passport or driver licence — verified", status: "Verified", statusColor: "bg-green-100 text-green-700" },
  { name: "Proof of address", desc: "Utility bill or bank statement (within 3 months)", status: "Verified", statusColor: "bg-green-100 text-green-700" },
  { name: "Source of funds declaration", desc: "Signed statutory declaration — under review", status: "Under review", statusColor: "bg-amber-100 text-amber-700" },
  { name: "Wholesale investor certificate", desc: "Accountant-certified certificate — required under s761GA", status: "Required", statusColor: "bg-amber-100 text-amber-700", hasUpload: true },
  { name: "Signed risk disclosure", desc: "Acknowledgement of investment risks", status: "Signed", statusColor: "bg-green-100 text-green-700" },
];

const regulatoryRows = [
  { label: "AMAX Wealth Pty Ltd", value: "Authorised Representative under Australian Financial Services Licence" },
  { label: "AUSTRAC registration", value: "AMAX Global Pty Ltd — Digital currency exchange and remittance provider" },
  { label: "Client classification", value: "Wholesale client — Corporations Act 2001 (Cth) s761G" },
  { label: "Dispute resolution", value: "AFCA member — Australian Financial Complaints Authority" },
  { label: "Record keeping", value: "s912A Corporations Act 2001 (Cth) — 7-year minimum retention" },
  { label: "Privacy", value: "Privacy Act 1988 (Cth) — Australian Privacy Principles apply" },
];

export default function Compliance() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-amber-700">Welcome back, Wise</h1>
          <p className="text-gray-500 text-sm">Compliance centre — AMAX Wealth · 5 accounts · Global</p>
        </div>
        <Card className="border shadow-sm">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="w-10 h-10 bg-slate-700 rounded-full flex items-center justify-center text-white text-sm font-semibold">AW</div>
            <div>
              <p className="text-sm font-medium">Your adviser</p>
              <p className="text-xs text-gray-500">+61 2 8320 1908</p>
            </div>
            <div className="flex gap-2 ml-2">
              <Button variant="outline" size="sm"><Phone className="w-3 h-3 mr-1" />Call</Button>
              <Button variant="outline" size="sm"><MessageSquare className="w-3 h-3 mr-1" />Message</Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center gap-4">
        <Badge className="bg-green-600 text-white px-3 py-1 text-sm">Tier 2 verified</Badge>
        <div>
          <p className="font-semibold text-gray-900">Wholesale investor — premium access enabled</p>
          <p className="text-sm text-gray-600">Verified under the Corporations Act 2001 (Cth) s761G — wholesale client classification</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {complianceMetrics.map((m, i) => (
          <Card key={i}>
            <CardContent className="p-5">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">{m.label}</p>
              <p className="text-3xl font-bold text-gray-900 mb-1">{m.value}%</p>
              <p className={`text-sm mb-2 ${m.status === "Completed" ? "text-green-600" : m.status === "Pending" ? "text-gray-400" : "text-orange-600"}`}>
                {m.status}
              </p>
              <div className="w-full bg-gray-200 rounded-full h-1.5">
                <div className={`${m.color} h-1.5 rounded-full`} style={{ width: `${m.value}%` }} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="kyc" className="space-y-6">
        <div className="overflow-x-auto">
          <TabsList className="inline-flex h-auto gap-1 bg-slate-100 p-1 rounded-lg min-w-max">
            <TabsTrigger value="kyc" className="min-w-[120px]">KYC status</TabsTrigger>
            <TabsTrigger value="documents" className="min-w-[120px]">Documents</TabsTrigger>
            <TabsTrigger value="risk" className="min-w-[120px]">Risk profile</TabsTrigger>
            <TabsTrigger value="regulatory" className="min-w-[120px]">Regulatory</TabsTrigger>
            <TabsTrigger value="terms" className="min-w-[140px]">Terms &amp; conditions</TabsTrigger>
            <TabsTrigger value="privacy" className="min-w-[120px]">Privacy policy</TabsTrigger>
            <TabsTrigger value="risk-disclosure" className="min-w-[120px]">Risk disclosure</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="kyc">
          <Card>
            <CardContent className="p-6 space-y-6">
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <p className="font-semibold text-gray-900 mb-1">Wholesale client classification</p>
                <p className="text-sm text-gray-700">
                  You are classified as a wholesale client under s761G of the Corporations Act 2001 (Cth). This classification is based on your verified net assets or income. Wholesale classification must be re-verified periodically. If your circumstances change, notify AMAX Wealth immediately.
                </p>
              </div>

              <div className="space-y-4">
                {kycSteps.map((step) => (
                  <div key={step.num} className="flex items-start gap-4 py-4 border-b border-gray-100 last:border-0">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold flex-shrink-0 mt-0.5 ${
                      step.status === "completed" ? "bg-green-100 text-green-700" : step.status === "pending" ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"
                    }`}>
                      {step.num}
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">{step.title}</p>
                      <p className="text-sm text-gray-500">{step.desc}</p>
                    </div>
                  </div>
                ))}
              </div>

              <Button variant="outline" size="sm">
                Continue KYC <ExternalLink className="w-3 h-3 ml-1" />
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="documents">
          <Card>
            <CardContent className="p-6 space-y-4">
              <p className="text-sm text-gray-600">Upload and manage your compliance documents. All documents are stored securely and used for regulatory verification only.</p>

              {documents.map((doc, i) => (
                <div key={i} className="flex items-center justify-between py-4 border-b border-gray-100 last:border-0">
                  <div>
                    <p className="font-medium text-gray-900">{doc.name}</p>
                    <p className="text-sm text-gray-500">{doc.desc}</p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <Badge className={doc.statusColor}>{doc.status}</Badge>
                    {doc.hasUpload && (
                      <Button variant="outline" size="sm">
                        Upload <ExternalLink className="w-3 h-3 ml-1" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="risk">
          <Card>
            <CardContent className="p-6 space-y-6">
              <p className="text-sm text-gray-600">Your self-assessed risk profile. This is used for general context only — not a substitute for a formal risk assessment by a licensed adviser.</p>

              <div className="space-y-1">
                <div className="flex justify-between items-center py-3 border-b border-gray-100">
                  <span className="text-gray-700">Risk tolerance</span>
                  <span className="font-medium text-gray-900">Moderate (60/100)</span>
                </div>
                <div className="flex justify-between items-center py-3 border-b border-gray-100">
                  <span className="text-gray-700">Investment horizon</span>
                  <span className="font-medium text-gray-900">5–10 years</span>
                </div>
                <div className="flex justify-between items-center py-3 border-b border-gray-100">
                  <span className="text-gray-700">Primary goal</span>
                  <span className="font-medium text-gray-900">Growth</span>
                </div>
              </div>

              <div className="flex items-center justify-between py-3 border-b border-gray-100">
                <span className="font-medium text-gray-900">Formal risk assessment</span>
                <div className="flex items-center gap-3">
                  <Badge className="bg-amber-100 text-amber-700">Pending</Badge>
                  <Button variant="outline" size="sm">
                    Complete <ExternalLink className="w-3 h-3 ml-1" />
                  </Button>
                </div>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <p className="text-sm text-amber-800">
                  A formal risk assessment must be completed by your licensed adviser before personal advice can be provided. Your self-assessed profile is used for general information purposes only.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="regulatory">
          <Card>
            <CardContent className="p-6 space-y-1">
              <p className="text-sm text-gray-600 mb-4">Regulatory status and licence information applicable to AMAX Wealth services.</p>

              {regulatoryRows.map((row, i) => (
                <div key={i} className="flex justify-between items-start py-4 border-b border-gray-100 last:border-0 gap-8">
                  <span className="font-medium text-gray-900 flex-shrink-0">{row.label}</span>
                  <span className="text-sm text-gray-600 text-right">{row.value}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="terms">
          <Card>
            <CardContent className="p-6 space-y-6">
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">1. Nature of services</h3>
                <p className="text-sm text-gray-700">
                  AMAX Wealth Pty Ltd provides financial product information and, where authorised, financial product advice as an Authorised Representative under an Australian Financial Services Licence. Services are provided to wholesale clients only as defined under the Corporations Act 2001 (Cth).
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">2. No personal advice without SOA</h3>
                <p className="text-sm text-gray-700">
                  General information provided on this platform does not constitute personal financial product advice. Personal advice will only be provided following completion of a fact-find and delivery of a Statement of Advice (SOA) by a licensed financial adviser.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">3. Investment risk acknowledgement</h3>
                <p className="text-sm text-gray-700">
                  By using this platform you acknowledge that all investments carry risk, including possible loss of capital. Past performance is not a reliable indicator of future performance. Target returns are indicative only and are not guaranteed.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">4. AI-generated content</h3>
                <p className="text-sm text-gray-700">
                  AI-generated insights on this platform are general information only. They do not take into account your personal circumstances and are not regulated investment advice.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">5. Custody of assets</h3>
                <p className="text-sm text-gray-700">
                  AMAX Wealth does not hold client funds or assets. All investments are held with external regulated custodians or fund managers. AMAX Wealth provides instruction, reporting, and advisory services only.
                </p>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-gray-200 text-sm text-gray-500">
                <span>Terms accepted</span>
                <span>2 Aug 2025</span>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="privacy">
          <Card>
            <CardContent className="p-6 space-y-6">
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">Collection of personal information</h3>
                <p className="text-sm text-gray-700">
                  AMAX Wealth collects personal information including identity documents, financial information, and transaction records for the purpose of providing financial services, meeting KYC/AML obligations, and complying with regulatory requirements under Australian law.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">Use and disclosure</h3>
                <p className="text-sm text-gray-700">
                  Your information is used to provide services, conduct AML/CTF screening, verify wholesale investor status, and comply with ASIC and AUSTRAC reporting obligations. Information is not sold to third parties.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">Storage and security</h3>
                <p className="text-sm text-gray-700">
                  Personal information is stored securely in Australia. AMAX Wealth applies the Australian Privacy Principles under the Privacy Act 1988 (Cth). You may request access to or correction of your personal information at any time.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">Contact</h3>
                <p className="text-sm text-gray-700">
                  For privacy enquiries contact AMAX Wealth compliance via the adviser contact details on this platform or submit a written request to our registered office.
                </p>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-gray-200 text-sm text-gray-500">
                <span>Privacy policy acknowledged</span>
                <span>2 Aug 2025</span>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="risk-disclosure">
          <Card>
            <CardContent className="p-6 space-y-6">
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <p className="text-sm text-amber-800 italic">
                  All investments carry risk. The value of your investments can go down as well as up. You may receive back less than you invest. Past performance is not a reliable indicator of future results.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-gray-900 mb-2">1 &nbsp; Market risk</h3>
                <p className="text-sm text-gray-700">
                  Investment values fluctuate with market conditions including interest rate changes, economic developments, geopolitical events, and investor sentiment. Equity and digital asset investments are subject to higher volatility than fixed-income products.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">2 &nbsp; Currency risk</h3>
                <p className="text-sm text-gray-700">
                  Multi-currency investments are exposed to foreign exchange fluctuations. Changes in exchange rates can materially affect the value of your holdings when converted to your base currency. FX hedging is available for select products — confirm availability with your adviser.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">3 &nbsp; Liquidity risk</h3>
                <p className="text-sm text-gray-700">
                  Some investment products have lock-up periods or limited redemption windows. You may be unable to access your funds on short notice. Always ensure you maintain sufficient liquid reserves outside your AMAX Wealth investments.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">4 &nbsp; Credit risk</h3>
                <p className="text-sm text-gray-700">
                  Fixed-income products are subject to the credit risk of the issuer. A downgrade or default may result in partial or total loss of invested capital. Credit ratings are provided as guidance only and are not guarantees of performance.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">5 &nbsp; Concentration risk</h3>
                <p className="text-sm text-gray-700">
                  Concentrating investments in a single asset class, sector, or geography increases vulnerability to adverse events. A diversified portfolio aligned to your risk tolerance may reduce concentration exposure — discuss with your adviser.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">6 &nbsp; Technology and digital asset risk</h3>
                <p className="text-sm text-gray-700">
                  Digital assets and crypto investments are subject to additional risks including regulatory uncertainty, technological failures, smart contract vulnerabilities, and extreme price volatility. These products are available to wholesale investors only and carry the possibility of total loss of capital.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">7 &nbsp; AI-generated content limitations</h3>
                <p className="text-sm text-gray-700">
                  AI tools on this platform provide general information only. They do not constitute regulated financial product advice under the Corporations Act 2001 (Cth). Always consult a licensed financial adviser before making investment decisions based on AI-generated content.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">8 &nbsp; Regulatory risk</h3>
                <p className="text-sm text-gray-700">
                  Changes in law, tax treatment, or regulatory requirements may adversely affect your investments. AMAX Wealth monitors regulatory developments and will notify clients of material changes affecting their holdings.
                </p>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-gray-200 text-sm text-gray-500">
                <span>Disclosure acknowledged · Last updated January 2025 · Australian law applies</span>
                <span>Signed 2 Aug 2025</span>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <div className="text-xs text-gray-400 leading-relaxed pt-4 border-t border-gray-100">
        Compliance documentation is maintained in accordance with AFSL obligations and ASIC requirements. AMAX Wealth Pty Ltd operates as an Authorised Representative under an Australian Financial Services Licence arrangement. All client data is handled in accordance with the Privacy Act 1988 (Cth).
      </div>
    </div>
  );
}
