import { db } from "../server/db";
import { investmentProducts } from "../shared/schema";
import { PRODUCT_CATALOGUE, assertCatalogueIsClean } from "../shared/product-catalogue";
import { eq } from "drizzle-orm";

type SeedProduct = typeof investmentProducts.$inferInsert;

// The 14 canonical products live in `shared/product-catalogue.ts` so this
// script, the `MemStorage` demo block in `server/storage.ts`, and the cleanup
// script (`scripts/cleanup-product-shelf.ts`) all share one source of truth.
// Field formatting conventions and the cleanliness rules that catch drift
// (tildes, "FDIC", non-canonical risk labels, missing "p.a." suffixes) are
// documented and enforced inside that module.
const seedProducts: SeedProduct[] = PRODUCT_CATALOGUE.map((p) => ({
  name: p.name,
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
  isActive: p.isActive,
}));

async function main() {
  // Fail fast if the shared catalogue itself has drifted out of compliance.
  // The same check runs in CI via shared/product-catalogue.test.ts, but
  // re-checking here means an out-of-date local checkout still refuses to
  // poison the database.
  assertCatalogueIsClean();

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
