import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { usePortfolio, useWallets, useUserInvestments, usePortfolioAllocation } from "@/hooks/use-portfolio";
import { Skeleton } from "@/components/ui/skeleton";
import { PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, LineChart, Line } from 'recharts';
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipTrigger as UiTooltipTrigger,
} from "@/components/ui/tooltip";
import { TrendingUp, TrendingDown, DollarSign, Bitcoin, PieChart as PieChartIcon, Target, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";

const COLORS = ['hsl(207, 90%, 54%)', 'hsl(0, 84%, 55%)', '#D1D5DB', '#8B5CF6', '#10B981', '#F59E0B'];

// Category-specific colors
const getCategoryColor = (categoryName: string) => {
  const colorMap: { [key: string]: string } = {
    'Real Estate': '#8B4513',     // Brown
    'Corporate Credit': '#D1D5DB',  // Gray-300
    'Venture Capital': '#8B5CF6',  // Purple
    'Digital Assets': '#EF4444',   // Red
    'Cash Deposits': '#3B82F6'     // Blue
  };
  return colorMap[categoryName] || '#6B7280'; // Default gray
};

export default function Portfolio() {
  const queryClient = useQueryClient();
  const [expandedProductKey, setExpandedProductKey] = useState<string | null>(null);

  const { data: portfolio, isLoading: portfolioLoading } = usePortfolio();
  const { data: wallets, isLoading: walletsLoading } = useWallets();
  const { data: userInvestments, isLoading: investmentsLoading } = useUserInvestments();
  const { data: allocation, isLoading: allocationLoading } = usePortfolioAllocation();
  
  const { data: investmentBreakdown, isLoading: breakdownLoading } = useQuery({
    queryKey: ["/api/investment-breakdown"],
    queryFn: async () => (await apiFetch("/api/investment-breakdown")).json(),
    refetchInterval: 5000, // Refresh every 5 seconds to track investment changes
  });

  // Portfolio history chart — monthly points from Jan 1, 2026 (historical + projected)
  const { data: perfChart } = useQuery({
    queryKey: ["/api/portfolio/performance-chart", "1Y"],
    queryFn: async () => (await apiFetch("/api/portfolio/performance-chart?timeframe=1Y")).json(),
  });

  // 1-year portfolio history — still used for Performance by Period period calculations
  const { data: yearHistory } = useQuery({
    queryKey: ["/api/portfolio/history", "1Y"],
    queryFn: async () => (await apiFetch("/api/portfolio/history?timeframe=1Y")).json(),
  });

  // YTD investment history — monthly points anchored from 1 Jan 2026
  const { data: investmentYtdHistory } = useQuery({
    queryKey: ["/api/investments/history-ytd"],
    queryFn: async () => (await apiFetch("/api/investments/history-ytd")).json(),
  });

  const { data: realMetrics, isLoading: metricsLoading } = useQuery({
    queryKey: ["/api/portfolio/real-metrics"],
    queryFn: async () => (await apiFetch("/api/portfolio/real-metrics")).json(),
  });

  const isLoading = portfolioLoading || walletsLoading || investmentsLoading || allocationLoading || breakdownLoading;

  // Use allocation data for accurate values
  const fiatValue = allocation?.fiat?.value || 0;
  const cryptoValue = allocation?.crypto?.value || 0;
  const stablecoinValue = allocation?.stablecoin?.value || 0;
  const investmentValue = allocation?.investment?.value || 0;
  const totalPortfolioValue = allocation?.totalValue || 0;

  // Create allocation data from allocation API
  const allocationData = [
    {
      name: 'Fiat Currencies',
      value: fiatValue,
      percentage: allocation?.fiat?.percentage || 0,
      color: COLORS[0],
      type: 'fiat'
    },
    {
      name: 'Crypto Assets',
      value: cryptoValue,
      percentage: allocation?.crypto?.percentage || 0,
      color: COLORS[1],
      type: 'crypto'
    },
    {
      name: 'Stablecoins',
      value: stablecoinValue,
      percentage: allocation?.stablecoin?.percentage || 0,
      color: COLORS[2],
      type: 'stablecoin'
    },
    {
      name: 'Investment Products',
      value: investmentValue,
      percentage: allocation?.investment?.percentage || 0,
      color: COLORS[3],
      type: 'investment'
    }
  ].filter(item => item.value > 0);

  // Individual wallet breakdown for detailed view
  const walletData = wallets?.map((wallet: any, index: number) => {
    const balance = parseFloat(wallet.balance);
    return {
      name: wallet.currency,
      value: balance,
      percentage: 0, // Raw balance for detailed view
      color: COLORS[index % COLORS.length],
      type: wallet.walletType
    };
  }).filter((item: any) => item.value > 0) || [];



  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <Skeleton className="h-8 w-48 mb-2" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <Skeleton className="h-6 w-32 mb-4" />
                <Skeleton className="h-8 w-full mb-2" />
                <Skeleton className="h-4 w-20" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  // Monthly P&L — preserve null from server; avoid fake-zero display
  const monthlyPnl = portfolio?.monthlyPnl != null ? parseFloat(portfolio.monthlyPnl) : null;
  const monthlyReturn = portfolio?.monthlyPnlPercent != null ? parseFloat(portfolio.monthlyPnlPercent) : null;
  const monthlyPnlKnown = monthlyPnl !== null && monthlyReturn !== null;

  // --- Performance by Period chart (returns computed from real snapshot history) ---
  const historyPoints = yearHistory?.data || [];
  const periodConfig = [
    { period: '1W',  days: 7 },
    { period: '1M',  days: 30 },
    { period: '3M',  days: 90 },
    { period: '6M',  days: 180 },
    {
      period: 'YTD',
      days: Math.max(
        1,
        Math.floor(
          (Date.now() - new Date(new Date().getFullYear(), 0, 1).getTime()) /
            (1000 * 60 * 60 * 24)
        )
      ),
    },
  ];
  const getReturnFromHistory = (days: number) => {
    if (!historyPoints.length) return null;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const eligible = historyPoints.filter((p: any) => p.timestamp <= cutoff);
    // Only compute if we have a real prior point (not just falling back to the first point)
    if (!eligible.length) return null;
    const startPoint = eligible[eligible.length - 1];
    const endPoint = historyPoints[historyPoints.length - 1];
    if (!startPoint || !endPoint || startPoint.value <= 0) return null;
    return ((endPoint.value - startPoint.value) / startPoint.value) * 100;
  };
  const periodPerformanceData = periodConfig.map(({ period, days }) => ({
    period,
    portfolioReturn: getReturnFromHistory(days),
  }));
  const hasAnyPeriodReturn = periodPerformanceData.some(d => d.portfolioReturn !== null);

  // Investment chart data — new format already has { month, historical, projected }
  const investmentChartData = investmentYtdHistory?.data ?? [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Portfolio Overview</h1>
          <p className="text-gray-600">Track your asset allocation and performance</p>
        </div>
        <Button>
          <RefreshCw className="w-4 h-4 mr-2" />
          Rebalance
        </Button>
      </div>

      {/* Portfolio Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-xs font-medium text-gray-500">Total Value</h3>
              <DollarSign className="w-3 h-3 text-primary" />
            </div>
            <p className="text-xs font-bold leading-tight whitespace-nowrap overflow-hidden text-ellipsis">${totalPortfolioValue.toLocaleString()}</p>
            <div className="flex items-center space-x-1 mt-1">
              <TrendingUp className="w-2 h-2 text-secondary" />
              <span className="text-xs text-secondary">+{monthlyReturn?.toFixed(1) ?? '0.0'}%</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-xs font-medium text-gray-500">Crypto Assets</h3>
              <Bitcoin className="w-3 h-3 text-yellow-500" />
            </div>
            <p className="text-xs font-bold leading-tight whitespace-nowrap overflow-hidden text-ellipsis">${cryptoValue.toLocaleString()}</p>
            <p className="text-xs text-gray-600 mt-1">
              {(allocation?.crypto?.percentage || 0).toFixed(1)}% of portfolio
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-xs font-medium text-gray-500">Stablecoins</h3>
              <DollarSign className="w-3 h-3 text-gray-400" />
            </div>
            <p className="text-xs font-bold leading-tight whitespace-nowrap overflow-hidden text-ellipsis">${stablecoinValue.toLocaleString()}</p>
            <p className="text-xs text-gray-600 mt-1">
              {(allocation?.stablecoin?.percentage || 0).toFixed(1)}% of portfolio
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-xs font-medium text-gray-500">Fiat Assets</h3>
              <DollarSign className="w-3 h-3 text-primary" />
            </div>
            <p className="text-xs font-bold leading-tight whitespace-nowrap overflow-hidden text-ellipsis">${fiatValue.toLocaleString()}</p>
            <p className="text-xs text-gray-600 mt-1">
              {(allocation?.fiat?.percentage || 0).toFixed(1)}% of portfolio
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-xs font-medium text-gray-500">Investments</h3>
              <Target className="w-3 h-3 text-purple-500" />
            </div>
            <p className="text-xs font-bold leading-tight whitespace-nowrap overflow-hidden text-ellipsis">${investmentValue.toLocaleString()}</p>
            <p className="text-xs text-gray-600 mt-1">
              {(allocation?.investment?.percentage || 0).toFixed(1)}% of portfolio
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-xs font-medium text-gray-500">Monthly P&L</h3>
              {!monthlyPnlKnown ? (
                <TrendingUp className="w-3 h-3 text-gray-400" />
              ) : monthlyPnl! >= 0 ? (
                <TrendingUp className="w-3 h-3 text-secondary" />
              ) : (
                <TrendingDown className="w-3 h-3 text-destructive" />
              )}
            </div>
            {!monthlyPnlKnown ? (
              <p className="text-xs font-bold text-gray-400 leading-tight">—</p>
            ) : (
              <p className={`text-xs font-bold leading-tight whitespace-nowrap overflow-hidden text-ellipsis ${monthlyPnl! >= 0 ? 'text-secondary' : 'text-destructive'}`}>
                {monthlyPnl! >= 0 ? '+' : ''}${Math.round(monthlyPnl!).toLocaleString()}
              </p>
            )}
            <p className="text-xs text-gray-600 mt-1">
              {!monthlyPnlKnown
                ? 'Insufficient history'
                : portfolio?.monthlyPnlSource === 'actual'
                  ? `${monthlyReturn! >= 0 ? '+' : ''}${monthlyReturn!.toFixed(1)}% vs 30 days ago`
                  : `${monthlyReturn! >= 0 ? '+' : ''}${monthlyReturn!.toFixed(1)}% estimated from historical basis`}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Performance and Allocation */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Asset Allocation */}
        <Card>
          <CardHeader>
            <CardTitle>Asset Allocation</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center space-x-6">
              <div className="h-64 w-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={allocationData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={100}
                      paddingAngle={5}
                      dataKey="value"
                    >
                      {allocationData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value: number) => [`$${value.toLocaleString()}`, 'Value']} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex-1 space-y-3">
                {allocationData.map((item, index) => (
                  <div key={item.name} className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }}></div>
                      <span className="font-medium">{item.name}</span>
                      <Badge variant="outline">{item.type}</Badge>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold">{item.percentage.toFixed(1)}%</p>
                      <p className="text-sm text-gray-600">${item.value.toLocaleString()}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Task #338 — actual-vs-target allocation bars per asset class.
                Targets come from the illustrative rebalancing benchmark
                surfaced by /api/portfolio/allocation; actuals are the live
                percentages already computed above. The bar is the actual
                allocation; the dashed marker shows the benchmark target so
                drift is visible at a glance. */}
            {allocation?.benchmark?.targets ? (
              <div className="mt-6 pt-6 border-t border-gray-100" data-testid="allocation-vs-target">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-gray-900">Allocation vs benchmark</h4>
                  <span className="text-xs text-gray-500" data-testid="benchmark-subtitle">
                    {/* Build the subtitle from the live benchmark payload so a
                        future risk-banded benchmark (e.g. 30/15/20/35) doesn't
                        leave the label silently misreporting the targets.
                        Task #388 — the prefix reflects which benchmark the
                        server resolved for this client (personalised when a
                        risk profile is on file, illustrative otherwise) so
                        the label never silently misrepresents the source. */}
                    {allocation.benchmark.type === 'risk_profile_personalised'
                      ? 'Risk profile'
                      : 'Illustrative'}
                    {' · '}
                    {[
                      allocation.benchmark.targets.fiat,
                      allocation.benchmark.targets.crypto,
                      allocation.benchmark.targets.stablecoin,
                      allocation.benchmark.targets.investment,
                    ]
                      .map((n: number) => `${Math.round(n)}`)
                      .join('/')}
                  </span>
                </div>
                <div className="space-y-3">
                  {([
                    { key: 'fiat',       label: 'Fiat Currencies' },
                    { key: 'crypto',     label: 'Crypto Assets' },
                    { key: 'stablecoin', label: 'Stablecoins' },
                    { key: 'investment', label: 'Investment Products' },
                  ] as const).map(({ key, label }) => {
                    const actual = allocation?.[key]?.percentage ?? 0;
                    const target = allocation.benchmark.targets[key] ?? 0;
                    const drift = actual - target;
                    const driftAbs = Math.abs(drift);
                    const driftLabel =
                      driftAbs < 0.05
                        ? 'On target'
                        : `${drift > 0 ? '+' : '−'}${driftAbs.toFixed(1)}pp ${drift > 0 ? 'over' : 'under'}`;
                    const driftColor =
                      driftAbs < 0.05
                        ? 'text-gray-500'
                        : driftAbs < 5
                          ? 'text-amber-600'
                          : 'text-red-600';
                    // Cap rendered bar at 100% so a heavy concentration in
                    // one class doesn't blow out the layout, but keep the
                    // numeric readout truthful.
                    const actualWidth = Math.min(100, Math.max(0, actual));
                    const targetLeft = Math.min(100, Math.max(0, target));
                    return (
                      <div key={key} data-testid={`allocation-bar-${key}`}>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="font-medium text-gray-700">{label}</span>
                          <span className="text-gray-600 tabular-nums">
                            <span className="font-semibold">{actual.toFixed(1)}%</span>
                            <span className="text-gray-400 mx-1">/</span>
                            <span>target {target.toFixed(0)}%</span>
                            <span className="text-gray-300 mx-1.5">·</span>
                            <span className={driftColor}>{driftLabel}</span>
                          </span>
                        </div>
                        <div className="relative h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className="absolute inset-y-0 left-0 bg-sky-500 rounded-full"
                            style={{ width: `${actualWidth}%` }}
                          />
                          {/* Target marker — vertical dashed line over the bar */}
                          <div
                            className="absolute inset-y-0 w-0.5 bg-gray-700"
                            style={{ left: `calc(${targetLeft}% - 1px)` }}
                            aria-hidden
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
                {allocation.benchmark.note ? (
                  <p className="text-[11px] text-gray-400 mt-3 leading-snug">
                    {allocation.benchmark.note}
                  </p>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* Investment Products Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PieChartIcon className="h-5 w-5" />
              Investment Products
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center space-x-6">
              <div className="h-64 w-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={investmentBreakdown?.categories || []}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={100}
                      paddingAngle={5}
                      dataKey="value"
                    >
                      {(investmentBreakdown?.categories || []).map((entry: any, index: number) => (
                        <Cell key={`cell-${index}`} fill={getCategoryColor(entry.name)} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value: number) => [`$${value.toLocaleString()}`, 'Value']} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex-1 space-y-3">
                {(investmentBreakdown?.categories || []).map((item: any, index: number) => (
                  <div 
                    key={item.name} 
                    className="flex items-center justify-between hover:bg-gray-50 p-2 rounded-lg cursor-pointer transition-colors"
                    onClick={() => window.location.href = '/investments'}
                  >
                    <div className="flex items-center space-x-3">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: getCategoryColor(item.name) }}></div>
                      <span className="font-medium">{item.name}</span>
                      <Badge variant="outline">{item.products.length} products</Badge>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold">{item.percentage.toFixed(1)}%</p>
                      <p className="text-sm text-gray-600">${item.value.toLocaleString()}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            
            {/* Individual Products */}
            <div className="mt-6 space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="font-semibold text-lg mb-3">Individual Investment Products</h4>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => window.location.href = '/investments'}
                  className="text-sm"
                >
                  View All Investments
                </Button>
              </div>
              {(investmentBreakdown?.categories || []).map((category: any) => (
                <div key={category.name} className="space-y-2">
                  <h5 className="font-medium text-sm text-gray-700 uppercase tracking-wide">{category.name}</h5>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {category.products.map((product: any, idx: number) => {
                      const productKey = `${category.name}-${product.productId ?? idx}`;
                      const isExpanded = expandedProductKey === productKey;
                      // Task #354 — show the most recent top-up first regardless
                      // of the order the API returns lots in.
                      const lots: any[] = Array.isArray(product.lots)
                        ? [...product.lots].sort((a, b) => {
                            const aTime = a?.investmentDate ? new Date(a.investmentDate).getTime() : 0;
                            const bTime = b?.investmentDate ? new Date(b.investmentDate).getTime() : 0;
                            return bTime - aTime;
                          })
                        : [];
                      const hasMultipleLots = lots.length > 1;
                      return (
                        <div
                          key={productKey}
                          className="bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                          data-testid={`product-row-${productKey}`}
                        >
                          <div className="flex items-center justify-between p-3">
                            <div className="flex items-center space-x-3 min-w-0 flex-1">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedProductKey(isExpanded ? null : productKey);
                                }}
                                disabled={lots.length === 0}
                                aria-expanded={isExpanded}
                                aria-label={isExpanded ? "Hide lots" : "Show lots"}
                                className="p-0.5 rounded hover:bg-gray-200 disabled:opacity-30 disabled:hover:bg-transparent"
                                data-testid={`toggle-lots-${productKey}`}
                              >
                                {isExpanded ? (
                                  <ChevronDown className="h-4 w-4 text-gray-600" />
                                ) : (
                                  <ChevronRight className="h-4 w-4 text-gray-600" />
                                )}
                              </button>
                              <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: getCategoryColor(category.name) }}></div>
                              <button
                                type="button"
                                onClick={() => (window.location.href = '/investments')}
                                className="text-sm font-medium text-left truncate hover:underline"
                              >
                                {product.name}
                              </button>
                              {hasMultipleLots && (
                                <Badge variant="secondary" className="text-xs">
                                  {lots.length} lots
                                </Badge>
                              )}
                            </div>
                            <div className="text-right pl-2">
                              <div className="text-sm font-semibold">${(product.value / 1000).toFixed(0)}K</div>
                              <div className="text-xs text-gray-500">{product.percentage.toFixed(1)}%</div>
                            </div>
                          </div>
                          {isExpanded && lots.length > 0 && (() => {
                            // Task #396 — sum the lot invested amounts so the
                            // share-of-position percentages always add up to 100%
                            // even if the parent product.investedAmount drifts.
                            const lotsInvestedSum = lots.reduce(
                              (sum, l) => sum + Number(l?.investedAmount ?? 0),
                              0,
                            );
                            // Largest-remainder rounding so the displayed
                            // integer percentages add up to exactly 100%
                            // (e.g. three equal lots show 34/33/33, not
                            // 33/33/33).
                            const lotSharePcts: number[] = (() => {
                              if (lotsInvestedSum <= 0) return lots.map(() => 0);
                              const exact = lots.map(
                                (l) => (Number(l?.investedAmount ?? 0) / lotsInvestedSum) * 100,
                              );
                              const floors = exact.map((v) => Math.floor(v));
                              let remainder = 100 - floors.reduce((s, v) => s + v, 0);
                              const order = exact
                                .map((v, i) => ({ i, frac: v - Math.floor(v) }))
                                .sort((a, b) => b.frac - a.frac);
                              const result = [...floors];
                              for (let k = 0; k < order.length && remainder > 0; k++) {
                                result[order[k].i] += 1;
                                remainder -= 1;
                              }
                              return result;
                            })();
                            return (
                            <div className="px-3 pb-3" data-testid={`lots-list-${productKey}`}>
                              <div className="border-t border-gray-200 pt-2 space-y-1.5">
                                {(() => {
                                  const totalInvested = Number(product.investedAmount ?? 0);
                                  const totalCurrent = Number(product.value ?? 0);
                                  const blendedReturn = Number(product.returnPercentage ?? 0);
                                  return (
                                    <div
                                      className="flex items-center justify-between text-xs text-gray-600 pb-1.5 border-b border-gray-200"
                                      data-testid={`lots-subtotal-${productKey}`}
                                    >
                                      <span className="font-medium text-gray-700">
                                        {lots.length} {lots.length === 1 ? 'lot' : 'lots'}
                                        <span className="text-gray-400 mx-1.5">·</span>
                                        Invested ${totalInvested.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                      </span>
                                      <div className="flex items-center gap-3">
                                        <span className="text-gray-700">
                                          Current ${totalCurrent.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                        </span>
                                        <span
                                          className={`font-medium tabular-nums ${blendedReturn >= 0 ? 'text-green-600' : 'text-red-600'}`}
                                        >
                                          Return {blendedReturn >= 0 ? '+' : ''}
                                          {blendedReturn.toFixed(2)}%
                                        </span>
                                      </div>
                                    </div>
                                  );
                                })()}
                                {lots.map((lot: any, lotIdx: number) => {
                                  const invested = Number(lot.investedAmount ?? 0);
                                  const current = Number(lot.currentValue ?? 0);
                                  const returnPct = Number(lot.returnPercentage ?? 0);
                                  const sharePct = lotSharePcts[lotIdx] ?? 0;
                                  const dateStr = lot.investmentDate
                                    ? new Date(lot.investmentDate).toLocaleDateString(undefined, {
                                        year: 'numeric',
                                        month: 'short',
                                        day: 'numeric',
                                      })
                                    : '—';
                                  return (
                                    <div
                                      key={lot.investmentId ?? lotIdx}
                                      className="flex items-center justify-between text-xs bg-white rounded px-2 py-1.5"
                                      data-testid={`lot-row-${productKey}-${lotIdx}`}
                                    >
                                      <div className="text-gray-600">
                                        <span className="font-medium text-gray-800">{dateStr}</span>
                                        <span className="text-gray-400 mx-1.5">·</span>
                                        Invested ${invested.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                        <span className="text-gray-400 mx-1.5">·</span>
                                        <UiTooltip>
                                          <UiTooltipTrigger asChild>
                                            <button
                                              type="button"
                                              className="text-gray-400 underline decoration-dotted decoration-gray-300 underline-offset-2 cursor-help focus:outline-none focus:ring-1 focus:ring-gray-400 rounded-sm"
                                              data-testid={`lot-share-${productKey}-${lotIdx}`}
                                              onClick={(e) => e.stopPropagation()}
                                            >
                                              {sharePct}% of position
                                            </button>
                                          </UiTooltipTrigger>
                                          <UiTooltipContent
                                            side="top"
                                            className="max-w-xs text-xs"
                                            data-testid={`lot-share-tooltip-${productKey}-${lotIdx}`}
                                          >
                                            Share of this product's total invested capital — $
                                            {invested.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                            {' of $'}
                                            {lotsInvestedSum.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                          </UiTooltipContent>
                                        </UiTooltip>
                                      </div>
                                      <div className="flex items-center gap-3">
                                        <span className="text-gray-700">
                                          ${current.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                        </span>
                                        <span
                                          className={`font-medium tabular-nums ${returnPct >= 0 ? 'text-green-600' : 'text-red-600'}`}
                                        >
                                          {returnPct >= 0 ? '+' : ''}
                                          {returnPct.toFixed(2)}%
                                        </span>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                            );
                          })()}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Portfolio History */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle>Portfolio History</CardTitle>
              <span className="text-xs text-muted-foreground border border-border rounded-full px-2 py-0.5">
                {perfChart?.chartSource === 'historical_plus_forecast'
                  ? 'Historical data + forecast'
                  : 'Historical estimate + forecast'}
              </span>
            </div>
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <div className="w-4 h-0.5 bg-red-500 rounded"></div>
                <span>
                  {perfChart?.chartSource === 'historical_plus_forecast'
                    ? 'Historical data'
                    : 'Historical estimate'}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-4 h-0.5 bg-blue-500 rounded" style={{ borderTop: '2px dashed #3b82f6', background: 'none' }}></div>
                <span>Forecast ({perfChart?.projectionRate ?? '10% p.a.'})</span>
              </div>
            </div>
          </div>
          {perfChart?.openingValue && (
            <div className="flex items-center gap-4 mt-2 text-sm flex-wrap">
              <span className="text-muted-foreground">Opening (Jan 1): <span className="font-medium text-foreground">${perfChart.openingValue.toLocaleString()}</span></span>
              {(() => {
                const lastReal = perfChart.data?.reduce((acc: number | null, r: any) =>
                  r.historical !== null ? r.historical : acc, null);
                if (lastReal && perfChart.openingValue) {
                  const ret = ((lastReal - perfChart.openingValue) / perfChart.openingValue * 100).toFixed(2);
                  return (
                    <span className={parseFloat(ret) >= 0 ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
                      YTD actual: {parseFloat(ret) >= 0 ? '+' : ''}{ret}%
                    </span>
                  );
                }
                return null;
              })()}
            </div>
          )}
        </CardHeader>
        <CardContent>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={perfChart?.data ?? []}
                margin={{ top: 5, right: 20, left: 20, bottom: 55 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                <XAxis
                  dataKey="month"
                  stroke="#6B7280"
                  fontSize={11}
                  interval={0}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis
                  stroke="#6B7280"
                  fontSize={12}
                  tickFormatter={(v) => `$${(v / 1_000_000).toFixed(1)}M`}
                  width={65}
                />
                <Tooltip
                  formatter={(value: number, name: string) => [
                    `$${value.toLocaleString()}`,
                    name === 'historical'
                      ? (perfChart?.chartSource === 'historical_plus_forecast'
                          ? 'Historical'
                          : 'Historical estimate')
                      : `Forecast (${perfChart?.projectionRate ?? '10% p.a.'})`,
                  ]}
                  contentStyle={{ backgroundColor: 'white', border: '1px solid #E5E7EB', borderRadius: '8px' }}
                />
                <Line
                  type="monotone"
                  dataKey="projected"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  dot={false}
                  activeDot={{ r: 4, fill: '#3b82f6' }}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="historical"
                  stroke="#ef4444"
                  strokeWidth={3}
                  dot={{ fill: '#ef4444', strokeWidth: 2, r: 4 }}
                  activeDot={{ r: 6, fill: '#ef4444' }}
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Tracks your total net worth across all asset classes — fiat currencies, crypto, stablecoins, and investment products. The red line shows confirmed portfolio values from real account snapshots; the blue dashed line projects forward at a blended 10% annual market rate to illustrate potential growth through year-end.
          </p>
        </CardContent>
      </Card>

      {/* Performance Metrics */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Performance by Period */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 flex-wrap">
                <CardTitle>Performance by Period</CardTitle>
                <span className="text-xs text-muted-foreground border border-border rounded-full px-2 py-0.5">
                  {hasAnyPeriodReturn ? 'Historical data' : 'Limited history'}
                </span>
                {yearHistory?.historySource === "historical_estimate" && (
                  <span className="text-xs bg-amber-100 text-amber-800 px-2 py-1 rounded">
                    Uses estimated history
                  </span>
                )}
              </div>
              {hasAnyPeriodReturn && (
                <div className="flex items-center space-x-4 text-sm">
                  <div className="flex items-center space-x-2">
                    <div className="w-3 h-3 bg-red-500 rounded-full"></div>
                    <span>Your Portfolio</span>
                  </div>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {hasAnyPeriodReturn ? (
              <>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={periodPerformanceData.filter(d => d.portfolioReturn !== null)}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                      <XAxis dataKey="period" stroke="#6B7280" fontSize={12} />
                      <YAxis stroke="#6B7280" fontSize={12} tickFormatter={(value) => `${value.toFixed(1)}%`} />
                      <Tooltip 
                        formatter={(value: number) => [
                          `${value.toFixed(2)}%`,
                          'Your Portfolio Return'
                        ]}
                        contentStyle={{ backgroundColor: 'white', border: '1px solid #E5E7EB', borderRadius: '8px' }}
                      />
                      <Line 
                        type="monotone" 
                        dataKey="portfolioReturn" 
                        stroke="#ef4444" 
                        strokeWidth={3}
                        dot={{ fill: "#ef4444", strokeWidth: 2, r: 4 }}
                        activeDot={{ r: 6, fill: "#ef4444" }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                  {periodPerformanceData.map((item) => (
                    <div key={item.period} className="text-center p-3 bg-gray-50 rounded-lg">
                      <p className="text-xs text-gray-600 mb-1">{item.period}</p>
                      {item.portfolioReturn !== null ? (
                        <p className={`text-sm font-bold ${item.portfolioReturn > 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {item.portfolioReturn > 0 ? '+' : ''}{item.portfolioReturn.toFixed(1)}%
                        </p>
                      ) : (
                        <p className="text-sm text-gray-400">N/A</p>
                      )}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-medium text-amber-900">Insufficient history</p>
                <p className="mt-1 text-sm text-amber-800">
                  Period returns will appear as real daily snapshots accumulate. At least two snapshots
                  separated by the relevant time window are needed for each period.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Risk Metrics */}
        <Card>
          <CardHeader>
            <CardTitle>Risk Metrics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <p className="text-xs text-gray-600 mb-1">YTD Return</p>
                  {metricsLoading ? (
                    <p className="text-sm font-bold text-gray-300">—</p>
                  ) : realMetrics?.periodReturns?.ytd !== null && realMetrics !== undefined ? (
                    <p className={`text-sm font-bold ${realMetrics.periodReturns.ytd! >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {realMetrics.periodReturns.ytd! >= 0 ? '+' : ''}{realMetrics.periodReturns.ytd!.toFixed(2)}%
                    </p>
                  ) : (
                    <p className="text-sm text-gray-400">—</p>
                  )}
                </div>
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <p className="text-xs text-gray-600 mb-1">Annualised (CAGR)</p>
                  {metricsLoading ? (
                    <p className="text-sm font-bold text-gray-300">—</p>
                  ) : realMetrics?.cagr !== null && realMetrics !== undefined ? (
                    <p className={`text-sm font-bold ${realMetrics.cagr! >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {realMetrics.cagr! >= 0 ? '+' : ''}{realMetrics.cagr!.toFixed(2)}%
                    </p>
                  ) : (
                    <p className="text-sm text-gray-400">—</p>
                  )}
                </div>
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <p className="text-xs text-gray-600 mb-1">Data Quality</p>
                  <p className="text-sm font-bold text-gray-700 capitalize">
                    {metricsLoading ? '—' : realMetrics?.riskMetricsState ?? 'limited'}
                  </p>
                </div>
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <p className="text-xs text-gray-600 mb-1">Risk-Free Rate</p>
                  <p className="text-sm font-bold text-gray-700">
                    {metricsLoading ? '—' : `${realMetrics?.riskFreeRate ?? 4.00}%`}
                  </p>
                </div>
              </div>
              {realMetrics?.canComputeRiskMetrics && (
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'Sharpe Ratio',   value: realMetrics.sharpe,               unit: '' },
                    { label: 'Volatility p.a.', value: realMetrics.annualizedVolatility, unit: '%' },
                    { label: 'Max Drawdown',    value: realMetrics.maxDrawdown,          unit: '%' },
                  ].map(({ label, value, unit }) => (
                    <div key={label} className="text-center p-3 bg-gray-50 rounded-lg">
                      <p className="text-xs text-gray-600 mb-1">{label}</p>
                      {value !== null && value !== undefined ? (
                        <p className="text-sm font-bold text-gray-800">{value}{unit}</p>
                      ) : (
                        <p className="text-sm text-gray-400">—</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {!metricsLoading && (() => {
                const state = realMetrics?.riskMetricsState;
                if (state === 'limited') return (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                    <p className="text-xs font-medium text-amber-900">Building performance history</p>
                    <p className="text-xs text-amber-800 mt-1">
                      Risk metrics will appear once sufficient portfolio history and variability are observed.
                    </p>
                  </div>
                );
                if (state === 'estimated') return (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                    <p className="text-xs font-medium text-amber-900">Building performance history</p>
                    <p className="text-xs text-amber-800 mt-1">
                      Metrics will appear as more real portfolio data is recorded. Current values are based on reconstructed history.
                    </p>
                  </div>
                );
                return (
                  <div className="rounded-lg border border-green-200 bg-green-50 p-3">
                    <p className="text-xs font-medium text-green-900">Historical data</p>
                    <p className="text-xs text-green-800 mt-1">
                      Metrics are based on observed portfolio performance.
                    </p>
                  </div>
                );
              })()}
              {!metricsLoading && realMetrics?.hasUnpricedAssets && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <p className="text-xs font-medium text-amber-900">Unpriced assets detected</p>
                  <p className="text-xs text-amber-800 mt-1">
                    One or more investments are missing live price or NAV data and are excluded from portfolio totals.
                  </p>
                </div>
              )}
              {!portfolioLoading && portfolio?.hasUnpricedWallets && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <p className="text-xs font-medium text-amber-900">Unpriced wallets detected</p>
                  <p className="text-xs text-amber-800 mt-1">
                    {portfolio.unpricedCurrencies?.length
                      ? `No FX rate available for: ${portfolio.unpricedCurrencies.join(", ")}. `
                      : ""}
                    These wallet balances are excluded from your total and may understate your net worth.
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Investment Value Since 1 Jan 2026 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle>Investment Value Since 1 Jan 2026</CardTitle>
              <span className="text-xs text-muted-foreground border border-border rounded-full px-2 py-0.5">
                Actual IRR projection
              </span>
            </div>
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <div className="w-4 h-0.5 bg-red-500 rounded"></div>
                <span>Actual</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-4 h-0.5 bg-blue-500 rounded" style={{ borderTop: '2px dashed #3b82f6', background: 'none' }}></div>
                <span>Estimated (actual IRR)</span>
              </div>
            </div>
          </div>
          {investmentYtdHistory?.openingValue && (
            <div className="flex items-center gap-4 mt-2 text-sm flex-wrap">
              <span className="text-muted-foreground">
                Opening (Jan 1): <span className="font-medium text-foreground">${investmentYtdHistory.openingValue.toLocaleString()}</span>
              </span>
              {(() => {
                const ret = parseFloat(investmentYtdHistory.totalReturnPercent ?? '0');
                if (investmentYtdHistory.totalReturnPercent) {
                  return (
                    <span className={ret >= 0 ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
                      YTD actual: {ret >= 0 ? '+' : ''}{ret.toFixed(2)}%
                    </span>
                  );
                }
                return null;
              })()}
            </div>
          )}
        </CardHeader>
        <CardContent>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={investmentChartData}
                margin={{ top: 5, right: 20, left: 20, bottom: 55 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                <XAxis
                  dataKey="month"
                  stroke="#6B7280"
                  fontSize={11}
                  interval={0}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis
                  stroke="#6B7280"
                  fontSize={12}
                  tickFormatter={(v) => `$${(v / 1_000_000).toFixed(2)}M`}
                  width={72}
                />
                <Tooltip
                  formatter={(value: number, name: string) => [
                    `$${value.toLocaleString()}`,
                    name === 'historical' ? 'Actual' : 'Estimated (actual IRR)',
                  ]}
                  contentStyle={{ backgroundColor: 'white', border: '1px solid #E5E7EB', borderRadius: '8px' }}
                />
                <Line
                  type="monotone"
                  dataKey="projected"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  dot={false}
                  activeDot={{ r: 4, fill: '#3b82f6' }}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="historical"
                  stroke="#ef4444"
                  strokeWidth={3}
                  dot={{ fill: '#ef4444', strokeWidth: 2, r: 4 }}
                  activeDot={{ r: 6, fill: '#ef4444' }}
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Isolates the performance of your structured investment products — real estate, corporate credit, venture capital, and digital asset allocations. The red line reflects confirmed investment values from real snapshots; the blue dashed line projects each product's growth forward using its actual contracted IRR, giving a fund-level view of your investment portfolio separate from liquid assets.
          </p>
        </CardContent>
      </Card>

    </div>
  );
}
