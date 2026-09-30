import { formatMoney, type PhpUsd } from "@/lib/money";

// PHP and USD side by side ("₱1,200.00 | $85.00"), or stacked. Never converted or summed.
// Currencies with no activity are muted.
export function MoneyPair({ value, stacked = false, className = "" }: { value: PhpUsd; stacked?: boolean; className?: string }) {
  const mute = (n: number) => (n === 0 ? "opacity-50" : "");
  if (stacked) {
    return (
      <span className={`flex flex-col ${className}`}>
        <span className={mute(value.php)}>{formatMoney(value.php, "PHP")}</span>
        <span className={mute(value.usd)}>{formatMoney(value.usd, "USD")}</span>
      </span>
    );
  }
  return (
    <span className={className}>
      <span className={mute(value.php)}>{formatMoney(value.php, "PHP")}</span>
      <span className="mx-1.5 opacity-40">|</span>
      <span className={mute(value.usd)}>{formatMoney(value.usd, "USD")}</span>
    </span>
  );
}
