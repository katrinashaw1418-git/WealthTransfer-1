import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ExternalLink } from "lucide-react";

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

export default function Compliance() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-amber-700">Welcome back, Wise</h1>
        <p className="text-gray-500 text-sm">KYC centre — AMAX Wealth · 5 accounts · Global</p>
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
          <TabsList className="inline-flex h-auto gap-1 bg-blue-50 border border-blue-200 p-1 rounded-lg min-w-max">
            <TabsTrigger value="kyc" className="text-blue-700 data-[state=active]:bg-gradient-to-r data-[state=active]:from-blue-500 data-[state=active]:to-indigo-600 data-[state=active]:text-white min-w-[120px]">KYC status</TabsTrigger>
            <TabsTrigger value="documents" className="text-blue-700 data-[state=active]:bg-gradient-to-r data-[state=active]:from-blue-500 data-[state=active]:to-indigo-600 data-[state=active]:text-white min-w-[120px]">Documents</TabsTrigger>
            <TabsTrigger value="risk" className="text-blue-700 data-[state=active]:bg-gradient-to-r data-[state=active]:from-blue-500 data-[state=active]:to-indigo-600 data-[state=active]:text-white min-w-[120px]">Risk profile</TabsTrigger>
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
      </Tabs>

      <div className="text-xs text-gray-400 leading-relaxed pt-4 border-t border-gray-100">
        Compliance documentation is maintained in accordance with AFSL obligations and ASIC requirements. For regulatory status, terms, privacy policy, and risk disclosures, see the Legal & Compliance page.
      </div>
    </div>
  );
}
