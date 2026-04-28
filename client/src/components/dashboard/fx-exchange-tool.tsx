import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useFxRate } from "@/hooks/use-fx-rates";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { KillSwitchBanner } from "@/components/kill-switch-banner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const currencies = [
  { code: "USD", name: "US Dollar" },
  { code: "CAD", name: "Canadian Dollar" },
  { code: "EUR", name: "Euro" },
  { code: "GBP", name: "British Pound" },
  { code: "AUD", name: "Australian Dollar" },
  { code: "HKD", name: "Hong Kong Dollar" },
  { code: "BTC", name: "Bitcoin" },
  { code: "ETH", name: "Ethereum" },
  { code: "USDT", name: "Tether" },
  { code: "USDC", name: "USD Coin" },
];

export default function FxExchangeTool() {
  const [fromCurrency, setFromCurrency] = useState("USD");
  const [toCurrency, setToCurrency] = useState("CAD");
  const [amount, setAmount] = useState("10000");
  const [showAfslHandoff, setShowAfslHandoff] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: fxRate, isLoading: rateLoading } = useFxRate(fromCurrency, toCurrency);

  const exchangeMutation = useMutation({
    mutationFn: (data: { fromCurrency: string; toCurrency: string; amount: number }) =>
      api.createFxExchange(data),
    onSuccess: () => {
      toast({
        title: "Exchange Successful",
        description: "Your FX exchange has been completed successfully.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wallets"] });
    },
    onError: () => {
      toast({
        title: "Exchange Failed",
        description: "There was an error processing your exchange. Please try again.",
        variant: "destructive",
      });
    },
  });

  // Task #337 — when an investor proceeds with an FX conversion, the
  // execution actually hands off to AMAX Global (AUSTRAC-registered DCE
  // / remittance), which sits outside AMAX Wealth's AFSL. Investors must
  // be told they're crossing that boundary before the request is sent,
  // so we open an interstitial AlertDialog and only fire the mutation
  // after the user explicitly confirms. Cancel returns them to this
  // screen with no API call made.
  const handleExchange = () => {
    if (!amount || parseFloat(amount) <= 0) {
      toast({
        title: "Invalid Amount",
        description: "Please enter a valid amount to exchange.",
        variant: "destructive",
      });
      return;
    }
    setShowAfslHandoff(true);
  };

  const confirmAfslHandoff = () => {
    setShowAfslHandoff(false);
    exchangeMutation.mutate({
      fromCurrency,
      toCurrency,
      amount: parseFloat(amount),
    });
  };

  const exchangeRate = fxRate ? parseFloat(fxRate.rate) : 1;
  const spread = fxRate ? parseFloat(fxRate.spread) : 0.005;
  const inputAmount = parseFloat(amount || "0");
  const fee = inputAmount * spread;
  // Deduct fee from source amount before converting so "You'll receive" is the net figure
  const convertedAmount = (inputAmount - fee) * exchangeRate;

  return (
    <Card>
      <CardHeader>
        <CardTitle>FX Calculator</CardTitle>
        <p className="text-xs text-gray-500 mt-1">Executed via AMAX Global (AUSTRAC-registered)</p>
      </CardHeader>
      <CardContent>
        <KillSwitchBanner
          switches={["transactions"]}
          message="FX exchange is temporarily paused. New conversions are disabled while we resolve an operational issue. Existing wallet balances are unaffected."
        />
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
                      {currency.code} - {currency.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="amount">Amount</Label>
              <Input
                id="amount"
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="10,000"
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
                      {currency.code} - {currency.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
          <div className="flex items-center justify-between text-sm mt-2">
            <span className="text-gray-600">Fee</span>
            <span className="font-medium">
              {(spread * 100).toFixed(1)}% ({fee.toFixed(2)} {fromCurrency})
            </span>
          </div>
        </div>
        <Button 
          className="w-full mt-6" 
          onClick={handleExchange}
          disabled={exchangeMutation.isPending || rateLoading}
          data-testid="button-fx-proceed"
        >
          {exchangeMutation.isPending ? "Processing..." : "Proceed to AMAX Global"}
        </Button>

        <AlertDialog open={showAfslHandoff} onOpenChange={setShowAfslHandoff}>
          <AlertDialogContent data-testid="dialog-afsl-handoff">
            <AlertDialogHeader>
              <AlertDialogTitle>You are leaving AMAX Wealth's AFSL coverage</AlertDialogTitle>
              <AlertDialogDescription className="space-y-2">
                <span className="block">
                  This conversion is executed by <strong>AMAX Global Pty Ltd</strong> (ABN 54 690 827 608),
                  an AUSTRAC-registered remittance service provider and Digital Currency Exchange.
                  AMAX Global operates outside the AFSL held by <strong>AMAX Wealth Pty Ltd</strong>,
                  so the personal-advice protections that apply on the rest of this portal do not extend
                  to the FX execution itself.
                </span>
                <span className="block">
                  By continuing, you confirm you understand the handoff and are instructing AMAX Global
                  to execute the conversion on a non-advised basis. You can cancel to return without
                  any conversion being submitted.
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-afsl-handoff-cancel">Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={confirmAfslHandoff} data-testid="button-afsl-handoff-confirm">
                Continue to AMAX Global
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
