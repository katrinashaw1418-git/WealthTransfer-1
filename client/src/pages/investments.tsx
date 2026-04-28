import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from "@/components/ui/dialog";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useWallets } from "@/hooks/use-portfolio";
import { TrendingUp, DollarSign, Clock, Shield, Filter, X, ChevronDown } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { InvestmentPerformanceChart } from "@/components/dashboard/investment-performance-chart";
import { KillSwitchBanner } from "@/components/kill-switch-banner";
import {
  isKnownProductCategory,
  PRODUCT_CATEGORY_LABELS,
  productCategoryIcon,
} from "@shared/product-categories";
import {
  RISK_PROFILE_LABELS,
  riskProfileLabel,
  toKnownRiskProfile,
  type KnownRiskProfile,
} from "@shared/risk-profiles";

const riskProfileColors: Record<KnownRiskProfile, string> = {
  low: "bg-green-100 text-green-800",
  conservative: "bg-green-100 text-green-800",
  moderate: "bg-yellow-100 text-yellow-800",
  high: "bg-red-100 text-red-800",
  very_high: "bg-red-200 text-red-900",
};

const returnTypeColors = {
  income: "bg-blue-100 text-blue-800",
  capital_gains: "bg-purple-100 text-purple-800",
  blended: "bg-indigo-100 text-indigo-800",
  yield: "bg-green-100 text-green-800",
};

