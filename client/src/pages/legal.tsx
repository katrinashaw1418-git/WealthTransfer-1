import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Download } from "lucide-react";

const fsgSections = [
  {
    title: null,
    text: "AMAX Wealth Pty Ltd (AMAX Wealth) operates as an Authorised Representative (AR Number: [AR Number]) under an Australian Financial Services Licence (AFSL Number: [AFSL Number]). AMAX Wealth provides financial product information and, where authorised, personal financial product advice to clients in accordance with the licensing arrangements of the relevant AFSL holder. Retail clients access advice through authorised representatives operating under that AFSL; wholesale client status is determined under the Corporations Act 2001 (Cth) s761G.",
  },
  {
    title: "Financial product advice",
    text: "AMAX Wealth provides general financial product information and, following completion of a fact-find and preparation of a Statement of Advice (SOA), personal financial product advice. Personal advice is provided to clients onboarded under the relevant AFSL holder's authorisation, including wholesale investors and retail clients accessing the platform through authorised representatives.",
  },
  {
    title: "Investment product access",
    text: "AMAX Wealth provides access to structured investment products including real estate equity funds, corporate credit funds, and digital asset strategies. Product availability is subject to client classification, suitability and the licensing arrangements of the relevant AFSL holder; retail clients may access products only where appropriate advice, disclosures and consents have been completed through an authorised representative. Investment instructions are executed by external fund managers — AMAX Wealth does not hold client funds.",
  },
  {
    title: "FX exchange",
    text: "Foreign exchange services are provided by AMAX Global Pty Ltd (ABN: [XX XXX XXX XXX]), a separate legal entity registered with AUSTRAC as a Digital Currency Exchange provider and Remittance Service Provider. AMAX Global is not an AFSL holder. FX and payment services are strictly separate from AMAX Wealth's investment and advisory services.",
  },
  {
    title: "Fees",
    text: "AMAX Wealth may receive platform fees, adviser fees, and product referral fees. All fees are disclosed in your Statement of Advice before any personal advice is acted upon. You will not be charged fees without your prior consent. Specific fee schedules are provided on request.",
  },
  {
    title: null,
    text: "AMAX Wealth Pty Ltd is associated with AMAX Global Pty Ltd through common ownership. Where AMAX Wealth refers to products or services provided by associated entities, this association will be disclosed in your SOA. AMAX Wealth manages conflicts of interest through disclosure and governance controls.",
  },
  {
    title: null,
    text: "You have the right to request further information about AMAX Wealth's services, fees, and conflicts of interest at any time. You may also request a copy of your Statement of Advice, fact-find, or any other document held by AMAX Wealth relating to your account. Contact us via the details below or through the adviser messaging function in the platform.",
  },
];

const complaintSteps = [
  { step: 1, title: "Contact us directly", desc: "Contact AMAX Wealth via phone, email, or adviser messaging. We aim to resolve complaints within 5 business days." },
  { step: 2, title: "Formal complaint", desc: "If unresolved, submit a formal written complaint. We will acknowledge within 1 business day and respond within 30 days." },
  { step: 3, title: "External resolution — AFCA", desc: "If still unresolved after 30 days, or if you are dissatisfied, contact AFCA — our external dispute resolution scheme." },
];

const privacySections = [
  { title: "Collection of personal information", text: "AMAX Wealth collects personal information including identity documents, financial details, and transaction records for KYC verification, AML/CTF compliance, wholesale investor verification, and the provision of financial services." },
  { title: "Use and disclosure", text: "Your information is used to provide services, conduct regulatory screening, and comply with ASIC and AUSTRAC obligations. Information is not sold to third parties. Disclosure to third parties occurs only where required by law or with your consent." },
  { title: "Storage and security", text: "Personal information is stored securely in Australia. AMAX Wealth applies industry-standard security measures. You may request access to or correction of your personal information at any time." },
  { title: "Cross-border disclosure", text: "Some data may be processed by service providers outside Australia. Where this occurs, AMAX Wealth takes reasonable steps to ensure equivalent privacy protections apply." },
  { title: "Your rights", text: "You may request access to, correction of, or deletion of your personal information. Contact our Privacy Officer at privacy@amaxwealth.com.au or +61 2 8320 1908." },
  { title: "Complaints", text: "Privacy complaints may be directed to our Privacy Officer. If unresolved, complaints may be referred to the Office of the Australian Information Commissioner (OAIC) at oaic.gov.au." },
];

