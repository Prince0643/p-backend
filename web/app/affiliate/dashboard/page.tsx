"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAffiliateAuth } from "@/lib/useAffiliateAuth";
import { useToast } from "@/lib/useToast";
import { Toast } from "@/components/Toast";
import { BrandMark } from "@/components/BrandMark";

const PH_BANKS = [
  { value: "BDO", label: "Banco de Oro (BDO)" },
  { value: "BPI", label: "Bank of the Philippine Islands (BPI)" },
  { value: "METROBANK", label: "Metrobank" },
  { value: "LANDBANK", label: "Land Bank of the Philippines" },
  { value: "PNB", label: "Philippine National Bank (PNB)" },
  { value: "UNIONBANK", label: "UnionBank" },
  { value: "SECURITY_BANK", label: "Security Bank" },
  { value: "RCBC", label: "RCBC" },
  { value: "OTHER", label: "Other Bank" },
];

type Affiliate = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  paymentRegion: "PH" | "GLOBAL";
  preferredBank: string;
  payoutDetails: Record<string, string>;
  status: "active" | "suspended" | "terminated";
  couponCode: string;
};

type Coupon = {
  code: string;
  active: boolean;
  discountPercent: number;
  affiliateFeePercent: number;
  maxRedemptions: number | null;
};

type Redemption = {
  id: string;
  paymentReference: string;
  baseAmount: number;
  discountAmount: number;
  affiliateFeeAmount: number;
  status: string;
  createdAt: string;
};

type Stats = { totalRedemptions: number; paidRedemptions: number; totalEarnings: number };

function statusPill(status: string) {
  if (status === "active" || status === "paid") return "border-emerald-400/40 text-emerald-200";
  if (status === "pending") return "border-amber-400/40 text-amber-200";
  return "border-red-400/40 text-red-200";
}

