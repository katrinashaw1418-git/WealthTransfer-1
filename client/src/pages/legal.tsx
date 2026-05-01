import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const privacySections = [
  {
    title: "Collection of personal information",
    text: "AMAX Wealth collects personal information including identity documents, financial details, and transaction records for KYC verification, AML/CTF compliance, wholesale investor verification, and the provision of financial services.",
  },
  {
    title: "Use and disclosure",
    text: "Your information is used to provide services, conduct regulatory screening, and comply with ASIC and AUSTRAC obligations. Information is not sold to third parties. Disclosure to third parties occurs only where required by law or with your consent.",
  },
  {
    title: "Storage and security",
    text: "Personal information is stored securely in Australia. AMAX Wealth applies industry-standard security measures. You may request access to or correction of your personal information at any time.",
  },
  {
    title: "Cross-border disclosure",
    text: "Some data may be processed by service providers outside Australia. Where this occurs, AMAX Wealth takes reasonable steps to ensure equivalent privacy protections apply.",
  },
  {
    title: "Your rights",
    text: "You may request access to, correction of, or deletion of your personal information. Contact our Privacy Officer at privacy@amaxwealth.com.au or +61 2 8320 1908.",
  },
  {
    title: "Complaints",
    text: "Privacy complaints may be directed to our Privacy Officer. If unresolved, complaints may be referred to the Office of the Australian Information Commissioner (OAIC) at oaic.gov.au.",
  },
];

const riskItems = [
  {
    num: 1,
    title: "Market risk",
    text: "Investment values fluctuate with market conditions including interest rate changes, economic developments, geopolitical events, and investor sentiment. Equity and digital asset investments are subject to higher volatility than fixed-income products.",
  },
  {
    num: 2,
    title: "Currency risk",
    text: "Multi-currency investments are exposed to foreign exchange fluctuations. Changes in exchange rates can materially affect the value of your holdings when converted to your base currency. FX hedging is available for select products — confirm availability with your adviser.",
  },
  {
    num: 3,
    title: "Liquidity risk",
    text: "Some investment products have lock-up periods or limited redemption windows. You may be unable to access your funds on short notice. Always ensure you maintain sufficient liquid reserves outside your AMAX Wealth investments.",
  },
  {
    num: 4,
    title: "Credit risk",
    text: "Fixed-income products are subject to the credit risk of the issuer. A downgrade or default may result in partial or total loss of invested capital. Credit ratings are provided as guidance only and are not guarantees of performance.",
  },
  {
    num: 5,
    title: "Concentration risk",
    text: "Concentrating investments in a single asset class, sector, or geography increases vulnerability to adverse events. A diversified portfolio aligned to your risk tolerance may reduce concentration exposure — discuss with your adviser.",
  },
  {
    num: 6,
    title: "Technology and digital asset risk",
    text: "Digital assets and crypto investments are subject to additional risks including regulatory uncertainty, technological failures, smart contract vulnerabilities, and extreme price volatility. These products are a specialist sleeve; access depends on product rules and your suitability assessment with your adviser, and may involve the possibility of total loss of capital.",
  },
  {
    num: 7,
    title: "AI-generated content limitations",
    text: "AI tools on this platform provide general information only. They do not constitute regulated financial product advice under the Corporations Act 2001 (Cth). Always consult a qualified financial adviser before making investment decisions based on AI-generated content.",
  },
  {
    num: 8,
    title: "Regulatory risk",
    text: "Changes in law, tax treatment, or regulatory requirements may adversely affect your investments. AMAX Wealth monitors regulatory developments and will notify clients of material changes affecting their holdings.",
  },
];

export default function Legal() {
  return (
    <div className="p-6 space-y-6">
      <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
        <p className="font-semibold text-slate-900 mb-2">General information only</p>
        <p className="leading-relaxed">
          Nothing on this page is personal financial product advice. Information is general in nature
          and does not take into account your objectives, situation, or needs. Before acting, consider
          whether it is appropriate for you and obtain personal advice from a qualified professional.
        </p>
      </div>

      <Tabs defaultValue="privacy" className="space-y-6">
        <div className="overflow-x-auto">
          <TabsList className="inline-flex h-auto gap-1 bg-sky-50 border border-sky-200 p-1 rounded-lg min-w-max">
            <TabsTrigger
              value="privacy"
              className="text-sky-700 data-[state=active]:bg-sky-500 data-[state=active]:text-white min-w-[120px]"
            >
              Privacy policy
            </TabsTrigger>
            <TabsTrigger
              value="risk-disclosure"
              className="text-sky-700 data-[state=active]:bg-sky-500 data-[state=active]:text-white min-w-[130px]"
            >
              Risk disclosure
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="privacy">
          <div className="space-y-4">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-1">Privacy policy</h2>
              <p className="text-sm text-gray-500">
                AMAX Wealth Pty Ltd is committed to protecting your personal information in accordance
                with the Privacy Act 1988 (Cth) and the Australian Privacy Principles (APPs).
              </p>
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

            <p className="text-xs text-gray-400">
              Privacy Policy version 1.0 · January 2025 · Privacy Act 1988 (Cth) applies
            </p>
          </div>
        </TabsContent>

        <TabsContent value="risk-disclosure">
          <div className="space-y-4">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-1">Risk disclosure</h2>
              <p className="text-sm text-gray-500">
                Important information about risks associated with products and strategies discussed on
                or through the platform. This summary is general in nature and is not personal advice.
              </p>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="text-sm text-gray-600 italic">
                All investments carry risk. The value of your investments can go down as well as up.
                You may receive back less than you invest. Past performance is not a reliable indicator
                of future results.
              </p>
            </div>

            <Card>
              <CardContent className="p-6 space-y-6">
                {riskItems.map((item) => (
                  <div
                    key={item.num}
                    className="pb-4 border-b border-gray-100 last:border-0 last:pb-0"
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-blue-600 font-semibold text-sm mt-0.5">{item.num}</span>
                      <div>
                        <p className="font-semibold text-gray-900 mb-1">{item.title}</p>
                        <p className="text-sm text-gray-700">{item.text}</p>
                      </div>
                    </div>
                  </div>
                ))}

                <div className="pt-4 border-t border-gray-200 text-sm text-gray-500">
                  <span>Last updated January 2025 · Australian law applies</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <footer className="border-t border-gray-200 pt-6 mt-8 text-sm text-gray-500">
        <p className="font-semibold text-gray-700 mb-2">Contact</p>
        <p>+61 2 8320 1908</p>
        <p>compliance@amaxwealth.com.au</p>
        <div className="mt-6 pt-4 border-t border-gray-100 text-xs text-gray-400">
          <p>© {new Date().getFullYear()} AMAX Wealth Pty Ltd. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