const termsOfService = [
  { num: 1, title: "Nature of services", text: "AMAX Wealth Pty Ltd operates as an Authorised Representative under an AFSL. Services are provided in accordance with the relevant AFSL holder's licensing arrangements, including to wholesale clients (Corporations Act 2001 (Cth) s761G) and to retail clients accessing the platform through authorised representatives. General information on the platform does not constitute personal financial product advice." },
  { num: 2, title: "No personal advice without SOA", text: "Personal financial product advice is only provided following a full fact-find and delivery of a Statement of Advice (SOA) by a licensed adviser. You must not act on any information on the platform as personal advice without a current SOA." },
  { num: 3, title: "Client classification", text: "Where applicable, by accessing this platform you confirm you are either a wholesale investor under s761G of the Corporations Act 2001 (Cth) or a retail client onboarded by an authorised representative operating under the relevant AFSL. You must notify AMAX Wealth immediately if your client classification changes." },
  { num: 4, title: "Investment risk", text: "All investments carry risk including possible loss of capital. Past performance is not a reliable indicator of future performance. Target returns are indicative only and are not guaranteed." },
  { num: 5, title: "Custody of assets", text: "AMAX Wealth does not hold client funds or assets. All investments are held with external regulated custodians or fund managers. AMAX Wealth provides instruction, reporting, and advisory services only." },
  { num: 6, title: "AI-generated content", text: "AI-generated market insights are general information only. They do not constitute regulated financial product advice and do not take into account your personal circumstances." },
  { num: 7, title: "FX and payments", text: "FX and payment services are provided by AMAX Global Pty Ltd (AUSTRAC registered), a separate legal entity. These services are not covered by AMAX Wealth's AFSL authorisation." },
  { num: 8, title: "Governing law", text: "These terms are governed by the laws of New South Wales, Australia. You submit to the non-exclusive jurisdiction of the courts of New South Wales." },
];

const regulatoryRows = [
  { label: "AMAX Wealth Pty Ltd", value: "Authorised Representative under Australian Financial Services Licence" },
  { label: "AUSTRAC registration", value: "AMAX Global Pty Ltd — Digital currency exchange and remittance provider" },
  { label: "Client classification", value: "Wholesale (s761G) and eligible retail clients onboarded via authorised representatives" },
  { label: "Dispute resolution", value: "AFCA member — Australian Financial Complaints Authority" },
  { label: "Record keeping", value: "s912A Corporations Act 2001 (Cth) — 7-year minimum retention" },
  { label: "Privacy", value: "Privacy Act 1988 (Cth) — Australian Privacy Principles apply" },
];

