import { Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export type BenchmarkAssetClass =
  | "fiat"
  | "crypto"
  | "stablecoin"
  | "investment";

export const BENCHMARK_DERIVATIONS: Record<
  BenchmarkAssetClass,
  { title: string; formula: string; explanation: string }
> = {
  fiat: {
    title: "Fiat",
    formula: "Fiat ← Cash",
    explanation:
      "Cash from your risk profile maps to fiat because cash held on the platform sits in fiat wallets.",
  },
  crypto: {
    title: "Crypto",
    formula: "Crypto ← Crypto",
    explanation:
      "The crypto weight from your risk profile maps directly to volatile (non-stablecoin) crypto holdings.",
  },
  stablecoin: {
    title: "Stablecoin",
    formula: "Stablecoin ← 0%",
    explanation:
      "The risk-profile model does not allocate to stablecoins, so the benchmark stablecoin weight is always 0%. Any stablecoin holdings you have will therefore show up as a real deviation in the rebalancing gap.",
  },
  investment: {
    title: "Investment",
    formula: "Investment ← Bonds + Equities + Alternatives",
    explanation:
      "The risk-profile model tracks bonds, equities and alternatives as three separate classes. The platform groups them into a single 'investment' bucket, so the benchmark weight here is the sum of those three.",
  },
};

export function BenchmarkDerivationPopover({
  assetClass,
}: {
  assetClass: BenchmarkAssetClass;
}) {
  const info = BENCHMARK_DERIVATIONS[assetClass];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`How is the ${info.title} benchmark derived?`}
          className="text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-300 rounded"
          data-testid={`button-derivation-${assetClass}`}
        >
          <Info className="w-3.5 h-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 text-sm"
        data-testid={`popover-derivation-${assetClass}`}
      >
        <p className="font-semibold text-gray-900">How this benchmark is derived</p>
        <p className="mt-2 font-mono text-xs text-blue-700">{info.formula}</p>
        <p className="mt-2 text-xs text-gray-600">{info.explanation}</p>
      </PopoverContent>
    </Popover>
  );
}
