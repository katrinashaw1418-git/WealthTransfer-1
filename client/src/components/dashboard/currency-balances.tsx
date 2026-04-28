import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useWallets } from "@/hooks/use-portfolio";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

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

// Task #337 — render the wallet row's updatedAt as a friendly relative
// timestamp ("just now", "3m ago", "2h ago", "Apr 28") so the happy-path
// "Last synced …" affordance reads naturally.
function formatLastSynced(ts?: string | null): string {
  if (!ts) return "just now";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "just now";
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export default function CurrencyBalances() {
  const { data: wallets, isLoading, error } = useWallets();

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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Asset Allocation</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
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
                  {/* Task #22 / Task #337 — balance-source affordance.
                     Happy path surfaces "Last synced <ts>" using the
                     wallet row's updatedAt (rewritten on every cache
                     refresh from the ledger). The destructive
                     "Reconciliation pending" wording is reserved for
                     genuine drift so it doesn't scare clients in the
                     normal case. Mirrors the wording on the Wallets page. */}
                  <div className="mt-1 flex justify-end">
                    {wallet.hasDrift ? (
                      <Badge
                        variant="destructive"
                        className="text-[10px] px-1.5 py-0 leading-tight font-normal"
                        data-testid={`badge-reconciliation-pending-${wallet.currency}`}
                      >
                        Reconciliation pending
                      </Badge>
                    ) : (
                      <span
                        className="text-[10px] text-muted-foreground"
                        data-testid={`tag-balance-source-${wallet.currency}`}
                        title={wallet.updatedAt ? new Date(wallet.updatedAt).toLocaleString() : undefined}
                      >
                        Last synced {formatLastSynced(wallet.updatedAt)}
                      </span>
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
