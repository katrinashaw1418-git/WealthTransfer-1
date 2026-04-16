import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { CurrencyConfig } from '@/lib/types';
import { Briefcase, TrendingUp, TrendingDown, Building, Info, DollarSign, BarChart3, Landmark } from 'lucide-react';
import { useFxRate } from '@/hooks/use-fx-rates';
import { useWallets } from '@/hooks/use-portfolio';

function HoldingValueDisplay({ wallet, displayCurrency }: { wallet: any, displayCurrency: string }) {
  const { data: fxRate } = useFxRate(wallet.currency, displayCurrency);

  if (!fxRate || wallet.currency === displayCurrency) {
    const config = CurrencyConfig[displayCurrency as keyof typeof CurrencyConfig];
    const balance = wallet.balance ? parseFloat(wallet.balance) : 0;
    const formattedBalance = balance > 1 ? balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : balance.toFixed(6);
    return <span className="font-semibold">{config?.symbol}{formattedBalance}</span>;
  }

  const rate = parseFloat(fxRate.rate);
  const convertedValue = parseFloat(wallet.balance || '0') * rate;
  const config = CurrencyConfig[displayCurrency as keyof typeof CurrencyConfig];
  const formattedValue = convertedValue > 1 ? convertedValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : convertedValue.toFixed(6);

  return <span className="font-semibold">{config?.symbol}{formattedValue}</span>;
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

  const totalHoldings = holdingsWithConfig.length;

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
          <h1 className="text-2xl font-bold text-gray-900">Investment Holdings</h1>
          <p className="text-sm text-gray-500 mt-1">Asset positions across your portfolio</p>
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
              <span className="text-sm font-medium text-gray-500">Fiat Currencies</span>
            </div>
            <p className="text-2xl font-bold">{fiatHoldings.length}</p>
            <p className="text-xs text-gray-400 mt-1">Held with external custodian</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-amber-500">
          <CardContent className="p-5">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 bg-amber-50 rounded-lg">
                <BarChart3 className="w-4 h-4 text-amber-600" />
              </div>
              <span className="text-sm font-medium text-gray-500">Digital Assets</span>
            </div>
            <p className="text-2xl font-bold">{cryptoHoldings.length}</p>
            <p className="text-xs text-gray-400 mt-1">Held with licensed custodian</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-green-500">
          <CardContent className="p-5">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 bg-green-50 rounded-lg">
                <DollarSign className="w-4 h-4 text-green-600" />
              </div>
              <span className="text-sm font-medium text-gray-500">Stablecoins</span>
            </div>
            <p className="text-2xl font-bold">{stablecoinHoldings.length}</p>
            <p className="text-xs text-gray-400 mt-1">Held with regulated issuer</p>
          </CardContent>
        </Card>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start gap-3">
        <Info className="w-5 h-5 text-blue-500 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-sm text-blue-800 font-medium">Custodian Disclosure</p>
          <p className="text-sm text-blue-700 mt-1">
            All holdings are maintained with external regulated custodians and are not held by AMAX Wealth. 
            Values shown are indicative and based on current market rates.
          </p>
        </div>
      </div>

      {fiatHoldings.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Landmark className="w-5 h-5 text-blue-600" />
              Fiat Currency Holdings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Currency</th>
                    <th className="text-right p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Units Held</th>
                    <th className="text-right p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Value ({displayCurrency})</th>
                    <th className="text-right p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Custodian</th>
                  </tr>
                </thead>
                <tbody>
                  {fiatHoldings.map((wallet: any) => (
                    <tr key={wallet.id} className="border-t hover:bg-gray-50 transition-colors">
                      <td className="p-4">
                        <div className="flex items-center gap-3">
                          <span className="text-xl">{wallet.config?.flag}</span>
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
              Digital Asset Holdings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Asset</th>
                    <th className="text-right p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Units Held</th>
                    <th className="text-right p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Value ({displayCurrency})</th>
                    <th className="text-right p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Custodian</th>
                  </tr>
                </thead>
                <tbody>
                  {cryptoHoldings.map((wallet: any) => (
                    <tr key={wallet.id} className="border-t hover:bg-gray-50 transition-colors">
                      <td className="p-4">
                        <div className="flex items-center gap-3">
                          <span className="text-xl">{wallet.config?.flag}</span>
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
                      </td>
                      <td className="p-4 text-right">
                        <HoldingValueDisplay wallet={wallet} displayCurrency={displayCurrency} />
                      </td>
                      <td className="p-4 text-right">
                        <Badge variant="outline" className="text-xs">Licensed Custodian</Badge>
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
              Stablecoin Holdings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Asset</th>
                    <th className="text-right p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Units Held</th>
                    <th className="text-right p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Value ({displayCurrency})</th>
                    <th className="text-right p-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Custodian</th>
                  </tr>
                </thead>
                <tbody>
                  {stablecoinHoldings.map((wallet: any) => (
                    <tr key={wallet.id} className="border-t hover:bg-gray-50 transition-colors">
                      <td className="p-4">
                        <div className="flex items-center gap-3">
                          <span className="text-xl">{wallet.config?.flag}</span>
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
                      </td>
                      <td className="p-4 text-right">
                        <HoldingValueDisplay wallet={wallet} displayCurrency={displayCurrency} />
                      </td>
                      <td className="p-4 text-right">
                        <Badge variant="outline" className="text-xs">Regulated Issuer</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="text-center text-xs text-gray-400 py-4">
        <p>Portfolio values are indicative only. Holdings are maintained with external regulated custodians.</p>
        <p className="mt-1">AMAX Wealth operates under Australian Financial Services Licence arrangements.</p>
      </div>
    </div>
  );
}