export default function AffiliateDashboardPage() {
  const { ready, email, requireAuth, handleAuthError, logout } = useAffiliateAuth();
  const { message, toast } = useToast();

  const [affiliate, setAffiliate] = useState<Affiliate | null>(null);
  const [coupon, setCoupon] = useState<Coupon | null>(null);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [copied, setCopied] = useState(false);

  const [editingPayout, setEditingPayout] = useState(false);
  const [region, setRegion] = useState<"PH" | "GLOBAL">("PH");
  const [phMethod, setPhMethod] = useState("");
  const [globalMethod, setGlobalMethod] = useState("");
  const [payoutSaving, setPayoutSaving] = useState(false);

  const load = useCallback(async (token: string) => {
    const data = await apiFetch<{ affiliate: Affiliate; coupon: Coupon | null; redemptions: Redemption[]; stats: Stats }>(
      "/api/affiliates/me",
      token
    );
    setAffiliate(data.affiliate);
    setCoupon(data.coupon);
    setRedemptions(data.redemptions);
    setStats(data.stats);
    setRegion(data.affiliate.paymentRegion);
    setPhMethod(data.affiliate.paymentRegion === "PH" ? data.affiliate.preferredBank : "");
    setGlobalMethod(data.affiliate.paymentRegion === "GLOBAL" ? data.affiliate.preferredBank : "");
  }, []);

  useEffect(() => {
    if (!ready) return;
    const token = requireAuth();
    if (!token) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern
    load(token).catch((e) => { if (!handleAuthError(e)) toast(e.message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requireAuth/load intentionally not deps to avoid refetch loops
  }, [ready]);

  async function copyCoupon() {
    if (!affiliate) return;
    try {
      await navigator.clipboard.writeText(affiliate.couponCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable - code is already visible on-screen.
    }
  }

  const isEwallet = phMethod === "GCASH" || phMethod === "MAYA";
  const isBank = region === "PH" && phMethod && !isEwallet;
  const isOtherBank = phMethod === "OTHER";

  async function handleSavePayout(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const token = requireAuth();
    if (!token) return;
    const form = e.currentTarget;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const fd = new FormData(form);
    const data = Object.fromEntries(fd.entries()) as Record<string, string>;
    data.paymentRegion = region;
    data.preferredBank = region === "PH" ? phMethod : globalMethod;

    setPayoutSaving(true);
    try {
      await apiFetch<{ affiliate: Affiliate }>("/api/affiliates/me/payout", token, { method: "PATCH", body: data });
      toast("Payout details updated.");
      setEditingPayout(false);
      await load(token);
    } catch (err) {
      if (!handleAuthError(err)) toast((err as Error).message);
    } finally {
      setPayoutSaving(false);
    }
  }

  function renderPayoutSummary(a: Affiliate) {
    const d = a.payoutDetails || {};
    if (a.paymentRegion === "PH") {
      if (a.preferredBank === "GCASH" || a.preferredBank === "MAYA") {
        return `${a.preferredBank} · ${d.accountHolderName} · ${d.mobileNumber}`;
      }
      return `${d.bankName || a.preferredBank} · ${d.accountName} · Acct ${d.accountNumber}`;
    }
    return `${a.preferredBank} · ${d.accountName} · ${d.accountEmail}`;
  }

  if (!affiliate) {
    return (
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 text-center text-sm text-slate-400">
        Loading your dashboard…
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <BrandMark subtitle="Affiliate Dashboard" />
          <h1 className="text-2xl font-bold">
            Welcome, {affiliate.firstName} {affiliate.lastName}
          </h1>
          <div className="text-xs text-slate-400">{email}</div>
        </div>
        <button
          onClick={logout}
          className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm font-semibold text-red-200 hover:bg-red-400/20"
        >
          Log Out
        </button>
      </header>

      {affiliate.status !== "active" && (
        <div className="mb-6 rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-200">
          Your account is currently <strong>{affiliate.status}</strong> — your coupon code is deactivated. Contact
          support if you think this is a mistake.
        </div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total Earnings" value={`₱${(stats?.totalEarnings ?? 0).toLocaleString()}`} accent />
        <StatCard label="Paid Redemptions" value={String(stats?.paidRedemptions ?? 0)} />
        <StatCard label="Total Redemptions" value={String(stats?.totalRedemptions ?? 0)} />
      </div>

      <section className="mb-6 rounded-2xl border border-white/10 bg-white/[.03] p-5 shadow-2xl">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-400">Your Coupon Code</h2>
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-xl border border-dashed border-cyan-300 bg-cyan-300/10 px-4 py-2.5 font-mono text-lg font-extrabold tracking-wider text-cyan-100">
            {affiliate.couponCode}
          </span>
          <button onClick={copyCoupon} className="rounded-lg border border-white/10 bg-white/10 px-3 py-2 text-xs font-bold">
            {copied ? "Copied!" : "Copy"}
          </button>
          {coupon && (
            <span className={`rounded-full border px-2.5 py-1 text-xs ${statusPill(coupon.active ? "active" : "inactive")}`}>
              {coupon.active ? "Active" : "Inactive"}
            </span>
          )}
        </div>
        {coupon && (
          <p className="mt-3 text-xs text-slate-400">
            {(coupon.discountPercent * 100).toFixed(0)}% customer discount · {(coupon.affiliateFeePercent * 100).toFixed(0)}%
            commission for you{coupon.maxRedemptions ? ` · one-time use` : ""}
          </p>
        )}
      </section>

      <section className="mb-6 rounded-2xl border border-white/10 bg-white/[.03] p-5 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-bold uppercase tracking-wide text-slate-400">Payout Details</h2>
          {!editingPayout && (
            <button
              onClick={() => setEditingPayout(true)}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold hover:bg-white/10"
            >
              Edit
            </button>
          )}
        </div>

        {!editingPayout ? (
          <p className="text-sm leading-relaxed text-slate-300">{renderPayoutSummary(affiliate)}</p>
        ) : (
          <form onSubmit={handleSavePayout} className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {(["PH", "GLOBAL"] as const).map((r) => (
                <label
                  key={r}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3.5 ${
                    region === r ? "border-blue-400 bg-blue-400/10" : "border-white/10 bg-[#0a122480]"
                  }`}
                >
                  <input
                    type="radio"
                    name="paymentRegionChoice"
                    checked={region === r}
                    onChange={() => {
                      setRegion(r);
                      setPhMethod("");
                      setGlobalMethod("");
                    }}
                  />
                  <span>
                    <strong>{r === "PH" ? "Philippines" : "Global"}</strong>
                    <br />
                    <span className="text-xs text-slate-400">{r === "PH" ? "GCash, Maya, or local bank" : "Wise or PayPal"}</span>
                  </span>
                </label>
              ))}
            </div>

            {region === "PH" && (
              <div className="space-y-3">
                <select className="input" required value={phMethod} onChange={(e) => setPhMethod(e.target.value)}>
                  <option value="">Select a payment method</option>
                  <option value="GCASH">GCash</option>
                  <option value="MAYA">Maya</option>
                  {PH_BANKS.map((b) => (
                    <option key={b.value} value={b.value}>{b.label}</option>
                  ))}
                </select>
                {isEwallet && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <input name="ewalletName" required placeholder="Account-holder Name" className="input" defaultValue={affiliate.payoutDetails.accountHolderName} />
                    <input name="ewalletNumber" required placeholder="Registered Mobile Number" className="input" defaultValue={affiliate.payoutDetails.mobileNumber} />
                  </div>
                )}
                {isBank && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {isOtherBank && (
                      <div className="sm:col-span-2">
                        <input name="otherBankName" required placeholder="Bank Name" className="input" />
                      </div>
                    )}
                    <input name="bankAccountName" required placeholder="Account Name" className="input" defaultValue={affiliate.payoutDetails.accountName} />
                    <input name="bankAccountNumber" required placeholder="Account Number" className="input" defaultValue={affiliate.payoutDetails.accountNumber} />
                    <input name="bankBranch" required placeholder="Bank Branch" className="input" defaultValue={affiliate.payoutDetails.bankBranch} />
                  </div>
                )}
              </div>
            )}

            {region === "GLOBAL" && (
              <div className="space-y-3">
                <select className="input" required value={globalMethod} onChange={(e) => setGlobalMethod(e.target.value)}>
                  <option value="">Select a payment method</option>
                  <option value="WISE">Wise</option>
                  <option value="PAYPAL">PayPal</option>
                </select>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <input name="globalAccountName" required placeholder="Account-holder Name" className="input" defaultValue={affiliate.payoutDetails.accountName} />
                  <input name="globalAccountEmail" type="email" required placeholder="Account Email" className="input" defaultValue={affiliate.payoutDetails.accountEmail} />
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingPayout(false)}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={payoutSaving}
                className="brand-action"
              >
                {payoutSaving ? "Saving…" : "Save Payout Details"}
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[.03] p-5 shadow-2xl">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-400">Redemption History</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
                <th className="p-2">Payment Ref</th>
                <th className="p-2">Sale Amount</th>
                <th className="p-2">Customer Discount</th>
                <th className="p-2">Your Commission</th>
                <th className="p-2">Status</th>
                <th className="p-2">Date</th>
              </tr>
            </thead>
            <tbody>
              {redemptions.length === 0 && (
                <tr><td colSpan={6} className="p-2 text-slate-400">No redemptions yet — share your code to get started.</td></tr>
              )}
              {redemptions.map((r) => (
                <tr key={r.id} className="border-t border-white/10">
                  <td className="p-2">{r.paymentReference}</td>
                  <td className="p-2">₱{Number(r.baseAmount).toLocaleString()}</td>
                  <td className="p-2">₱{Number(r.discountAmount).toLocaleString()}</td>
                  <td className="p-2 font-bold text-emerald-300">₱{Number(r.affiliateFeeAmount).toLocaleString()}</td>
                  <td className="p-2">
                    <span className={`rounded-full border px-2 py-0.5 ${statusPill(r.status)}`}>{r.status}</span>
                  </td>
                  <td className="p-2">{new Date(r.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Toast message={message} />
    </main>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 shadow-xl ${accent ? "border-cyan-300/40 bg-cyan-300/10" : "border-white/10 bg-white/[.03]"}`}>
      <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-extrabold">{value}</div>
    </div>
  );
}
