import { useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { useAuth } from "@/contexts/auth";
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

// Task #337 — landing page used to hard-code the "featured" product list
// (Real Estate Equity Fund / Corporate Credit Fund / Bitcoin Tracker
// Fund), and the Corporate Credit IRR drifted to 6.2% while the seeded
// product on the shelf and the detail page quoted 10–12%. We now bind
// the same three featured slots to the live `/api/investment-products`
// response so every surface (landing, product shelf, detail page) reads
// the IRR, term, minimum and risk profile from one source.
type LandingProduct = {
  name: string;
  category: string;
  irr: string | null;
  term: string;
  min: string;
  risk: "Low" | "Medium" | "High";
};

const LANDING_FEATURED_NAMES: ReadonlyArray<string> = [
  "Real Estate Equity Fund",
  "Cash Flow-Based Corporate Credit Fund",
  "Bitcoin Tracker Fund",
];

const RISK_LABEL: Record<string, "Low" | "Medium" | "High"> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

function deriveLandingProduct(p: any): LandingProduct {
  const min = parseFloat(p?.minimumInvestment ?? "0");
  return {
    name: p?.name ?? "",
    // Collapse the long shelf names so the landing card stays scannable
    // while still pointing at the same underlying fund.
    category: p?.category === "corporate_credit" ? "Corporate Credit"
      : p?.category === "real_estate" ? "Real Estate"
      : p?.category === "digital_assets" ? "Digital Assets"
      : (p?.category ?? "Investment"),
    irr: p?.targetNetIrr ? `Target IRR ${p.targetNetIrr} (indicative)` : null,
    term: p?.term ?? "—",
    min: Number.isFinite(min) && min > 0 ? `$${min.toLocaleString()}` : "—",
    risk: RISK_LABEL[(p?.riskProfile ?? "").toLowerCase()] ?? "Medium",
  };
}

export default function Landing() {
  const [, navigate] = useLocation();
  const { isAuthenticated } = useAuth();

  // Only verified investors see specific product details (s761G/s761GA),
  // so we mirror that gate on the data fetch. Public visitors see the
  // gated card and never trigger the request.
  const { data: apiProducts } = useQuery<any[]>({
    queryKey: ["/api/investment-products"],
    queryFn: async () => (await apiFetch("/api/investment-products")).json(),
    enabled: isAuthenticated,
  });

  const featuredProducts: LandingProduct[] = useMemo(() => {
    if (!apiProducts) return [];
    return LANDING_FEATURED_NAMES
      .map((name) => apiProducts.find((p) => p?.name === name))
      .filter(Boolean)
      .map(deriveLandingProduct);
  }, [apiProducts]);

  return (
    <div className="min-h-screen bg-white">
      <div
        className="bg-amber-500 border-b-2 border-amber-600 px-4 py-3"
        role="alert"
        data-testid="banner-dev-staging"
      >
        <div className="max-w-7xl mx-auto flex items-start md:items-center justify-center gap-3">
          <AlertTriangle className="w-5 h-5 text-white flex-shrink-0 mt-0.5 md:mt-0" />
          <p className="text-sm md:text-base text-white font-semibold leading-snug text-center">
            Development / staging environment — this platform is not yet live. Do not submit personal,
            financial or identity information. Any data entered here may be wiped without notice.
          </p>
        </div>
      </div>

      <header className="bg-sky-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={darkBlueLogo} alt="AMAX Wealth" className="rounded-lg" style={{ width: "63px", height: "63px", mixBlendMode: "multiply" }} />
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
            <button
              type="button"
              onClick={() => {
                document.getElementById("for-advisers")?.scrollIntoView({ behavior: "smooth" });
              }}
              className="hidden md:inline text-sm text-sky-900 hover:text-sky-700 font-medium"
              data-testid="link-for-advisers"
            >
              For Advisers
            </button>
            <Button className="bg-sky-100 text-sky-900 hover:bg-sky-200 font-semibold" onClick={() => navigate("/login")}>
              Sign In
            </Button>
            <Button
              className="bg-sky-500 hover:bg-sky-600 text-white font-semibold"
              onClick={() => navigate("/apply")}
              data-testid="button-header-apply"
            >
              Apply for access
            </Button>
          </div>
        </div>
      </header>

      <section className="bg-sky-50 text-sky-900">
        <div className="max-w-7xl mx-auto px-6 py-24 md:py-32">
          <div className="max-w-3xl">
            <Badge className="bg-white/10 text-sky-900 border-white/20 mb-6">
              AFSL authorisation pending
            </Badge>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold leading-tight mb-6">
              A modern wealth platform for investors and financial planners
            </h1>
            <p className="text-lg md:text-xl text-sky-700 mb-8 max-w-2xl">
              Eligible Australian investors access portfolio tools, FX, digital assets and curated
              investment opportunities. Authorised representatives view linked-client portfolios and
              advice records, and browse the AMAX product shelf — read-only today, with consent-gated
              instruction workflows on the roadmap.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Button
                size="lg"
                className="bg-sky-500 hover:bg-sky-600 text-white font-semibold"
                onClick={() => navigate("/login")}
                data-testid="button-hero-investor"
              >
                I am an Investor
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
              <Button
                size="lg"
                className="bg-sky-900 hover:bg-sky-950 text-white font-semibold"
                onClick={() => {
                  document.getElementById("for-advisers")?.scrollIntoView({ behavior: "smooth" });
                }}
                data-testid="button-hero-adviser"
              >
                Wealth Planner (AFSL / AR only)
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="border-sky-300 text-sky-900 hover:bg-sky-100 font-semibold bg-transparent"
                onClick={() => {
                  document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" });
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
          <div className="flex flex-wrap items-center justify-center gap-4 text-xs text-gray-500" data-testid="trust-strip">
            <span className="flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5 text-amber-500" />AFSL authorisation — pending</span>
            <span className="flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5 text-amber-500" />AUSTRAC registration — pending</span>
            <span className="flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5 text-amber-500" />AFCA membership — pending</span>
          </div>
          <p className="text-center text-xs text-gray-400 mt-2">Intended for eligible Australian investors and authorised representatives once licensing is finalised.</p>
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
          <p className="text-center text-xs text-gray-500 mt-6 italic" data-testid="text-stats-disclaimer">
            Figures are illustrative. Actual platform AUM is not disclosed publicly.
          </p>
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
                desc: "Market commentary and portfolio analytics — published as general information only. Personal investment recommendations are delivered separately, by your licensed adviser, in a Statement of Advice.",
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
                desc: "Multi-currency FX conversion is intended to be executed via AMAX Global Pty Ltd (AUSTRAC registration pending). Payments and settlement are handled by AMAX Global — separate from the wealth platform.",
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

      <section className="py-20 bg-sky-900 text-white" id="for-advisers">
        <div className="max-w-7xl mx-auto px-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <div>
              <Badge className="bg-white/10 text-white border-white/20 mb-6">
                For Wealth Planners & AFSL Partners
              </Badge>
              <h2 className="text-3xl md:text-4xl font-bold mb-4">
                A platform layer for external advisers and authorised representatives
              </h2>
              <p className="text-sky-100 mb-4">
                View linked-client portfolios, KYC and advice-record status, and
                browse the AMAX product shelf — under your AFSL or as an Authorised
                Representative on the AMAX licence. Instruction and fee-consent
                workflows are coming in subsequent releases.
              </p>
              <div className="bg-amber-500/20 border border-amber-300/40 rounded-md p-3 mb-8 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-200 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-amber-50">
                  <strong>Credential-gated.</strong> Adviser access requires a current AFSL or AR
                  authorisation. There is no self-registration — onboarding is manually approved
                  by AMAX compliance. Retail clients should use the investor flow above.
                </p>
              </div>
              <ul className="space-y-3 mb-8 text-sm text-sky-100">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-5 h-5 text-sky-300 flex-shrink-0 mt-0.5" />
                  <span>Linked-client overlay: portfolio, KYC, advice-record visibility</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-5 h-5 text-sky-300 flex-shrink-0 mt-0.5" />
                  <span>Read-only product shelf with target IRR, term, structure and minimums</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-5 h-5 text-sky-300 flex-shrink-0 mt-0.5" />
                  <span>Audit log on every adviser write — read-only access to client state today</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-5 h-5 text-sky-300 flex-shrink-0 mt-0.5" />
                  <span>DBFO-aligned design: instruction + fee-consent workflows on the roadmap</span>
                </li>
              </ul>
              <div className="flex flex-col sm:flex-row gap-3">
                <Button
                  size="lg"
                  className="bg-white text-sky-900 hover:bg-sky-50 font-semibold"
                  onClick={() => navigate("/login")}
                  data-testid="button-adviser-signin"
                >
                  Adviser Sign In (AFSL / AR)
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="border-white/30 text-white hover:bg-white/10 hover:text-white font-semibold bg-transparent"
                  onClick={() => window.open("mailto:advisers@amaxwealth.com.au")}
                  data-testid="button-adviser-contact"
                >
                  Request adviser onboarding (credentials required)
                </Button>
              </div>
            </div>
            <div className="bg-sky-800/50 border border-sky-700 rounded-lg p-8">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 bg-sky-500 rounded-lg flex items-center justify-center">
                  <Users className="w-5 h-5 text-white" />
                </div>
                <div>
                  <p className="font-semibold">Adviser portal</p>
                  <p className="text-xs text-sky-300">Authorised representatives only</p>
                </div>
              </div>
              <div className="space-y-4 text-sm">
                <div className="flex items-start gap-3">
                  <Shield className="w-4 h-4 text-sky-300 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">RG 175 chokepoints</p>
                    <p className="text-sky-200 text-xs">
                      No execution against client money without explicit client consent.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <FileText className="w-4 h-4 text-sky-300 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">DBFO fee consent</p>
                    <p className="text-sky-200 text-xs">
                      Every fee deduction backed by an active fee-consent record.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Scale className="w-4 h-4 text-sky-300 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">Audit-by-default</p>
                    <p className="text-sky-200 text-xs">
                      Every adviser write is captured in the immutable audit log.
                    </p>
                  </div>
                </div>
              </div>
              <p className="text-xs text-sky-300 mt-6 pt-6 border-t border-sky-700">
                Adviser access is granted per-client via the AMAX onboarding flow.
                Contact us to discuss adviser onboarding under your AFSL.
              </p>
            </div>
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
          {isAuthenticated ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {featuredProducts.map((product) => (
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
          ) : (
            <div className="max-w-2xl mx-auto" data-testid="card-products-gated">
              <Card className="border-2 border-sky-200 bg-sky-50/40 shadow-sm">
                <CardContent className="p-8 text-center">
                  <div className="w-14 h-14 bg-sky-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Lock className="w-7 h-7 text-sky-700" />
                  </div>
                  <h3 className="text-xl font-semibold text-sky-900 mb-3">
                    Product details are restricted to verified wholesale investors
                  </h3>
                  <p className="text-sm text-gray-700 mb-2">
                    Target returns, terms, minimum investment amounts and risk ratings for our
                    Real Estate Equity Fund, Corporate Credit Fund and Bitcoin Tracker Fund are
                    not disclosed publicly. Under s761G / s761GA of the Corporations Act 2001 (Cth),
                    these products may only be offered to wholesale investors.
                  </p>
                  <p className="text-xs text-gray-500 mb-6">
                    Sign in if you already have an approved account, or apply for access to start
                    wholesale-investor verification.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-3 justify-center">
                    <Button
                      className="bg-sky-500 hover:bg-sky-600 text-white font-semibold"
                      onClick={() => navigate("/apply")}
                      data-testid="button-products-apply"
                    >
                      Apply for access
                      <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                    <Button
                      variant="outline"
                      className="border-sky-300 text-sky-900 hover:bg-sky-100 font-semibold bg-transparent"
                      onClick={() => navigate("/login")}
                      data-testid="button-products-signin"
                    >
                      Sign in
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
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
                <li>Phone: +61 2 8320 1908</li>
                <li>Email: info@amaxwealth.com.au</li>
              </ul>
              <div className="mt-5 pt-4 border-t border-sky-100 space-y-2 text-sm text-sky-900">
                <p className="text-xs font-semibold text-sky-900 uppercase tracking-wider mb-1">
                  External dispute resolution
                </p>
                <p data-testid="text-afca-helpline">
                  AFCA helpline: <span className="font-medium">1800 931 678</span>
                </p>
                <p data-testid="text-afca-member">
                  AMAX AFCA Member No:{" "}
                  <span className="font-medium">Pending — not yet issued</span>
                </p>
              </div>
            </div>
          </div>

          <div className="bg-amber-50 border-2 border-amber-300 rounded-lg p-3 mt-8 text-xs text-amber-900">
            <span className="font-semibold">Draft — regulatory details pending.</span>{" "}
            AMAX Wealth's AFSL authorisation, AR number, ABN, AFCA membership and AUSTRAC registration
            are not yet issued. Final legal review and AFSL partner sign-off are required before
            external use of this site.
          </div>

          <div className="bg-sky-50 border border-sky-100 rounded-lg p-6 mt-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-sky-900">
              <div>
                <p className="font-medium text-sky-900 mb-1">AMAX Wealth</p>
                <p>
                  Authorised Representative number: Pending — not yet issued. AFSL authorisation:
                  Pending — not yet issued. ABN: Pending — not yet issued.
                </p>
              </div>
              <div>
                <p className="font-medium text-sky-900 mb-1">AMAX Global</p>
                <p>
                  Intended to operate as a Digital Currency Exchange and Remittance provider
                  registered with AUSTRAC. AUSTRAC registration: Pending — not yet issued.
                </p>
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
