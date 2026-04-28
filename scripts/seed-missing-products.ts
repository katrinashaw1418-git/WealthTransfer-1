import { db } from "../server/db";
import { investmentProducts } from "../shared/schema";
import { eq } from "drizzle-orm";

type SeedProduct = typeof investmentProducts.$inferInsert;

// Source-of-truth catalogue for the 14-product adviser shelf.
// Field formatting conventions (mirrored in MemStorage demo data):
//   - riskProfile: canonical lowercase enum key from shared/risk-profiles.ts
//     ("low" | "conservative" | "moderate" | "high" | "very_high"). The
//     adviser suitability check (`server/services/adviser-access.ts`) and
//     the investments page filter both compare against these keys, so any
//     drift to sentence-case strings ("High", "Very High") silently breaks
//     the suitability rule and the risk filter.
//   - targetNetIrr: ranges with en dash, "p.a." suffix on numeric returns,
//     no tilde, no trailing word "target". Bitcoin uses non-numeric label.
//   - term: months/years with en dash; rolling/notice/recommended-hold
//     qualifiers move into the structure field, never the main term.
//   - distributions: short label only — Monthly | Quarterly | Semi-annual |
//     Daily accrual | At exit | None | simple combinations.
const seedProducts: SeedProduct[] = [
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
    structure: "Registered money market fund · Not an ADI deposit, not FCS-protected",
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

async function main() {
  let inserted = 0;
  let skipped = 0;
  for (const p of seedProducts) {
    const existing = await db
      .select({ id: investmentProducts.id })
      .from(investmentProducts)
      .where(eq(investmentProducts.name, p.name));
    if (existing.length > 0) {
      console.log(`  [skip] already exists: ${p.name}`);
      skipped++;
      continue;
    }
    await db.insert(investmentProducts).values(p);
    console.log(`  [add ] ${p.category.padEnd(18)} ${p.name}`);
    inserted++;
  }
  console.log(`\nDone. Inserted: ${inserted}, skipped: ${skipped}`);

  const all = await db.select().from(investmentProducts);
  console.log(`Total products in DB now: ${all.length}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
