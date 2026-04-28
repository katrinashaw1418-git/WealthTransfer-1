// =============================================================================
// CANONICAL ADVISER PRODUCT CATALOGUE
// -----------------------------------------------------------------------------
// Single source of truth for the 14-product adviser shelf. Previously the same
// list was hand-copied into three places — `scripts/seed-missing-products.ts`,
// `scripts/cleanup-product-shelf.ts`, and the `MemStorage` demo block in
// `server/storage.ts` — which let the shelf silently drift back to mixed-case
// risk labels, FDIC text, or other compliance issues whenever someone updated
// one copy and forgot the others. All three consumers now import from this
// module instead.
//
// Field formatting conventions (enforced by `findCatalogueViolations` below
// and the matching vitest in `shared/product-catalogue.test.ts`):
//   - riskProfile: canonical lowercase enum key from shared/risk-profiles.ts
//     ("low" | "conservative" | "moderate" | "high" | "very_high"). The
//     adviser suitability check (`server/services/adviser-access.ts`) and
//     the investments page filter both compare against these keys, so any
//     drift to sentence-case strings ("High", "Very High") silently breaks
//     the suitability rule and the risk filter.
//   - targetNetIrr: ranges with en dash, "p.a." suffix on numeric returns,
//     no tilde, no trailing word "target". Bitcoin uses non-numeric label.
//   - term / structure / distributions / liquidity: short labels, en dashes
//     for ranges, no tilde (~) shorthand for "approximately".
//   - No "FDIC" anywhere. The Australian platform uses the Financial Claims
//     Scheme (FCS); FDIC is the unrelated US scheme and would be a
//     compliance issue if it appeared on the adviser shelf.
//
// Adding a new product? Add it to PRODUCT_CATALOGUE below. The cleanliness
// vitest will fail in CI if the new entry uses any of the banned formats,
// and the seed/cleanup/MemStorage paths will pick up the addition for free.
// =============================================================================

import {
  type KnownProductCategory,
  PRODUCT_CATEGORY_VALUES,
} from "./product-categories";
import {
  type KnownRiskProfile,
  RISK_PROFILE_KEYS,
} from "./risk-profiles";

export type CatalogueReturnType =
  | "income"
  | "capital_gains"
  | "blended"
  | "yield";

export interface CatalogueProduct {
  name: string;
  category: KnownProductCategory;
  subCategory: string;
  investmentStrategy: string;
  targetNetIrr: string;
  grossIrr?: string | null;
  moic?: string | null;
  term: string;
  structure: string;
  distributions: string;
  liquidity: string;
  minimumInvestment: string;
  riskProfile: KnownRiskProfile;
  returnType: CatalogueReturnType;
  lvr?: string | null;
  isActive: boolean;
}

