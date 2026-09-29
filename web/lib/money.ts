// Money is always shown per currency (PHP local, USD global) - never converted.
export function formatMoney(value: number, currency: string) {
  const cur = currency || "PHP";
  try {
    return new Intl.NumberFormat(cur === "USD" ? "en-US" : "en-PH", {
      style: "currency",
      currency: cur,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(value) || 0);
  } catch {
    return `${cur} ${(Number(value) || 0).toFixed(2)}`;
  }
}

// "₱1,200.00 + $85.00" from { PHP: n, USD: n }. Zero-only maps render as a single zero.
export function formatByCurrency(amounts: Record<string, number>) {
  const entries = Object.entries(amounts).filter(([, v]) => Number(v) !== 0);
  if (entries.length === 0) return formatMoney(0, "PHP");
  return entries.map(([cur, v]) => formatMoney(v, cur)).join(" + ");
}
