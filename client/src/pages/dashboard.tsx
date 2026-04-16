import WealthOverview from "@/components/dashboard/wealth-overview";
import PortfolioChart from "@/components/dashboard/portfolio-chart";
import FxExchangeTool from "@/components/dashboard/fx-exchange-tool";
import AiAdvisoryPanel from "@/components/dashboard/ai-advisory-panel";
import CurrencyBalances from "@/components/dashboard/currency-balances";
import TransactionHistory from "@/components/dashboard/transaction-history";

export default function Dashboard() {
  return (
    <div className="p-6 space-y-6">
      {/* Wealth Overview Cards */}
      <WealthOverview />

      {/* Main Dashboard Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Portfolio Chart and FX Tool */}
        <div className="lg:col-span-2 space-y-6">
          <PortfolioChart />
          <FxExchangeTool />
        </div>

        {/* Right Column - Market Insights and Balances */}
        <div className="space-y-6">
          <AiAdvisoryPanel />
          <CurrencyBalances />
        </div>
      </div>

      {/* Transaction History */}
      <TransactionHistory />
    </div>
  );
}
