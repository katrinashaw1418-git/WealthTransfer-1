/**
 * Idempotent cleanup of the adviser product shelf in the database.
 *
 * This script applies the SAME source-of-truth catalogue defined in
 * `scripts/seed-missing-products.ts` and `server/storage.ts` MemStorage to
 * any environment whose `investment_products` table predates the cleanup.
 *
 * Specifically it:
 *   1. Removes (or deactivates if referenced) the test "InRange825" record
 *      that exists only in the database — it is not in any seed file.
 *   2. Deactivates any other legacy active products whose names are NOT in
 *      the canonical 14-product catalogue, so the adviser shelf shows the
 *      expected 14 cleaned-up products.
 *   3. Updates the canonical 14 products in place with the normalised
 *      formatting (canonical lowercase risk_profile keys from
 *      `shared/risk-profiles.ts` — "low"/"moderate"/"high"/"very_high",
 *      en-dash ranges with p.a., short distribution labels, FCS-protected
 *      (Australian Financial Claims Scheme — never FDIC, that's the US
 *      scheme), Bitcoin "Market-linked" label, etc.).
 *   4. Normalises the `risk_profile` column on every other row to one of the
 *      canonical lowercase keys. Historical seed data wrote sentence-case
 *      values like "Very High", which silently broke the investments-page
 *      risk filter (strict equality) and the adviser-access suitability
 *      check (compares against "high"/"very_high"). See
 *      `normalizeRiskProfileColumn()` below.
 *
 * Safe to re-run: every step is keyed by product name and is idempotent.
 * Re-running on an already-clean DB is a no-op.
 *
 * --------------------------------------------------------------------------
 * OPERATOR RUNBOOK NOTE — READ BEFORE RE-RUNNING
 * --------------------------------------------------------------------------
 * Step 2 (deactivateLegacyExtras) deactivates EVERY active product whose
 * `name` is not in the `canonical` array below. That is intentional for the
 * one-off shelf cleanup that ships with task #289, but it has an important
 * implication for ongoing operations:
 *
 *   ❗ If a NEW legitimate product has been added to the catalogue since the
 *      last time this script ran, you MUST add its name to the `canonical`
 *      array (and ideally to the seed/MemStorage source-of-truth modules)
 *      BEFORE re-running. Otherwise this script will silently deactivate it.
 *
 * Treat this script as a pinned-version migration, not a recurring cron
 * job. If you need to re-apply the shelf hygiene without the deactivation
 * step (for example, only to refresh the formatting of the 14 canonical
 * products), comment out the `deactivateLegacyExtras` call in main().
 * --------------------------------------------------------------------------
 *
 * Usage:
 *   npx tsx scripts/cleanup-product-shelf.ts
 */
import { db } from "../server/db";
import { investmentProducts, userInvestments } from "../shared/schema";
import {
  PRODUCT_CATEGORY_LABELS,
  type KnownProductCategory,
} from "../shared/product-categories";
import {
  RISK_PROFILE_KEYS,
  isKnownRiskProfile,
  toKnownRiskProfile,
} from "../shared/risk-profiles";
import { and, eq, inArray, not, or } from "drizzle-orm";

const CANONICAL_CATEGORIES = Object.keys(PRODUCT_CATEGORY_LABELS);

// Operator-curated mapping from a historical / invalid `category` string to
// the canonical category it should be re-labelled to. Used by
// `removeInvalidCategoryRows()` for rows that have user_investments references
// (and therefore can't be deleted without breaking historical holdings).
//
// Empty by default: every entry must be approved by whoever owns product
// data, because the script otherwise has no safe way to guess the intended
// category. If the script encounters a referenced row whose invalid category
// is not in this map, it throws so an operator must explicitly extend it
// rather than silently leave bad data behind.
const INVALID_CATEGORY_MIGRATIONS: Record<string, KnownProductCategory> = {
  // Example (do not enable without owner sign-off):
  // x: "cash_deposit",
};

type ProductPatch = Pick<
  typeof investmentProducts.$inferInsert,
  | "name"
  | "category"
  | "subCategory"
  | "investmentStrategy"
  | "targetNetIrr"
  | "term"
  | "structure"
  | "distributions"
  | "liquidity"
  | "minimumInvestment"
  | "riskProfile"
  | "returnType"
  | "isActive"
> & { lvr?: string | null; grossIrr?: string | null; moic?: string | null };

