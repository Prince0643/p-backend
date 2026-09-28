"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminTopbar } from "@/components/AdminTopbar";
import { Toast } from "@/components/Toast";
import { apiFetch } from "@/lib/api";
import { useAdminAuth } from "@/lib/useAdminAuth";
import { useToast } from "@/lib/useToast";

type Channel = "local" | "global";

type SiteProduct = { kind: "local" | "ghl"; ref: string; name: string | null };

type Site = {
  id: string;
  name: string;
  url: string;
  channel: Channel;
  active: boolean;
  products: SiteProduct[];
  campaignCount: number;
};

type LocalProduct = { id: string; name: string; amountPhp: number; currency: string };

type GhlProduct = { ref: string; name: string; price: number | null; currency: string | null };

const emptyForm = {
  name: "",
  url: "",
  channel: "local" as Channel,
  active: "true",
};

export default function CampaignSitesPage() {
  const { ready, admin, requireAuth, handleAuthError, logout } = useAdminAuth();
  const { message, toast } = useToast();

  const [sites, setSites] = useState<Site[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [selectedProducts, setSelectedProducts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  const [localProducts, setLocalProducts] = useState<LocalProduct[]>([]);
  const [ghlProducts, setGhlProducts] = useState<GhlProduct[]>([]);
  const [loadingGhlProducts, setLoadingGhlProducts] = useState(false);
  const [ghlProductsError, setGhlProductsError] = useState<string | null>(null);

  const loadSites = useCallback(async (key: string) => {
    const data = await apiFetch<{ sites: Site[] }>("/api/admin/campaign-sites", key);
    setSites(data.sites || []);
  }, []);

  const loadLocalProducts = useCallback(async (key: string) => {
    const data = await apiFetch<{ products: LocalProduct[] }>("/api/admin/products", key);
    setLocalProducts(data.products || []);
  }, []);

  const loadGhlProducts = useCallback(async (key: string) => {
    setLoadingGhlProducts(true);
    setGhlProductsError(null);
    try {
      const data = await apiFetch<{ products: GhlProduct[] }>("/api/admin/campaign-sites/ghl-products", key);
      setGhlProducts(data.products || []);
    } catch (e) {
      setGhlProductsError((e as Error).message || "Could not load GHL products.");
    } finally {
      setLoadingGhlProducts(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    const key = requireAuth();
    if (!key) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern
    setLoading(true);
    Promise.all([loadSites(key), loadLocalProducts(key)])
      .catch((e) => { if (!handleAuthError(e)) toast(e.message); })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requireAuth/load fns intentionally not deps to avoid refetch loops
  }, [ready]);

  function fillForm(s: Site | null) {
    setSelectedId(s?.id || null);
    setForm({
      name: s?.name || "",
      url: s?.url || "",
      channel: s?.channel || "local",
      active: s ? String(!!s.active) : "true",
    });
    const productMap: Record<string, string> = {};
    (s?.products || []).forEach((p) => {
      productMap[p.ref] = p.name || p.ref;
    });
    setSelectedProducts(productMap);
    if ((s?.channel || "local") === "global") {
      const key = requireAuth();
      if (key && ghlProducts.length === 0 && !loadingGhlProducts) {
        loadGhlProducts(key).catch(() => {});
      }
    }
  }

  async function handleRefresh() {
    const key = requireAuth();
    if (!key) return;
    try {
      await loadSites(key);
      await loadLocalProducts(key);
      if (form.channel === "global") await loadGhlProducts(key);
      toast("Refreshed.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  function handleChannelChange(channel: Channel) {
    setForm((f) => ({ ...f, channel }));
    setSelectedProducts({});
    if (channel === "global" && ghlProducts.length === 0 && !loadingGhlProducts) {
      const key = requireAuth();
      if (key) loadGhlProducts(key).catch(() => {});
    }
  }

  function toggleProduct(ref: string, name: string) {
    setSelectedProducts((prev) => {
      const next = { ...prev };
      if (next[ref] !== undefined) delete next[ref];
      else next[ref] = name;
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const key = requireAuth();
    if (!key) return;

    const products: SiteProduct[] = Object.entries(selectedProducts).map(([ref, name]) => ({
      kind: form.channel === "local" ? "local" : "ghl",
      ref,
      name: name || null,
    }));

    const payload = {
      name: form.name.trim(),
      url: form.url.trim(),
      channel: form.channel,
      active: form.active === "true",
      products,
    };

    setSaving(true);
    try {
      const method = selectedId ? "PUT" : "POST";
      const path = selectedId
        ? `/api/admin/campaign-sites/${encodeURIComponent(selectedId)}`
        : "/api/admin/campaign-sites";
      const data = await apiFetch<{ site: Site }>(path, key, { method, body: payload });
      toast("Saved.");
      await loadSites(key);
      fillForm(data.site);
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!selectedId) return;
    if (!confirm("Delete this campaign site? This cannot be undone.")) return;
    const key = requireAuth();
    if (!key) return;
    try {
      await apiFetch(`/api/admin/campaign-sites/${encodeURIComponent(selectedId)}`, key, { method: "DELETE" });
      toast("Deleted.");
      fillForm(null);
      await loadSites(key);
    } catch (e) {
      // On a 409 (site still used by campaigns), apiFetch surfaces the server's
      // {error} message here - point the admin at the safer alternative.
      if (!handleAuthError(e)) {
        toast(`${(e as Error).message} Try setting the site to Inactive instead.`);
      }
    }
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return sites;
    const q = search.toLowerCase();
    return sites.filter((s) => `${s.name} ${s.url} ${s.channel}`.toLowerCase().includes(q));
  }, [sites, search]);

  const productOptions = form.channel === "local"
    ? localProducts.map((p) => ({ ref: p.id, label: `${p.name} · ₱${Number(p.amountPhp).toLocaleString()}` }))
    : ghlProducts.map((p) => ({
        ref: p.ref,
        label: `${p.name}${p.price != null ? ` · ${p.currency || ""} ${p.price}` : ""}`,
      }));

  return (
    <div className="flex flex-1 flex-col">
      <AdminTopbar
        title="Nexistry Backend"
        subtitle="Campaign Sites"
        adminEmail={admin?.email}
        onRefresh={handleRefresh}
        onLogout={logout}
      />
      <main className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-4 px-5 pb-28 pt-5 lg:grid-cols-[1fr_1.2fr]">
        <section className="flex flex-col rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">Campaign Sites</h2>
            <div className="flex gap-2">
              <label className="sr-only" htmlFor="site-search">Search campaign sites</label>
              <input
                id="site-search"
                className="rounded-lg border border-white/10 bg-[#0c162ce6] px-3 py-2 text-sm outline-none focus:border-blue-400"
                placeholder="Search sites…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button onClick={() => fillForm(null)} className="rounded-lg bg-blue-400 hover:bg-blue-300 px-3 py-2 text-sm font-extrabold text-slate-950">
                New Site
              </button>
            </div>
          </div>
          <div className="flex max-h-[70vh] flex-col gap-2.5 overflow-y-auto p-2.5">
            {loading && (
              <div className="rounded-xl border border-white/10 bg-[#0c162c8c] p-3 text-xs text-slate-400">Loading sites…</div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="rounded-xl border border-white/10 bg-[#0c162c8c] p-3">
                <div className="font-extrabold">No campaign sites</div>
                <div className="mt-1 text-xs text-slate-400">Create one to point affiliate campaigns at a checkout destination.</div>
              </div>
            )}
            {filtered.map((s) => (
              <div
                key={s.id}
                onClick={() => fillForm(s)}
                className={`flex cursor-pointer items-start justify-between gap-2.5 rounded-xl border p-3 hover:border-blue-400/40 ${
                  selectedId === s.id ? "border-blue-400 bg-blue-400/10" : "border-white/10 bg-[#0c162c8c]"
                }`}
              >
                <div className="min-w-0">
                  <div className="font-extrabold">{s.name}</div>
                  <div className="mt-1 truncate text-xs text-slate-400" title={s.url}>{s.url}</div>
                  <div className="mt-1 text-[11px] text-slate-500">
                    {s.products.length} product{s.products.length === 1 ? "" : "s"} · {s.campaignCount} campaign{s.campaignCount === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <span className={`rounded-full border px-2.5 py-1 text-[11px] ${s.channel === "global" ? "border-cyan-400/40 text-cyan-200" : "border-blue-400/40 text-blue-200"}`}>
                    {s.channel === "global" ? "Global" : "Local"}
                  </span>
                  <span className={`rounded-full border px-2.5 py-1 text-[11px] ${s.active ? "border-emerald-400/40 text-emerald-200" : "border-red-400/40 text-red-200"}`}>
                    {s.active ? "Active" : "Inactive"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">
              {selectedId ? `Edit Site: ${form.name}` : "New Site"}
            </h2>
            {selectedId && (
              <button onClick={handleDelete} className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm font-extrabold text-red-200">
                Delete
              </button>
            )}
          </div>

          <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
            <Field label="Name">
              <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Channel">
              <select
                className="input"
                value={form.channel}
                onChange={(e) => handleChannelChange(e.target.value as Channel)}
              >
                <option value="local">Local (PayMongo, PHP)</option>
                <option value="global">Global (GHL checkout, USD)</option>
              </select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="URL" hint="Campaign destination URLs must be on this site's host.">
                <input
                  className="input"
                  type="url"
                  required
                  placeholder="https://nexistryacademy.com"
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Status">
              <select className="input" value={form.active} onChange={(e) => setForm({ ...form, active: e.target.value })}>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            </Field>

            <div className="sm:col-span-2">
              <span className="mb-1.5 block text-xs font-semibold text-slate-300">
                Products {form.channel === "global" ? "(GHL)" : "(local)"}
              </span>
              {form.channel === "global" && loadingGhlProducts && (
                <div className="rounded-lg border border-white/10 bg-[#0c162c8c] p-3 text-xs text-slate-400">Loading GHL products…</div>
              )}
              {form.channel === "global" && ghlProductsError && !loadingGhlProducts && (
                <div className="rounded-lg border border-amber-300/25 bg-amber-300/10 p-3 text-xs text-amber-100">
                  {ghlProductsError}{" "}
                  <button
                    type="button"
                    className="ml-1 font-bold underline"
                    onClick={() => {
                      const key = requireAuth();
                      if (key) loadGhlProducts(key).catch(() => {});
                    }}
                  >
                    Retry
                  </button>
                </div>
              )}
              {(form.channel === "local" || (!loadingGhlProducts && !ghlProductsError)) && (
                <fieldset className="max-h-56 overflow-y-auto rounded-lg border border-white/10 bg-[#0c162ce6] p-2.5">
                  <legend className="sr-only">Select products for this site</legend>
                  {productOptions.length === 0 && (
                    <div className="p-2 text-xs text-slate-400">
                      {form.channel === "local" ? "No local products found." : "No GHL products available."}
                    </div>
                  )}
                  {productOptions.map((opt) => (
                    <label key={opt.ref} className="flex min-h-[36px] cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-white/5">
                      <input
                        type="checkbox"
                        checked={selectedProducts[opt.ref] !== undefined}
                        onChange={() => toggleProduct(opt.ref, opt.label)}
                      />
                      <span>{opt.label}</span>
                    </label>
                  ))}
                </fieldset>
              )}
            </div>

            <div className="col-span-full flex justify-end">
              <button type="submit" disabled={saving} className="rounded-lg bg-blue-400 hover:bg-blue-300 px-4 py-2.5 text-sm font-extrabold text-slate-950 disabled:opacity-60">
                {saving ? "Saving…" : "Save Site"}
              </button>
            </div>
          </form>
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
