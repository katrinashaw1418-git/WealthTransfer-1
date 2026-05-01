import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { userInvestments } from "@shared/schema";

type SelectHandle = Pick<typeof db, "select">;

export interface AggregatedUserInvestmentRow {
  id: number;
  userId: number;
  productId: number;
  investedAmount: string;
  currentValue: string;
  totalReturn: string;
  returnPercent: string;
  status: string;
  investmentDate: Date | null;
  maturityDate: Date | null;
  updatedAt: Date | null;
  lotCount: number;
}

// Investor dashboard / portfolio positions view: one row per product_id.
// This keeps duplicate lots from rendering as duplicated products while
// preserving aggregate exposure (invested/current/return).
export async function listAggregatedUserInvestments(
  userId: number,
  executor?: SelectHandle,
): Promise<AggregatedUserInvestmentRow[]> {
  const dbx = executor ?? db;
  return dbx
    .select({
      id: sql<number>`min(${userInvestments.id})::int`,
      userId: userInvestments.userId,
      productId: userInvestments.productId,
      investedAmount: sql<string>`coalesce(sum(${userInvestments.investedAmount}), 0)::numeric(15,2)::text`,
      currentValue: sql<string>`coalesce(sum(${userInvestments.currentValue}), 0)::numeric(15,2)::text`,
      totalReturn: sql<string>`(coalesce(sum(${userInvestments.currentValue}), 0) - coalesce(sum(${userInvestments.investedAmount}), 0))::numeric(15,2)::text`,
      returnPercent: sql<string>`case
        when coalesce(sum(${userInvestments.investedAmount}), 0) > 0
          then ((coalesce(sum(${userInvestments.currentValue}), 0) - coalesce(sum(${userInvestments.investedAmount}), 0))
                / coalesce(sum(${userInvestments.investedAmount}), 0) * 100)::numeric(8,2)::text
        else '0.00'
      end`,
      status: sql<string>`case
        when count(distinct ${userInvestments.status}) = 1 then min(${userInvestments.status})
        else 'active'
      end`,
      investmentDate: sql<Date | null>`min(${userInvestments.investmentDate})`,
      maturityDate: sql<Date | null>`max(${userInvestments.maturityDate})`,
      updatedAt: sql<Date | null>`max(${userInvestments.updatedAt})`,
      lotCount: sql<number>`count(*)::int`,
    })
    .from(userInvestments)
    .where(eq(userInvestments.userId, userId))
    .groupBy(userInvestments.userId, userInvestments.productId)
    .orderBy(desc(sql`min(${userInvestments.investmentDate})`));
}
