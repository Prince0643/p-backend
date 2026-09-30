"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import { apiFetch } from "@/lib/api";
import { formatMoney, toPhpUsd } from "@/lib/money";

type Handlers = {
  requireAuth: () => string | null;
  handleAuthError: (e: unknown) => boolean;
  toast: (m: string) => void;
};

type CouponLocation = { key: "global" | "main"; locationId: string; ghlCouponId: string; status: string };

type UnifiedCoupon = {
  code: string;
  origin: "local" | "ghl";
  type: "affiliate" | "general";
  discountPercent: number;
  affiliate: { email: string; name: string } | null;
  locations: CouponLocation[];
  usage: { paidCount: number; unassignedCount: number };
};

type UsageRedemption = {
  id: string;
  source: "paymongo" | "ghl";
  status: string;
  email: string;
  fullName: string;
  currency: string;
  baseAmount: number;
  discountAmount: number;
  commissionBase: number;
  affiliateFeeAmount: number;
  affiliateEmail: string;
  createdAt: string;
  ghlOrderId?: string;
  ghlLocationKey?: string;
  isTest?: boolean;
};

type UsageTotals = Record<string, { orders: number; revenue: number; discount: number; commission: number }>;

type AffiliateOption = { id: string; firstName: string; lastName: string; email: string; couponCode?: string; status?: string };

const btn = "rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-60";
const btnPrimary = "rounded-lg bg-blue-400 hover:bg-blue-300 px-3 py-2 text-sm font-extrabold text-slate-950 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-60";
const btnDanger = "rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-1.5 text-xs font-bold text-red-200 hover:bg-red-400/20 focus-visible:outline-2 focus-visible:outline-red-300 disabled:opacity-60";