export const PRODUCT_CATALOGUE: readonly CatalogueProduct[] = [
  {
    name: "Real Estate Equity Fund",
    category: "real_estate",
    subCategory: "equity_fund",
    investmentStrategy:
      "Structured equity and mezzanine capital deployed into residential and mixed-use development projects, primarily through preferred equity or subordinated positions. Focus on downside protection (typ. 60–70% LVR), co-investment alignment with developers, and disciplined feasibility validation.",
    targetNetIrr: "9.8–11.0% p.a.",
    term: "2–6 years",
    structure: "Preferred equity / subordinated debt",
    distributions: "Quarterly",
    liquidity: "Fixed-term, no early redemptions",
    minimumInvestment: "250000.00",
    riskProfile: "high",
    returnType: "capital_gains",
    lvr: "40–80% (typ. ~70%)",
    isActive: true,
  },
  {
    name: "Real Estate Credit Fund",
    category: "real_estate",
    subCategory: "credit_fund",
    investmentStrategy:
      "Diversified exposure to senior and subordinated real estate-backed loans for land subdivisions and construction financing. Provides regular income and controlled exposure across multiple projects and geographies.",
    targetNetIrr: "10.5–11.5% p.a.",
    term: "9–12 months",
    structure: "Real estate-backed loans (rolling portfolio)",
    distributions: "Quarterly",
    liquidity: "Quarterly redemptions (5% NAV cap)",
    minimumInvestment: "100000.00",
    riskProfile: "moderate",
    returnType: "income",
    lvr: "68%",
    isActive: true,
  },
  {
    name: "Real Estate First Mortgage Fund",
    category: "real_estate",
    subCategory: "first_mortgage",
    investmentStrategy:
      "First-ranking mortgage finance to conservative, well-prepared property projects with tight controls, strong fundamentals, and regular servicing income.",
    targetNetIrr: "8.5–9.5% p.a.",
    term: "9–10 months",
    structure: "First-ranking mortgage",
    distributions: "Quarterly",
    liquidity: "Quarterly redemption",
    minimumInvestment: "50000.00",
    riskProfile: "moderate",
    returnType: "income",
    lvr: "64%",
    isActive: true,
  },
  {
    name: "Cash Flow-Based Corporate Credit Fund",
    category: "corporate_credit",
    subCategory: "cash_flow_credit",
    investmentStrategy:
      "Secured senior lending to companies with strong recurring revenue and positive EBITDA. Terms are tailored to enterprise value and cash flow serviceability, not fixed asset security.",
    targetNetIrr: "10–12% p.a.",
    term: "2–3 years",
    structure: "First lien amortising loan",
    distributions: "Monthly",
    liquidity: "Locked term",
    minimumInvestment: "100000.00",
    riskProfile: "moderate",
    returnType: "income",
    isActive: true,
  },
  {
    name: "Security-Backed Corporate Credit Fund",
    category: "corporate_credit",
    subCategory: "security_backed_credit",
    investmentStrategy:
      "Senior secured loans combined with equity warrants and downside protection via put rights. Structured for both income and potential capital appreciation.",
    targetNetIrr: "12–15% p.a.",
    term: "30–39 months",
    structure: "Senior lien loan + equity warrants",
    distributions: "Quarterly + At exit",
    liquidity: "Locked term",
    minimumInvestment: "150000.00",
    riskProfile: "moderate",
    returnType: "blended",
    isActive: true,
  },
  {
    name: "VC / Growth Equity Fund",
    category: "venture_capital",
    subCategory: "growth_equity",
    investmentStrategy:
      "Equity investments into founder-led and management-aligned private companies with growth potential. Structured for long-term capital gains with governance protections and value creation support.",
    targetNetIrr: "16–20% p.a.",
    grossIrr: "22–25%",
    moic: "3–4x",
    term: "5–7 years",
    structure: "Equity investment",
    distributions: "At exit",
    liquidity: "Illiquid / long-term lock-in",
    minimumInvestment: "500000.00",
    riskProfile: "high",
    returnType: "capital_gains",
    isActive: true,
  },
  {
    name: "Hybrid Capital Fund",
    category: "venture_capital",
    subCategory: "hybrid_capital",
    investmentStrategy:
      "Structured equity capital with partial cash or PIK returns, plus participation in equity upside. Designed for companies that require non-dilutive growth capital with income and total return alignment.",
    targetNetIrr: "12–16% p.a.",
    term: "3–5 years",
    structure: "Convertible preferred or structured equity",
    distributions: "Quarterly + At exit",
    liquidity: "Locked term",
    minimumInvestment: "250000.00",
    riskProfile: "high",
    returnType: "blended",
    isActive: true,
  },
  {
    name: "Bitcoin Tracker Fund",
    category: "digital_assets",
    subCategory: "bitcoin_tracker",
    investmentStrategy:
      "Passive exposure to the price performance of Bitcoin through a regulated, institutionally structured fund with professional custody and institutional-grade security. Features quarterly rebalancing, tax-efficient structure, and direct Bitcoin exposure without operational complexities.",
    targetNetIrr: "Market-linked — no target return",
    term: "Open-ended",
    structure: "Regulated passive tracker fund (quarterly liquidity)",
    distributions: "None",
    liquidity: "Quarterly",
    minimumInvestment: "25000.00",
    riskProfile: "very_high",
    returnType: "capital_gains",
    isActive: true,
  },
  {
    name: "Web3 Innovation Fund",
    category: "digital_assets",
    subCategory: "token_fund",
    investmentStrategy:
      "Strategic investments in pre-launch tokens and early-stage Web3 projects including DeFi protocols, NFT platforms, and infrastructure tokens. Features professional due diligence, strategic partnerships, and institutional-grade token custody with structured unlock schedules.",
    targetNetIrr: "30–50% p.a.",
    grossIrr: "40–60%",
    moic: "5–10x",
    term: "3–5 years",
    structure: "Hybrid venture + token allocation fund",
    distributions: "Quarterly",
    liquidity: "Illiquid",
    minimumInvestment: "250000.00",
    riskProfile: "very_high",
    returnType: "capital_gains",
    isActive: true,
  },
  {
    name: "Diversified Crypto Fund",
    category: "digital_assets",
    subCategory: "blockchain_fund",
    investmentStrategy:
      "Institutional-grade diversified exposure across the crypto ecosystem including blue-chip cryptocurrencies (40%), DeFi protocols (25%), infrastructure tokens (20%), and emerging opportunities (15%). Features active management, risk controls, and institutional custody.",
    targetNetIrr: "25–35% p.a.",
    grossIrr: "30–40%",
    moic: "2.5–4x",
    term: "Open-ended",
    structure: "Multi-strategy diversified fund (3-year recommended hold)",
    distributions: "Semi-annual",
    liquidity: "Quarterly",
    minimumInvestment: "50000.00",
    riskProfile: "high",
    returnType: "blended",
    isActive: true,
  },
  {
    name: "Ethereum Staking Fund",
    category: "digital_assets",
    subCategory: "staking_fund",
    investmentStrategy:
      "Professional Ethereum staking service offering institutional-grade ETH2.0 staking with automated validator management, slashing protection, and optimal reward distribution. Features liquid staking tokens, professional custody, and consistent yield generation.",
    targetNetIrr: "4.5–7% p.a.",
    grossIrr: "5–8%",
    term: "Open-ended",
    structure: "Liquid staking fund",
    distributions: "Monthly",
    liquidity: "Daily",
    minimumInvestment: "10000.00",
    riskProfile: "moderate",
    returnType: "income",
    isActive: true,
  },
  {
    name: "High-Yield Savings Account",
    category: "cash_deposit",
    subCategory: "savings_account",
    investmentStrategy:
      "FCS-protected high-yield savings account offering competitive interest rates for idle funds. ADI-issued deposit, covered up to $250,000 per ADI under the Financial Claims Scheme. Features instant access, no minimum balance requirements, and automated daily interest accrual with monthly compounding.",
    targetNetIrr: "4.5–5.5% p.a.",
    term: "Open-ended",
    structure:
      "ADI-issued savings deposit · FCS-protected (covered up to $250,000 per ADI under the Financial Claims Scheme)",
    distributions: "Daily accrual",
    liquidity: "Instant access (T+0)",
    minimumInvestment: "0.00",
    riskProfile: "low",
    returnType: "yield",
    isActive: true,
  },
  {
    name: "Money Market Sweep Fund",
    category: "cash_deposit",
    subCategory: "money_market",
    investmentStrategy:
      "Institutional-grade money market fund providing enhanced yields through T-bills, commercial paper, and repo markets. Features professional treasury management with same-day liquidity and government-backed security.",
    targetNetIrr: "3.8–4.8% p.a.",
    term: "Open-ended",
    structure:
      "Registered money market fund · Not an ADI deposit, not FCS-protected",
    distributions: "Daily accrual",
    liquidity: "Same-day settlement (T+0)",
    minimumInvestment: "1000.00",
    riskProfile: "low",
    returnType: "yield",
    isActive: true,
  },
  {
    name: "Premium Treasury Deposit",
    category: "cash_deposit",
    subCategory: "treasury_deposit",
    investmentStrategy:
      "Premium ADI-issued deposit product backed by Australian government securities offering superior yields for larger balances. Features tiered interest rates and notice-based liquidity for sophisticated treasury management.",
    targetNetIrr: "2.5–3.5% p.a.",
    term: "Open-ended",
    structure:
      "ADI-issued term deposit · FCS-protected (covered up to $250,000 per ADI under the Financial Claims Scheme) · 30-day notice",
    distributions: "Daily accrual",
    liquidity: "Next-day access (T+1)",
    minimumInvestment: "10000.00",
    riskProfile: "low",
    returnType: "yield",
    isActive: true,
  },
];