const riskItems = [
  { num: 1, title: "Market risk", text: "Investment values fluctuate with market conditions including interest rate changes, economic developments, geopolitical events, and investor sentiment. Equity and digital asset investments are subject to higher volatility than fixed-income products." },
  { num: 2, title: "Currency risk", text: "Multi-currency investments are exposed to foreign exchange fluctuations. Changes in exchange rates can materially affect the value of your holdings when converted to your base currency. FX hedging is available for select products — confirm availability with your adviser." },
  { num: 3, title: "Liquidity risk", text: "Some investment products have lock-up periods or limited redemption windows. You may be unable to access your funds on short notice. Always ensure you maintain sufficient liquid reserves outside your AMAX Wealth investments." },
  { num: 4, title: "Credit risk", text: "Fixed-income products are subject to the credit risk of the issuer. A downgrade or default may result in partial or total loss of invested capital. Credit ratings are provided as guidance only and are not guarantees of performance." },
  { num: 5, title: "Concentration risk", text: "Concentrating investments in a single asset class, sector, or geography increases vulnerability to adverse events. A diversified portfolio aligned to your risk tolerance may reduce concentration exposure — discuss with your adviser." },
  { num: 6, title: "Technology and digital asset risk", text: "Digital assets and crypto investments are subject to additional risks including regulatory uncertainty, technological failures, smart contract vulnerabilities, and extreme price volatility. These products are a specialist sleeve, are available only where the relevant AFSL authorisation and client suitability assessment permits, and carry the possibility of total loss of capital." },
  { num: 7, title: "AI-generated content limitations", text: "AI tools on this platform provide general information only. They do not constitute regulated financial product advice under the Corporations Act 2001 (Cth). Always consult a licensed financial adviser before making investment decisions based on AI-generated content." },
  { num: 8, title: "Regulatory risk", text: "Changes in law, tax treatment, or regulatory requirements may adversely affect your investments. AMAX Wealth monitors regulatory developments and will notify clients of material changes affecting their holdings." },
];

const documentLibrary = [
  { name: "Financial Services Guide (FSG)", desc: "Version 1.0 · January 2025 · Required before advice" },
  { name: "Risk disclosure statement", desc: "Version 1.0 · January 2025 · Australian law applies" },
  { name: "Privacy policy", desc: "Version 1.0 · January 2025 · Privacy Act 1988 (Cth)" },
  { name: "Terms of service", desc: "Version 1.0 · January 2025" },
  { name: "Complaints policy", desc: "Internal dispute resolution procedure · AFCA membership" },
  { name: "Wholesale investor certificate template", desc: "For accountant certification — s761GA" },
];

