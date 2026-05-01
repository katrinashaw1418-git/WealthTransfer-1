import "../../scripts/_bootstrap-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { investmentProducts, userInvestments, users } from "@shared/schema";
import { listAggregatedUserInvestments } from "./user-investments";

const TAG = `t-positions-agg-${Date.now()}`;

let userId: number;
let productId: number;

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({
      username: `${TAG}-user`,
      email: `${TAG}@test.local`,
      password: "x",
      firstName: "Positions",
      lastName: "Aggregation",
      role: "client",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning({ id: users.id });
  userId = u.id;

  const [p] = await db
    .insert(investmentProducts)
    .values({
      name: `${TAG}-product`,
      category: "real_estate",
      subCategory: "first_mortgage",
      investmentStrategy: "fixture",
      targetNetIrr: "0.08",
      term: "12 months",
      structure: "trust",
      distributions: "monthly",
      liquidity: "low",
      minimumInvestment: "1000.00",
      riskProfile: "moderate",
      returnType: "income",
    })
    .returning({ id: investmentProducts.id });
  productId = p.id;
});

afterAll(async () => {
  try {
    await db.delete(userInvestments).where(eq(userInvestments.userId, userId));
  } catch {}
  try {
    await db.delete(investmentProducts).where(eq(investmentProducts.id, productId));
  } catch {}
  try {
    await db.delete(users).where(eq(users.id, userId));
  } catch {}
});

describe("listAggregatedUserInvestments", () => {
  it("returns a single aggregated row when multiple lots share the same product_id", async () => {
    await db
      .insert(userInvestments)
      .values([
        {
          userId,
          productId,
          investedAmount: "1000.00",
          currentValue: "1200.00",
          totalReturn: "200.00",
          returnPercent: "20.00",
          status: "active",
        },
        {
          userId,
          productId,
          investedAmount: "500.00",
          currentValue: "550.00",
          totalReturn: "50.00",
          returnPercent: "10.00",
          status: "active",
        },
      ])
      .returning();

    const rows = await listAggregatedUserInvestments(userId);
    const sameProduct = rows.filter((r) => r.productId === productId);

    expect(sameProduct).toHaveLength(1);
    expect(sameProduct[0].lotCount).toBe(2);
    expect(sameProduct[0].investedAmount).toBe("1500.00");
    expect(sameProduct[0].currentValue).toBe("1750.00");
    expect(sameProduct[0].totalReturn).toBe("250.00");
    expect(sameProduct[0].returnPercent).toBe("16.67");
  });
});