export default function Investments() {
  const [filters, setFilters] = useState<{ category?: string; riskProfile?: string; liquidity?: string }>({});
  const [investmentAmount, setInvestmentAmount] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<any>(null);
  const [selectedCurrency, setSelectedCurrency] = useState("USD");
  const [investModalOpen, setInvestModalOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: products, isLoading: productsLoading } = useQuery({
    queryKey: ["/api/investment-products", filters],
    queryFn: () => api.getInvestmentProducts(filters),
  });

  const { data: userInvestments, isLoading: investmentsLoading } = useQuery({
    queryKey: ["/api/user-investments"],
    queryFn: () => api.getUserInvestments(),
    refetchInterval: 5000, // Refresh every 5 seconds to track investment changes
  });

  const { data: wallets } = useWallets();

  // Fetch FX rates for currency conversion
  const { data: fxRates } = useQuery({
    queryKey: ["/api/fx-rates"],
    queryFn: () => api.getFxRates(),
  });

  const investMutation = useMutation({
    mutationFn: (data: { productId: number; amount: number; sourceCurrency?: string; sourceAmount?: number }) =>
      apiRequest("POST", "/api/investments", data).then(r => r.json()),
    onSuccess: (response) => {
      toast({
        title: "Investment Created",
        description: `Investment instruction submitted for $${parseFloat(response.investment.investedAmount).toLocaleString()}. Updated available balance: $${parseFloat(response.newBalance).toLocaleString()}`,
      });
      // Invalidate multiple queries to update UI
      queryClient.invalidateQueries({ queryKey: ["/api/user-investments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wallets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio/allocation"] });
      queryClient.invalidateQueries({ queryKey: ["/api/investment-breakdown"] });
      queryClient.invalidateQueries({ queryKey: ["/api/investment-performance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/transactions"] });
      setInvestModalOpen(false);
      setInvestmentAmount("");
      setSelectedProduct(null);
    },
    onError: (error: any) => {
      toast({
        title: "Investment Failed",
        description: error.message || "Unable to create investment. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleInvest = () => {
    if (!selectedProduct || !investmentAmount) {
      toast({
        title: "Missing Information",
        description: "Please enter an investment amount.",
        variant: "destructive",
      });
      return;
    }

    const amount = parseFloat(investmentAmount);
    const minimumInvestment = parseFloat(selectedProduct.minimumInvestment);
    
    // Convert to USD if needed
    const usdAmount = selectedCurrency === 'USD' ? amount : getUsdEquivalent(amount, selectedCurrency);

    if (usdAmount === null) {
      toast({
        title: "Rate unavailable",
        description: `Live ${selectedCurrency}/USD pricing is currently unavailable. Please try again shortly.`,
        variant: "destructive",
      });
      return;
    }

    if (usdAmount < minimumInvestment) {
      toast({
        title: "Below Minimum",
        description: `Minimum investment is $${minimumInvestment.toLocaleString()} USD`,
        variant: "destructive",
      });
      return;
    }

    if (amount > availableBalance) {
      toast({
        title: "Insufficient Funds",
        description: `You have ${currencySymbols[selectedCurrency] || selectedCurrency}${availableBalance.toLocaleString()} available in your ${selectedCurrency} account.`,
        variant: "destructive",
      });
      return;
    }

    // Create investment with source currency info for proper account deduction
    investMutation.mutate({
      productId: selectedProduct.id,
      amount: usdAmount, // USD equivalent for investment
      sourceCurrency: selectedCurrency,
      sourceAmount: amount, // Original currency amount for wallet deduction
    });
  };

  const clearFilters = () => {
    setFilters({});
  };

  const hasActiveFilters = Object.values(filters).some(Boolean);

  const totalInvested = userInvestments?.reduce((sum: number, inv: any) => sum + parseFloat(inv.investedAmount), 0) || 0;
  const totalCurrentValue = userInvestments?.reduce((sum: number, inv: any) => sum + parseFloat(inv.currentValue), 0) || 0;
  const totalReturn = totalCurrentValue - totalInvested;
  const totalReturnPercent = totalInvested > 0 ? (totalReturn / totalInvested) * 100 : 0;

  // Currency selection and conversion logic
  const selectedWallet = wallets?.find((w: any) => w.currency === selectedCurrency);
  const availableBalance = selectedWallet?.availableBalance ? parseFloat(selectedWallet.availableBalance) : 0;
  


  // Get available currencies from wallets with proper symbols
  const currencySymbols: Record<string, string> = {
    'USD': '$',
    'CAD': 'C$',
    'EUR': '€',
    'GBP': '£',
    'AUD': 'A$',
    'HKD': 'HK$',
    'SGD': 'S$',
    'BTC': '₿',
    'ETH': 'Ξ',
    'USDT': '₮',
    'USDC': '◎'
  };

  const availableCurrencies = wallets?.map((wallet: any) => ({
    currency: wallet.currency,
    balance: parseFloat(wallet.availableBalance || '0'),
    displayName: wallet.displayName || wallet.currency,
    symbol: currencySymbols[wallet.currency] || wallet.currency
  })) || [];

  // Convert to USD for display if not USD
  const getUsdEquivalent = (amount: number, currency: string): number | null => {
    if (currency === 'USD') return amount;
    
    // Look for direct rate from currency to USD
    let rate = fxRates?.find((r: any) => r.baseCurrency === currency && r.targetCurrency === 'USD')?.rate;
    
    // If not found, look for USD to currency rate and invert it
    if (!rate) {
      const inverseRate = fxRates?.find((r: any) => r.baseCurrency === 'USD' && r.targetCurrency === currency)?.rate;
      if (inverseRate) {
        rate = 1 / parseFloat(inverseRate);
      }
    }
    
    // Parse the rate as it comes as string from API
    if (rate) {
      rate = parseFloat(rate);
    }
    
    // No live rate available — return null so callers can show "unavailable"
    // rather than silently using a stale hardcoded value.
    if (!rate) return null;

    return amount * rate;
  };

  if (productsLoading || investmentsLoading) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Skeleton className="h-8 w-48 mb-2" />
            <Skeleton className="h-4 w-64" />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <Skeleton className="h-6 w-3/4 mb-4" />
                <Skeleton className="h-4 w-full mb-2" />
                <Skeleton className="h-4 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <KillSwitchBanner
        switches={["transactions"]}
        message="New investment buys are temporarily paused. You can still view your existing positions and performance."
      />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Investment Products</h1>
          <p className="text-gray-600">Wholesale products — for eligible investors only. All investments carry risk of capital loss.</p>
        </div>
      </div>

      {/* Portfolio Overview */}
      {userInvestments && userInvestments.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <Card className="flex flex-col h-32">
            <CardContent className="p-4 flex flex-col justify-between h-full">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-medium text-gray-500">Total Invested</h3>
                <DollarSign className="w-3 h-3 text-primary" />
              </div>
              <div className="flex flex-col justify-end h-16">
                <div className="flex items-end h-6">
                  <p className="text-lg font-bold whitespace-nowrap overflow-hidden text-ellipsis w-full leading-none">${totalInvested.toLocaleString()}</p>
                </div>
                <div className="h-4"></div>
              </div>
            </CardContent>
          </Card>
          <Card className="flex flex-col h-32">
            <CardContent className="p-4 flex flex-col justify-between h-full">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-medium text-gray-500">Current Value</h3>
                <TrendingUp className="w-3 h-3 text-green-600" />
              </div>
              <div className="flex flex-col justify-end h-16">
                <div className="flex items-end h-6">
                  <p className="text-lg font-bold whitespace-nowrap overflow-hidden text-ellipsis w-full leading-none">${totalCurrentValue.toLocaleString()}</p>
                </div>
                <div className="h-4"></div>
              </div>
            </CardContent>
          </Card>
          <Card className="flex flex-col h-32">
            <CardContent className="p-4 flex flex-col justify-between h-full">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <h3 className="text-xs font-medium text-gray-500">Total Return</h3>
                  <span className={`text-xs ${totalReturnPercent >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {totalReturnPercent >= 0 ? '+' : ''}{totalReturnPercent.toFixed(2)}%
                  </span>
                </div>
                <TrendingUp className="w-3 h-3 text-secondary" />
              </div>
              <div className="flex flex-col justify-end h-16">
                <div className="flex items-end h-6">
                  <p className={`text-lg font-bold whitespace-nowrap overflow-hidden text-ellipsis w-full leading-none ${totalReturn >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    ${totalReturn.toLocaleString()}
                  </p>
                </div>
                <div className="h-4"></div>
              </div>
            </CardContent>
          </Card>
          <Card className="flex flex-col h-32">
            <CardContent className="p-4 flex flex-col justify-between h-full">
              <div className="flex items-center space-x-2">
                <h3 className="text-xs font-medium text-gray-500">Cash Allocation (via external custodian)</h3>
                <Select value={selectedCurrency} onValueChange={setSelectedCurrency}>
                  <SelectTrigger className="w-auto min-w-12 h-5 text-xs border border-green-200 rounded px-1 py-0 focus:ring-1 focus:ring-green-500 bg-green-50 hover:bg-green-100 transition-colors font-semibold text-green-700">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableCurrencies.map((currency: any) => (
                      <SelectItem key={currency.currency} value={currency.currency}>
                        <span className="font-medium">{currency.currency}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col justify-end h-16">
                <div className="flex items-end h-6">
                  <p className="text-lg font-bold text-green-600 whitespace-nowrap overflow-hidden text-ellipsis w-full leading-none">
                    {currencySymbols[selectedCurrency] || selectedCurrency}{availableBalance.toLocaleString()}
                  </p>
                </div>
                <div className="h-4 flex items-center">
                  {selectedCurrency !== 'USD' && (
                    <span className="text-xs text-gray-600">
                      {getUsdEquivalent(availableBalance, selectedCurrency) !== null
                        ? `US$${getUsdEquivalent(availableBalance, selectedCurrency)!.toLocaleString()}`
                        : "Rate unavailable"}
                    </span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Performance by Period Chart */}
      {userInvestments && userInvestments.length > 0 && (
        <InvestmentPerformanceChart />
      )}

      {/* Filters */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Filter className="w-4 h-4" />
              Filter Products
            </CardTitle>
            {hasActiveFilters && (
              <Button variant="outline" size="sm" onClick={clearFilters}>
                <X className="w-3 h-3 mr-1" />
                Clear
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label>Category</Label>
              <Select value={filters.category || "all"} onValueChange={(value) => 
                setFilters({...filters, category: value === "all" ? undefined : value})
              }>
                <SelectTrigger>
                  <SelectValue placeholder="All categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  {Object.entries(PRODUCT_CATEGORY_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Risk Profile</Label>
              <Select value={filters.riskProfile || "all"} onValueChange={(value) => 
                setFilters({...filters, riskProfile: value === "all" ? undefined : value})
              }>
                <SelectTrigger>
                  <SelectValue placeholder="All risk levels" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Risk Levels</SelectItem>
                  {Object.entries(RISK_PROFILE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Liquidity</Label>
              <Select value={filters.liquidity || "all"} onValueChange={(value) => 
                setFilters({...filters, liquidity: value === "all" ? undefined : value})
              }>
                <SelectTrigger>
                  <SelectValue placeholder="All liquidity types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                  <SelectItem value="locked">Locked Term</SelectItem>
                  <SelectItem value="illiquid">Long-term Lock-in</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Investment Products Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {products?.map((product: any) => {
          const category: string | null | undefined = product.category;
          const CategoryIcon = productCategoryIcon(category);
          const categoryLabel = isKnownProductCategory(category)
            ? PRODUCT_CATEGORY_LABELS[category]
            : "Other";
          const minimumInvestment = parseFloat(product.minimumInvestment);
          
          return (
            <Card key={product.id} className="hover:shadow-lg transition-shadow flex flex-col h-full">
              <CardContent className="p-6 flex flex-col flex-grow">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center space-x-3">
                    <div className="p-2 bg-primary/10 rounded-lg">
                      <CategoryIcon className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-lg">{product.name}</h3>
                      <p className="text-sm text-muted-foreground">
                        {categoryLabel}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 mb-4">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Indicative Return:</span>
                    <span className="font-semibold text-green-600 text-right">{product.targetNetIrr}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Term:</span>
                    <span className="font-medium text-right">{product.term}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Min. Investment:</span>
                    <span className="font-medium text-right">${minimumInvestment.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Capital Invested:</span>
                    <span className="font-medium text-blue-600 text-right">${userInvestments?.filter((inv: any) => inv.productId === product.id).reduce((sum: number, inv: any) => sum + parseFloat(inv.investedAmount), 0).toLocaleString() || '0'}</span>
                  </div>
                </div>

                <div className="flex gap-2 mb-4">
                  {(() => {
                    const known = toKnownRiskProfile(product.riskProfile);
                    return (
                      <Badge className={known ? riskProfileColors[known] : undefined}>
                        {riskProfileLabel(product.riskProfile)}
                      </Badge>
                    );
                  })()}
                  <Badge className={returnTypeColors[product.returnType as keyof typeof returnTypeColors]}>
                    {product.returnType.replace('_', ' ')}
                  </Badge>
                </div>

                <p className="text-sm text-muted-foreground mb-6 line-clamp-3 flex-grow">
                  {product.investmentStrategy}
                </p>

                <div className="space-y-2 mt-auto">
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button variant="outline" className="w-full">
                        View Details
                      </Button>
                    </DialogTrigger>
                  <DialogContent className="max-w-2xl">
                    <DialogHeader>
                      <DialogTitle>{product.name}</DialogTitle>
                      <DialogDescription>
                        {categoryLabel} Investment Product
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div>
                        <h4 className="font-semibold mb-2">Investment Strategy</h4>
                        <p className="text-sm text-muted-foreground">{product.investmentStrategy}</p>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <h4 className="font-semibold mb-2">Key Details</h4>
                          <div className="space-y-2 text-sm">
                            <div className="flex justify-between">
                              <span>Target Net IRR:</span>
                              <span className="font-semibold text-green-600">{product.targetNetIrr}</span>
                            </div>
                            {product.grossIrr && (
                              <div className="flex justify-between">
                                <span>Gross IRR:</span>
                                <span className="font-semibold">{product.grossIrr}</span>
                              </div>
                            )}
                            {product.moic && (
                              <div className="flex justify-between">
                                <span>MOIC:</span>
                                <span className="font-semibold">{product.moic}</span>
                              </div>
                            )}
                            <div className="flex justify-between">
                              <span>Term:</span>
                              <span className="font-medium">{product.term}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>Structure:</span>
                              <span className="font-medium">{product.structure}</span>
                            </div>
                          </div>
                        </div>
                        
                        <div>
                          <h4 className="font-semibold mb-2">Terms & Conditions</h4>
                          <div className="space-y-2 text-sm">
                            <div className="flex justify-between">
                              <span>Distributions:</span>
                              <span className="font-medium">{product.distributions}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>Liquidity:</span>
                              <span className="font-medium">{product.liquidity}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>Min. Investment:</span>
                              <span className="font-medium">${minimumInvestment.toLocaleString()}</span>
                            </div>
                            {product.lvr && (
                              <div className="flex justify-between">
                                <span>LVR:</span>
                                <span className="font-medium">{product.lvr}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </DialogContent>
                  </Dialog>

                  <Button 
                    className="w-full"
                    onClick={() => {
                      setSelectedProduct(product);
                      setInvestModalOpen(true);
                    }}
                  >
                    Submit Investment Instruction
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Investment Modal */}
      <Dialog open={investModalOpen} onOpenChange={setInvestModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invest in {selectedProduct?.name}</DialogTitle>
            <DialogDescription>
              Enter your investment amount below
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="amount">Investment Amount ({selectedCurrency})</Label>
              <Input
                id="amount"
                type="number"
                value={investmentAmount}
                onChange={(e) => setInvestmentAmount(e.target.value)}
                placeholder={`Enter amount in ${selectedCurrency}`}
              />
              {selectedProduct && (
                <div className="mt-1 space-y-1">
                  <p className="text-xs text-muted-foreground">
                    Minimum: ${parseFloat(selectedProduct.minimumInvestment).toLocaleString()} USD
                  </p>
                  <p className="text-xs font-medium text-blue-600">
                    Capital Invested: ${userInvestments?.filter((inv: any) => inv.productId === selectedProduct.id).reduce((sum: number, inv: any) => sum + parseFloat(inv.investedAmount), 0).toLocaleString() || '0'} USD
                  </p>
                  <p className="text-xs font-medium text-green-600">
                    Available to Invest: {currencySymbols[selectedCurrency] || selectedCurrency}{availableBalance.toLocaleString()}
                    {selectedCurrency !== 'USD' && (() => {
                      const eq = getUsdEquivalent(availableBalance, selectedCurrency);
                      return eq !== null ? ` (≈ US$${eq.toLocaleString()})` : " (rate unavailable)";
                    })()}
                  </p>

                  {selectedCurrency !== 'USD' && investmentAmount && (() => {
                    const eq = getUsdEquivalent(parseFloat(investmentAmount), selectedCurrency);
                    return eq !== null ? (
                      <p className="text-xs text-orange-600">
                        Will convert {currencySymbols[selectedCurrency] || selectedCurrency}{parseFloat(investmentAmount).toLocaleString()} → US${eq.toLocaleString()} at current exchange rate
                      </p>
                    ) : (
                      <p className="text-xs text-red-600">
                        Live {selectedCurrency}/USD rate unavailable — cannot estimate USD equivalent.
                      </p>
                    );
                  })()}
                </div>
              )}
            </div>
            
            {selectedProduct && (
              <div className="p-4 bg-gray-50 rounded-lg">
                <h4 className="font-semibold mb-2">Investment Summary</h4>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span>Indicative Return:</span>
                    <span className="font-semibold text-green-600">{selectedProduct.targetNetIrr}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Term:</span>
                    <span className="font-medium">{selectedProduct.term}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Risk Profile:</span>
                    {(() => {
                      const known = toKnownRiskProfile(selectedProduct.riskProfile);
                      return (
                        <Badge className={known ? riskProfileColors[known] : undefined}>
                          {riskProfileLabel(selectedProduct.riskProfile)}
                        </Badge>
                      );
                    })()}
                  </div>
                </div>
              </div>
            )}

            <Button 
              onClick={handleInvest} 
              disabled={investMutation.isPending}
              className="w-full"
            >
              {investMutation.isPending ? "Processing..." : "Confirm Investment"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div className="mt-8 pt-4 border-t border-gray-200">
        <p className="text-xs text-gray-400 leading-relaxed">
          Past performance is not a reliable indicator of future performance. Indicative returns are targets only and are not guaranteed. All investments carry risk including potential loss of capital. Information on this page is general in nature and does not constitute personal financial product advice. AMAX Wealth is an Authorised Representative of the AFSL holder. Client assets are held with external regulated custodians and are not held by AMAX Wealth.
        </p>
      </div>
    </div>
  );
}