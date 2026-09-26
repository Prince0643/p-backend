"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminTopbar } from "@/components/AdminTopbar";
import { Toast } from "@/components/Toast";
import { apiFetch } from "@/lib/api";
import { useAdminAuth } from "@/lib/useAdminAuth";
import { useToast } from "@/lib/useToast";

type Coupon = {
  code: string;
  discountPercent: number;
  affiliateFeePercent: number;
  affiliateEmail: string;
  active: boolean;
  expiresAt: string | null;
  productIds: string[];
  maxRedemptions: number | null;
  notes: string;
};

type Redemption = {
  id: string;
  code: string;
  paymentReference: string;
  fullName: string;
  email: string;
  baseAmount: number;
  discountAmount: number;
  affiliateFeeAmount: number;
  affiliateEmail: string;
  status: string;
  createdAt: string;
};

type GhlCoupon = {
  id: string;
  code: string;
  name: string;
  status: string;
  discountType: string;
  discountValue: number | null;
  usageLimit: number | null;
  redemptionCount: number | null;
  startDate: string | null;
  endDate: string | null;
  createdAt: string | null;
  locationName: string;
  locationId: string;
  affiliate: {
    id: string;
    name: string;
    email: string;
    status: string;
  } | null;
};

type GhlCouponError = {
  locationName: string;
  locationId: string;
  error: string;
};

type GhlSyncSummary = {
  locations: number;
  localCoupons: number;
  activeCoupons: number;
  created: number;
  skippedExisting: number;
  skippedInactive: number;
  errors: number;
};

const emptyForm = {
  code: "",
  discountPercent: "",
  affiliateFeePercent: "",
  affiliateEmail: "",
  expiresAt: "",
  maxRedemptions: "",
  productIds: "",
  active: "true",
  notes: "",
};

