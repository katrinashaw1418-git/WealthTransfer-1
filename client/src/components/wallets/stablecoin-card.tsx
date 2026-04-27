import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { QrCode, Download, Upload, ArrowUpDown, AlertCircle } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useFxRate } from "@/hooks/use-fx-rates";
import { api } from "@/lib/api";
import { KillSwitchBanner } from "@/components/kill-switch-banner";

interface StablecoinCardProps {
  currency: "USDT" | "USDC";
  balance: string;
  availableBalance: string;
  config: {
    name: string;
    symbol: string;
    color: string;
    flag: string;
  };
}

export default function StablecoinCard({ currency, balance, availableBalance, config }: StablecoinCardProps) {
  const [depositModalOpen, setDepositModalOpen] = useState(false);
  const [withdrawModalOpen, setWithdrawModalOpen] = useState(false);
  const [tradeModalOpen, setTradeModalOpen] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawAddress, setWithdrawAddress] = useState("");
  const [tradeAmount, setTradeAmount] = useState("");
  const [targetCurrency, setTargetCurrency] = useState("USD");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Trading currencies
  const tradeCurrencies = [
    { code: "USD", name: "US Dollar" },
    { code: "CAD", name: "Canadian Dollar" },
    { code: "EUR", name: "Euro" },
    { code: "GBP", name: "British Pound" },
    { code: "AUD", name: "Australian Dollar" },
    { code: "HKD", name: "Hong Kong Dollar" },
    { code: "SGD", name: "Singapore Dollar" },
    { code: "BTC", name: "Bitcoin" },
    { code: "ETH", name: "Ethereum" },
    { code: "USDT", name: "Tether" },
    { code: "USDC", name: "USD Coin" },
  ].filter(c => c.code !== currency); // Remove current currency from options

  // Get FX rate for trading
  const { data: fxRate, isLoading: rateLoading } = useFxRate(currency, targetCurrency);

  // Mock wallet addresses for deposits
  const walletAddress = currency === "USDT" 
    ? "0x742d3a8F87A4CfA7a4D2a3B4a5F8C4e6D9E0f1a2"
    : "0x456e7B8F12C3d4e5F6a7B8c9D0e1F2a3B4c5D6e7";

  const handleCopyAddress = () => {
    navigator.clipboard.writeText(walletAddress);
    toast({
      title: "Address Copied",
      description: "Wallet address copied to clipboard",
    });
  };

  const handleSimulateDeposit = async () => {
    try {
      // Simulate a deposit transaction
      await createTransactionMutation.mutateAsync({
        type: "deposit",
        toCurrency: currency,
        amount: "1000.00", // Demo deposit amount
        description: `${currency} deposit from blockchain`,
        status: "completed",
        fee: 0.00,
      });

      toast({
        title: "Deposit Detected",
        description: `Demo deposit of 1000 ${currency} has been processed`,
      });
      
      setDepositModalOpen(false);
    } catch (error) {
      toast({
        title: "Deposit Failed",
        description: "Unable to process deposit. Please try again.",
        variant: "destructive",
      });
    }
  };

  // Create transaction mutation
  const createTransactionMutation = useMutation({
    mutationFn: async (transactionData: any) => {
      return await apiRequest('POST', '/api/transactions', transactionData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/wallets'] });
      queryClient.invalidateQueries({ queryKey: ['/api/portfolio'] });
    },
  });

  const handleWithdraw = async () => {
    if (!withdrawAmount || !withdrawAddress) {
      toast({
        title: "Error",
        description: "Please fill in all fields",
        variant: "destructive",
      });
      return;
    }

    const amount = parseFloat(withdrawAmount);
    if (amount <= 0 || amount > parseFloat(availableBalance)) {
      toast({
        title: "Invalid Amount",
        description: "Amount must be greater than 0 and not exceed available balance",
        variant: "destructive",
      });
      return;
    }

    try {
      await createTransactionMutation.mutateAsync({
        type: "withdrawal",
        fromCurrency: currency,
        amount: amount.toString(),
        description: `${currency} withdrawal to ${withdrawAddress.slice(0, 10)}...`,
        status: "pending",
        fee: 25.00, // Estimated ETH gas fee
      });

      toast({
        title: "Withdrawal Initiated",
        description: `${withdrawAmount} ${currency} withdrawal is being processed`,
      });
      
      setWithdrawModalOpen(false);
      setWithdrawAmount("");
      setWithdrawAddress("");
    } catch (error) {
      toast({
        title: "Withdrawal Failed",
        description: "Unable to process withdrawal. Please try again.",
        variant: "destructive",
      });
    }
  };

  // Trade exchange mutation
  const exchangeMutation = useMutation({
    mutationFn: (data: { fromCurrency: string; toCurrency: string; amount: number }) =>
      api.createFxExchange(data),
    onSuccess: () => {
      toast({
        title: "Trade Successful",
        description: `Successfully traded ${tradeAmount} ${currency} for ${targetCurrency}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wallets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
      setTradeModalOpen(false);
      setTradeAmount("");
    },
    onError: () => {
      toast({
        title: "Trade Failed",
        description: "Unable to complete trade. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleTrade = async () => {
    if (!tradeAmount || parseFloat(tradeAmount) <= 0) {
      toast({
        title: "Invalid Amount",
        description: "Please enter a valid amount to trade",
        variant: "destructive",
      });
      return;
    }

    const amount = parseFloat(tradeAmount);
    if (amount > parseFloat(availableBalance)) {
      toast({
        title: "Insufficient Balance",
        description: "Trade amount exceeds available balance",
        variant: "destructive",
      });
      return;
    }

    exchangeMutation.mutate({
      fromCurrency: currency,
      toCurrency: targetCurrency,
      amount: amount,
    });
  };

  return (
    <Card className="relative overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className={`w-10 h-10 ${config.color} rounded-full flex items-center justify-center text-white font-bold`}>
              {config.flag}
            </div>
            <div>
              <CardTitle className="text-lg">{config.name}</CardTitle>
              <p className="text-sm text-muted-foreground">ERC-20 Stablecoin</p>
            </div>
          </div>
          <Badge variant="secondary" className="bg-green-100 text-green-700">
            Stable Value
          </Badge>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">Total Balance</span>
            <span className="font-semibold">{config.symbol}{balance}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">Available</span>
            <span className="text-sm">{config.symbol}{availableBalance}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">USD Value</span>
            <span className="text-sm font-medium">${balance}</span>
          </div>
        </div>

        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="text-xs">
            {currency} transactions settle on Ethereum blockchain. Gas fees apply for withdrawals.
          </AlertDescription>
        </Alert>

        <div className="grid grid-cols-3 gap-2">
          <Dialog open={depositModalOpen} onOpenChange={setDepositModalOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="flex items-center gap-1">
                <Download className="w-3 h-3" />
                Deposit
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Deposit {currency}</DialogTitle>
                <DialogDescription>
                  Send {currency} tokens to your wallet address below
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <KillSwitchBanner
                  switches={["deposits", "transactions"]}
                  message={`${currency} deposits are temporarily paused while we resolve an operational issue. Please try again later.`}
                />
                <div className="text-center">
                  <div className="bg-white p-4 rounded-lg border mx-auto w-fit mb-3">
                    <QrCode className="w-32 h-32 mx-auto" />
                  </div>
                  <p className="text-sm text-muted-foreground mb-2">Scan QR code or copy address below</p>
                </div>
                
                <div className="space-y-2">
                  <Label>Wallet Address (ERC-20)</Label>
                  <div className="flex space-x-2">
                    <Input 
                      value={walletAddress} 
                      readOnly 
                      className="font-mono text-xs"
                    />
                    <Button variant="outline" size="sm" onClick={handleCopyAddress}>
                      Copy
                    </Button>
                  </div>
                </div>

                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    Only send {currency} tokens to this address. Minimum deposit: 10 {currency}. 
                    Transactions require 1 block confirmation.
                  </AlertDescription>
                </Alert>

                <div className="border-t pt-4">
                  <Button
                    disabled
                    className="w-full"
                    variant="outline"
                  >
                    Deposits unavailable
                  </Button>
                  <p className="text-xs text-muted-foreground mt-2 text-center">
                    Live stablecoin deposit processing is not enabled in this environment.
                  </p>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          <Dialog open={withdrawModalOpen} onOpenChange={setWithdrawModalOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="flex items-center gap-1">
                <Upload className="w-3 h-3" />
                Withdraw
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Withdraw {currency}</DialogTitle>
                <DialogDescription>
                  Send {currency} tokens to an external wallet address
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <KillSwitchBanner
                  switches={["withdrawals", "transactions"]}
                  message={`${currency} withdrawals are temporarily paused while we resolve an operational issue. Please try again later.`}
                />
                <div className="space-y-2">
                  <Label>Destination Address</Label>
                  <Input 
                    placeholder="0x..." 
                    value={withdrawAddress}
                    onChange={(e) => setWithdrawAddress(e.target.value)}
                    className="font-mono text-sm"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label>Amount</Label>
                  <div className="relative">
                    <Input 
                      type="number" 
                      placeholder="0.00"
                      value={withdrawAmount}
                      onChange={(e) => setWithdrawAmount(e.target.value)}
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      {currency}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Available: {config.symbol}{availableBalance}
                  </p>
                </div>

                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    Withdrawal fee: ~$15-25 (ETH gas). KYC verification required. 
                    Processing time: 5-30 minutes.
                  </AlertDescription>
                </Alert>

                <Button 
                  onClick={handleWithdraw} 
                  className="w-full"
                  disabled={createTransactionMutation.isPending}
                >
                  {createTransactionMutation.isPending ? "Processing..." : "Initiate Withdrawal"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>

          <Dialog open={tradeModalOpen} onOpenChange={setTradeModalOpen}>
            <DialogTrigger asChild>
              <Button 
                variant="outline" 
                size="sm" 
                className="flex items-center gap-1"
              >
                <ArrowUpDown className="w-3 h-3" />
                Trade
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Trade {currency}</DialogTitle>
                <DialogDescription>
                  Exchange {currency} for another currency
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>From</Label>
                    <div className="flex items-center space-x-2 p-3 border rounded-lg bg-gray-50">
                      <div className={`w-6 h-6 ${config.color} rounded-full flex items-center justify-center text-white text-xs font-bold`}>
                        {config.flag}
                      </div>
                      <span className="font-medium">{currency}</span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>To</Label>
                    <Select value={targetCurrency} onValueChange={setTargetCurrency}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {tradeCurrencies.map((curr) => (
                          <SelectItem key={curr.code} value={curr.code}>
                            {curr.code} - {curr.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                
                <div className="space-y-2">
                  <Label>Amount</Label>
                  <div className="relative">
                    <Input 
                      type="number" 
                      placeholder="0.00"
                      value={tradeAmount}
                      onChange={(e) => setTradeAmount(e.target.value)}
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      {currency}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Available: {config.symbol}{availableBalance}
                  </p>
                </div>

                {fxRate && tradeAmount && (
                  <div className="p-3 bg-gray-50 rounded-lg space-y-2">
                    <div className="flex justify-between text-sm">
                      <span>Exchange Rate:</span>
                      <span className="font-medium">1 {currency} = {parseFloat(fxRate.rate).toFixed(4)} {targetCurrency}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span>You'll receive:</span>
                      <span className="font-medium text-green-600">
                        {(parseFloat(tradeAmount) * parseFloat(fxRate.rate)).toFixed(2)} {targetCurrency}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span>Fee:</span>
                      <span className="font-medium">
                        {(parseFloat(fxRate.spread) * 100).toFixed(2)}%
                      </span>
                    </div>
                  </div>
                )}

                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    Trades are executed at current market rates. Fees apply based on trading pair.
                  </AlertDescription>
                </Alert>

                <Button 
                  onClick={handleTrade} 
                  className="w-full"
                  disabled={exchangeMutation.isPending || rateLoading || !tradeAmount}
                >
                  {exchangeMutation.isPending ? "Processing Trade..." : "Execute Trade"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </CardContent>
    </Card>
  );
}