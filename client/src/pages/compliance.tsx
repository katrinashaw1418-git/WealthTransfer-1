import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Shield, 
  CheckCircle, 
  Clock, 
  AlertTriangle, 
  Upload, 
  Download, 
  Eye,
  FileText,
  Camera,
  User,
  MapPin,
  CreditCard,
  Building
} from "lucide-react";

export default function Compliance() {
  const [kycStep, setKycStep] = useState(2);
  const [selectedDocument, setSelectedDocument] = useState<File | null>(null);

  // Mock KYC data
  const kycStatus = {
    overall: "in_progress",
    steps: [
      { id: 1, title: "Identity Verification", status: "completed", icon: User, description: "Government ID verified" },
      { id: 2, title: "Address Verification", status: "in_progress", icon: MapPin, description: "Proof of address pending" },
      { id: 3, title: "Source of Funds", status: "pending", icon: CreditCard, description: "Income verification required" },
      { id: 4, title: "Risk Assessment", status: "pending", icon: Shield, description: "Questionnaire completion" },
    ]
  };

  const documents = [
    { id: 1, type: "passport", name: "Passport Copy", status: "approved", uploadDate: "2024-01-10", size: "2.4 MB" },
    { id: 2, type: "address", name: "Utility Bill", status: "under_review", uploadDate: "2024-01-12", size: "1.8 MB" },
    { id: 3, type: "bank_statement", name: "Bank Statement", status: "pending", uploadDate: "", size: "" },
    { id: 4, type: "income", name: "Income Statement", status: "pending", uploadDate: "", size: "" },
  ];

  const complianceMetrics = [
    { label: "KYC Completion", value: 65, status: "in_progress" },
    { label: "AML Screening", value: 100, status: "completed" },
    { label: "Document Verification", value: 50, status: "in_progress" },
    { label: "Risk Assessment", value: 0, status: "pending" },
  ];

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
      case "approved":
        return "bg-green-100 text-green-800";
      case "in_progress":
      case "under_review":
        return "bg-yellow-100 text-yellow-800";
      case "pending":
        return "bg-gray-100 text-gray-800";
      case "rejected":
        return "bg-red-100 text-red-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
      case "approved":
        return CheckCircle;
      case "in_progress":
      case "under_review":
        return Clock;
      case "pending":
        return Clock;
      case "rejected":
        return AlertTriangle;
      default:
        return Clock;
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setSelectedDocument(file);
      // Handle file upload logic here
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Compliance Center</h1>
          <p className="text-gray-600">Manage your verification status and regulatory compliance</p>
        </div>
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
            <Shield className="w-4 h-4 text-white" />
          </div>
          <div>
            <p className="text-sm font-medium">Tier 2 Verified</p>
            <p className="text-xs text-gray-500">Premium access enabled</p>
          </div>
        </div>
      </div>

      {/* Compliance Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {complianceMetrics.map((metric, index) => (
          <Card key={index}>
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-gray-500">{metric.label}</h3>
                <Badge className={getStatusColor(metric.status)}>
                  {metric.status.replace('_', ' ')}
                </Badge>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-2xl font-bold">{metric.value}%</span>
                </div>
                <Progress value={metric.value} className="h-2" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="kyc" className="space-y-6">
        <TabsList className="flex flex-wrap h-auto gap-1 bg-slate-100 p-1 rounded-lg">
          <TabsTrigger value="kyc" className="flex-1 min-w-[120px]">KYC Status</TabsTrigger>
          <TabsTrigger value="documents" className="flex-1 min-w-[120px]">Documents</TabsTrigger>
          <TabsTrigger value="risk" className="flex-1 min-w-[120px]">Risk Profile</TabsTrigger>
          <TabsTrigger value="regulatory" className="flex-1 min-w-[120px]">Regulatory</TabsTrigger>
          <TabsTrigger value="terms" className="flex-1 min-w-[120px]">Terms &amp; Conditions</TabsTrigger>
          <TabsTrigger value="privacy" className="flex-1 min-w-[120px]">Privacy Policy</TabsTrigger>
          <TabsTrigger value="risk-disclosure" className="flex-1 min-w-[120px]">Risk Disclosure</TabsTrigger>
        </TabsList>

        {/* KYC Status Tab */}
        <TabsContent value="kyc" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Know Your Customer (KYC) Verification</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                {kycStatus.steps.map((step) => {
                  const Icon = step.icon;
                  const StatusIcon = getStatusIcon(step.status);
                  
                  return (
                    <div key={step.id} className="flex items-center space-x-4 p-4 border rounded-lg">
                      <div className="w-12 h-12 bg-gray-100 rounded-lg flex items-center justify-center">
                        <Icon className="w-6 h-6 text-gray-600" />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center space-x-3 mb-1">
                          <h3 className="font-medium">{step.title}</h3>
                          <Badge className={getStatusColor(step.status)}>
                            {step.status.replace('_', ' ')}
                          </Badge>
                        </div>
                        <p className="text-sm text-gray-600">{step.description}</p>
                      </div>
                      <StatusIcon className={`w-5 h-5 ${
                        step.status === 'completed' ? 'text-green-600' : 
                        step.status === 'in_progress' ? 'text-yellow-600' : 
                        'text-gray-400'
                      }`} />
                    </div>
                  );
                })}
              </div>
              
              <div className="mt-6 p-4 bg-blue-50 rounded-lg">
                <div className="flex items-start space-x-3">
                  <Shield className="w-5 h-5 text-blue-600 mt-0.5" />
                  <div>
                    <h4 className="font-medium text-blue-900 mb-1">Next Steps</h4>
                    <p className="text-sm text-blue-700 mb-3">
                      Complete your address verification by uploading a recent utility bill or bank statement.
                    </p>
                    <Button size="sm">
                      Continue Verification
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Documents Tab */}
        <TabsContent value="documents" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Document Management</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {documents.map((doc) => {
                  const StatusIcon = getStatusIcon(doc.status);
                  
                  return (
                    <div key={doc.id} className="flex items-center justify-between p-4 border rounded-lg">
                      <div className="flex items-center space-x-4">
                        <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
                          <FileText className="w-5 h-5 text-gray-600" />
                        </div>
                        <div>
                          <h3 className="font-medium">{doc.name}</h3>
                          <div className="flex items-center space-x-4 text-sm text-gray-600">
                            {doc.uploadDate && (
                              <span>Uploaded: {new Date(doc.uploadDate).toLocaleDateString()}</span>
                            )}
                            {doc.size && <span>Size: {doc.size}</span>}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center space-x-3">
                        <Badge className={getStatusColor(doc.status)}>
                          {doc.status.replace('_', ' ')}
                        </Badge>
                        {doc.status === "pending" ? (
                          <Button size="sm">
                            <Upload className="w-3 h-3 mr-1" />
                            Upload
                          </Button>
                        ) : (
                          <div className="flex space-x-2">
                            <Button size="sm" variant="outline">
                              <Eye className="w-3 h-3 mr-1" />
                              View
                            </Button>
                            <Button size="sm" variant="outline">
                              <Download className="w-3 h-3 mr-1" />
                              Download
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              
              <div className="mt-6 p-4 border-2 border-dashed border-gray-300 rounded-lg text-center">
                <Upload className="w-8 h-8 text-gray-400 mx-auto mb-3" />
                <h3 className="font-medium text-gray-900 mb-1">Upload New Document</h3>
                <p className="text-sm text-gray-600 mb-4">
                  Drag and drop files here, or click to browse
                </p>
                <input
                  type="file"
                  onChange={handleFileUpload}
                  accept=".pdf,.jpg,.jpeg,.png"
                  className="hidden"
                  id="file-upload"
                />
                <label htmlFor="file-upload">
                  <Button asChild>
                    <span>Choose Files</span>
                  </Button>
                </label>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Risk Profile Tab */}
        <TabsContent value="risk" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Risk Assessment Questionnaire</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                <div>
                  <Label htmlFor="investment-experience">Investment Experience</Label>
                  <Select>
                    <SelectTrigger>
                      <SelectValue placeholder="Select your experience level" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="novice">Novice (0-2 years)</SelectItem>
                      <SelectItem value="intermediate">Intermediate (3-7 years)</SelectItem>
                      <SelectItem value="experienced">Experienced (8+ years)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="annual-income">Annual Income (USD)</Label>
                  <Select>
                    <SelectTrigger>
                      <SelectValue placeholder="Select income range" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="under-50k">Under $50,000</SelectItem>
                      <SelectItem value="50k-100k">$50,000 - $100,000</SelectItem>
                      <SelectItem value="100k-250k">$100,000 - $250,000</SelectItem>
                      <SelectItem value="250k-500k">$250,000 - $500,000</SelectItem>
                      <SelectItem value="over-500k">Over $500,000</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="investment-goals">Primary Investment Goals</Label>
                  <Textarea 
                    id="investment-goals"
                    placeholder="Describe your investment objectives, time horizon, and risk tolerance..."
                    className="min-h-[100px]"
                  />
                </div>

                <div>
                  <Label htmlFor="source-of-funds">Source of Funds</Label>
                  <Select>
                    <SelectTrigger>
                      <SelectValue placeholder="Select primary source" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="employment">Employment Income</SelectItem>
                      <SelectItem value="business">Business Income</SelectItem>
                      <SelectItem value="investments">Investment Returns</SelectItem>
                      <SelectItem value="inheritance">Inheritance</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Button className="w-full">
                  Complete Risk Assessment
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Regulatory Tab */}
        <TabsContent value="regulatory" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Regulatory Compliance</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="p-4 border rounded-lg">
                    <div className="flex items-center space-x-3 mb-3">
                      <Building className="w-5 h-5 text-primary" />
                      <h3 className="font-medium">AFSL — Authorised Representative</h3>
                    </div>
                    <Badge className="bg-green-100 text-green-800 mb-2">Active</Badge>
                    <p className="text-sm text-gray-600">
                      AMAX Wealth operates as an Authorised Representative under an Australian Financial Services Licence. AR Number: [AR Number].
                    </p>
                  </div>

                  <div className="p-4 border rounded-lg">
                    <div className="flex items-center space-x-3 mb-3">
                      <Building className="w-5 h-5 text-primary" />
                      <h3 className="font-medium">AUSTRAC — AMAX Global</h3>
                    </div>
                    <Badge className="bg-green-100 text-green-800 mb-2">Registered</Badge>
                    <p className="text-sm text-gray-600">
                      AMAX Global is registered with AUSTRAC as a Digital Currency Exchange and Remittance provider. FX and payment services are executed via AMAX Global, a separate entity.
                    </p>
                  </div>

                  <div className="p-4 border rounded-lg">
                    <div className="flex items-center space-x-3 mb-3">
                      <Building className="w-5 h-5 text-primary" />
                      <h3 className="font-medium">AFCA Membership</h3>
                    </div>
                    <Badge className="bg-green-100 text-green-800 mb-2">Member</Badge>
                    <p className="text-sm text-gray-600">
                      AMAX Wealth is a member of the Australian Financial Complaints Authority for external dispute resolution. AFCA has discretion regarding complaints from wholesale clients.
                    </p>
                  </div>

                  <div className="p-4 border rounded-lg">
                    <div className="flex items-center space-x-3 mb-3">
                      <Building className="w-5 h-5 text-primary" />
                      <h3 className="font-medium">Privacy Act 1988 (Cth)</h3>
                    </div>
                    <Badge className="bg-green-100 text-green-800 mb-2">Compliant</Badge>
                    <p className="text-sm text-gray-600">
                      Data handling complies with the Australian Privacy Principles under the Privacy Act 1988 (Cth).
                    </p>
                  </div>
                </div>

                <div className="p-4 bg-blue-50 rounded-lg">
                  <h4 className="font-medium text-blue-900 mb-2">Record-Keeping Obligations</h4>
                  <p className="text-sm text-blue-700">
                    AMAX Wealth maintains records in accordance with s912A of the Corporations Act 2001 (Cth). 
                    All transaction records, advice documents, and compliance records are retained for a minimum of 7 years.
                  </p>
                </div>

                <div className="p-4 bg-gray-50 rounded-lg border">
                  <h4 className="font-medium text-gray-900 mb-2">Entity Separation</h4>
                  <p className="text-sm text-gray-600">
                    <strong>AMAX Wealth</strong> provides advisory and reporting services under AFSL arrangements. 
                    <strong> AMAX Global</strong> provides FX, remittance, and digital currency exchange services under AUSTRAC registration. 
                    These are separate entities with distinct regulatory obligations. Client funds are not held by AMAX Wealth.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Terms & Conditions Tab */}
        <TabsContent value="terms" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-blue-600" />
                Terms & Conditions
              </CardTitle>
            </CardHeader>
            <CardContent className="prose prose-sm max-w-none text-gray-700 space-y-4">
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">1. Acceptance of Terms</h3>
                <p>By accessing or using AMAX Wealth Management platform, you agree to be bound by these Terms and Conditions. If you do not agree, please do not use our services. These terms constitute a legally binding agreement between you and AMAX Financial Services Ltd.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">2. Eligibility</h3>
                <p>You must be at least 18 years of age and legally capable of entering into binding contracts to use our services. Use of AMAX services is restricted in jurisdictions where such services are prohibited by law.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">3. Account Responsibilities</h3>
                <p>You are responsible for maintaining the confidentiality of your account credentials and for all activity that occurs under your account. You must notify AMAX immediately of any unauthorized use or suspected breach of security.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">4. Services</h3>
                <p>AMAX Wealth provides portfolio reporting, advisory services, and investment product access under AFSL arrangements. FX and payment services are provided separately by AMAX Global under AUSTRAC registration. Client funds and assets are maintained with external regulated custodians and are not held by AMAX Wealth. All investment services are subject to applicable financial regulations and require completed KYC verification.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">5. Fees and Charges</h3>
                <p>AMAX charges fees for certain services including FX conversion (0.5% of converted amount), withdrawals (flat $25 fee), and investment management (per product schedule). All fees are disclosed prior to transaction confirmation.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">6. Limitation of Liability</h3>
                <p>AMAX is not liable for losses arising from market fluctuations, system outages, third-party failures, or events beyond our reasonable control. Our total liability to you shall not exceed fees paid in the preceding 12 months.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">7. Custody Disclaimer</h3>
                <p>AMAX Wealth does not hold client funds or assets. All positions are maintained with external regulated custodians. AMAX Wealth acts solely as an advisory and reporting platform under its Authorised Representative arrangement.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">8. Governing Law</h3>
                <p>These Terms are governed by the laws of the Commonwealth of Australia. Disputes shall be subject to the jurisdiction of the courts of New South Wales, Australia.</p>
              </div>
              <p className="text-xs text-gray-400 pt-2">Last updated: January 2025 | Version 4.0 | Australian law applies</p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Privacy Policy Tab */}
        <TabsContent value="privacy" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-green-600" />
                Privacy Policy
              </CardTitle>
            </CardHeader>
            <CardContent className="prose prose-sm max-w-none text-gray-700 space-y-4">
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">1. Data We Collect</h3>
                <p>We collect information you provide directly (name, email, government ID, financial data), usage data (transaction history, platform interactions), and technical data (IP address, device type, browser). All collection is governed by the Australian Privacy Principles under the Privacy Act 1988 (Cth).</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">2. How We Use Your Data</h3>
                <p>Your data is used to: provide and improve our services, comply with KYC/AML obligations, process transactions, generate AI-powered investment insights, detect and prevent fraud, and communicate account updates. We do not sell your personal data to third parties.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">3. Data Sharing</h3>
                <p>We share data with: regulatory bodies (as required by law), payment processors and banking partners (for transaction processing), identity verification providers (for KYC), and cloud service providers (under strict data processing agreements).</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">4. Data Retention</h3>
                <p>Financial records are retained for a minimum of 7 years as required by financial regulations. Account data is retained for the duration of your relationship with AMAX and 5 years thereafter. You may request deletion of non-regulatory data at any time.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">5. Your Rights</h3>
                <p>Under the Australian Privacy Principles you have the right to: access your personal information, request correction of inaccuracies, and make complaints about privacy breaches. Submit requests to privacy@amaxwealth.com.au. Financial records subject to s912A retention requirements cannot be deleted during the 7-year retention period.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">6. Cookies</h3>
                <p>AMAX uses strictly necessary cookies for session management and authentication. We use analytics cookies (with your consent) to improve platform performance. You can manage cookie preferences in your browser settings.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">7. Security</h3>
                <p>We employ industry-standard security measures including AES-256 encryption at rest, TLS 1.3 in transit, multi-factor authentication, and regular penetration testing. In the event of a notifiable data breach, we will notify the Office of the Australian Information Commissioner and affected individuals as required under the Notifiable Data Breaches scheme.</p>
              </div>
              <p className="text-xs text-gray-400 pt-2">Last updated: January 2025 | Compliant with Australian Privacy Principles (Privacy Act 1988)</p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Risk Disclosure Tab */}
        <TabsContent value="risk-disclosure" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-600" />
                Risk Disclosure Statement
              </CardTitle>
            </CardHeader>
            <CardContent className="prose prose-sm max-w-none text-gray-700 space-y-4">
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <p className="font-semibold text-amber-800">Important Notice</p>
                <p className="text-amber-700 text-sm mt-1">All investments carry risk. The value of your investments can go down as well as up. You may receive back less than you invest. Past performance is not a reliable indicator of future results.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">1. Market Risk</h3>
                <p>Investment values fluctuate with market conditions including interest rate changes, economic developments, geopolitical events, and investor sentiment. Equity investments are subject to higher volatility than fixed-income products.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">2. Currency Risk</h3>
                <p>Multi-currency investments are exposed to foreign exchange fluctuations. Changes in exchange rates can materially affect the value of your holdings when converted back to your base currency. FX hedging is available for select products.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">3. Liquidity Risk</h3>
                <p>Some investment products have lock-up periods or limited redemption windows. You may be unable to access your funds on short notice. Always ensure you have sufficient liquid reserves outside your AMAX investments.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">4. Credit Risk</h3>
                <p>Fixed-income products are subject to the credit risk of the issuer. A downgrade or default may result in partial or total loss of the invested capital. Credit ratings are provided as guidance only and are not guarantees of performance.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">5. Concentration Risk</h3>
                <p>Concentrating investments in a single asset class, sector, or geography increases vulnerability to specific adverse events. AMAX recommends diversified portfolios aligned with your risk tolerance and investment horizon.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">6. Technology Risk</h3>
                <p>Digital assets and crypto investments are subject to additional risks including regulatory uncertainty, technological failures, smart contract vulnerabilities, and extreme price volatility. These are suitable only for experienced investors who can afford total loss.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">7. AI Advisory Limitations</h3>
                <p>AMAX AI advisory tools provide information and educational content only. They do not constitute regulated investment advice. Always consult a qualified financial adviser before making significant investment decisions based on AI-generated insights.</p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-base mb-2">8. Regulatory Risk</h3>
                <p>Changes in law, tax treatment, or regulatory requirements may adversely affect your investments. AMAX monitors regulatory developments and will notify clients of material changes that affect their holdings.</p>
              </div>
              <p className="text-xs text-gray-400 pt-2">This disclosure is provided in accordance with the Corporations Act 2001 (Cth) and ASIC regulatory guidance | Last updated: January 2025</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