export const PRODUCT_CATALOGUE_NAMES: readonly string[] = PRODUCT_CATALOGUE.map(
  (p) => p.name,
);

// =============================================================================
// CLEANLINESS CHECK
// -----------------------------------------------------------------------------
// Detects the four classes of compliance/formatting drift that have re-appeared
// historically when product copies were edited in isolation. The vitest in
// `shared/product-catalogue.test.ts` runs `findCatalogueViolations` against
// `PRODUCT_CATALOGUE` on every CI run and fails the build if anything slips
// through.
// =============================================================================

export type CatalogueViolationRule =
  | "tilde"
  | "fdic"
  | "non-canonical-risk-profile"
  | "missing-pa-suffix";

export interface CatalogueViolation {
  productName: string;
  field: string;
  rule: CatalogueViolationRule;
  value: string;
  message: string;
}

// Fields where a tilde would be the "approximately" shorthand we explicitly
// disallow on the user-visible product summary. `lvr` and `investmentStrategy`
// are intentionally excluded: the LVR field carries operator-curated ranges
// like "40–80% (typ. ~70%)" where the tilde communicates a typical mid-point,
// and the long-form strategy paragraph is a free-text marketing description.
const TILDE_BANNED_FIELDS: readonly (keyof CatalogueProduct)[] = [
  "name",
  "targetNetIrr",
  "grossIrr",
  "moic",
  "term",
  "structure",
  "distributions",
  "liquidity",
];

