import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useFxRates, useFxRate } from "@/hooks/use-fx-rates";
import { useWallets } from "@/hooks/use-portfolio";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ArrowRightLeft, TrendingUp, TrendingDown, Wallet, Phone, MessageSquare, X } from "lucide-react";

const currencies = [
  { code: "USD", name: "US Dollar", flag: "🇺🇸" },
  { code: "CAD", name: "Canadian Dollar", flag: "🇨🇦" },
  { code: "EUR", name: "Euro", flag: "🇪🇺" },
  { code: "GBP", name: "British Pound", flag: "🇬🇧" },
  { code: "AUD", name: "Australian Dollar", flag: "🇦🇺" },
  { code: "HKD", name: "Hong Kong Dollar", flag: "🇭🇰" },
  { code: "BTC", name: "Bitcoin", flag: "₿" },
  { code: "ETH", name: "Ethereum", flag: "Ξ" },
  { code: "USDT", name: "Tether", flag: "💵" },
  { code: "USDC", name: "USD Coin", flag: "🪙" },
];

export default function FxExchange() {
  const [fromCurrency, setFromCurrency] = useState("USD");
  const [toCurrency, setToCurrency] = useState("CAD");
  const [amount, setAmount] = useState("10000");
  const [showAdvisorBox, setShowAdvisorBox] = useState(true);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: wallets = [] } = useWallets();

  const { data: fxRates, isLoading: ratesLoading } = useFxRates();
  const { data: fxRate, isLoading: rateLoading } = useFxRate(fromCurrency, toCurrency);

  const exchangeMutation = useMutation({
    mutationFn: async (data: { fromCurrency: string; toCurrency: string; amount: number }) => {
      console.log("Making exchange API call with data:", data);
      const response = await apiRequest("POST", "/api/fx-exchange", data);
      if (!response.ok) {
        throw new Error('Exchange failed');
      }
      const result = await response.json();
      console.log("Exchange API result:", result);
      return result;
    },
    onSuccess: (data) => {
      console.log("Exchange mutation onSuccess called with data:", data);
      toast({
        title: "Exchange Successful",
        description: `Successfully exchanged ${amount} ${fromCurrency} to ${data.convertedAmount?.toLocaleString()} ${toCurrency}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wallets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio/allocation"] });
      queryClient.invalidateQueries({ queryKey: ["/api/investment-breakdown"] });
    },
    onError: (error) => {
      console.error("Exchange mutation error:", error);
      toast({
        title: "Exchange Failed",
        description: "There was an error processing your exchange. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleExchange = () => {
    if (!amount || parseFloat(amount) <= 0) {
      toast({
        title: "Invalid Amount",
        description: "Please enter a valid amount to exchange.",
        variant: "destructive",
      });
      return;
    }

    console.log("handleExchange called with:", { fromCurrency, toCurrency, amount });
    console.log("Starting exchange mutation...");
    
    exchangeMutation.mutate({
      fromCurrency,
      toCurrency,
      amount: parseFloat(amount),
    });
  };

  const exchangeRate = fxRate ? parseFloat(fxRate.rate) : 1;
  const spread = fxRate ? parseFloat(fxRate.spread) : 0.005;
  const grossConverted = parseFloat(amount || "0") * exchangeRate;
  const fee = grossConverted * spread; // Use live spread from API (not hardcoded)
  const convertedAmount = grossConverted - fee;
  
  // Get wallet balances for display
  const fromWallet = wallets.find((w: any) => w.currency === fromCurrency);
  const toWallet = wallets.find((w: any) => w.currency === toCurrency);
  const fromBalance = fromWallet ? parseFloat(fromWallet.balance) : 0;
  const toBalance = toWallet ? parseFloat(toWallet.balance) : 0;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">FX Exchange</h1>
        <p className="text-gray-600">Exchange currencies with competitive rates</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Exchange Form */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Currency Exchange</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="from-currency">From</Label>
                    <Select value={fromCurrency} onValueChange={setFromCurrency}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {currencies.map((currency) => (
                          <SelectItem key={currency.code} value={currency.code}>
                            {currency.flag} {currency.code} - {currency.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex items-center mt-1 text-sm text-gray-600">
                      <Wallet className="w-4 h-4 mr-1" />
                      <span>Available: {fromBalance.toLocaleString()} {fromCurrency}</span>
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="amount">Amount</Label>
                    <Input
                      id="amount"
                      type="number"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="Enter amount"
                    />
                  </div>
                </div>
                
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="to-currency">To</Label>
                    <Select value={toCurrency} onValueChange={setToCurrency}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {currencies.map((currency) => (
                          <SelectItem key={currency.code} value={currency.code}>
                            {currency.flag} {currency.code} - {currency.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex items-center mt-1 text-sm text-gray-600">
                      <Wallet className="w-4 h-4 mr-1" />
                      <span>Available: {toBalance.toLocaleString()} {toCurrency}</span>
                    </div>
                  </div>
                  <div>
                    <Label>You'll receive</Label>
                    <div className="w-full px-4 py-3 bg-gray-50 border border-gray-300 rounded-lg text-lg font-semibold text-gray-900">
                      {convertedAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} {toCurrency}
                    </div>
                  </div>
                </div>
              </div>
              
              <div className="mt-6 p-4 bg-gray-50 rounded-lg">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">Exchange Rate</span>
                  <span className="font-medium">
                    {rateLoading ? "Loading..." : `1 ${fromCurrency} = ${exchangeRate.toFixed(4)} ${toCurrency}`}
                  </span>
                </div>
                {!rateLoading && (fxRate as any)?.isStale && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                    <span>⚠</span>
                    <span>
                      Rate data is {(fxRate as any).rateAgeMinutes} min old — live refresh may have been delayed. Rate shown reflects last confirmed market data.
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between text-sm mt-2">
                  <span className="text-gray-600">Processing Fee</span>
                  <span className="font-medium">
                    0.5% ({fee.toFixed(2)} {toCurrency})
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm mt-2">
                  <span className="text-gray-600">Estimated completion</span>
                  <span className="font-medium">Instant</span>
                </div>
              </div>
              
              <Button 
                className="w-full mt-6" 
                onClick={handleExchange}
                disabled={exchangeMutation.isPending || rateLoading}
              >
                {exchangeMutation.isPending ? "Processing..." : "Exchange Now"}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Live Rates */}
        <div>
          <Card>
            <CardHeader>
              <CardTitle>Live Exchange Rates</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {fxRates?.map((rate: any) => {
                  const rateValue = parseFloat(rate.rate);

                  return (
                    <div key={`${rate.baseCurrency}-${rate.targetCurrency}`} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                      <div>
                        <p className="font-medium">{rate.baseCurrency}/{rate.targetCurrency}</p>
                        <p className="text-sm text-gray-600">
                          {currencies.find(c => c.code === rate.baseCurrency)?.name} to {currencies.find(c => c.code === rate.targetCurrency)?.name}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold">{rateValue.toFixed(4)}</p>
                        {rate.isStale ? (
                          <span className="text-xs text-amber-600">⚠ {rate.rateAgeMinutes}m ago</span>
                        ) : (
                          <span className="text-xs text-green-600">
                            {rate.rateAgeMinutes !== null ? `${rate.rateAgeMinutes}m ago` : "Live rate"}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Floating Contact Your Advisor Box */}
      {showAdvisorBox && (
        <div className="fixed top-4 right-4 z-50 w-80">
          <Card className="backdrop-blur-sm bg-white/95 border-purple-200 shadow-lg">
            <CardContent className="p-4">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center space-x-2">
                  <div className="w-8 h-8 bg-purple-600 rounded-full flex items-center justify-center">
                    <MessageSquare className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm">Wealth Planner</h3>
                    <p className="text-xs text-gray-600">Advisory Team</p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAdvisorBox(false)}
                  className="h-6 w-6 p-0 hover:bg-gray-100"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
              
              <p className="text-xs text-gray-700 mb-3">
                Need help with currency exchange? Our wealth planners are here to assist.
              </p>
              
              <div className="flex items-center space-x-2 text-purple-600 mb-3">
                <Phone className="w-3 h-3" />
                <span className="font-medium text-xs">+61 2 8320 1908</span>
              </div>
              
              <div className="flex space-x-2">
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => window.open('tel:+61283201908', '_self')}
                  className="flex-1 text-xs h-8"
                >
                  <Phone className="w-3 h-3 mr-1" />
                  Call
                </Button>
                <Button 
                  size="sm"
                  className="flex-1 bg-purple-600 hover:bg-purple-700 text-xs h-8"
                >
                  <MessageSquare className="w-3 h-3 mr-1" />
                  Message
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
