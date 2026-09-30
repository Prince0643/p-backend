// PayMongo test cards - source: https://developers.paymongo.com/docs/payment-acceptance-testing
// Any future expiry date and any 3-digit CVC work with these.
const SUCCESS_CARDS = [
  { number: "4343434343434345", note: "Visa - success" },
  { number: "4571736000000075", note: "Visa - success" },
  { number: "5123000000000002", note: "Mastercard - success" },
  { number: "4120000000000007", note: "Visa - success with 3DS (choose Authorize)" },
  { number: "5123000000000001", note: "Mastercard - success, 3DS optional" },
];

const DECLINED_CARDS = [
  { number: "4200000000000018", note: "Declined: expired card" },
  { number: "4300000000000017", note: "Declined: invalid CVC" },
  { number: "5100000000000198", note: "Declined: insufficient funds" },
  { number: "4111111111111111", note: "Declined: generic" },
];

export function TestCards() {
  return (
    <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-3.5">
      <h3 className="text-xs font-bold uppercase tracking-wide text-amber-200">PayMongo test cards</h3>
      <p className="mt-1 text-[11px] text-slate-400">
        Use any future expiry date and any 3-digit CVC. For GCash, Maya, GrabPay and ShopeePay, open the redirect page
        and choose Authorize or Fail - no real account needed.
      </p>
      <ul className="mt-2 space-y-1 font-mono text-xs">
        {SUCCESS_CARDS.map((c) => (
          <li key={c.number}>
            <span className="text-emerald-300">{c.number}</span>
            <span className="ml-2 font-sans text-slate-400">{c.note}</span>
          </li>
        ))}
        {DECLINED_CARDS.map((c) => (
          <li key={c.number}>
            <span className="text-red-300">{c.number}</span>
            <span className="ml-2 font-sans text-slate-400">{c.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
