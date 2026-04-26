import { db } from "../server/db";
import { investmentProducts } from "../shared/schema";
import { eq } from "drizzle-orm";

type SeedProduct = typeof investmentProducts.$inferInsert;

const seedProducts: SeedProduct[] = [
  {
    name: "Real Estate Credit Fund",
    category: "real_estate",
    subCategory: "credit_fund",
    investmentStrategy:
      "Diversified exposure to senior and subordinated real estate-backed loans for land subdivisions and construction financing. Provides regular income and controlled exposure across multiple projects and geographies.",
    targetNetIrr: "~11%",
    term: "~10.2 months (rolling)",
    structure: "Real estate-backed loans",
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
    targetNetIrr: "~9%",
    term: "~9.4 months",
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
    targetNetIrr: "10–12%",
    term: "2–3 years",
    structure: "First lien amortising loan",
    distributions: "Monthly or quarterly",
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
    targetNetIrr: "12–15%",
    term: "30–39 months",
    structure: "Senior lien loan + warrant",
    distributions: "Fixed yield + equity realisation",
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
    targetNetIrr: "16–20%",
    grossIrr: "22–25%",
    moic: "3–4x",
    term: "5–7+ years",
    structure: "Equity investment",
    distributions: "Capital gain at exit",
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
    targetNetIrr: "12–16%",
    term: "3–5 years",
    structure: "Convertible preferred or structured equity",
    distributions: "Income + capital gains",
    liquidity: "Locked term",
    minimumInvestment: "250000.00",
    riskProfile: "high",
    returnType: "blended",
    isActive: true,
  },
  {
    name: "Diversified Crypto Fund",
    category: "digital_assets",
    subCategory: "blockchain_fund",
    investmentStrategy:
      "Institutional-grade diversified exposure across the crypto ecosystem including blue-chip cryptocurrencies (40%), DeFi protocols (25%), infrastructure tokens (20%), and emerging opportunities (15%). Features active management, risk controls, and institutional custody.",
    targetNetIrr: "25–35% target",
    grossIrr: "30–40%",
    moic: "2.5–4x over cycle",
    term: "Open-ended with 3-year recommended hold",
    structure: "Multi-strategy diversified fund",
    distributions: "Semi-annual distributions from DeFi yield",
    liquidity: "quarterly",
    minimumInvestment: "50000.00",
    riskProfile: "high",
    returnType: "blended",
    isActive: true,
  },
  {
    name: "High-Yield Savings Account",
    category: "cash_deposit",
    subCategory: "savings_account",
    investmentStrategy:
      "FDIC-insured high-yield savings account offering competitive interest rates for idle funds. Features instant access, no minimum balance requirements, and automated daily interest accrual with monthly compounding.",
    targetNetIrr: "4.5–5.5% p.a.",
    term: "Open-ended",
    structure: "FDIC-insured savings account",
    distributions: "Daily accrual, monthly credit",
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
    structure: "Money market fund sweep",
    distributions: "Daily accrual, monthly credit",
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
      "Premium deposit product backed by US Treasury securities offering superior yields for larger balances. Features tiered interest rates, government backing, and next-day liquidity for sophisticated treasury management.",
    targetNetIrr: "2.5–3.5% p.a.",
    term: "Open-ended with 30-day notice",
    structure: "Treasury-backed deposit account",
    distributions: "Daily accrual, quarterly credit",
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
