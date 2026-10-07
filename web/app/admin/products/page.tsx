"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminTopbar } from "@/components/AdminTopbar";
import { EmbedPanel } from "@/components/EmbedPanel";
import { GhlProductsPanel } from "@/components/GhlProductsPanel";
import { ProductCouponConfigPanel, Switch } from "@/components/ProductCouponConfigPanel";
import { Toast } from "@/components/Toast";
import { apiFetch } from "@/lib/api";
import { useAdminAuth } from "@/lib/useAdminAuth";
import { useToast } from "@/lib/useToast";

type Product = {
  id: string;
  name: string;
  amountPhp: number;
  setupFeePhp?: number | null;
  currency: string;
  billing: { type: string; interval?: string };
  couponConfig?: { affiliateCouponsEnabled: boolean; disabledCouponCount: number };
  defaults: {
    paymentMethod?: string;
    source?: string;
    taxRate?: number;
    displaySuffix?: string;
    successUrl?: string;
    cancelUrl?: string;
    termsUrl?: string;
    privacyUrl?: string;
  };
};

const emptyForm = {
  id: "",
  name: "",
  amountPhp: "",
  hasSetupFee: false,
  setupFeePhp: "",
  taxRate: "",
  paymentMethod: "",
  source: "",
  displaySuffix: "",
  billingType: "one_time",
  successUrl: "",
  cancelUrl: "",
  termsUrl: "",
  privacyUrl: "",
};

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export default function ProductsPage() {
  const { ready, admin, requireAuth, handleAuthError, logout } = useAdminAuth();
  const { message, toast } = useToast();

  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  const loadProducts = useCallback(
    async (key: string) => {
      const data = await apiFetch<{ products: Product[] }>("/api/admin/products", key);
      setProducts(data.products || []);
    },
    []
  );

  useEffect(() => {
    if (!ready) return;
    const key = requireAuth();
    if (!key) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern
    loadProducts(key).catch((e) => { if (!handleAuthError(e)) toast(e.message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requireAuth/loadProducts intentionally not deps to avoid refetch loops
  }, [ready]);

  function fillForm(p: Product | null) {
    setSelectedId(p?.id || null);
    setForm({
      id: p?.id || "",
      name: p?.name || "",
      amountPhp: p ? String(p.amountPhp) : "",
      hasSetupFee: Boolean(p?.setupFeePhp),
      setupFeePhp: p?.setupFeePhp ? String(p.setupFeePhp) : "",
      taxRate: p?.defaults?.taxRate != null ? String(p.defaults.taxRate) : "",
      paymentMethod: p?.defaults?.paymentMethod || "",
      source: p?.defaults?.source || "",
      displaySuffix: p?.defaults?.displaySuffix || "",
      billingType: p?.billing?.type || "one_time",
      successUrl: p?.defaults?.successUrl || "",
      cancelUrl: p?.defaults?.cancelUrl || "",
      termsUrl: p?.defaults?.termsUrl || "",
      privacyUrl: p?.defaults?.privacyUrl || "",
    });
  }

  function selectProduct(p: Product) {
    fillForm(p);
  }

  async function handleRefresh() {
    const key = requireAuth();
    if (!key) return;
    try {
      await loadProducts(key);
      toast("Refreshed.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const key = requireAuth();
    if (!key) return;

    const setupFee = form.billingType === "recurring" && form.hasSetupFee ? Number(form.setupFeePhp) : null;
    if (form.billingType === "recurring" && form.hasSetupFee && !(setupFee! > 0)) {
      toast("Enter a setup fee greater than 0, or turn the setup fee off.");
      return;
    }

    const payload = {
      id: selectedId || form.id || slugify(form.name),
      name: form.name,
      amountPhp: Number(form.amountPhp),
      setupFeePhp: setupFee,
      currency: "PHP",
      billing: { type: form.billingType },
      defaults: {
        ...(form.paymentMethod ? { paymentMethod: form.paymentMethod } : {}),
        ...(form.source ? { source: form.source } : {}),
        ...(form.taxRate ? { taxRate: Number(form.taxRate) } : {}),
        ...(form.displaySuffix ? { displaySuffix: form.displaySuffix } : {}),
        ...(form.successUrl ? { successUrl: form.successUrl } : {}),
        ...(form.cancelUrl ? { cancelUrl: form.cancelUrl } : {}),
        termsUrl: form.termsUrl.trim(),
        privacyUrl: form.privacyUrl.trim(),
      },
    };

    try {
      const method = selectedId ? "PUT" : "POST";
      const path = selectedId
        ? `/api/admin/products/${encodeURIComponent(payload.id)}`
        : "/api/admin/products";
      const data = await apiFetch<{ product: Product }>(path, key, { method, body: payload });
      toast("Saved.");
      await loadProducts(key);
      selectProduct(data.product);
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function handleDelete() {
    if (!selectedId) return;
    if (!confirm(`Delete product "${selectedId}"?`)) return;
    const key = requireAuth();
    if (!key) return;
    try {
      await apiFetch(`/api/admin/products/${encodeURIComponent(selectedId)}`, key, { method: "DELETE" });
      toast("Deleted.");
      fillForm(null);
      await loadProducts(key);
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  // Opens a new tab in PayMongo TEST mode. The tab is opened synchronously (popup blockers), then
  // pointed at the preview page once the short-lived admin-only token arrives. The token travels
  // in the URL fragment, so it is never sent to a server or logged.
  async function handleTestCheckout(productId: string) {
    const key = requireAuth();
    if (!key) return;
    const tab = window.open("", "_blank");
    try {
      const data = await apiFetch<{ token: string; expiresAt: string }>("/api/admin/test-checkout-token", key, { method: "POST" });
      const hash = new URLSearchParams({ t: data.token, p: productId, exp: data.expiresAt }).toString();
      const url = `/admin/test-checkout#${hash}`;
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch (e) {
      tab?.close();
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  const filtered = products.filter((p) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q);
  });

  return (
    <div className="flex flex-1 flex-col">
      <AdminTopbar
        title="Nexistry Backend"
        subtitle="Product Catalog + Embeddable Checkout Forms"
        adminEmail={admin?.email}
        onRefresh={handleRefresh}
        onLogout={logout}
      />
      <main className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-4 px-5 py-5 lg:grid-cols-[1fr_1.2fr]">
        <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">Products</h2>
            <div className="flex gap-2">
              <input
                className="rounded-lg border border-white/10 bg-[#0c162ce6] px-3 py-2 text-sm outline-none focus:border-blue-400"
                placeholder="Search products…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button type="button"
                onClick={() => fillForm(null)}
                className="rounded-lg bg-gradient-to-b from-blue-400 to-blue-500 px-3 py-2 text-sm font-extrabold text-slate-950"
              >
                New Product
              </button>
            </div>
          </div>
          <div className="flex max-h-[70vh] flex-col gap-2.5 overflow-y-auto p-2.5">
            {filtered.length === 0 && (
              <div className="rounded-xl border border-white/10 bg-[#0c162c8c] p-3">
                <div className="font-extrabold">No products</div>
                <div className="mt-1 text-xs text-slate-400">Create one to get an embeddable checkout form.</div>
              </div>
            )}
            {filtered.map((p) => (
              <div
                key={p.id}
                onClick={() => selectProduct(p)}
                className={`flex cursor-pointer items-start justify-between gap-2.5 rounded-xl border p-3 hover:border-blue-400/40 ${
                  selectedId === p.id ? "border-blue-400 bg-blue-400/10" : "border-white/10 bg-[#0c162c8c]"
                }`}
              >
                <div>
                  <div className="font-extrabold">{p.name}</div>
                  <div className="mt-1 text-xs text-slate-400">
                    {p.id} · ₱{Number(p.amountPhp).toLocaleString()}
                    {p.defaults?.displaySuffix ? ` ${p.defaults.displaySuffix}` : ""}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <div className="rounded-full border border-white/10 px-2.5 py-1 text-xs">Embed</div>
                  {p.setupFeePhp ? (
                    <div className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-2 py-0.5 text-[11px] text-cyan-200">
                      Setup fee ₱{Number(p.setupFeePhp).toLocaleString()}
                    </div>
                  ) : null}
                  {p.couponConfig && p.couponConfig.affiliateCouponsEnabled === false && (
                    <div className="rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[11px] text-amber-200">Affiliate off</div>
                  )}
                  {p.couponConfig && p.couponConfig.disabledCouponCount > 0 && (
                    <div className="rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[11px] text-amber-200">
                      {p.couponConfig.disabledCouponCount} {p.couponConfig.disabledCouponCount === 1 ? "coupon" : "coupons"} off
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">
              {selectedId ? `Edit Product: ${form.name}` : "New Product"}
            </h2>
            <div className="flex gap-2">
              {selectedId && (
                <button type="button"
                  onClick={handleDelete}
                  className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm font-extrabold text-red-200"
                >
                  Delete
                </button>
              )}
              <button type="button"
                onClick={() => fillForm(products.find((p) => p.id === selectedId) || null)}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold"
              >
                Reset
              </button>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
            <Field
              label="ID (slug)"
              hint={selectedId ? "ID is permanent \u2014 embeds reference it." : "Leave blank to auto-generate from name."}
            >
              <input className="input" placeholder="e.g. ghl_practice_access" value={form.id}
                readOnly={!!selectedId}
                onChange={(e) => setForm({ ...form, id: e.target.value })} />
            </Field>
            <Field label="Name">
              <input className="input" required value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Amount (PHP)">
              <input className="input" type="number" min={1} step="0.01" required value={form.amountPhp}
                onChange={(e) => setForm({ ...form, amountPhp: e.target.value })} />
            </Field>
            <Field label="Tax rate" hint="Charged at checkout. 0.10 = 10%. Leave blank to use the server default.">
              <input className="input" type="number" min={0} max={1} step="0.01" value={form.taxRate}
                onChange={(e) => setForm({ ...form, taxRate: e.target.value })} />
            </Field>
            <Field label="Default payment method">
              <input className="input" placeholder="e.g. qrph or all" value={form.paymentMethod}
                onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })} />
            </Field>
            <Field label="Default source">
              <input className="input" value={form.source}
                onChange={(e) => setForm({ ...form, source: e.target.value })} />
            </Field>
            <Field label="Display suffix">
              <input className="input" placeholder="e.g. /month" value={form.displaySuffix}
                onChange={(e) => setForm({ ...form, displaySuffix: e.target.value })} />
            </Field>
            <Field label="Billing">
              <select className="input" value={form.billingType}
                onChange={(e) => setForm({
                  ...form,
                  billingType: e.target.value,
                  ...(e.target.value === "recurring" ? {} : { hasSetupFee: false, setupFeePhp: "" }),
                })}>
                <option value="one_time">One-time</option>
                <option value="recurring">Recurring (GHL invoice schedule)</option>
              </select>
            </Field>
            {form.billingType === "recurring" && (
              <>
                <div className="flex items-center justify-between gap-3 self-end rounded-lg border border-white/10 px-3 py-2">
                  <span className="text-xs font-semibold text-slate-300">Add setup fee?</span>
                  <Switch
                    label="Add setup fee"
                    checked={form.hasSetupFee}
                    onChange={(v) => setForm({ ...form, hasSetupFee: v, setupFeePhp: v ? form.setupFeePhp : "" })}
                  />
                </div>
                {form.hasSetupFee && (
                  <Field
                    label="Setup fee (₱)"
                    hint={
                      Number(form.setupFeePhp) > 0 && Number(form.amountPhp) > 0
                        ? `First payment: ₱${(Number(form.amountPhp) + Number(form.setupFeePhp)).toLocaleString()} · then ₱${Number(form.amountPhp).toLocaleString()}/month (before tax/discounts)`
                        : "Charged once, with the first payment only. Renewals stay at the monthly price."
                    }
                  >
                    <input className="input" type="number" min="0" step="0.01" value={form.setupFeePhp}
                      onChange={(e) => setForm({ ...form, setupFeePhp: e.target.value })} />
                  </Field>
                )}
              </>
            )}
            <Field label="Success URL">
              <input className="input" value={form.successUrl}
                onChange={(e) => setForm({ ...form, successUrl: e.target.value })} />
            </Field>
            <Field label="Cancel URL">
              <input className="input" value={form.cancelUrl}
                onChange={(e) => setForm({ ...form, cancelUrl: e.target.value })} />
            </Field>
            <Field label="Terms & Conditions link (override)" hint="Leave blank to use the global setting (Admin > Settings).">
              <input className="input" type="url" placeholder="https://" value={form.termsUrl}
                onChange={(e) => setForm({ ...form, termsUrl: e.target.value })} />
            </Field>
            <Field label="Privacy Policy link (override)" hint="Leave blank to use the global setting (Admin > Settings).">
              <input className="input" type="url" placeholder="https://" value={form.privacyUrl}
                onChange={(e) => setForm({ ...form, privacyUrl: e.target.value })} />
            </Field>

            <div className="col-span-full flex justify-end">
              <button type="submit" className="rounded-lg bg-gradient-to-b from-blue-400 to-blue-500 px-4 py-2.5 text-sm font-extrabold text-slate-950">
                Save Product
              </button>
            </div>
          </form>

          {selectedId && (
            <>
              <div className="h-px bg-white/10" />
              <ProductCouponConfigPanel
                key={selectedId}
                target={{ kind: "local", ref: selectedId, name: form.name }}
                requireAuth={requireAuth}
                handleAuthError={handleAuthError}
                toast={toast}
                onSaved={() => {
                  const key = requireAuth();
                  if (key) loadProducts(key).catch(() => {});
                }}
              />
            </>
          )}

          <div className="h-px bg-white/10" />

          {selectedId ? (
            <EmbedPanel productId={selectedId} onCopyFallbackToast={toast} onTestCheckout={handleTestCheckout} />
          ) : (
            <p className="p-4 text-xs text-slate-400">Save or select a product to get its embed form.</p>
          )}
        </section>

        <div className="lg:col-span-2">
          {ready && admin && (
            <GhlProductsPanel requireAuth={requireAuth} handleAuthError={handleAuthError} toast={toast} />
          )}
        </div>
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
