import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { CurrencyConfig } from '@/lib/types';
import { Info, DollarSign, BarChart3, Landmark } from 'lucide-react';
import { useFxRates } from '@/hooks/use-fx-rates';
import { useWallets } from '@/hooks/use-portfolio';

// Task #336 — the wallet table previously called useFxRate(currency, AUD)
// and silently rendered the raw unit balance whenever a direct rate was
// missing. ETH→AUD has no direct seeded rate, so a 2.0 ETH wallet displayed
// as "$2.00" AUD instead of the indicative ~$13k. We now load the full FX
// table once and chain currency → USD → display when no direct/inverse
// rate exists. Stablecoins are USD-pegged so we re-base them to USD before
// the lookup, matching the server-side convertToAud() routing.
function HoldingValueDisplay({ wallet, displayCurrency }: { wallet: any, displayCurrency: string }) {
  const { data: rates } = useFxRates();
  const balance = wallet.balance ? parseFloat(wallet.balance) : 0;
  const config = CurrencyConfig[displayCurrency as keyof typeof CurrencyConfig];

  const findRate = (from: string, to: string): number | null => {
    if (from === to) return 1;
    if (!Array.isArray(rates)) return null;
    const direct = rates.find((r: any) => r.baseCurrency === from && r.targetCurrency === to);
    if (direct) return parseFloat(direct.rate);
    const inverse = rates.find((r: any) => r.baseCurrency === to && r.targetCurrency === from);
    if (inverse) return 1 / parseFloat(inverse.rate);
    return null;
  };

  const sourceCurrency = (wallet.currency === 'USDT' || wallet.currency === 'USDC') ? 'USD' : wallet.currency;
  let rate = findRate(sourceCurrency, displayCurrency);
  if (rate === null) {
    const toUsd = findRate(sourceCurrency, 'USD');
    const usdToTarget = findRate('USD', displayCurrency);
    if (toUsd !== null && usdToTarget !== null) {
      rate = toUsd * usdToTarget;
    }
  }

  if (rate === null) {
    // No price chain available — surface the raw unit balance rather than
    // an inflated/incorrect figure so the gap is visible.
    const formattedBalance = balance > 1 ? balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : balance.toFixed(6);
    return <span className="font-semibold">{formattedBalance} {wallet.currency}</span>;
  }

  const convertedValue = balance * rate;
  const formattedValue = convertedValue > 1 ? convertedValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : convertedValue.toFixed(6);
  return <span className="font-semibold">{config?.symbol}{formattedValue}</span>;
}

const currencyInitialColors: Record<string, string> = {
  USD: 'bg-green-100 text-green-700',
  AUD: 'bg-yellow-100 text-yellow-700',
  CAD: 'bg-red-100 text-red-700',
  EUR: 'bg-blue-100 text-blue-700',
  GBP: 'bg-purple-100 text-purple-700',
  HKD: 'bg-rose-100 text-rose-700',
  SGD: 'bg-teal-100 text-teal-700',
  BTC: 'bg-orange-100 text-orange-700',
  ETH: 'bg-indigo-100 text-indigo-700',
  USDT: 'bg-emerald-100 text-emerald-700',
  USDC: 'bg-sky-100 text-sky-700',
};

