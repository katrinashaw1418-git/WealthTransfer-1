// =============================================================================
// PORTFOLIO VALUATION
// -----------------------------------------------------------------------------
// One canonical engine for "what is this user's portfolio worth right now?".
//
// Used by:
//   * /api/portfolio/* client endpoints (server/routes.ts)
//   * /api/adviser/clients/:id/portfolio (server/services/adviser-access.ts)
//   * Snapshot writers and reconciliation routines
//
// Why it lives in its own module:
//   * The adviser read path needs the live total (not the stale `portfolios`
//     snapshot row, which nothing in the codebase keeps refreshed). Having
//     adviser-access import the helper directly from routes.ts would create a
//     routes -> adviser-routes -> adviser-access -> routes import cycle.
//   * One module = one place where "how do we value a portfolio?" is defined,
//     so the adviser view is guaranteed to match the client view.
// =============================================================================

import { storage } from "../storage";

// ---- Investment performance ------------------------------------------------

// Category-level fallback rates — only used when a product has no explicit
// annualReturn set. Fail-closed valuation in calculateInvestmentPerformance
// means this is currently only used for the items[].annualReturn label.
export function getAnnualReturnFallback(category: string, productName?: string): number {
  const rates = {
    real_estate: 0.11,
    corporate_credit: 0.11,
    venture_capital: 0.18,
    digital_assets:
      productName && typeof productName === "string" && productName.includes("Bitcoin") ? 0.6 : 0.0575,
    default: 0.11,
  };
  return rates[category as keyof typeof rates] ?? rates.default;
}

// Unified per-investment performance calculation.
// Prefers product.annualReturn + product.returnMethod when set; refuses to
// compute when no rate is available (fail-closed) so callers don't silently
// overstate portfolio value.
export function calculateInvestmentPerformance(
  product: any,
  investedAmount: number,
  investmentDate: Date,
  currentDate: Date = new Date(),
): { currentValue: number | null; returnAmount: number; returnPercentage: number; valuationStatus?: string } {
  if (!product) {
    return { currentValue: investedAmount, returnAmount: 0, returnPercentage: 0 };
  }
  if (investedAmount <= 0) {
    return { currentValue: 0, returnAmount: 0, returnPercentage: 0 };
  }

  const start = new Date(investmentDate);
  const end = new Date(currentDate);
  if (start > end) {
    return { currentValue: investedAmount, returnAmount: 0, returnPercentage: 0 };
  }

  const daysHeld = Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  const yearsHeld = daysHeld / 365;
  const returnMethod = product.returnMethod || "fixed_annual_compound";

  let currentValue: number | null = investedAmount;
  let valuationStatus: string | undefined;

  switch (returnMethod) {
    case "manual_nav":
    case "market_price":
      currentValue = null;
      valuationStatus = "missing_price_source";
      break;
    default: {
      if (product.annualReturn == null) {
        currentValue = null;
        valuationStatus = "missing_product_rate";
        break;
      }
      const annualReturn = parseFloat(product.annualReturn);
      if (returnMethod === "fixed_annual_simple") {
        currentValue = investedAmount * (1 + annualReturn * yearsHeld);
      } else {
        currentValue = investedAmount * Math.pow(1 + annualReturn, yearsHeld);
      }
    }
  }

  const returnAmount = currentValue !== null ? currentValue - investedAmount : 0;
  const returnPercentage = currentValue !== null ? (returnAmount / investedAmount) * 100 : 0;

  return { currentValue, returnAmount, returnPercentage, valuationStatus };
}

// ---- FX --------------------------------------------------------------------

// Tries direct rate then inverse. Returns null when no rate is available so
// callers can surface the gap rather than silently undercounting.
export async function convertToUsd(currency: string, amount: number): Promise<number | null> {
  if (currency === "USD") return amount;
  const direct = await storage.getFxRate(currency, "USD");
  if (direct) return amount * parseFloat(direct.rate);
  const inverse = await storage.getFxRate("USD", currency);
  if (inverse) return amount / parseFloat(inverse.rate);
  return null;
}

// ---- Investment totals -----------------------------------------------------

export interface InvestmentTotals {
  totalInvested: number;
  totalCurrentValue: number;
  totalReturn: number;
  totalReturnPercent: number;
  hasUnpricedAssets: boolean;
  items: Array<{
    id: number;
    productId: number;
    productName: string;
    category: string;
    annualReturn: string;
    returnMethod: string;
    investedAmount: number;
    currentValue: number | null;
    returnAmount: number;
    returnPercentage: number;
    valuationStatus?: string;
  }>;
}