export default function Legal() {
  return (
    <div className="p-6 space-y-6">
      <Tabs defaultValue="fsg" className="space-y-6">
        <div className="overflow-x-auto">
          <TabsList className="inline-flex h-auto gap-1 bg-sky-50 border border-sky-200 p-1 rounded-lg min-w-max">
            <TabsTrigger value="fsg" className="text-sky-700 data-[state=active]:bg-sky-500 data-[state=active]:text-white min-w-[160px]">Financial Services Guide</TabsTrigger>
            <TabsTrigger value="regulatory" className="text-sky-700 data-[state=active]:bg-sky-500 data-[state=active]:text-white min-w-[120px]">Regulatory</TabsTrigger>
            <TabsTrigger value="terms" className="text-sky-700 data-[state=active]:bg-sky-500 data-[state=active]:text-white min-w-[140px]">Terms of service</TabsTrigger>
            <TabsTrigger value="privacy" className="text-sky-700 data-[state=active]:bg-sky-500 data-[state=active]:text-white min-w-[120px]">Privacy policy</TabsTrigger>
            <TabsTrigger value="risk-disclosure" className="text-sky-700 data-[state=active]:bg-sky-500 data-[state=active]:text-white min-w-[130px]">Risk disclosure</TabsTrigger>
            <TabsTrigger value="complaints" className="text-sky-700 data-[state=active]:bg-sky-500 data-[state=active]:text-white min-w-[150px]">Complaints &amp; AFCA</TabsTrigger>
            <TabsTrigger value="documents" className="text-sky-700 data-[state=active]:bg-sky-500 data-[state=active]:text-white min-w-[120px]">Documents</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="fsg">
          <div className="space-y-4">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-1">Financial Services Guide</h2>
              <p className="text-sm text-gray-500">This FSG is designed to help you decide whether to use the services offered by AMAX Wealth.</p>
            </div>

            {fsgSections.map((section, i) => (
              <Card key={i}>
                <CardContent className="p-6">
                  {section.title && <h3 className="font-semibold text-gray-900 mb-2">{section.title}</h3>}
                  <p className="text-sm text-gray-700 leading-relaxed">{section.text}</p>
                </CardContent>
              </Card>
            ))}

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="font-semibold text-blue-900 mb-1">Questions about this FSG?</p>
              <p className="text-sm text-blue-800">Contact AMAX Wealth compliance at +61 2 8320 1908 or via adviser messaging in the platform. For complaints, see the Complaints & AFCA tab.</p>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="regulatory">
          <div className="space-y-4">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-1">Regulatory status</h2>
              <p className="text-sm text-gray-500">Regulatory status and licence information applicable to AMAX Wealth services.</p>
            </div>

            <Card>
              <CardContent className="p-6 space-y-1">
                {regulatoryRows.map((row, i) => (
                  <div key={i} className="flex justify-between items-start py-4 border-b border-gray-100 last:border-0 gap-8">
                    <span className="font-medium text-gray-900 flex-shrink-0">{row.label}</span>
                    <span className="text-sm text-gray-600 text-right">{row.value}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="risk-disclosure">
          <div className="space-y-4">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-1">Risk disclosure</h2>
              <p className="text-sm text-gray-500">Important information about the risks associated with financial products available through AMAX Wealth.</p>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="text-sm text-gray-600 italic">
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
        </TabsContent>

        <TabsContent value="complaints">
          <div className="space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-1">Complaints and dispute resolution</h2>
              <p className="text-sm text-gray-500">AMAX Wealth is committed to resolving complaints promptly and fairly. If you have a complaint, please follow the process below.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {complaintSteps.map((step) => (
                <Card key={step.step}>
                  <CardContent className="p-5">
                    <p className="text-xs text-gray-400 mb-1">Step {step.step}</p>
                    <p className="font-semibold text-gray-900 mb-2">{step.title}</p>
                    <p className="text-sm text-gray-600">{step.desc}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            <div className="bg-green-50 border border-green-200 rounded-lg p-5 space-y-3">
              <p className="font-semibold text-green-900">Australian Financial Complaints Authority (AFCA)</p>
              <p className="text-sm text-green-800">
                AFCA provides free, independent dispute resolution for financial services complaints. AMAX Wealth is a member of AFCA. You can contact AFCA at any time — you do not need to wait for our internal process to be exhausted.
              </p>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline" className="border-green-300 text-green-800">1800 931 678 (free call)</Badge>
                <Badge variant="outline" className="border-green-300 text-green-800">info@afca.org.au</Badge>
                <Badge variant="outline" className="border-green-300 text-green-800">afca.org.au</Badge>
                <Badge variant="outline" className="border-green-300 text-green-800">GPO Box 3, Melbourne VIC 3001</Badge>
              </div>
            </div>

            <Card>
              <CardContent className="p-6 space-y-3">
                <p className="font-semibold text-gray-900">Internal complaint contact</p>
                <div className="text-sm text-gray-700 space-y-1">
                  <p>AMAX Wealth Compliance Team</p>
                  <p>Phone: +61 2 8320 1908</p>
                  <p>Email: compliance@amaxwealth.com.au</p>
                  <p>Address: [Registered office address], Australia</p>
                </div>
                <p className="text-sm text-gray-600 mt-3">
                  Complaints must be submitted in writing for formal resolution. Please include your full name, account number, description of the complaint, and your preferred resolution.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6">
                <p className="font-semibold text-gray-900 mb-2">Timeframes</p>
                <p className="text-sm text-gray-700">
                  Acknowledgement: within 1 business day · Initial response: within 5 business days · Final response: within 30 days · AFCA referral: if unresolved within 30 days or if you are unsatisfied with our response at any stage.
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="privacy">
          <div className="space-y-4">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-1">Privacy policy</h2>
              <p className="text-sm text-gray-500">AMAX Wealth Pty Ltd is committed to protecting your personal information in accordance with the Privacy Act 1988 (Cth) and the Australian Privacy Principles (APPs).</p>
            </div>

            <Card>
              <CardContent className="p-6 space-y-6">
                {privacySections.map((section, i) => (
                  <div key={i} className="pb-4 border-b border-gray-100 last:border-0 last:pb-0">
                    <h3 className="font-semibold text-gray-900 mb-2">{section.title}</h3>
                    <p className="text-sm text-gray-700">{section.text}</p>
                  </div>
                ))}
              </CardContent>
            </Card>

            <p className="text-xs text-gray-400">Privacy Policy version 1.0 · January 2025 · Privacy Act 1988 (Cth) applies</p>
          </div>
        </TabsContent>

        <TabsContent value="terms">
          <div className="space-y-4">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-1">Terms of service</h2>
              <p className="text-sm text-gray-500">By using AMAX Wealth you agree to these terms. If you do not agree, you must discontinue use of the platform immediately.</p>
            </div>

            <Card>
              <CardContent className="p-6 space-y-6">
                {termsOfService.map((item) => (
                  <div key={item.num} className="pb-4 border-b border-gray-100 last:border-0 last:pb-0">
                    <h3 className="font-semibold text-gray-900 mb-2">{item.num}. {item.title}</h3>
                    <p className="text-sm text-gray-700">{item.text}</p>
                  </div>
                ))}

                <div className="flex items-center justify-between pt-4 border-t border-gray-200 text-sm text-gray-500">
                  <span>Terms accepted</span>
                  <span>2 Aug 2025</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="documents">
          <div className="space-y-4">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-1">Document library</h2>
              <p className="text-sm text-gray-500">All regulatory and legal documents for AMAX Wealth. Available to existing clients and prospective investors on request.</p>
            </div>

            <Card>
              <CardContent className="p-6 space-y-1">
                {documentLibrary.map((doc, i) => (
                  <div key={i} className="flex items-center justify-between py-4 border-b border-gray-100 last:border-0">
                    <div>
                      <p className="font-medium text-gray-900">{doc.name}</p>
                      <p className="text-sm text-gray-500">{doc.desc}</p>
                    </div>
                    <Button variant="outline" size="sm">
                      <Download className="w-3 h-3 mr-1" /> Download PDF
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="font-semibold text-blue-900 mb-1">Need an Information Memorandum?</p>
              <p className="text-sm text-blue-800">Product IMs are available to verified clients on request. Contact your adviser or submit a request via the platform.</p>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <footer className="border-t border-gray-200 pt-6 mt-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-sm text-gray-500">
          <div>
            <p className="font-semibold text-gray-700 mb-2">AMAX Wealth</p>
            <p>AMAX Wealth Pty Ltd is an Authorised Representative under an Australian Financial Services Licence.</p>
            <p className="mt-2">AFSL: [AFSL Number] · AR: [AR Number]</p>
            <p>ABN: [ABN]</p>
            <p className="mt-2">AMAX Global Pty Ltd — AUSTRAC registered</p>
            <p>DCE & Remittance · ABN: [ABN]</p>
            <p className="mt-2">Registered office: [Address], Australia</p>
          </div>
          <div>
            <p className="font-semibold text-gray-700 mb-2">Legal</p>
            <p>FSG</p>
            <p>Risk disclosure</p>
            <p>Privacy policy</p>
            <p>Terms of service</p>
            <p>Complaints — AFCA</p>
          </div>
          <div>
            <p className="font-semibold text-gray-700 mb-2">Contact</p>
            <p>+61 2 8320 1908</p>
            <p>compliance@amaxwealth.com.au</p>
            <p>AFCA: 1800 931 678</p>
          </div>
        </div>
        <div className="mt-6 pt-4 border-t border-gray-100 text-xs text-gray-400">
          <p>© 2025 AMAX Wealth Pty Ltd. All rights reserved. Eligible clients only —</p>
          <p>Authorised Representative under an Australian Financial Services Licence arrangement.</p>
        </div>
      </footer>
    </div>
  );
}
