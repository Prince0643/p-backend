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

export type PhpUsd = { php: number; usd: number };

// Folds a { [currency]: number } map into the two supported buckets. Missing or unknown
// currencies count as PHP (the legacy default). PHP and USD are never converted or added.
export function toPhpUsd(amounts: Record<string, number> | null | undefined): PhpUsd {
  const out: PhpUsd = { php: 0, usd: 0 };
  for (const [cur, v] of Object.entries(amounts || {})) {
    if (cur === "USD") out.usd += Number(v) || 0;
    else out.php += Number(v) || 0;
  }
  return out;
}

// Same, for a { [currency]: { field: number } } map (e.g. the API's totalsByCurrency).
export function pickPhpUsd<T extends object>(totals: Record<string, T> | null | undefined, field: keyof T): PhpUsd {
  const flat: Record<string, number> = {};
  for (const [cur, t] of Object.entries(totals || {})) flat[cur] = ((t as Record<string, unknown>)[field as string] as number) ?? 0;
  return toPhpUsd(flat);
}

// "₱1,200.00 | $85.00" - both currencies always shown.
export function formatPhpUsd(p: PhpUsd) {
  return `${formatMoney(p.php, "PHP")} | ${formatMoney(p.usd, "USD")}`;
}