export async function calculateInvestmentTotalsAtDate(
  userId: number,
  asOfDate: Date = new Date(),
): Promise<InvestmentTotals> {
  const investments = await storage.getUserInvestments(userId);
  const products = await storage.getInvestmentProducts();

  let totalInvested = 0;
  let totalCurrentValue = 0;
  let hasUnpricedAssets = false;
  const items: InvestmentTotals["items"] = [];

  for (const inv of investments as any[]) {
    const product = (products as any[]).find((p: any) => p.id === inv.productId);
    if (!product) continue;
    const investedAmount = parseFloat(inv.investedAmount);
    const investmentDate = new Date(inv.investmentDate ?? Date.now());
    if (investmentDate > asOfDate) continue;
    const perf = calculateInvestmentPerformance(product, investedAmount, investmentDate, asOfDate);
    totalInvested += investedAmount;
    totalCurrentValue += perf.currentValue ?? 0;
    if (perf.currentValue === null) hasUnpricedAssets = true;
    items.push({
      id: inv.id,
      productId: product.id,
      productName: product.name,
      category: product.category,
      annualReturn:
        product.annualReturn ?? getAnnualReturnFallback(product.category, product.name).toString(),
      returnMethod: product.returnMethod ?? "fixed_annual_compound",
      investedAmount,
      currentValue: perf.currentValue,
      returnAmount: perf.returnAmount,
      returnPercentage: perf.returnPercentage,
      ...(perf.valuationStatus ? { valuationStatus: perf.valuationStatus } : {}),
    });
  }

  if (!Number.isFinite(totalCurrentValue)) {
    throw new Error(`[investment_totals] NaN in totalCurrentValue for userId=${userId}`);
  }

  return {
    totalInvested,
    totalCurrentValue,
    totalReturn: totalCurrentValue - totalInvested,
    totalReturnPercent:
      totalInvested > 0 ? ((totalCurrentValue - totalInvested) / totalInvested) * 100 : 0,
    hasUnpricedAssets,
    items,
  };
}

// ---- Wallet reconstruction -------------------------------------------------

// Reconstruct wallet balances at a historical date by reverse transaction
// replay. Float arithmetic is intentional (drift < $0.01 per chain).
export async function reconstructWalletBalancesAsOf(
  userId: number,
  asOfDate: Date,
): Promise<Array<{ currency: string; balance: number; walletType: string }>> {
  const wallets = await storage.getWallets(userId);
  const allTransactions = await storage.getTransactions(userId);

  return (wallets as any[]).map((wallet: any) => {
    const currency = wallet.currency;
    const currentBalance = parseFloat(wallet.balance);

    const txAfter = (allTransactions as any[]).filter(
      (t: any) => t.status === "completed" && new Date(t.createdAt) > asOfDate,
    );

    const totalDebits = txAfter
      .filter((t: any) => t.fromCurrency === currency)
      .reduce((sum: number, t: any) => sum + parseFloat(t.amount), 0);

    const totalCredits = txAfter
      .filter((t: any) => t.toCurrency === currency)
      .reduce((sum: number, t: any) => {
        const base = parseFloat(t.amount);
        const rate = t.exchangeRate ? parseFloat(t.exchangeRate) : 1;
        const feeInTarget = t.fee ? parseFloat(t.fee) : 0;
        return sum + (t.type === "exchange" ? base * rate - feeInTarget : base);
      }, 0);

    const historicalBalance = Math.max(0, currentBalance + totalDebits - totalCredits);
    return { currency, balance: historicalBalance, walletType: wallet.walletType };
  });
}

// ---- Portfolio totals ------------------------------------------------------

export interface PortfolioTotals {
  fiatValue: number;
  cryptoValue: number;
  stablecoinValue: number;
  investmentValue: number;
  totalValue: number;
  hasUnpricedWallets: boolean;
  unpricedCurrencies: string[];
}

export async function calculatePortfolioTotalsAtDate(
  userId: number,
  asOfDate: Date = new Date(),
): Promise<PortfolioTotals> {
  const now = new Date();
  const isToday = Math.abs(asOfDate.getTime() - now.getTime()) < 12 * 60 * 60 * 1000;

  const walletData = isToday
    ? (await storage.getWallets(userId)).map((w: any) => ({
        currency: w.currency,
        balance: parseFloat(w.balance),
        walletType: w.walletType,
      }))
    : await reconstructWalletBalancesAsOf(userId, asOfDate);

  let fiatValue = 0;
  let cryptoValue = 0;
  let stablecoinValue = 0;
  let hasUnpricedWallets = false;
  const unpricedCurrencies: string[] = [];

  for (const wallet of walletData) {
    const balance = wallet.balance;
    if (wallet.walletType === "fiat") {
      const usd = await convertToUsd(wallet.currency, balance);
      if (usd !== null) {
        fiatValue += usd;
      } else {
        hasUnpricedWallets = true;
        unpricedCurrencies.push(wallet.currency);
      }
    } else if (wallet.currency === "USDT" || wallet.currency === "USDC") {
      stablecoinValue += balance;
    } else {
      const rate = await storage.getFxRate(wallet.currency, "USD");
      if (rate) {
        cryptoValue += balance * parseFloat(rate.rate);
      } else {
        hasUnpricedWallets = true;
        unpricedCurrencies.push(wallet.currency);
      }
    }
  }

  const investmentTotals = await calculateInvestmentTotalsAtDate(userId, asOfDate);
  const investmentValue = investmentTotals.totalCurrentValue;

  return {
    fiatValue,
    cryptoValue,
    stablecoinValue,
    investmentValue,
    totalValue: fiatValue + cryptoValue + stablecoinValue + investmentValue,
    hasUnpricedWallets,
    unpricedCurrencies,
  };
}
