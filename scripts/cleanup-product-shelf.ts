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
import {
  PRODUCT_CATALOGUE,
  PRODUCT_CATALOGUE_NAMES,
  assertCatalogueIsClean,
  type CatalogueProduct,
} from "../shared/product-catalogue";
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

// The cleanup pass writes the same column-set we accept on insert, plus the
// optional nullable LVR / grossIrr / moic columns. The canonical entries
// themselves come from `shared/product-catalogue.ts` so the seed script,
// MemStorage demo block, and this cleanup pass cannot drift apart.
type ProductPatch = CatalogueProduct;

// Canonical 14-product shelf is defined in `shared/product-catalogue.ts`.
// `.map(...)` clones each entry so this script can pass mutable objects to the
// drizzle write-path without leaking back into the shared `readonly` array.
const canonical: ProductPatch[] = PRODUCT_CATALOGUE.map((p) => ({ ...p }));

const canonicalNames = PRODUCT_CATALOGUE_NAMES;

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
  // Fail fast if the shared catalogue itself has drifted out of compliance.
  // The same gate runs in CI via shared/product-catalogue.test.ts; checking
  // here too means an out-of-date local checkout cannot poison the database.
  assertCatalogueIsClean();

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
