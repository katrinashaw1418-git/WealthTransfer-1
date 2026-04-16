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
import darkBlueLogo from "@assets/DARK_BLUE_LOGO_1776310673148.jpg";

export default function Landing() {
  const [, navigate] = useLocation();

  return (
    <div className="min-h-screen bg-white">
      <div className="bg-slate-900 px-4 py-2">
        <div className="max-w-7xl mx-auto flex items-center justify-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
          <p className="text-xs text-slate-300">
            <strong>Notice:</strong> This website is currently under development. Features and content are subject to change.
          </p>
        </div>
      </div>

      <header className="bg-slate-900">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={darkBlueLogo} alt="AMAX Wealth" className="w-10 h-10 rounded-lg" />
            <div>
              <span className="text-xl font-bold text-white">AMAX WEALTH</span>
              <p className="text-xs text-slate-400">Investments / Advice</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <a href="tel:+61283201908" className="hidden md:flex items-center gap-2 text-sm text-slate-300 hover:text-white">
              <Phone className="w-4 h-4" />
              +61 2 8320 1908
            </a>
            <Button className="bg-slate-700 text-white hover:bg-slate-600 font-semibold" onClick={() => navigate("/login")}>
              Sign In
            </Button>
            <Button className="bg-amber-500 hover:bg-amber-400 text-white font-semibold" onClick={() => navigate("/login")}>
              Apply for Access
            </Button>
          </div>
        </div>
      </header>

      <section className="bg-slate-900 text-white">
        <div className="max-w-7xl mx-auto px-6 py-24 md:py-32">
          <div className="max-w-3xl">
            <Badge className="bg-white/10 text-white border-white/20 mb-6">
              Authorised Representative under AFSL
            </Badge>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold leading-tight mb-6">
              Institutional-grade wealth management for wholesale investors
            </h1>
            <p className="text-lg md:text-xl text-slate-300 mb-8 max-w-2xl">
              Consolidated portfolio reporting, structured investment access, and advisory services — 
              delivered through a secure, compliance-first platform.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Button 
                size="lg" 
                className="bg-amber-500 hover:bg-amber-400 text-white font-semibold"
                onClick={() => navigate("/login")}
              >
                Apply for Access
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
              <Button 
                size="lg" 
                className="bg-slate-700 text-white hover:bg-slate-600 font-semibold"
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

      <section className="py-16 bg-gray-50 border-b">
        <div className="max-w-7xl mx-auto px-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 text-center">
            <div>
              <p className="text-3xl font-bold text-gray-900">$4.8M+</p>
              <p className="text-sm text-gray-500 mt-1">Assets Under Reporting</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-gray-900">7</p>
              <p className="text-sm text-gray-500 mt-1">Currencies Supported</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-gray-900">5</p>
              <p className="text-sm text-gray-500 mt-1">Investment Products</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-gray-900">AFSL</p>
              <p className="text-sm text-gray-500 mt-1">Regulated Framework</p>
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
            <Card className="border-0 shadow-lg">
              <CardContent className="p-8">
                <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center mb-6">
                  <BarChart3 className="w-6 h-6 text-blue-600" />
                </div>
                <h3 className="text-xl font-semibold text-gray-900 mb-3">Consolidated Reporting</h3>
                <p className="text-gray-600">
                  View all positions across fiat currencies, digital assets, and structured investments 
                  in a single portfolio view. All values are indicative, sourced from external custodians.
                </p>
              </CardContent>
            </Card>
            <Card className="border-0 shadow-lg">
              <CardContent className="p-8">
                <div className="w-12 h-12 bg-amber-100 rounded-xl flex items-center justify-center mb-6">
                  <Building2 className="w-6 h-6 text-amber-600" />
                </div>
                <h3 className="text-xl font-semibold text-gray-900 mb-3">Structured Products</h3>
                <p className="text-gray-600">
                  Access real estate, corporate credit, and digital asset investment products through 
                  a compliant subscription process with full risk disclosure.
                </p>
              </CardContent>
            </Card>
            <Card className="border-0 shadow-lg">
              <CardContent className="p-8">
                <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center mb-6">
                  <Shield className="w-6 h-6 text-green-600" />
                </div>
                <h3 className="text-xl font-semibold text-gray-900 mb-3">Compliance-First</h3>
                <p className="text-gray-600">
                  Built under Australian Financial Services Licence arrangements with AFCA membership, 
                  KYC/AML verification, and full audit trail for all transactions.
                </p>
              </CardContent>
            </Card>
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
                  <item.icon className="w-7 h-7 text-amber-600" />
                </div>
                <div className="text-xs font-bold text-amber-500 mb-2">STEP {item.step}</div>
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
              { name: "Real Estate Equity Fund", category: "Real Estate", irr: "Target indicative: 8.5%", term: "24 months", min: "$250,000", risk: "Medium" },
              { name: "Corporate Credit Fund", category: "Corporate Credit", irr: "Target indicative: 6.2%", term: "18 months", min: "$25,000", risk: "Low" },
              { name: "Digital Asset Allocation", category: "Digital Assets", irr: "Market-linked (variable)", term: "12 months", min: "$25,000", risk: "High" },
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
                      <span className="font-medium">{product.irr}</span>
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
                  <p className="text-xs text-gray-400 mt-4">Capital is at risk. Past performance is not indicative of future results.</p>
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

      <section className="py-20 bg-slate-900 text-white">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-3xl font-bold mb-4">Ready to get started?</h2>
          <p className="text-slate-300 mb-8">
            Apply for access to the AMAX Wealth platform. Our team will guide you through 
            the verification and onboarding process.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button 
              size="lg" 
              className="bg-amber-500 hover:bg-amber-400 text-white font-semibold"
              onClick={() => navigate("/login")}
            >
              Apply for Access
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
            <Button 
              size="lg" 
              className="bg-slate-700 text-white hover:bg-slate-600 font-semibold"
              onClick={() => window.open('tel:+61283201908')}
            >
              <Phone className="w-4 h-4 mr-2" />
              Call +61 2 8320 1908
            </Button>
          </div>
        </div>
      </section>

      <footer className="bg-slate-950 text-slate-400 py-16">
        <div className="max-w-7xl mx-auto px-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-12">
            <div>
              <div className="flex items-center gap-3 mb-4">
                <img src={darkBlueLogo} alt="AMAX Wealth" className="w-8 h-8 rounded-lg" />
                <span className="text-lg font-bold text-white">AMAX WEALTH</span>
              </div>
              <p className="text-sm">
                Institutional-grade wealth management for wholesale investors under Australian Financial Services Licence arrangements.
              </p>
            </div>
            <div>
              <h4 className="text-white font-semibold mb-4">Platform</h4>
              <ul className="space-y-2 text-sm">
                <li><span className="hover:text-white cursor-pointer">Portfolio Reporting</span></li>
                <li><span className="hover:text-white cursor-pointer">Investment Products</span></li>
                <li><span className="hover:text-white cursor-pointer">Market Insights</span></li>
                <li><span className="hover:text-white cursor-pointer">Compliance Centre</span></li>
              </ul>
            </div>
            <div>
              <h4 className="text-white font-semibold mb-4">Legal</h4>
              <ul className="space-y-2 text-sm">
                <li><span className="hover:text-white cursor-pointer">Financial Services Guide</span></li>
                <li><span className="hover:text-white cursor-pointer">Privacy Policy</span></li>
                <li><span className="hover:text-white cursor-pointer">Terms of Service</span></li>
                <li><span className="hover:text-white cursor-pointer">Risk Disclosure</span></li>
              </ul>
            </div>
            <div>
              <h4 className="text-white font-semibold mb-4">Contact</h4>
              <ul className="space-y-2 text-sm">
                <li>+61 2 8320 1908</li>
                <li>info@amaxwealth.com.au</li>
                <li className="pt-2">
                  <span className="text-xs">AFCA: 1800 931 678</span>
                </li>
              </ul>
            </div>
          </div>

          <div className="border-t border-slate-800 pt-8 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div>
                <p className="font-medium text-slate-300 mb-1">AMAX Wealth</p>
                <p>Authorised Representative No. [AR Number] of [AFSL Holder] (AFSL No. [AFSL Number]). ABN: [ABN].</p>
              </div>
              <div>
                <p className="font-medium text-slate-300 mb-1">AMAX Global</p>
                <p>Registered with AUSTRAC as a Digital Currency Exchange and Remittance provider. AUSTRAC Reg: [Registration Number].</p>
              </div>
            </div>
            <p className="text-xs text-slate-500">
              AMAX Wealth does not hold client funds or assets. All positions are maintained with external regulated custodians. 
              This website does not constitute financial advice. Information provided is general in nature and does not take into 
              account your personal circumstances. Before making investment decisions, obtain advice from a qualified financial adviser.
            </p>
            <p className="text-xs text-slate-600">
              © {new Date().getFullYear()} AMAX Wealth. All rights reserved. Australian law applies.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
