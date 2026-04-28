import { Card, CardContent } from "@/components/ui/card";
import { TrendingUp, Bitcoin, DollarSign, TrendingDown, Briefcase } from "lucide-react";
import { usePortfolio } from "@/hooks/use-portfolio";
import { Skeleton } from "@/components/ui/skeleton";

// Task #493 — investor dashboard alignment.
// Hero KPI strip ordering follows the latest design pack:
//   Total portfolio value · Investment products · Cash (fiat) · Monthly P&L · Digital Asset Exposure
// All four pre-existing tiles are preserved; "Investment products" is the
// new fifth tile sourced from `portfolio.investmentValue` already returned
// by /api/portfolio. The grid is 5-up on xl screens and gracefully wraps
// (2-up sm, 3-up md, 5-up xl) on narrower viewports — no tile is removed.

export default function WealthOverview() {
  const { data: portfolio, isLoading, error } = usePortfolio();

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-6">
        {[1, 2, 3, 4, 5].map((i) => (
          <Card key={i}>
            <CardContent className="p-6">
              <Skeleton className="h-4 w-3/4 mb-4" />
              <Skeleton className="h-8 w-full mb-2" />
              <Skeleton className="h-4 w-1/2" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-6">
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-destructive">Failed to load portfolio data</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!portfolio) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-6">
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground">No portfolio data available</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const totalValue = parseFloat(portfolio.totalValue);
  const cryptoValue = parseFloat(portfolio.cryptoValue);
  const stablecoinValue = parseFloat(portfolio.stablecoinValue || "0");
  const fiatValue = parseFloat(portfolio.fiatValue);
  const investmentValue = parseFloat(portfolio.investmentValue || "0");
  const monthlyPnl = portfolio.monthlyPnl != null ? parseFloat(portfolio.monthlyPnl) : null;
  const monthlyPnlPercent = portfolio.monthlyPnlPercent != null ? parseFloat(portfolio.monthlyPnlPercent) : null;
  const monthlyPnlKnown = monthlyPnl !== null && monthlyPnlPercent !== null;
  const cryptoPercent = totalValue > 0 ? (cryptoValue / totalValue) * 100 : 0;
  const investmentPercent = totalValue > 0 ? (investmentValue / totalValue) * 100 : 0;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-6">
      <Card data-testid="kpi-total-portfolio">
        <CardContent className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-gray-500">Total Portfolio Value</h3>
            <TrendingUp className="w-4 h-4 text-secondary" />
          </div>
          <div className="space-y-2">
            <p className="text-2xl font-bold text-gray-900">
              ${totalValue.toLocaleString()}
            </p>
            <div className="flex items-center space-x-2">
              {monthlyPnlKnown ? (
                <span className={`text-sm ${monthlyPnlPercent! >= 0 ? 'text-secondary' : 'text-destructive'}`}>
                  {monthlyPnlPercent! >= 0 ? '+' : ''}{monthlyPnlPercent!.toFixed(2)}%
                </span>
              ) : (
                <span className="text-sm text-gray-400">—</span>
              )}
              <span className="text-xs text-gray-500">
                {portfolio.monthlyPnlSource === 'actual'
                  ? 'vs 30 days ago'
                  : portfolio.monthlyPnlSource === 'historical_estimate'
                  ? 'estimated from historical basis'
                  : 'insufficient history'}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="kpi-investment-products">
        <CardContent className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-gray-500">Investment Products</h3>
            <Briefcase className="w-4 h-4 text-primary" />
          </div>
          <div className="space-y-2">
            <p className="text-2xl font-bold text-gray-900">
              ${investmentValue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </p>
            <div className="flex items-center space-x-2">
              <span className="text-sm text-gray-600">{investmentPercent.toFixed(1)}% of portfolio</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="kpi-cash-allocation">
        <CardContent className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-gray-500">Cash (fiat)</h3>
            <DollarSign className="w-4 h-4 text-primary" />
          </div>
          <div className="space-y-2">
            <p className="text-2xl font-bold text-gray-900">
              ${fiatValue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </p>
            <div className="flex items-center space-x-2">
              <span className="text-sm text-gray-600">Via external custodian</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="kpi-monthly-pnl">
        <CardContent className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-gray-500">Monthly P&L (est.)</h3>
            {!monthlyPnlKnown ? (
              <TrendingUp className="w-4 h-4 text-gray-400" />
            ) : monthlyPnl! >= 0 ? (
              <TrendingUp className="w-4 h-4 text-secondary" />
            ) : (
              <TrendingDown className="w-4 h-4 text-destructive" />
            )}
          </div>
          <div className="space-y-2">
            {monthlyPnlKnown ? (
              <p className={`text-2xl font-bold ${monthlyPnl! >= 0 ? 'text-secondary' : 'text-destructive'}`}>
                {monthlyPnl! >= 0 ? '+' : ''}${monthlyPnl!.toLocaleString()}
              </p>
            ) : (
              <p className="text-2xl font-bold text-gray-400">—</p>
            )}
            <div className="flex items-center space-x-2">
              {monthlyPnlKnown ? (
                <span className={`text-sm ${monthlyPnlPercent! >= 0 ? 'text-secondary' : 'text-destructive'}`}>
                  {monthlyPnlPercent! >= 0 ? '+' : ''}{monthlyPnlPercent}%
                </span>
              ) : (
                <span className="text-sm text-gray-400">Insufficient history</span>
              )}
              {monthlyPnlKnown && <span className="text-xs text-gray-500">return</span>}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="kpi-digital-asset-exposure">
        <CardContent className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-gray-500">Digital Asset Exposure</h3>
            <Bitcoin className="w-4 h-4 text-yellow-500" />
          </div>
          <div className="space-y-2">
            <p className="text-2xl font-bold text-gray-900">
              ${cryptoValue.toLocaleString()}
            </p>
            <div className="flex items-center space-x-2">
              <span className="text-sm text-gray-600">{cryptoPercent.toFixed(1)}% of portfolio</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