// FDIC is a US scheme; this Australian platform uses the FCS. An FDIC mention
// in any text-bearing field would be a compliance issue, so the check covers
// every textual field including the long-form strategy and the lvr line.
const FDIC_BANNED_FIELDS: readonly (keyof CatalogueProduct)[] = [
  "name",
  "investmentStrategy",
  "targetNetIrr",
  "grossIrr",
  "moic",
  "term",
  "structure",
  "distributions",
  "liquidity",
  "lvr",
];

const HAS_DIGIT = /\d/;
const ENDS_WITH_PA = /p\.a\.$/;
const TILDE = "~";
// Case-insensitive: "FDIC", "fdic", and "Fdic" are all blocked. The
// Australian platform always uses the FCS (Financial Claims Scheme); any
// casing of "FDIC" indicates either a copy-paste from US documentation or a
// compliance error.
const FDIC_PATTERN = /\bfdic\b/i;

function getFieldValue(
  product: CatalogueProduct,
  field: keyof CatalogueProduct,
): string | null {
  const v = product[field];
  return typeof v === "string" ? v : null;
}

export function findCatalogueViolations(
  catalogue: readonly CatalogueProduct[] = PRODUCT_CATALOGUE,
): CatalogueViolation[] {
  const violations: CatalogueViolation[] = [];

  for (const p of catalogue) {
    for (const field of TILDE_BANNED_FIELDS) {
      const value = getFieldValue(p, field);
      if (value !== null && value.includes(TILDE)) {
        violations.push({
          productName: p.name,
          field: String(field),
          rule: "tilde",
          value,
          message: `${p.name}.${String(field)} contains a tilde ("~"). Use a precise figure or the word "approximately" instead.`,
        });
      }
    }

    for (const field of FDIC_BANNED_FIELDS) {
      const value = getFieldValue(p, field);
      if (value !== null && FDIC_PATTERN.test(value)) {
        violations.push({
          productName: p.name,
          field: String(field),
          rule: "fdic",
          value,
          message: `${p.name}.${String(field)} mentions "FDIC". The Australian platform uses the FCS (Financial Claims Scheme), not the US FDIC scheme.`,
        });
      }
    }

    if (!RISK_PROFILE_KEYS.includes(p.riskProfile)) {
      violations.push({
        productName: p.name,
        field: "riskProfile",
        rule: "non-canonical-risk-profile",
        value: String(p.riskProfile),
        message: `${p.name}.riskProfile is "${String(p.riskProfile)}". Must be one of: ${RISK_PROFILE_KEYS.join(", ")} (canonical lowercase keys from shared/risk-profiles.ts).`,
      });
    }

    const irr = p.targetNetIrr.trim();
    if (HAS_DIGIT.test(irr) && !ENDS_WITH_PA.test(irr)) {
      violations.push({
        productName: p.name,
        field: "targetNetIrr",
        rule: "missing-pa-suffix",
        value: p.targetNetIrr,
        message: `${p.name}.targetNetIrr is "${p.targetNetIrr}". Numeric IRR values must end with the "p.a." suffix.`,
      });
    }
  }

  return violations;
}

export function assertCatalogueIsClean(
  catalogue: readonly CatalogueProduct[] = PRODUCT_CATALOGUE,
): void {
  const violations = findCatalogueViolations(catalogue);
  if (violations.length === 0) return;
  const summary = violations.map((v) => `  - ${v.message}`).join("\n");
  throw new Error(
    `Product catalogue cleanliness check failed (${violations.length} violation${violations.length === 1 ? "" : "s"}):\n${summary}`,
  );
}

// Defence in depth: every `CatalogueProduct.category` must be a value declared
// in `shared/product-categories.ts`. The TypeScript type already enforces this
// at compile time, but exporting a runtime check lets consumers (and the test
// suite) confirm that the array hasn't been widened with `as any` or a plain
// string cast.
export function catalogueCategoriesAreKnown(
  catalogue: readonly CatalogueProduct[] = PRODUCT_CATALOGUE,
): boolean {
  const known = new Set<string>(PRODUCT_CATEGORY_VALUES);
  return catalogue.every((p) => known.has(p.category));
}