const canonical: ProductPatch[] = [
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

const canonicalNames = canonical.map((p) => p.name);

async function removeInvalidCategoryRows(): Promise<void> {
  // Catches every product whose `category` is outside the canonical set
  // defined in shared/product-categories.ts. Historically this was just the
  // `InRange825` test fixture (category "x"); generalising it picks up any
  // future drift (e.g. inactive `DraftProduct` rows) without needing another
  // patch to this script.
  const matches = await db
    .select({
      id: investmentProducts.id,
      name: investmentProducts.name,
      category: investmentProducts.category,
    })
    .from(investmentProducts)
    .where(not(inArray(investmentProducts.category, CANONICAL_CATEGORIES)));

  if (matches.length === 0) {
    console.log("  [skip] no products with invalid categories");
    return;
  }

  for (const m of matches) {
    const refs = await db
      .select({ id: userInvestments.id })
      .from(userInvestments)
      .where(eq(userInvestments.productId, m.id))
      .limit(1);

    if (refs.length > 0) {
      // Cannot delete — historical user_investments depend on this product id.
      // Re-categorise to the operator-approved canonical category and
      // deactivate so it disappears from the active shelf without leaving an
      // invalid `category` value in the database.
      const target = INVALID_CATEGORY_MIGRATIONS[m.category];
      if (!target) {
        throw new Error(
          `Cannot clean up product id=${m.id} ("${m.name}") with invalid category "${m.category}": ` +
            `it has user_investments references and no entry exists in INVALID_CATEGORY_MIGRATIONS. ` +
            `Add { "${m.category}": "<canonical_category>" } to that map (with owner sign-off) and re-run.`,
        );
      }
      await db
        .update(investmentProducts)
        .set({ category: target, isActive: false })
        .where(eq(investmentProducts.id, m.id));
      console.log(
        `  [recategorise+deactivate] ${m.name} (id=${m.id}, "${m.category}" -> "${target}") — has user_investments references; cannot delete`,
      );
    } else {
      await db.delete(investmentProducts).where(eq(investmentProducts.id, m.id));
      console.log(
        `  [delete    ] ${m.name} (id=${m.id}, category="${m.category}")`,
      );
    }
  }
}

async function assertNoInvalidCategoriesRemain(): Promise<void> {
  const remaining = await db
    .select({
      id: investmentProducts.id,
      name: investmentProducts.name,
      category: investmentProducts.category,
    })
    .from(investmentProducts)
    .where(not(inArray(investmentProducts.category, CANONICAL_CATEGORIES)));

  if (remaining.length > 0) {
    for (const r of remaining) {
      console.error(
        `  [FAIL] ${r.name} (id=${r.id}) still has invalid category "${r.category}"`,
      );
    }
    throw new Error(
      `Cleanup verification failed: ${remaining.length} product(s) still have non-canonical categories.`,
    );
  }
  console.log("  [ok] no products with invalid categories remain");
}

async function deactivateLegacyExtras(): Promise<void> {
  const extras = await db
    .select({ id: investmentProducts.id, name: investmentProducts.name })
    .from(investmentProducts)
    .where(
      and(
        eq(investmentProducts.isActive, true),
        not(inArray(investmentProducts.name, canonicalNames)),
      ),
    );

  if (extras.length === 0) {
    console.log("  [skip] no legacy active extras to deactivate");
    return;
  }

  for (const e of extras) {
    await db
      .update(investmentProducts)
      .set({ isActive: false })
      .where(eq(investmentProducts.id, e.id));
    console.log(`  [deactivate] ${e.name} (id=${e.id}) — not in canonical 14`);
  }
}

// Task #336 — investor-facing reads filter on `isPublished`. Any product
// whose name matches a known test/draft fixture is flipped to
// isPublished=false so:
//   - investor portal pages never see them (the route layer now drops any
//     row with isPublished=false), and
//   - admin tooling can still inspect/edit them in the database.
//
// The filter is name-based and idempotent. Add new test names here as the
// QA team introduces them. Real, sales-approved funds keep the default
// isPublished=true and remain visible.
const unpublishedTestNames = [
  "Smoke Test Fund",
  "DraftProduct",
  "InRange825",
];

async function markTestProductsUnpublished(): Promise<void> {
  const matches = await db
    .select({ id: investmentProducts.id, name: investmentProducts.name, isPublished: investmentProducts.isPublished })
    .from(investmentProducts)
    .where(inArray(investmentProducts.name, unpublishedTestNames));

  if (matches.length === 0) {
    console.log("  [skip] no test products to unpublish");
    return;
  }

  for (const m of matches) {
    if (m.isPublished === false) {
      console.log(`  [skip] ${m.name} (id=${m.id}) already unpublished`);
      continue;
    }
    await db
      .update(investmentProducts)
      .set({ isPublished: false })
      .where(eq(investmentProducts.id, m.id));
    console.log(`  [unpublish] ${m.name} (id=${m.id})`);
  }
}

// Task #339 — historical seed data wrote sentence-case `risk_profile` values
// like "Low" / "Very High". The shared enum (`shared/risk-profiles.ts`) uses
// canonical lowercase keys ("low" | "conservative" | "moderate" | "high" |
// "very_high"), and both the investments-page filter (strict equality) and
// the adviser-access suitability check compare against those keys. Anything
// outside the canonical set silently breaks both code paths.
//
// This pass coerces every row's `risk_profile` to a canonical key via
// `toKnownRiskProfile`, which already handles sentence-case + whitespace
// drift ("Very High" -> "very_high"). Rows that genuinely cannot be matched
// are left untouched and reported, so an operator can decide whether to set
// them to a canonical value manually rather than this script silently
// downgrading them. Idempotent: rows already on a canonical key are skipped.
async function normalizeRiskProfileColumn(): Promise<void> {
  const rows = await db
    .select({
      id: investmentProducts.id,
      name: investmentProducts.name,
      riskProfile: investmentProducts.riskProfile,
    })
    .from(investmentProducts);

  let updated = 0;
  let alreadyCanonical = 0;
  const unmappable: Array<{ id: number; name: string; riskProfile: string }> = [];

  for (const r of rows) {
    if (isKnownRiskProfile(r.riskProfile)) {
      alreadyCanonical++;
      continue;
    }
    const canonical = toKnownRiskProfile(r.riskProfile);
    if (!canonical) {
      unmappable.push({ id: r.id, name: r.name, riskProfile: r.riskProfile });
      continue;
    }
    await db
      .update(investmentProducts)
      .set({ riskProfile: canonical })
      .where(eq(investmentProducts.id, r.id));
    console.log(
      `  [normalize] ${r.name} (id=${r.id}): "${r.riskProfile}" -> "${canonical}"`,
    );
    updated++;
  }

  console.log(
    `  Normalised: ${updated}, already canonical: ${alreadyCanonical}` +
      (unmappable.length > 0 ? `, unmappable: ${unmappable.length}` : ""),
  );

  if (unmappable.length > 0) {
    for (const u of unmappable) {
      console.warn(
        `  [WARN] ${u.name} (id=${u.id}) has unmappable risk_profile "${u.riskProfile}". ` +
          `Allowed values: ${RISK_PROFILE_KEYS.join(", ")}.`,
      );
    }
  }
}

async function upsertCanonical(): Promise<void> {
  let updated = 0;
  let inserted = 0;
  for (const p of canonical) {
    const existing = await db
      .select({ id: investmentProducts.id })
      .from(investmentProducts)
      .where(eq(investmentProducts.name, p.name));

    if (existing.length === 0) {
      await db.insert(investmentProducts).values(p);
      console.log(`  [insert] ${p.name}`);
      inserted++;
      continue;
    }

    for (const row of existing) {
      await db
        .update(investmentProducts)
        .set({
          category: p.category,
          subCategory: p.subCategory,
          investmentStrategy: p.investmentStrategy,
          targetNetIrr: p.targetNetIrr,
          grossIrr: p.grossIrr ?? null,
          moic: p.moic ?? null,
          term: p.term,
          structure: p.structure,
          distributions: p.distributions,
          liquidity: p.liquidity,
          minimumInvestment: p.minimumInvestment,
          riskProfile: p.riskProfile,
          returnType: p.returnType,
          lvr: p.lvr ?? null,
          isActive: true,
          // Task #336 — explicitly republish canonical funds in case a
          // previous cleanup pass (or a manual edit) flipped them off.
          isPublished: true,
        })
        .where(eq(investmentProducts.id, row.id));
      updated++;
    }
  }
  console.log(`  Updated: ${updated}, Inserted: ${inserted}`);
}

async function main() {
  console.log(
    "Cleanup: removing rows with non-canonical categories (e.g. test fixtures like InRange825 / DraftProduct)",
  );
  await removeInvalidCategoryRows();

  console.log("\nCleanup: deactivating legacy active products outside the canonical 14");
  await deactivateLegacyExtras();

  console.log("\nCleanup: marking known test/draft products as unpublished (Task #336)");
  await markTestProductsUnpublished();

  console.log(
    "\nCleanup: normalising risk_profile column to canonical lowercase keys (Task #339)",
  );
  await normalizeRiskProfileColumn();

  console.log("\nCleanup: normalising the canonical 14 products");
  await upsertCanonical();

  console.log("\nCleanup: verifying no rows with invalid categories remain");
  await assertNoInvalidCategoriesRemain();

  const finalActive = await db
    .select({ id: investmentProducts.id, name: investmentProducts.name })
    .from(investmentProducts)
    .where(eq(investmentProducts.isActive, true));

  console.log(`\nActive products on the shelf: ${finalActive.length}`);
  for (const p of finalActive) {
    console.log(`  - ${p.name} (id=${p.id})`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