function CurrencyInitial({ currency }: { currency: string }) {
  const colorClass = currencyInitialColors[currency] || 'bg-gray-100 text-gray-700';
  const initial = currency.charAt(0);
  return (
    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold ${colorClass}`}>
      {initial}
    </div>
  );
}

// Task #22 / Task #337 — small balance-source affordance.
// In the happy path (cached wallet balance agrees with the ledger sum) we
// surface "Last synced <timestamp>" using the wallet row's last-update
// timestamp, which is rewritten every time the cache is refreshed from the
// ledger. The destructive "Reconciliation pending" wording is reserved for
// real drift so it doesn't scare clients in the normal case. Same wording
// pattern is reused on the dashboard wallet list.
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

function BalanceSourceTag({ wallet }: { wallet: any }) {
  if (wallet?.hasDrift) {
    return (
      <Badge
        variant="destructive"
        className="text-[10px] px-1.5 py-0 leading-tight font-normal"
        data-testid={`badge-reconciliation-pending-${wallet?.currency}`}
      >
        Reconciliation pending
      </Badge>
    );
  }
  return (
    <span
      className="text-[10px] text-muted-foreground"
      data-testid={`tag-balance-source-${wallet?.currency}`}
      title={wallet?.updatedAt ? new Date(wallet.updatedAt).toLocaleString() : undefined}
    >
      Last synced {formatLastSynced(wallet?.updatedAt)}
    </span>
  );
}

export default function Wallets() {
  const { data: wallets = [], isLoading } = useWallets();
  const [displayCurrency, setDisplayCurrency] = useState('AUD');

  const fiatCurrencies = ['USD', 'AUD', 'CAD', 'EUR', 'GBP', 'HKD', 'SGD'];
  const cryptoCurrencies = ['BTC', 'ETH'];
  const stablecoins = ['USDT', 'USDC'];

  const holdingsWithConfig = wallets
    .filter((wallet: any) => parseFloat(wallet.balance || '0') > 0)
    .map((wallet: any) => ({
      ...wallet,
      config: CurrencyConfig[wallet.currency as keyof typeof CurrencyConfig],
    }));

  const fiatHoldings = holdingsWithConfig.filter((w: any) => fiatCurrencies.includes(w.currency));
  const cryptoHoldings = holdingsWithConfig.filter((w: any) => cryptoCurrencies.includes(w.currency));
  const stablecoinHoldings = holdingsWithConfig.filter((w: any) => stablecoins.includes(w.currency));

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-28" />)}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Portfolio Overview</h1>
          <p className="text-sm text-gray-500 mt-1">Consolidated exposure across external custodians</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">Display currency:</span>
          <Select value={displayCurrency} onValueChange={setDisplayCurrency}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {['AUD', 'USD', 'EUR', 'GBP', 'CAD', 'HKD', 'SGD'].map(currency => {
                const config = CurrencyConfig[currency as keyof typeof CurrencyConfig];
                return (
                  <SelectItem key={currency} value={currency}>
                    <span className="flex items-center gap-2">
                      <span>{config?.flag}</span>
                      <span>{currency}</span>
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="border-l-4 border-l-blue-500">
          <CardContent className="p-5">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 bg-blue-50 rounded-lg">
                <Landmark className="w-4 h-4 text-blue-600" />
              </div>
              <span className="text-sm font-medium text-gray-500">Cash Allocation</span>
            </div>
            <p className="text-2xl font-bold">{fiatHoldings.length} <span className="text-sm font-normal text-gray-400">currencies</span></p>
            <p className="text-xs text-gray-400 mt-1">Via external custodian</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-amber-500">
          <CardContent className="p-5">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 bg-amber-50 rounded-lg">
                <BarChart3 className="w-4 h-4 text-amber-600" />
              </div>
              <span className="text-sm font-medium text-gray-500">Digital Asset Exposure</span>
            </div>
            <p className="text-2xl font-bold">{cryptoHoldings.length} <span className="text-sm font-normal text-gray-400">assets</span></p>
            <p className="text-xs text-gray-400 mt-1">Via external provider</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-green-500">
          <CardContent className="p-5">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 bg-green-50 rounded-lg">
                <DollarSign className="w-4 h-4 text-green-600" />
              </div>
              <span className="text-sm font-medium text-gray-500">USD-Denominated Digital Exposure</span>
            </div>
            <p className="text-2xl font-bold">{stablecoinHoldings.length} <span className="text-sm font-normal text-gray-400">positions</span></p>
            <p className="text-xs text-gray-400 mt-1">Via external provider</p>
          </CardContent>
        </Card>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start gap-3">
        <Info className="w-5 h-5 text-blue-500 mt-0.5 flex-shrink-0" />
        <div className="space-y-2">
          <p className="text-sm text-blue-800 font-medium">Important Disclosure — Non-Custodial Reporting View</p>
          <p className="text-sm text-blue-700">
            <strong>AMAX Global Pty Ltd (ABN 54 690 827 608) does not hold client funds.</strong> Balances shown reflect funds held with regulated banking partners and, for digital asset exposure,
            with <strong>Independent Reserve Pty Ltd</strong> (AUSTRAC DCE registration <strong>DCE-100461150-001</strong>). AMAX acts as a remittance service provider and Digital Currency Exchange
            (DCE) facilitator only. AMAX is not a custodian and does not operate a deposit-taking institution.
          </p>
          <p className="text-sm text-blue-700">
            This view is for reporting purposes only. Values are indicative, based on current market rates, and <strong>do not constitute personal financial advice</strong>.
            Account balances are available for instructed transactions subject to AML/CTF screening, KYC verification and Travel Rule obligations.
          </p>
        </div>
      </div>

      {fiatHoldings.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Landmark className="w-5 h-5 text-blue-600" />
              Cash Allocation
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Currency</th>
                    <th className="text-right p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Exposure</th>
                    <th className="text-right p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Indicative Value ({displayCurrency})</th>
                    <th className="text-right p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Provider</th>
                  </tr>
                </thead>
                <tbody>
                  {fiatHoldings.map((wallet: any) => (
                    <tr key={wallet.id} className="border-t hover:bg-gray-50 transition-colors">
                      <td className="p-4">
                        <div className="flex items-center gap-3">
                          <CurrencyInitial currency={wallet.currency} />
                          <div>
                            <p className="font-medium text-gray-900">{wallet.currency}</p>
                            <p className="text-sm text-gray-500">{wallet.config?.name}</p>
                          </div>
                        </div>
                      </td>
                      <td className="p-4 text-right">
                        <p className="font-mono text-gray-900">
                          {wallet.config?.symbol}{parseFloat(wallet.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </p>
                        <div className="mt-1 flex justify-end">
                          <BalanceSourceTag wallet={wallet} />
                        </div>
                      </td>
                      <td className="p-4 text-right">
                        <HoldingValueDisplay wallet={wallet} displayCurrency={displayCurrency} />
                      </td>
                      <td className="p-4 text-right">
                        <Badge variant="outline" className="text-xs">External Provider</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {cryptoHoldings.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <BarChart3 className="w-5 h-5 text-amber-600" />
              Digital Asset Exposure
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Asset</th>
                    <th className="text-right p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Units</th>
                    <th className="text-right p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Indicative Value ({displayCurrency})</th>
                    <th className="text-right p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Provider</th>
                  </tr>
                </thead>
                <tbody>
                  {cryptoHoldings.map((wallet: any) => (
                    <tr key={wallet.id} className="border-t hover:bg-gray-50 transition-colors">
                      <td className="p-4">
                        <div className="flex items-center gap-3">
                          <CurrencyInitial currency={wallet.currency} />
                          <div>
                            <p className="font-medium text-gray-900">{wallet.currency}</p>
                            <p className="text-sm text-gray-500">{wallet.config?.name}</p>
                          </div>
                        </div>
                      </td>
                      <td className="p-4 text-right">
                        <p className="font-mono text-gray-900">
                          {parseFloat(wallet.balance).toFixed(6)}
                        </p>
                        <div className="mt-1 flex justify-end">
                          <BalanceSourceTag wallet={wallet} />
                        </div>
                      </td>
                      <td className="p-4 text-right">
                        <HoldingValueDisplay wallet={wallet} displayCurrency={displayCurrency} />
                      </td>
                      <td className="p-4 text-right">
                        <Badge variant="outline" className="text-xs">External Provider</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {stablecoinHoldings.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <DollarSign className="w-5 h-5 text-green-600" />
              USD-Denominated Digital Exposure
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Asset</th>
                    <th className="text-right p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Units</th>
                    <th className="text-right p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Indicative Value ({displayCurrency})</th>
                    <th className="text-right p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Provider</th>
                  </tr>
                </thead>
                <tbody>
                  {stablecoinHoldings.map((wallet: any) => (
                    <tr key={wallet.id} className="border-t hover:bg-gray-50 transition-colors">
                      <td className="p-4">
                        <div className="flex items-center gap-3">
                          <CurrencyInitial currency={wallet.currency} />
                          <div>
                            <p className="font-medium text-gray-900">{wallet.currency}</p>
                            <p className="text-sm text-gray-500">{wallet.config?.name}</p>
                          </div>
                        </div>
                      </td>
                      <td className="p-4 text-right">
                        <p className="font-mono text-gray-900">
                          {parseFloat(wallet.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </p>
                        <div className="mt-1 flex justify-end">
                          <BalanceSourceTag wallet={wallet} />
                        </div>
                      </td>
                      <td className="p-4 text-right">
                        <HoldingValueDisplay wallet={wallet} displayCurrency={displayCurrency} />
                      </td>
                      <td className="p-4 text-right">
                        <Badge variant="outline" className="text-xs">External Provider</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="text-center text-xs text-gray-400 py-4 space-y-1">
        <p>All positions are maintained with regulated banking partners and external Digital Currency Exchange providers — not held by AMAX.</p>
        <p>Crypto exposure is held with Independent Reserve Pty Ltd (AUSTRAC DCE-100461150-001). Fiat balances are held with regulated partner banking institutions.</p>
        <p>Values are indicative only and based on current market rates. This view does not constitute personal financial advice.</p>
        <p>AMAX Global Pty Ltd (ABN 54 690 827 608) is registered with AUSTRAC as a remittance service provider and Digital Currency Exchange. AMAX Wealth Pty Ltd advisory services are provided under separate AFSL arrangements.</p>
      </div>
    </div>
  );
}
