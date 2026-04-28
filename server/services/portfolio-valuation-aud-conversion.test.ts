// =============================================================================
// Task #336 — regression test for crypto-to-AUD conversion
// =============================================================================
// The investor portal previously valued BTC and ETH wallets at "balance ×
// USD price" and labelled the result "AUD", which under-stated client
// portfolios by ~32% (the AUD/USD rate). This test pins the new behaviour
// of `convertToAud` so that:
//
//   - BTC uses the seeded direct BTC→AUD rate.
//   - ETH chains via USD because no direct ETH→AUD rate is seeded — this
//     is the path that was silently broken before the fix.
//   - Stablecoins (USDT/USDC) are treated as 1:1 USD and then converted
//     to AUD via the USD→AUD chain.
//   - USD wallets convert via the direct USD→AUD rate.
//   - AUD passes through unchanged.
//
// Storage is mocked so the test stays a fast, deterministic unit test that
// does not touch the live FX table or the database.
// =============================================================================
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET ||= "portfolio-valuation-aud-test-secret";
});

vi.mock("../storage", () => {
  // Pricing snapshot used across the assertions:
  //   BTC/USD = 97,250
  //   ETH/USD = 6,500   (no direct ETH/AUD)
  //   BTC/AUD = 144,178 (direct, takes precedence)
  //   USD/AUD = 1.4825
  const rates: Record<string, { rate: string }> = {
    "BTC|USD": { rate: "97250" },
    "ETH|USD": { rate: "6500" },
    "BTC|AUD": { rate: "144178" },
    "USD|AUD": { rate: "1.4825" },
  };
  return {
    storage: {
      getFxRate: vi.fn(async (base: string, target: string) => {
        return rates[`${base}|${target}`] ?? null;
      }),
    },
  };
});

import { convertToAud } from "./portfolio-valuation";

describe("convertToAud (Task #336)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns AUD amounts unchanged", async () => {
    expect(await convertToAud("AUD", 1234.56)).toBeCloseTo(1234.56, 6);
  });

  it("uses the direct BTC→AUD rate when seeded", async () => {
    // 0.05 BTC × 144,178 AUD/BTC = 7,208.90 AUD
    const aud = await convertToAud("BTC", 0.05);
    expect(aud).not.toBeNull();
    expect(aud!).toBeCloseTo(7208.9, 2);
  });

  it("chains ETH via USD when no direct ETH→AUD rate exists", async () => {
    // 2 ETH × 6,500 USD/ETH = 13,000 USD; × 1.4825 USD→AUD = 19,272.50 AUD
    const aud = await convertToAud("ETH", 2);
    expect(aud).not.toBeNull();
    expect(aud!).toBeCloseTo(19272.5, 2);
  });

  it("treats stablecoins (USDT/USDC) as 1:1 USD then converts to AUD", async () => {
    // 1,000 USDT → 1,000 USD × 1.4825 = 1,482.50 AUD
    const usdt = await convertToAud("USDT", 1000);
    expect(usdt).not.toBeNull();
    expect(usdt!).toBeCloseTo(1482.5, 2);

    const usdc = await convertToAud("USDC", 1000);
    expect(usdc).not.toBeNull();
    expect(usdc!).toBeCloseTo(1482.5, 2);
  });

  it("converts USD via the direct USD→AUD rate", async () => {
    // 500 USD × 1.4825 = 741.25 AUD
    const aud = await convertToAud("USD", 500);
    expect(aud).not.toBeNull();
    expect(aud!).toBeCloseTo(741.25, 2);
  });
});
