"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminTopbar } from "@/components/AdminTopbar";
import { Toast } from "@/components/Toast";
import { apiFetch } from "@/lib/api";
import { useApiKey } from "@/lib/useApiKey";
import { useToast } from "@/lib/useToast";

type Product = {
  id: string;
  name: string;
  amountPhp: number;
  currency: string;
  billing: { type: string; interval?: string };
  defaults: {
    paymentMethod?: string;
    source?: string;
    taxRate?: number;
    displaySuffix?: string;
    successUrl?: string;
    cancelUrl?: string;
  };
};

const emptyForm = {
  id: "",
  name: "",
  amountPhp: "",
  taxRate: "",
  paymentMethod: "",
  source: "",
  displaySuffix: "",
  billingType: "one_time",
  successUrl: "",
  cancelUrl: "",
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
  const { ready, ensureApiKey, promptForNewKey } = useApiKey();
  const { message, toast } = useToast();

  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [backendUrl, setBackendUrl] = useState("https://api.nexistrydigitalsolutions.com");
  const [snippet, setSnippet] = useState("");

  const loadProducts = useCallback(
    async (key: string) => {
      const data = await apiFetch<{ products: Product[] }>("/api/admin/products", key);
      setProducts(data.products || []);
    },
    []
  );

  const refreshSnippet = useCallback(
    async (id: string, key: string, url: string) => {
      if (!id) {
        setSnippet("");
        return;
      }
      const data = await apiFetch<{ snippet: string }>(
        `/api/admin/products/${encodeURIComponent(id)}/snippet?backendUrl=${encodeURIComponent(url)}`,
        key
      );
      setSnippet(data.snippet || "");
    },
    []
  );

  useEffect(() => {
    if (!ready) return;
    const key = ensureApiKey();
    if (!key) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern
    loadProducts(key).catch((e) => toast(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ensureApiKey/loadProducts intentionally not deps to avoid refetch loops
  }, [ready]);

  function fillForm(p: Product | null) {
    setSelectedId(p?.id || null);
    setForm({
      id: p?.id || "",
      name: p?.name || "",
      amountPhp: p ? String(p.amountPhp) : "",
      taxRate: p?.defaults?.taxRate != null ? String(p.defaults.taxRate) : "",
      paymentMethod: p?.defaults?.paymentMethod || "",
      source: p?.defaults?.source || "",
      displaySuffix: p?.defaults?.displaySuffix || "",
      billingType: p?.billing?.type || "one_time",
      successUrl: p?.defaults?.successUrl || "",
      cancelUrl: p?.defaults?.cancelUrl || "",
    });
  }

  async function selectProduct(p: Product) {
    fillForm(p);
    try {
      const key = ensureApiKey();
      if (!key) return;
      await refreshSnippet(p.id, key, backendUrl);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function handleRefresh() {
    const key = ensureApiKey();
    if (!key) return;
    try {
      await loadProducts(key);
      toast("Refreshed.");
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const key = ensureApiKey();
    if (!key) return;

    const payload = {
      id: form.id || slugify(form.name),
      name: form.name,
      amountPhp: Number(form.amountPhp),
      currency: "PHP",
      billing: { type: form.billingType },
      defaults: {
        ...(form.paymentMethod ? { paymentMethod: form.paymentMethod } : {}),
        ...(form.source ? { source: form.source } : {}),
        ...(form.taxRate ? { taxRate: Number(form.taxRate) } : {}),
        ...(form.displaySuffix ? { displaySuffix: form.displaySuffix } : {}),
        ...(form.successUrl ? { successUrl: form.successUrl } : {}),
        ...(form.cancelUrl ? { cancelUrl: form.cancelUrl } : {}),
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
      await selectProduct(data.product);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function handleDelete() {
    if (!selectedId) return;
    if (!confirm(`Delete product "${selectedId}"?`)) return;
    const key = ensureApiKey();
    if (!key) return;
    try {
      await apiFetch(`/api/admin/products/${encodeURIComponent(selectedId)}`, key, { method: "DELETE" });
      toast("Deleted.");
      fillForm(null);
      setSnippet("");
      await loadProducts(key);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function handleCopySnippet() {
    if (!snippet) return toast("No snippet to copy.");
    try {
      await navigator.clipboard.writeText(snippet);
      toast("Copied snippet.");
    } catch {
      toast("Could not copy - select and copy manually.");
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
        subtitle="Product Catalog + HTML Snippet Generator"
        onSetKey={promptForNewKey}
        onRefresh={handleRefresh}
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
              <button
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
                <div className="mt-1 text-xs text-slate-400">Create one to generate an HTML snippet.</div>
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
                <div className="rounded-full border border-white/10 px-2.5 py-1 text-xs">Snippet</div>
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
                <button
                  onClick={handleDelete}
                  className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm font-extrabold text-red-200"
                >
                  Delete
                </button>
              )}
              <button
                onClick={() => fillForm(products.find((p) => p.id === selectedId) || null)}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold"
              >
                Reset
              </button>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
            <Field label="ID (slug)" hint="Leave blank to auto-generate from name.">
              <input className="input" placeholder="e.g. ghl_practice_access" value={form.id}
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
            <Field label="Default tax rate" hint="Used for snippet generation only.">
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
                onChange={(e) => setForm({ ...form, billingType: e.target.value })}>
                <option value="one_time">One-time</option>
                <option value="recurring">Recurring (GHL invoice schedule)</option>
              </select>
            </Field>
            <Field label="Success URL">
              <input className="input" value={form.successUrl}
                onChange={(e) => setForm({ ...form, successUrl: e.target.value })} />
            </Field>
            <Field label="Cancel URL">
              <input className="input" value={form.cancelUrl}
                onChange={(e) => setForm({ ...form, cancelUrl: e.target.value })} />
            </Field>

            <div className="col-span-full flex justify-end">
              <button type="submit" className="rounded-lg bg-gradient-to-b from-blue-400 to-blue-500 px-4 py-2.5 text-sm font-extrabold text-slate-950">
                Save Product
              </button>
            </div>
          </form>

          <div className="h-px bg-white/10" />

          <div className="flex items-center justify-between gap-3 p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">Generated HTML Snippet</h2>
            <button onClick={handleCopySnippet} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold">
              Copy
            </button>
          </div>
          <div className="px-4 pb-4">
            <label className="mb-3 block">
              <span className="mb-1.5 block text-xs font-semibold text-slate-300">Backend URL</span>
              <input
                className="input"
                value={backendUrl}
                onChange={(e) => setBackendUrl(e.target.value)}
                onBlur={() => {
                  if (!selectedId) return;
                  const key = ensureApiKey();
                  if (!key) return;
                  refreshSnippet(selectedId, key, backendUrl).catch((e) => toast((e as Error).message));
                }}
              />
            </label>
            <textarea
              readOnly
              value={snippet}
              placeholder="Save a product to generate a snippet…"
              className="h-64 w-full resize-y rounded-lg border border-white/10 bg-[#0c162ce6] p-3 font-mono text-xs leading-relaxed"
            />
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
