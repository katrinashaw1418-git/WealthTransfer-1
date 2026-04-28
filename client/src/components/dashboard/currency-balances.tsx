import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useWallets, usePortfolio } from "@/hooks/use-portfolio";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Briefcase, Bitcoin } from "lucide-react";

const currencyConfig = {
  USD: { name: "US Dollar", symbol: "$", color: "bg-green-500" },
  CAD: { name: "Canadian Dollar", symbol: "$", color: "bg-red-500" },
  EUR: { name: "Euro", symbol: "€", color: "bg-blue-600" },
  GBP: { name: "British Pound", symbol: "£", color: "bg-purple-500" },
  AUD: { name: "Australian Dollar", symbol: "$", color: "bg-orange-500" },
  HKD: { name: "Hong Kong Dollar", symbol: "$", color: "bg-pink-500" },
  SGD: { name: "Singapore Dollar", symbol: "$", color: "bg-teal-500" },
  BTC: { name: "Bitcoin", symbol: "₿", color: "bg-yellow-500" },
  ETH: { name: "Ethereum", symbol: "Ξ", color: "bg-indigo-500" },
  USDT: { name: "Tether", symbol: "₮", color: "bg-emerald-500" },
  USDC: { name: "USD Coin", symbol: "◎", color: "bg-sky-400" },
};

const fiatCurrencies = ['USD', 'AUD', 'CAD', 'EUR', 'GBP', 'HKD', 'SGD'];

// Task #493 — render the wallet row's updatedAt as a concrete absolute
// timestamp ("26 Apr 2026 20:09") so investors can match it against the
// custodian statement timestamp without ambiguity. Falls back to a short
// dash on missing/invalid input rather than guessing "just now".
function formatLastSynced(ts?: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const datePart = d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const timePart = d.toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${datePart} ${timePart}`;
}

export default function CurrencyBalances() {
  const { data: wallets, isLoading, error } = useWallets();
  // Task #493 — investor dashboard alignment. Add two summary rows above the
  // per-currency wallet rows: "Investment funds" (sum of structured products)
  // and "Liquid crypto" (sum of BTC/ETH spot exposure). Sourced from the
  // existing /api/portfolio aggregation so we don't duplicate any business
  // logic. The per-currency wallet rows below are preserved unchanged.
  const { data: portfolio } = usePortfolio();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Asset Allocation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <div className="flex items-center space-x-3">
                <Skeleton className="w-8 h-8 rounded-full" />
                <div>
                  <Skeleton className="h-4 w-20 mb-1" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </div>
              <Skeleton className="h-5 w-16" />
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Asset Allocation</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">Failed to load allocation data</p>
        </CardContent>
      </Card>
    );
  }

  if (!wallets || wallets.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Asset Allocation</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No allocation data available</p>
        </CardContent>
      </Card>
    );
  }

  const investmentValue = portfolio ? parseFloat(portfolio.investmentValue || "0") : 0;
  const cryptoValue = portfolio ? parseFloat(portfolio.cryptoValue || "0") : 0;
  const totalValue = portfolio ? parseFloat(portfolio.totalValue || "0") : 0;
  const investmentPct = totalValue > 0 ? (investmentValue / totalValue) * 100 : 0;
  const cryptoPct = totalValue > 0 ? (cryptoValue / totalValue) * 100 : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Asset Allocation</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {/* Task #493 — additive summary rows. Rendered above the
             per-currency wallet rows; do not replace them. Hidden when
             value is zero so empty accounts don't show meaningless rows. */}
          {portfolio && investmentValue > 0 && (
            <div
              className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
              data-testid="row-investment-funds"
            >
              <div className="flex items-center space-x-3">
                <div className="w-8 h-8 rounded-full flex items-center justify-center bg-primary/10">
                  <Briefcase className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <p className="font-medium text-gray-900">Investment funds</p>
                  <p className="text-sm text-gray-500">Structured products</p>
                </div>
              </div>
              <div className="text-right">
                <p className="font-semibold text-gray-900">
                  ${investmentValue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {investmentPct.toFixed(1)}% of portfolio
                </p>
              </div>
            </div>
          )}

          {portfolio && cryptoValue > 0 && (
            <div
              className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
              data-testid="row-liquid-crypto"
            >
              <div className="flex items-center space-x-3">
                <div className="w-8 h-8 rounded-full flex items-center justify-center bg-yellow-500">
                  <Bitcoin className="w-4 h-4 text-white" />
                </div>
                <div>
                  <p className="font-medium text-gray-900">Liquid crypto</p>
                  <p className="text-sm text-gray-500">BTC, ETH spot exposure</p>
                </div>
              </div>
              <div className="text-right">
                <p className="font-semibold text-gray-900">
                  ${cryptoValue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {cryptoPct.toFixed(1)}% of portfolio
                </p>
              </div>
            </div>
          )}

          {wallets.map((wallet: any) => {
            const config = currencyConfig[wallet.currency as keyof typeof currencyConfig];
            const balance = parseFloat(wallet.balance);
            const isFiat = fiatCurrencies.includes(wallet.currency);
            
            return (
              <div key={wallet.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div className="flex items-center space-x-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${config?.color || 'bg-gray-500'}`}>
                    <span className="text-white font-bold text-xs">
                      {wallet.currency.charAt(0)}
                    </span>
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">
                      {config?.name || wallet.currency}
                    </p>
                    <p className="text-sm text-gray-500">
                      {isFiat ? 'Via external custodian' : 'Digital exposure'}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-gray-900">
                    {wallet.walletType === 'crypto' 
                      ? `${balance.toFixed(4)} ${wallet.currency}`
                      : `${config?.symbol || '$'}${balance.toLocaleString()}`
                    }
                  </p>
                  {/* Task #22 / Task #337 / Task #493 — balance-source affordance.
                     Always lead with the sync timestamp ("Last synced …") so
                     clients see the freshness signal first. When `hasDrift`
                     is true the row also keeps the explicit destructive
                     "Reconciliation pending" badge (preservation rule) and
                     suffixes the line with "Custodian refresh pending" so
                     the timestamp is contextualised rather than replaced. */}
                  <div className="mt-1 flex flex-col items-end gap-0.5">
                    <span
                      className="text-[10px] text-muted-foreground"
                      data-testid={`tag-balance-source-${wallet.currency}`}
                      title={wallet.updatedAt ? new Date(wallet.updatedAt).toLocaleString() : undefined}
                    >
                      Last synced {formatLastSynced(wallet.updatedAt)}
                      {wallet.hasDrift && (
                        <span
                          className="ml-1 text-amber-700"
                          data-testid={`tag-custodian-refresh-pending-${wallet.currency}`}
                        >
                          · Custodian refresh pending
                        </span>
                      )}
                    </span>
                    {wallet.hasDrift && (
                      <Badge
                        variant="destructive"
                        className="text-[10px] px-1.5 py-0 leading-tight font-normal"
                        data-testid={`badge-reconciliation-pending-${wallet.currency}`}
                      >
                        Reconciliation pending
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
