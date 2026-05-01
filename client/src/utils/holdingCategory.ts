export function normalizeHoldingCategory(raw?: string | null): string {
  const value = (raw ?? "").trim();
  const t = value.toLowerCase();

  if (
    t.includes("crypto") ||
    t.includes("stablecoin") ||
    t.includes("fx") ||
    t.includes("foreign exchange")
  ) {
    return "External holdings";
  }

  return value || "Unclassified";
}