function toLocalDatetimeValue(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CouponsPage() {
  const { ready, admin, requireAuth, handleAuthError, logout } = useAdminAuth();
  const { message, toast } = useToast();

  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [search, setSearch] = useState("");
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedRedemptionIds, setSelectedRedemptionIds] = useState<Set<string>>(new Set());
  const [ghlCoupons, setGhlCoupons] = useState<GhlCoupon[]>([]);
  const [ghlErrors, setGhlErrors] = useState<GhlCouponError[]>([]);
  const [ghlStatusFilter, setGhlStatusFilter] = useState("");
  const [ghlSearch, setGhlSearch] = useState("");
  const [loadingGhlCoupons, setLoadingGhlCoupons] = useState(false);
  const [syncingGhlCoupons, setSyncingGhlCoupons] = useState(false);
  const [ghlSyncSummary, setGhlSyncSummary] = useState<GhlSyncSummary | null>(null);

  const loadCoupons = useCallback(async (key: string) => {
    const data = await apiFetch<{ coupons: Coupon[] }>("/api/admin/coupons", key);
    setCoupons(data.coupons || []);
  }, []);

  const loadRedemptions = useCallback(async (key: string, code: string | null, status: string) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (code) params.set("code", code);
    const data = await apiFetch<{ redemptions: Redemption[] }>(
      `/api/admin/coupons/redemptions${params.toString() ? `?${params}` : ""}`,
      key
    );
    setRedemptions(data.redemptions || []);
  }, []);

  const loadGhlCoupons = useCallback(async (key: string, status: string, searchTerm: string) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (searchTerm.trim()) params.set("search", searchTerm.trim());
    const data = await apiFetch<{ coupons: GhlCoupon[]; errors: GhlCouponError[] }>(
      `/api/admin/coupons/ghl${params.toString() ? `?${params}` : ""}`,
      key
    );
    setGhlCoupons(data.coupons || []);
    setGhlErrors(data.errors || []);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const key = requireAuth();
    if (!key) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern
    loadCoupons(key).catch((e) => { if (!handleAuthError(e)) toast(e.message); });
    loadRedemptions(key, null, "").catch((e) => { if (!handleAuthError(e)) toast(e.message); });
    setLoadingGhlCoupons(true);
    loadGhlCoupons(key, "", "")
      .catch((e) => { if (!handleAuthError(e)) toast(e.message); })
      .finally(() => setLoadingGhlCoupons(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requireAuth/load fns intentionally not deps to avoid refetch loops
  }, [ready]);

  function fillForm(c: Coupon | null) {
    setSelectedCode(c?.code || null);
    setForm({
      code: c?.code || "",
      discountPercent: c ? String(Number((c.discountPercent * 100).toFixed(4))) : "",
      affiliateFeePercent: c ? String(Number((c.affiliateFeePercent * 100).toFixed(4))) : "",
      affiliateEmail: c?.affiliateEmail || "",
      expiresAt: toLocalDatetimeValue(c?.expiresAt || null),
      maxRedemptions: c?.maxRedemptions != null ? String(c.maxRedemptions) : "",
      productIds: (c?.productIds || []).join(", "),
      active: c ? String(!!c.active) : "true",
      notes: c?.notes || "",
    });
  }

  async function handleRefresh() {
    const key = requireAuth();
    if (!key) return;
    try {
      await loadCoupons(key);
      await loadRedemptions(key, selectedCode, statusFilter);
      await loadGhlCoupons(key, ghlStatusFilter, ghlSearch);
      toast("Refreshed.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const key = requireAuth();
    if (!key) return;

    const payload = {
      code: form.code.trim().toUpperCase(),
      discountPercent: Number(form.discountPercent) / 100,
      affiliateFeePercent: form.affiliateFeePercent ? Number(form.affiliateFeePercent) / 100 : 0,
      affiliateEmail: form.affiliateEmail,
      expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      maxRedemptions: form.maxRedemptions ? Number(form.maxRedemptions) : null,
      productIds: form.productIds.split(",").map((s) => s.trim()).filter(Boolean),
      active: form.active === "true",
      notes: form.notes,
    };

    try {
      const method = selectedCode ? "PUT" : "POST";
      const path = selectedCode
        ? `/api/admin/coupons/${encodeURIComponent(payload.code)}`
        : "/api/admin/coupons";
      const data = await apiFetch<{ coupon: Coupon }>(path, key, { method, body: payload });
      toast("Saved.");
      await loadCoupons(key);
      fillForm(data.coupon);
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function handleDelete() {
    if (!selectedCode) return;
    if (!confirm(`Delete coupon "${selectedCode}"?`)) return;
    const key = requireAuth();
    if (!key) return;
    try {
      await apiFetch(`/api/admin/coupons/${encodeURIComponent(selectedCode)}`, key, { method: "DELETE" });
      toast("Deleted.");
      fillForm(null);
      await loadCoupons(key);
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function handleLoadRedemptions() {
    const key = requireAuth();
    if (!key) return;
    try {
      await loadRedemptions(key, selectedCode, statusFilter);
      toast("Loaded redemptions.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function handleLoadGhlCoupons() {
    const key = requireAuth();
    if (!key) return;
    setLoadingGhlCoupons(true);
    try {
      await loadGhlCoupons(key, ghlStatusFilter, ghlSearch);
      toast("Loaded GHL coupons.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    } finally {
      setLoadingGhlCoupons(false);
    }
  }

  async function handleSyncGhlCoupons() {
    if (!confirm("Sync every active local coupon code to every configured GHL location? Existing GHL codes will be skipped.")) return;
    const key = requireAuth();
    if (!key) return;
    setSyncingGhlCoupons(true);
    try {
      const data = await apiFetch<{ summary: GhlSyncSummary }>("/api/admin/coupons/ghl/sync", key, { method: "POST" });
      setGhlSyncSummary(data.summary);
      await loadGhlCoupons(key, ghlStatusFilter, ghlSearch);
      toast(`GHL sync complete: ${data.summary.created} created, ${data.summary.skippedExisting} already existed.`);
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    } finally {
      setSyncingGhlCoupons(false);
    }
  }

  async function handleMarkPaid() {
    if (selectedRedemptionIds.size === 0) return toast("Select at least one redemption.");
    if (!confirm(`Mark ${selectedRedemptionIds.size} redemption(s) as paid?`)) return;
    const key = requireAuth();
    if (!key) return;
    try {
      await apiFetch("/api/admin/coupons/redemptions/mark-paid", key, {
        method: "POST",
        body: { ids: Array.from(selectedRedemptionIds) },
      });
      toast("Marked as paid.");
      setSelectedRedemptionIds(new Set());
      await loadRedemptions(key, selectedCode, statusFilter);
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  function toggleRedemption(id: string) {
    setSelectedRedemptionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filtered = coupons.filter((c) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return c.code.toLowerCase().includes(q) || c.affiliateEmail.toLowerCase().includes(q);
  });

  const affiliateLinkedCount = ghlCoupons.filter((c) => c.affiliate).length;

  return (
    <div className="flex flex-1 flex-col">
      <AdminTopbar
        title="Nexistry Backend"
        subtitle="Coupons + Affiliate Payout Tracking"
        adminEmail={admin?.email}
        onRefresh={handleRefresh}
        onLogout={logout}
      />
      <main className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-4 px-5 pb-28 pt-5 lg:grid-cols-[1fr_1.2fr]">
        <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">Coupons</h2>
            <div className="flex gap-2">
              <input
                className="rounded-lg border border-white/10 bg-[#0c162ce6] px-3 py-2 text-sm outline-none focus:border-blue-400"
                placeholder="Search coupons…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button onClick={() => fillForm(null)} className="rounded-lg bg-blue-400 hover:bg-blue-300 px-3 py-2 text-sm font-extrabold text-slate-950">
                New Coupon
              </button>
            </div>
          </div>
          <div className="flex max-h-[50vh] flex-col gap-2.5 overflow-y-auto p-2.5">
            {filtered.length === 0 && (
              <div className="rounded-xl border border-white/10 bg-[#0c162c8c] p-3">
                <div className="font-extrabold">No coupons</div>
                <div className="mt-1 text-xs text-slate-400">Create one to enable a promo code at checkout.</div>
              </div>
            )}
            {filtered.map((c) => (
              <div
                key={c.code}
                onClick={() => fillForm(c)}
                className={`flex cursor-pointer items-start justify-between gap-2.5 rounded-xl border p-3 hover:border-blue-400/40 ${
                  selectedCode === c.code ? "border-blue-400 bg-blue-400/10" : "border-white/10 bg-[#0c162c8c]"
                }`}
              >
                <div>
                  <div className="font-extrabold">{c.code}</div>
                  <div className="mt-1 text-xs text-slate-400">
                    {(c.discountPercent * 100).toFixed(0)}% off
                    {c.affiliateFeePercent ? ` · ${(c.affiliateFeePercent * 100).toFixed(0)}% affiliate fee` : ""} ·{" "}
                    {c.expiresAt ? `expires ${new Date(c.expiresAt).toLocaleString()}` : "no expiry"}
                  </div>
                </div>
                <div className={`rounded-full border px-2.5 py-1 text-xs ${c.active ? "border-emerald-400/40 text-emerald-200" : "border-red-400/40 text-red-200"}`}>
                  {c.active ? "Active" : "Inactive"}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">
              {selectedCode ? `Edit Coupon: ${selectedCode}` : "New Coupon"}
            </h2>
            {selectedCode && (
              <button onClick={handleDelete} className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm font-extrabold text-red-200">
                Delete
              </button>
            )}
          </div>

          <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
            <Field label="Code" hint="Uppercased automatically. Letters, numbers, - and _ only, up to 50 characters.">
              <input className="input uppercase" required maxLength={50} value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })} />
            </Field>
            <Field label="Discount %">
              <input className="input" type="number" min={0} max={100} step="0.01" required value={form.discountPercent}
                onChange={(e) => setForm({ ...form, discountPercent: e.target.value })} />
            </Field>
            <Field label="Affiliate fee %">
              <input className="input" type="number" min={0} max={100} step="0.01" value={form.affiliateFeePercent}
                onChange={(e) => setForm({ ...form, affiliateFeePercent: e.target.value })} />
            </Field>
            <Field label="Affiliate email">
              <input className="input" type="email" value={form.affiliateEmail}
                onChange={(e) => setForm({ ...form, affiliateEmail: e.target.value })} />
            </Field>
            <Field label="Expires at" hint="Leave blank for no expiry.">
              <input className="input" type="datetime-local" value={form.expiresAt}
                onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
            </Field>
            <Field label="Max redemptions" hint="Leave blank for unlimited.">
              <input className="input" type="number" min={1} step={1} value={form.maxRedemptions}
                onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value })} />
            </Field>
            <Field label="Eligible product IDs" hint="Comma-separated. Leave blank for all products.">
              <input className="input" value={form.productIds}
                onChange={(e) => setForm({ ...form, productIds: e.target.value })} />
            </Field>
            <Field label="Status">
              <select className="input" value={form.active} onChange={(e) => setForm({ ...form, active: e.target.value })}>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Notes">
                <input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </Field>
            </div>
            <div className="col-span-full flex justify-end">
              <button type="submit" className="rounded-lg bg-blue-400 hover:bg-blue-300 px-4 py-2.5 text-sm font-extrabold text-slate-950">
                Save Coupon
              </button>
            </div>
          </form>

          <div className="h-px bg-white/10" />

          <div className="flex flex-wrap items-center justify-between gap-3 p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">Redemptions &amp; Affiliate Payouts</h2>
            <div className="flex flex-wrap gap-2">
              <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">All statuses</option>
                <option value="pending">Pending</option>
                <option value="paid">Paid</option>
                <option value="released">Released</option>
              </select>
              <button onClick={handleLoadRedemptions} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold">
                Load
              </button>
              <button onClick={handleMarkPaid} className="rounded-lg bg-blue-400 hover:bg-blue-300 px-3 py-2 text-sm font-extrabold text-slate-950">
                Mark Selected Paid
              </button>
            </div>
          </div>
          <div className="overflow-x-auto px-3.5 pb-8">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
                  <th className="p-2"></th>
                  <th className="p-2">Code</th>
                  <th className="p-2">Payment Ref</th>
                  <th className="p-2">Customer</th>
                  <th className="p-2">Base</th>
                  <th className="p-2">Discount</th>
                  <th className="p-2">Affiliate Fee</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Date</th>
                </tr>
              </thead>
              <tbody>
                {redemptions.length === 0 && (
                  <tr><td colSpan={9} className="p-2 text-slate-400">No redemptions loaded.</td></tr>
                )}
                {redemptions.map((r) => (
                  <tr key={r.id} className="border-t border-white/10 hover:bg-white/[.03]">
                    <td className="p-2">
                      <input
                        type="checkbox"
                        disabled={r.status === "paid"}
                        checked={selectedRedemptionIds.has(r.id)}
                        onChange={() => toggleRedemption(r.id)}
                      />
                    </td>
                    <td className="p-2">{r.code}</td>
                    <td className="p-2">{r.paymentReference}</td>
                    <td className="p-2">
                      {r.fullName}
                      <br />
                      <span className="text-slate-400">{r.email}</span>
                    </td>
                    <td className="p-2">₱{Number(r.baseAmount).toLocaleString()}</td>
                    <td className="p-2">₱{Number(r.discountAmount).toLocaleString()}</td>
                    <td className="p-2">₱{Number(r.affiliateFeeAmount).toLocaleString()}</td>
                    <td className={`p-2 ${r.status === "paid" ? "text-emerald-300" : "text-amber-300"}`}>{r.status}</td>
                    <td className="p-2">{new Date(r.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
            <div>
              <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">GHL Coupons</h2>
              <div className="mt-1 text-xs text-slate-400">
                {ghlCoupons.length} codes fetched · {affiliateLinkedCount} matched to affiliates
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                className="input w-52"
                placeholder="Search GHL coupons…"
                value={ghlSearch}
                onChange={(e) => setGhlSearch(e.target.value)}
              />
              <select className="input w-36" value={ghlStatusFilter} onChange={(e) => setGhlStatusFilter(e.target.value)}>
                <option value="">All statuses</option>
                <option value="scheduled">Scheduled</option>
                <option value="active">Active</option>
                <option value="expired">Expired</option>
              </select>
              <button onClick={handleLoadGhlCoupons} disabled={loadingGhlCoupons} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold disabled:opacity-60">
                {loadingGhlCoupons ? "Loading…" : "Fetch GHL"}
              </button>
              <button onClick={handleSyncGhlCoupons} disabled={syncingGhlCoupons} className="rounded-lg bg-blue-400 hover:bg-blue-300 px-3 py-2 text-sm font-extrabold text-slate-950 disabled:opacity-60">
                {syncingGhlCoupons ? "Syncing…" : "Sync Local to GHL"}
              </button>
            </div>
          </div>

          {ghlSyncSummary && (
            <div className="m-3.5 grid gap-2 rounded-xl border border-blue-300/20 bg-blue-300/10 p-3 text-xs text-blue-100 sm:grid-cols-6">
              <Metric label="Locations" value={ghlSyncSummary.locations} />
              <Metric label="Local" value={ghlSyncSummary.localCoupons} />
              <Metric label="Active" value={ghlSyncSummary.activeCoupons} />
              <Metric label="Created" value={ghlSyncSummary.created} />
              <Metric label="Existing" value={ghlSyncSummary.skippedExisting} />
              <Metric label="Errors" value={ghlSyncSummary.errors} />
            </div>
          )}

          {ghlErrors.length > 0 && (
            <div className="m-3.5 rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-xs text-amber-100">
              {ghlErrors.map((err) => (
                <div key={err.locationId}>
                  {err.locationName}: {err.error}
                </div>
              ))}
            </div>
          )}

          <div className="overflow-x-auto px-3.5 pb-8">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
                  <th className="p-2">Code</th>
                  <th className="p-2">Location</th>
                  <th className="p-2">Affiliate</th>
                  <th className="p-2">Discount</th>
                  <th className="p-2">Usage</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Ends</th>
                </tr>
              </thead>
              <tbody>
                {ghlCoupons.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-2 text-slate-400">
                      {loadingGhlCoupons ? "Loading GHL coupons…" : "No GHL coupons loaded."}
                    </td>
                  </tr>
                )}
                {ghlCoupons.map((coupon, index) => (
                  <tr key={`${coupon.locationId}-${coupon.id || coupon.code || index}`} className="border-t border-white/10 hover:bg-white/[.03]">
                    <td className="p-2 font-mono text-blue-200">{coupon.code || "—"}</td>
                    <td className="p-2">
                      {coupon.locationName}
                      <br />
                      <span className="font-mono text-[10px] text-slate-500">{coupon.locationId}</span>
                    </td>
                    <td className="p-2">
                      {coupon.affiliate ? (
                        <>
                          {coupon.affiliate.name || coupon.affiliate.email}
                          <br />
                          <span className="text-slate-400">{coupon.affiliate.email} · {coupon.affiliate.status}</span>
                        </>
                      ) : (
                        <span className="text-slate-500">Not linked</span>
                      )}
                    </td>
                    <td className="p-2">
                      {coupon.discountValue != null ? coupon.discountValue : "—"}
                      {coupon.discountType ? ` ${coupon.discountType}` : ""}
                    </td>
                    <td className="p-2">
                      {coupon.redemptionCount ?? 0}
                      {coupon.usageLimit != null ? ` / ${coupon.usageLimit}` : ""}
                    </td>
                    <td className="p-2">{coupon.status || "—"}</td>
                    <td className="p-2">{coupon.endDate ? new Date(coupon.endDate).toLocaleDateString() : "No expiry"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
      <Toast message={message} />
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-slate-300">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-blue-200/70">{label}</div>
      <div className="mt-0.5 text-base font-extrabold text-white">{value}</div>
    </div>
  );
}
