import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Shield,
  TrendingUp,
  BarChart3,
  Building2,
  Lock,
  Globe,
  ArrowRight,
  Phone,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  Users,
  FileText,
  Scale,
} from "lucide-react";
import darkBlueLogo from "@assets/AMAX_LOGO_BLUE_1776427512999.jpg";

export default function Landing() {
  const [, navigate] = useLocation();

  return (
    <div className="min-h-screen bg-white">
      <div className="bg-sky-50 px-4 py-2">
        <div className="max-w-7xl mx-auto flex items-center justify-center">
          <p className="text-xs text-sky-700">
            <strong>Notice:</strong> This website is currently under development. Features and content are subject to change.
          </p>
        </div>
      </div>

      <header className="bg-sky-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={darkBlueLogo} alt="AMAX Wealth" className="w-20 h-20 rounded-lg" />
            <div>
              <span className="text-xl font-bold text-sky-900">AMAX WEALTH</span>
              <p className="text-xs text-sky-900">Investments / Advice</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <a href="tel:+61283201908" className="hidden md:flex items-center gap-2 text-sm text-sky-900">
              <Phone className="w-4 h-4" />
              +61 2 8320 1908
            </a>
            <Button className="bg-sky-100 text-sky-900 hover:bg-sky-200 font-semibold" onClick={() => navigate("/login")}>
              Sign In
            </Button>
            <Button className="bg-sky-500 hover:bg-sky-600 text-white font-semibold" onClick={() => navigate("/apply")}>
              Apply for Access
            </Button>
          </div>
        </div>
      </header>

      <section className="bg-sky-50 text-sky-900">
        <div className="max-w-7xl mx-auto px-6 py-24 md:py-32">
          <div className="max-w-3xl">
            <Badge className="bg-white/10 text-sky-900 border-white/20 mb-6">
              Authorised Representative under AFSL
            </Badge>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold leading-tight mb-6">
              Institutional-grade wealth management for wholesale investors
            </h1>
            <p className="text-lg md:text-xl text-sky-700 mb-8 max-w-2xl">
              Consolidated portfolio reporting, structured investment access, and advisory services — 
              delivered through a secure, compliance-first platform.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Button 
                size="lg" 
                className="bg-sky-500 hover:bg-sky-600 text-white font-semibold"
                onClick={() => navigate("/apply")}
              >
                Apply for Access
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
              <Button 
                size="lg" 
                className="bg-sky-100 text-sky-900 hover:bg-sky-200 font-semibold"
                onClick={() => {
                  const el = document.getElementById('how-it-works');
                  el?.scrollIntoView({ behavior: 'smooth' });
                }}
              >
                How It Works
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="py-6 bg-white border-b">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex flex-wrap items-center justify-center gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-green-500" />Authorised Representative — AFSL</span>
            <span className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-green-500" />AUSTRAC registered — AMAX Global</span>
            <span className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-green-500" />AFCA member</span>
          </div>
          <p className="text-center text-xs text-gray-400 mt-2">Wholesale clients only</p>
        </div>
      </section>

      <section className="py-16 bg-gray-50 border-b">
        <div className="max-w-7xl mx-auto px-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 text-center">
            <div>
              <p className="text-3xl font-bold text-gray-900">$4.8M+</p>
              <p className="text-sm text-gray-500 mt-1">Assets under reporting</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-gray-900">5</p>
              <p className="text-sm text-gray-500 mt-1">Investment products</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-gray-900">3</p>
              <p className="text-sm text-gray-500 mt-1">Asset classes</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-gray-900">Tier 2</p>
              <p className="text-sm text-gray-500 mt-1">Verification tier</p>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-gray-900 mb-4">Platform Capabilities</h2>
            <p className="text-gray-600 max-w-2xl mx-auto">
              A secure, regulated environment for managing cross-border wealth across multiple asset classes and currencies.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              {
                icon: BarChart3, bg: "bg-sky-100", fg: "text-blue-600",
                title: "Portfolio dashboard",
                desc: "Consolidated view of all holdings across fiat, digital assets, and structured investments with indicative valuations and performance metrics.",
                link: "Reporting only"
              },
              {
                icon: Building2, bg: "bg-amber-100", fg: "text-amber-600",
                title: "Investment products",
                desc: "Structured investment access via real estate, equity, corporate credit, and digital asset products. All products are available to wholesale investors only.",
                link: "Wholesale only"
              },
              {
                icon: TrendingUp, bg: "bg-green-100", fg: "text-green-600",
                title: "General market insights",
                desc: "Market commentary, portfolio analytics, and general information to help you understand market conditions. General information only — not personal financial advice.",
                link: "General info only"
              },
              {
                icon: FileText, bg: "bg-purple-100", fg: "text-purple-600",
                title: "Statement of Advice",
                desc: "Personalised advice delivered through a formal SOA prepared by your licensed adviser. Required before any personal investment recommendations are acted upon.",
                link: "AFSL regulated"
              },
              {
                icon: Globe, bg: "bg-teal-100", fg: "text-teal-600",
                title: "FX exchange",
                desc: "Multi-currency FX conversion executed via AMAX Global Pty Ltd (AUSTRAC registered). Payments and settlement are handled by AMAX Global — separate from the wealth platform.",
                link: "AMAX Global"
              },
              {
                icon: Shield, bg: "bg-slate-100", fg: "text-slate-600",
                title: "Compliance centre",
                desc: "KYC, AML screening, wholesale investor verification, and regulatory documents — all in one place. Maintains your compliance status and audit trail.",
                link: "Always current"
              },
            ].map((item) => (
              <Card key={item.title} className="border-0 shadow-lg">
                <CardContent className="p-8">
                  <div className={`w-12 h-12 ${item.bg} rounded-xl flex items-center justify-center mb-6`}>
                    <item.icon className={`w-6 h-6 ${item.fg}`} />
                  </div>
                  <h3 className="text-xl font-semibold text-gray-900 mb-3">{item.title}</h3>
                  <p className="text-gray-600 text-sm mb-3">{item.desc}</p>
                  <p className="text-xs text-gray-400 italic">{item.link}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 bg-gray-50" id="how-it-works">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-gray-900 mb-4">How It Works</h2>
            <p className="text-gray-600 max-w-2xl mx-auto">
              A structured onboarding process designed to meet regulatory requirements and ensure 
              suitability before any investment instruction is accepted.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            {[
              { step: "01", icon: Users, title: "Apply & Verify", desc: "Complete identity verification and wholesale investor classification with supporting documentation." },
              { step: "02", icon: FileText, title: "Fact-Find", desc: "Provide your financial situation, objectives, risk tolerance, and investment experience for adviser review." },
              { step: "03", icon: Scale, title: "Advice Record", desc: "Your adviser prepares an advice document tailored to your circumstances. You review and accept before proceeding." },
              { step: "04", icon: TrendingUp, title: "Invest", desc: "Subscribe to investment products through a compliant instruction process with risk acknowledgement." },
            ].map((item) => (
              <div key={item.step} className="text-center">
                <div className="w-16 h-16 bg-white rounded-2xl shadow-md flex items-center justify-center mx-auto mb-6">
                  <item.icon className="w-7 h-7 text-sky-500" />
                </div>
                <div className="text-xs font-bold text-sky-500 mb-2">STEP {item.step}</div>
                <h3 className="text-lg font-semibold text-gray-900 mb-3">{item.title}</h3>
                <p className="text-sm text-gray-600">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-gray-900 mb-4">Investment Products</h2>
            <p className="text-gray-600 max-w-2xl mx-auto">
              Wholesale products — for eligible investors only. All products carry risk of capital loss.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[
              { name: "Real Estate Equity Fund", category: "Real Estate", irr: "Target IRR 8.5% p.a. (indicative)", term: "24 months", min: "$250,000", risk: "Medium" },
              { name: "Corporate Credit Fund", category: "Corporate Credit", irr: "Target IRR 6.2% p.a. (indicative)", term: "18 months", min: "$25,000", risk: "Low" },
              { name: "Bitcoin Tracker Fund", category: "Digital Assets", irr: null, term: "12 months", min: "$25,000", risk: "High" },
            ].map((product) => (
              <Card key={product.name} className="border shadow-sm hover:shadow-md transition-shadow">
                <CardContent className="p-6">
                  <div className="flex items-center justify-between mb-4">
                    <Badge variant="outline" className="text-xs">{product.category}</Badge>
                    <Badge variant={product.risk === "High" ? "destructive" : product.risk === "Medium" ? "default" : "secondary"} className="text-xs">
                      {product.risk} Risk
                    </Badge>
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">{product.name}</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Return</span>
                      <span className="font-medium">{product.irr ?? "Market-linked — highly variable"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Term</span>
                      <span className="font-medium">{product.term}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Minimum</span>
                      <span className="font-medium">{product.min}</span>
                    </div>
                  </div>
                  <p className="text-xs text-gray-400 mt-4">Capital is at risk. {product.irr ? "Past performance is not indicative of future results." : "There is no target return for this product. Total loss is possible."}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 bg-gray-50">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-gray-900 mb-4">Wholesale Investor Eligibility</h2>
            <p className="text-gray-600 max-w-2xl mx-auto">
              Under s761G and s761GA of the Corporations Act 2001, you may qualify as a wholesale investor through any of the following pathways.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl mx-auto">
            {[
              "Net assets of $2.5 million or more",
              "Gross income of $250,000+ for prior 2 financial years",
              "Professional investor (AFSL holder, APRA-regulated body)",
              "Accountant certificate confirming financial threshold",
              "Investment of $500,000+ in the product",
              "SMSF with $10 million+ in assets",
            ].map((item, i) => (
              <div key={i} className="flex items-start gap-3 p-4 bg-white rounded-lg border">
                <CheckCircle2 className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-gray-700">{item}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 bg-sky-50 text-sky-900">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-3xl font-bold mb-4">Ready to apply?</h2>
          <p className="text-sky-700 mb-8">
            If you meet the wholesale investor criteria, apply for access today. Our compliance team will review your 
            application and a licensed adviser will be in touch.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button 
              size="lg" 
              className="bg-sky-500 hover:bg-sky-600 text-white font-semibold"
              onClick={() => navigate("/apply")}
            >
              Apply for Access
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
            <Button 
              size="lg" 
              className="bg-sky-100 text-sky-900 hover:bg-sky-200 font-semibold"
              onClick={() => window.open('tel:+61283201908')}
            >
              <Phone className="w-4 h-4 mr-2" />
              Speak to an adviser
            </Button>
          </div>
          <p className="text-xs text-gray-500 mt-8 max-w-2xl mx-auto">
            By applying you confirm you are an eligible wholesale investor under the Corporations Act 2001 (Cth). Application does not guarantee 
            access. A verification process including KYC, AML screening, and wholesale investor certification is required.
          </p>
        </div>
      </section>

      <footer className="bg-white border-t border-sky-100 text-sky-900 py-16">
        <div className="max-w-7xl mx-auto px-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-12">
            <div>
              <div className="flex items-center gap-3 mb-4">
                <img src={darkBlueLogo} alt="AMAX Wealth" className="w-8 h-8 rounded-lg" />
                <span className="text-lg font-bold text-sky-900">AMAX WEALTH</span>
              </div>
              <p className="text-sm text-sky-900">
                Institutional-grade wealth management for wholesale investors under Australian Financial Services Licence arrangements.
              </p>
            </div>
            <div>
              <h4 className="text-sky-900 font-semibold mb-4">Platform</h4>
              <ul className="space-y-2 text-sm text-sky-900">
                <li><span className="cursor-pointer">Portfolio Reporting</span></li>
                <li><span className="cursor-pointer">Investment Products</span></li>
                <li><span className="cursor-pointer">Market Insights</span></li>
                <li><span className="cursor-pointer">Compliance Centre</span></li>
              </ul>
            </div>
            <div>
              <h4 className="text-sky-900 font-semibold mb-4">Legal</h4>
              <ul className="space-y-2 text-sm text-sky-900">
                <li><span className="cursor-pointer">Financial Services Guide</span></li>
                <li><span className="cursor-pointer">Privacy Policy</span></li>
                <li><span className="cursor-pointer">Terms of Service</span></li>
                <li><span className="cursor-pointer">Risk Disclosure</span></li>
              </ul>
            </div>
            <div>
              <h4 className="text-sky-900 font-semibold mb-4">Contact</h4>
              <ul className="space-y-2 text-sm text-sky-900">
                <li>+61 2 8320 1908</li>
                <li>info@amaxwealth.com.au</li>
                <li className="pt-2">
                  <span className="text-xs">AFCA: 1800 931 678</span>
                </li>
                <li>
                  <span className="text-xs">AFCA Member No: [Member Number]</span>
                </li>
              </ul>
            </div>
          </div>

          <div className="bg-sky-50 border border-sky-100 rounded-lg p-6 mt-8 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-sky-900">
              <div>
                <p className="font-medium text-sky-900 mb-1">AMAX Wealth</p>
                <p>Authorised Representative No. [AR Number] of [AFSL Holder] (AFSL No. [AFSL Number]). ABN: [ABN].</p>
              </div>
              <div>
                <p className="font-medium text-sky-900 mb-1">AMAX Global</p>
                <p>Registered with AUSTRAC as a Digital Currency Exchange and Remittance provider. AUSTRAC Reg: [Registration Number].</p>
              </div>
            </div>
            <p className="text-xs text-sky-900">
              AMAX Wealth does not hold client funds or assets. All positions are maintained with external regulated custodians. 
              This website does not constitute financial advice. Information provided is general in nature and does not take into 
              account your personal circumstances. Before making investment decisions, obtain advice from a qualified financial adviser.
            </p>
            <p className="text-xs text-sky-900">
              © {new Date().getFullYear()} AMAX Wealth. All rights reserved. Australian law applies.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