function TotalsSummary({ totals, cols }: { totals: Record<string, Record<string, number>>; cols: { key: string; label: string; money?: boolean }[] }) {
  // Always show PHP and USD blocks side by side (zeros when idle); never converted or summed.
  const fold = (key: string, cur: "PHP" | "USD") => {
    const flat: Record<string, number> = {};
    for (const [c, t] of Object.entries(totals)) flat[c] = t[key] ?? 0;
    const p = toPhpUsd(flat);
    return cur === "USD" ? p.usd : p.php;
  };
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {(["PHP", "USD"] as const).map((cur) => (
        <div key={cur} className="rounded-xl border border-white/10 bg-[#0c162c66] p-3">
          <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">{cur}</div>
          <div className="grid grid-cols-2 gap-2">
            {cols.map((c) => {
              const v = fold(c.key, cur);
              return (
                <div key={c.key}>
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">{c.label}</div>
                  <div className={`text-sm font-extrabold ${v === 0 ? "opacity-50" : ""}`}>{c.money === false ? String(v) : formatMoney(v, cur)}</div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function CouponUsageModal({ code, onClose, handlers }: { code: string; onClose: () => void; handlers: Handlers }) {
  const [rows, setRows] = useState<UsageRedemption[] | null>(null);
  const [totals, setTotals] = useState<UsageTotals>({});
  const [error, setError] = useState<string | null>(null);
  const { requireAuth, handleAuthError } = handlers;

  useEffect(() => {
    const key = requireAuth();
    if (!key) return;
    let cancelled = false;
    apiFetch<{ redemptions: UsageRedemption[]; totalsByCurrency: UsageTotals }>(
      `/api/admin/coupons/${encodeURIComponent(code)}/usage`,
      key
    )
      .then((d) => {
        if (cancelled) return;
        setRows(d.redemptions || []);
        setTotals(d.totalsByCurrency || {});
      })
      .catch((e) => {
        if (cancelled || handleAuthError(e)) return;
        setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- auth helpers are stable enough; avoid refetch loops
  }, [code]);

  return (
    <Modal title={`Usage of ${code}`} onClose={onClose} wide>
      {error ? (
        <p role="alert" className="text-sm text-red-300">{error}</p>
      ) : rows === null ? (
        <p role="status" className="text-sm text-slate-400">Loading usage…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400">This coupon has not been used yet.</p>
      ) : (
        <div className="space-y-4">
          <TotalsSummary
            totals={totals}
            cols={[
              { key: "orders", label: "Orders", money: false },
              { key: "revenue", label: "Revenue" },
              { key: "discount", label: "Discounts" },
              { key: "commission", label: "Commission" },
            ]}
          />
          {rows.some((r) => r.isTest) && (
            <p className="text-xs text-fuchsia-200">TEST rows are GHL test-mode orders - listed for verification only, not counted in the totals above.</p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <caption className="sr-only">Redemptions of coupon {code}</caption>
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
                  <th scope="col" className="p-2">Date</th>
                  <th scope="col" className="p-2">Source</th>
                  <th scope="col" className="p-2">Buyer</th>
                  <th scope="col" className="p-2">Amount</th>
                  <th scope="col" className="p-2">Discount</th>
                  <th scope="col" className="p-2">Commission</th>
                  <th scope="col" className="p-2">Affiliate</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-white/10">
                    <td className="p-2">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="p-2">
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] ${r.source === "ghl" ? "border-cyan-400/40 text-cyan-200" : "border-blue-400/40 text-blue-200"}`}>
                        {r.source === "ghl" ? "GHL" : "PayMongo"}
                      </span>
                      {r.isTest && (
                        <span className="ml-1 rounded-full border border-fuchsia-300/40 bg-fuchsia-400/10 px-2 py-0.5 text-[10px] font-bold uppercase text-fuchsia-200">TEST</span>
                      )}
                      {r.status !== "paid" && <div className="mt-0.5 text-[10px] text-amber-300">{r.status}</div>}
                    </td>
                    <td className="p-2">
                      {r.fullName || "—"}
                      <br />
                      <span className="text-slate-400">{r.email}</span>
                    </td>
                    <td className="p-2">{formatMoney(r.baseAmount, r.currency)}</td>
                    <td className="p-2">{formatMoney(r.discountAmount, r.currency)}</td>
                    <td className="p-2">{r.affiliateEmail ? formatMoney(r.affiliateFeeAmount, r.currency) : <span className="text-slate-500">—</span>}</td>
                    <td className="p-2">{r.affiliateEmail || <span className="text-slate-500">Unassigned</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}

type Creditable = UsageRedemption;

function AssignModal({
  coupon,
  onClose,
  onChanged,
  handlers,
}: {
  coupon: UnifiedCoupon;
  onClose: () => void;
  onChanged: () => void;
  handlers: Handlers;
}) {
  const { requireAuth, handleAuthError, toast } = handlers;
  const [affiliates, setAffiliates] = useState<AffiliateOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<AffiliateOption | null>(null);
  const [fee, setFee] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creditable, setCreditable] = useState<Creditable[] | null>(null);
  const [effectiveFee, setEffectiveFee] = useState<number | null>(null);
  const [result, setResult] = useState<{ credited: number; totalsByCurrency: Record<string, { commission: number }> } | null>(null);

  useEffect(() => {
    const key = requireAuth();
    if (!key) return;
    apiFetch<{ affiliates: AffiliateOption[] }>("/api/admin/affiliates", key)
      .then((d) => setAffiliates(d.affiliates || []))
      .catch((e) => {
        if (!handleAuthError(e)) setLoadError((e as Error).message);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on open
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const isActive = (a: AffiliateOption) => !a.status || a.status === "active";
    return (affiliates || [])
      .filter((a) => !q || `${a.firstName} ${a.lastName} ${a.email} ${a.couponCode || ""}`.toLowerCase().includes(q))
      .sort((a, b) => Number(isActive(b)) - Number(isActive(a)))
      .slice(0, 50);
  }, [affiliates, query]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!picked) return setError("Choose an affiliate first.");
    const body: Record<string, unknown> = { affiliateEmail: picked.email };
    let feeFraction: number | null = null;
    if (fee.trim() !== "") {
      const n = Number(fee);
      if (!Number.isFinite(n) || n < 0 || n > 100) return setError("Fee must be between 0 and 100.");
      feeFraction = n / 100;
      body.affiliateFeePercent = feeFraction;
    }
    const key = requireAuth();
    if (!key) return;
    setBusy(true);
    setError(null);
    try {
      const d = await apiFetch<{ coupon?: { affiliateFeePercent?: number }; creditable?: Creditable[] }>(
        `/api/admin/ghl-coupons/${encodeURIComponent(coupon.code)}/assign`,
        key,
        { method: "POST", body }
      );
      onChanged();
      const list = d.creditable || [];
      setEffectiveFee(feeFraction ?? d.coupon?.affiliateFeePercent ?? null);
      if (list.length > 0) setCreditable(list);
      else {
        toast(`Assigned ${coupon.code} to ${picked.email}.`);
        onClose();
      }
    } catch (err) {
      if (!handleAuthError(err)) setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function credit(ids?: string[]) {
    const key = requireAuth();
    if (!key) return;
    setBusy(true);
    setError(null);
    try {
      const d = await apiFetch<{ credited: number; totalsByCurrency: Record<string, { commission: number }> }>(
        `/api/admin/ghl-coupons/${encodeURIComponent(coupon.code)}/credit-past`,
        key,
        { method: "POST", body: ids ? { redemptionIds: ids } : {} }
      );
      setResult(d);
      onChanged();
    } catch (err) {
      if (!handleAuthError(err)) setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Modal title="Past orders credited" onClose={onClose}>
        <p className="mb-3 text-sm">Credited {result.credited} order{result.credited === 1 ? "" : "s"} to {picked?.email}.</p>
        <div className="space-y-1.5 text-sm">
          {Object.entries(result.totalsByCurrency || {}).map(([cur, t]) => (
            <div key={cur}>Commission ({cur}): <strong>{formatMoney(t.commission, cur)}</strong></div>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <button type="button" className={btnPrimary} onClick={onClose}>Done</button>
        </div>
      </Modal>
    );
  }

  if (creditable) {
    return (
      <Modal title={`Credit past orders for ${coupon.code}?`} onClose={onClose} wide>
        <p className="mb-3 text-sm text-slate-300">
          {coupon.code} is now assigned to {picked?.email}. {creditable.length} earlier order{creditable.length === 1 ? " used" : "s used"} this
          code without an affiliate. Credit them?
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <caption className="sr-only">Orders that can be credited</caption>
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
                <th scope="col" className="p-2">Date</th>
                <th scope="col" className="p-2">Buyer</th>
                <th scope="col" className="p-2">Amount</th>
                <th scope="col" className="p-2">Projected commission</th>
              </tr>
            </thead>
            <tbody>
              {creditable.map((r) => (
                <tr key={r.id} className="border-t border-white/10">
                  <td className="p-2">{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td className="p-2">{r.fullName || "—"}<br /><span className="text-slate-400">{r.email}</span></td>
                  <td className="p-2">{formatMoney(r.baseAmount, r.currency)}</td>
                  <td className="p-2">
                    {effectiveFee != null ? formatMoney((r.commissionBase || 0) * effectiveFee, r.currency) : <span className="text-slate-500">Default fee</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose} disabled={busy}>Skip</button>
          <button type="button" className={btnPrimary} onClick={() => credit(creditable.map((r) => r.id))} disabled={busy}>
            {busy ? "Crediting…" : `Credit these ${creditable.length} orders`}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Assign ${coupon.code} to an affiliate`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor="assign-affiliate-search" className="mb-1.5 block text-xs font-semibold text-slate-300">Affiliate</label>
          <input
            id="assign-affiliate-search"
            className="input"
            placeholder="Search name, email, or coupon…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-white/10 bg-[#0c162ce6]" role="radiogroup" aria-label="Matching affiliates">
            {loadError ? (
              <div role="alert" className="p-2.5 text-xs text-red-300">{loadError}</div>
            ) : affiliates === null ? (
              <div role="status" className="p-2.5 text-xs text-slate-400">Loading affiliates…</div>
            ) : matches.length === 0 ? (
              <div className="p-2.5 text-xs text-slate-400">No matching affiliates.</div>
            ) : (
              matches.map((a) => (
                <label key={a.id} className={`flex min-h-10 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-white/5 ${picked?.id === a.id ? "bg-blue-400/10" : ""}`}>
                  <input type="radio" name="assign-affiliate" checked={picked?.id === a.id} onChange={() => setPicked(a)} />
                  <span>
                    {a.firstName} {a.lastName}
                    <span className="block text-xs text-slate-400">{a.email}{a.status && a.status !== "active" ? <span className="ml-1 text-slate-500"> (inactive)</span> : null}</span>
                  </span>
                </label>
              ))
            )}
          </div>
        </div>
        <div>
          <label htmlFor="assign-fee" className="mb-1.5 block text-xs font-semibold text-slate-300">Affiliate fee % (optional)</label>
          <input id="assign-fee" className="input" type="number" min={0} max={100} step="0.01" value={fee} onChange={(e) => setFee(e.target.value)} />
          <span className="mt-1.5 block text-[11px] text-slate-400">Whole percent, e.g. 20. Leave blank to use the default fee.</span>
        </div>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button type="submit" className={btnPrimary} disabled={busy || !picked}>{busy ? "Assigning…" : "Assign"}</button>
        </div>
      </form>
    </Modal>
  );
}

function UnassignModal({ coupon, onClose, onChanged, handlers }: { coupon: UnifiedCoupon; onClose: () => void; onChanged: () => void; handlers: Handlers }) {
  const { requireAuth, handleAuthError, toast } = handlers;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmUnassign() {
    const key = requireAuth();
    if (!key) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/admin/ghl-coupons/${encodeURIComponent(coupon.code)}/unassign`, key, { method: "POST" });
      toast(`Unassigned ${coupon.code}.`);
      onChanged();
      onClose();
    } catch (err) {
      if (!handleAuthError(err)) setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Unassign ${coupon.code}?`} onClose={onClose}>
      <p className="text-sm text-slate-300">
        {coupon.code} will no longer be linked to {coupon.affiliate?.name || coupon.affiliate?.email}. Future orders will not earn them commission.
      </p>
      {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btn} onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="rounded-lg bg-red-400 hover:bg-red-300 px-3 py-2 text-sm font-extrabold text-slate-950 disabled:opacity-60" onClick={confirmUnassign} disabled={busy}>
          {busy ? "Unassigning…" : "Unassign"}
        </button>
      </div>
    </Modal>
  );
}

export function GhlCouponsPanel({ handlers, ready, refreshKey }: { handlers: Handlers; ready: boolean; refreshKey: number }) {
  // Always read the latest auth helpers: they close over session state that is
  // still null on first render, so a memoized load must not capture them.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });
  const [coupons, setCoupons] = useState<UnifiedCoupon[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [assigning, setAssigning] = useState<UnifiedCoupon | null>(null);
  const [unassigning, setUnassigning] = useState<UnifiedCoupon | null>(null);
  const [usageCode, setUsageCode] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { requireAuth, handleAuthError } = handlersRef.current;
    const key = requireAuth();
    if (!key) return;
    setLoading(true);
    setLoadError(null);
    try {
      const d = await apiFetch<{ coupons: UnifiedCoupon[]; errors?: string[] }>("/api/admin/ghl-coupons", key);
      setCoupons(d.coupons || []);
      setErrors(d.errors || []);
    } catch (e) {
      if (!handleAuthError(e)) setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    load();
  }, [ready, refreshKey, load]);

  const filtered = coupons.filter((c) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return c.code.toLowerCase().includes(q) || (c.affiliate?.email || "").toLowerCase().includes(q) || (c.affiliate?.name || "").toLowerCase().includes(q);
  });

  return (
    <section aria-labelledby="ghl-unified-heading" className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl lg:col-span-2 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
        <div>
          <h2 id="ghl-unified-heading" className="text-xs font-bold uppercase tracking-wide text-slate-200">GHL Coupons &amp; Affiliate Assignment</h2>
          <div className="mt-1 text-xs text-slate-400">
            {coupons.length} coupons · {coupons.filter((c) => !c.affiliate).length} unassigned
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="ghl-unified-search">Search coupons or affiliates</label>
          <input id="ghl-unified-search" className="input w-52" placeholder="Search code or affiliate…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button type="button" className={btn} onClick={load} disabled={loading}>{loading ? "Loading…" : "Reload"}</button>
        </div>
      </div>

      {errors.length > 0 && (
        <div role="alert" className="m-3.5 rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-xs text-amber-100">
          <div className="mb-1 font-bold">Some GHL locations could not be read. The list may be incomplete.</div>
          {errors.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}
      {loadError && <div role="alert" className="m-3.5 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-xs text-red-200">{loadError}</div>}

      <div className="overflow-x-auto px-3.5 pb-8">
        <table className="w-full text-xs">
          <caption className="sr-only">GHL and local coupons with affiliate assignment</caption>
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
              <th scope="col" className="p-2">Code</th>
              <th scope="col" className="p-2">Origin</th>
              <th scope="col" className="p-2">Discount</th>
              <th scope="col" className="p-2">Locations</th>
              <th scope="col" className="p-2">Affiliate</th>
              <th scope="col" className="p-2">Paid uses</th>
              <th scope="col" className="p-2">Unassigned uses</th>
              <th scope="col" className="p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="p-2 text-slate-400">{loading ? "Loading coupons…" : "No coupons found."}</td></tr>
            )}
            {filtered.map((c) => (
              <tr key={c.code} className="border-t border-white/10 align-top hover:bg-white/[.03]">
                <td className="p-2 font-mono text-blue-200">{c.code}</td>
                <td className="p-2">
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] ${c.origin === "ghl" ? "border-amber-400/40 text-amber-200" : "border-purple-400/40 text-purple-200"}`}>
                    {c.origin === "ghl" ? "Made in GHL" : "Ours"}
                  </span>
                </td>
                <td className="p-2">{(c.discountPercent * 100).toFixed(0)}%</td>
                <td className="p-2">
                  <div className="flex flex-wrap gap-1">
                    {c.locations.length === 0 && <span className="text-slate-500">—</span>}
                    {c.locations.map((l) => (
                      <span key={`${l.key}-${l.locationId}`} className="rounded-full border border-white/15 px-2 py-0.5 text-[10px] text-slate-200">
                        {l.key === "global" ? "Global" : "Main"} · {l.status || "unknown"}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="p-2">
                  {c.affiliate ? (
                    <>
                      {c.affiliate.name || c.affiliate.email}
                      <br />
                      <span className="text-slate-400">{c.affiliate.email}</span>
                    </>
                  ) : (
                    <span className="text-slate-500">Unassigned</span>
                  )}
                </td>
                <td className="p-2">{c.usage?.paidCount ?? 0}</td>
                <td className="p-2">{c.usage?.unassignedCount ?? 0}</td>
                <td className="p-2">
                  <div className="flex flex-wrap gap-1.5">
                    {(!c.affiliate || c.origin === "ghl") && (
                      <button type="button" className={btn} onClick={() => setAssigning(c)} aria-label={`Assign ${c.code} to an affiliate`}>
                        {c.affiliate ? "Reassign" : "Assign to affiliate"}
                      </button>
                    )}
                    {c.origin === "ghl" && c.affiliate && (
                      <button type="button" className={btnDanger} onClick={() => setUnassigning(c)} aria-label={`Unassign ${c.code}`}>Unassign</button>
                    )}
                    <button type="button" className={btn} onClick={() => setUsageCode(c.code)} aria-label={`View usage of ${c.code}`}>View usage</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {assigning && <AssignModal coupon={assigning} onClose={() => setAssigning(null)} onChanged={load} handlers={handlers} />}
      {unassigning && <UnassignModal coupon={unassigning} onClose={() => setUnassigning(null)} onChanged={load} handlers={handlers} />}
      {usageCode && <CouponUsageModal code={usageCode} onClose={() => setUsageCode(null)} handlers={handlers} />}
    </section>
  );
}
