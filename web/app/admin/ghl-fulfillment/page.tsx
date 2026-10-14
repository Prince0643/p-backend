"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminTopbar } from "@/components/AdminTopbar";
import { Toast } from "@/components/Toast";
import { apiFetch } from "@/lib/api";
import { useAdminAuth } from "@/lib/useAdminAuth";
import { useToast } from "@/lib/useToast";

type Product = { id: string; name: string };
type SubAccount = {
  id: string;
  name: string;
  locationId: string;
  businessName: string;
  active: boolean;
  hasPrivateKey: boolean;
};
type Rule = {
  productId: string;
  productName?: string;
  subAccountId: string;
  enabled: boolean;
  firstPaymentTags: string[];
  renewalTags: string[];
  everyPaymentTags: string[];
  removeTags: string[];
  customFields: unknown[];
  subAccount?: { name: string; locationId: string; active: boolean };
};

const emptyAccount = { id: "", name: "", locationId: "", privateKey: "", businessName: "", active: true };
const emptyRule = {
  productId: "",
  subAccountId: "",
  enabled: true,
  tags: "",
};

function splitList(value: string) {
  return value.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
}

function joinList(value: string[]) {
  return (value || []).join("\n");
}

function addTagsForRule(rule: Rule) {
  return Array.from(new Set([...(rule.everyPaymentTags || []), ...(rule.firstPaymentTags || []), ...(rule.renewalTags || [])]));
}

function slugify(input: string) {
  return input.trim().toLowerCase().replace(/['"]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

export default function GhlFulfillmentPage() {
  const { ready, admin, requireAuth, handleAuthError, logout } = useAdminAuth();
  const { message, toast } = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [subAccounts, setSubAccounts] = useState<SubAccount[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [accountForm, setAccountForm] = useState(emptyAccount);
  const [ruleForm, setRuleForm] = useState(emptyRule);
  const [routeProductId, setRouteProductId] = useState("");

  const load = useCallback(async (key: string) => {
    const [cfg, prods] = await Promise.all([
      apiFetch<{ subAccounts: SubAccount[]; rules: Rule[] }>("/api/admin/ghl-fulfillment", key),
      apiFetch<{ products: Product[] }>("/api/admin/products", key),
    ]);
    setSubAccounts(cfg.subAccounts || []);
    setRules(cfg.rules || []);
    setProducts(prods.products || []);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const key = requireAuth();
    if (!key) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern
    load(key).catch((e) => { if (!handleAuthError(e)) toast(e.message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const rulesByRoute = useMemo(() => {
    const map = new Map<string, Rule>();
    for (const rule of rules) map.set(`${rule.productId}:${rule.subAccountId}`, rule);
    return map;
  }, [rules]);

  function getRouteRule(productId: string, subAccountId: string) {
    return rulesByRoute.get(`${productId}:${subAccountId}`) || null;
  }

  async function handleRefresh() {
    const key = requireAuth();
    if (!key) return;
    try {
      await load(key);
      toast("Refreshed.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function saveAccount(e: React.FormEvent) {
    e.preventDefault();
    const key = requireAuth();
    if (!key) return;
    try {
      await apiFetch("/api/admin/ghl-fulfillment/sub-accounts", key, {
        method: "POST",
        body: { ...accountForm, id: accountForm.id || slugify(accountForm.name) },
      });
      setAccountForm(emptyAccount);
      await load(key);
      toast("Sub-account saved.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function importEnvSubAccounts() {
    const key = requireAuth();
    if (!key) return;
    try {
      const data = await apiFetch<{ count: number }>("/api/admin/ghl-fulfillment/import-env", key, { method: "POST" });
      await load(key);
      toast(data.count ? `Imported ${data.count} sub-account${data.count === 1 ? "" : "s"}.` : "No env sub-accounts found.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function deleteAccount(id: string) {
    if (!confirm(`Delete GHL sub-account "${id}" and its product rules?`)) return;
    const key = requireAuth();
    if (!key) return;
    try {
      await apiFetch(`/api/admin/ghl-fulfillment/sub-accounts/${encodeURIComponent(id)}`, key, { method: "DELETE" });
      await load(key);
      toast("Sub-account deleted.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  function editRule(rule: Rule) {
    setRuleForm({
      productId: rule.productId,
      subAccountId: rule.subAccountId,
      enabled: rule.enabled,
      tags: joinList(addTagsForRule(rule)),
    });
  }

  async function saveRule(e: React.FormEvent) {
    e.preventDefault();
    const key = requireAuth();
    if (!key) return;
    try {
      await apiFetch("/api/admin/ghl-fulfillment/rules", key, {
        method: "POST",
        body: {
          productId: ruleForm.productId,
          subAccountId: ruleForm.subAccountId,
          enabled: ruleForm.enabled,
          firstPaymentTags: [],
          renewalTags: [],
          everyPaymentTags: splitList(ruleForm.tags),
          removeTags: [],
          customFields: [],
        },
      });
      setRuleForm(emptyRule);
      await load(key);
      toast("Rule saved.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function deleteRule(rule: Rule) {
    const key = requireAuth();
    if (!key) return;
    try {
      await apiFetch(`/api/admin/ghl-fulfillment/rules/${encodeURIComponent(rule.productId)}/${encodeURIComponent(rule.subAccountId)}`, key, { method: "DELETE" });
      await load(key);
      toast("Rule deleted.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function toggleRoute(subAccount: SubAccount, shouldEnable: boolean) {
    const key = requireAuth();
    if (!key) return;
    if (!routeProductId) {
      toast("Select a product first.");
      return;
    }

    const existing = getRouteRule(routeProductId, subAccount.id);
    try {
      if (shouldEnable) {
        await apiFetch("/api/admin/ghl-fulfillment/rules", key, {
          method: "POST",
          body: {
            productId: routeProductId,
            subAccountId: subAccount.id,
            enabled: true,
            firstPaymentTags: existing?.firstPaymentTags || [],
            renewalTags: existing?.renewalTags || [],
            everyPaymentTags: existing?.everyPaymentTags || [],
            removeTags: existing?.removeTags || [],
            customFields: [],
          },
        });
        await load(key);
        toast("Route enabled.");
        return;
      }

      if (!existing) return;
      const hasAdvancedConfig =
        existing.firstPaymentTags.length > 0 ||
        existing.renewalTags.length > 0 ||
        existing.everyPaymentTags.length > 0 ||
        existing.removeTags.length > 0 ||
        existing.customFields.length > 0;
      if (hasAdvancedConfig && !confirm("This route has tags or custom fields configured. Removing it will delete that config. Continue?")) {
        return;
      }
      await apiFetch(`/api/admin/ghl-fulfillment/rules/${encodeURIComponent(existing.productId)}/${encodeURIComponent(existing.subAccountId)}`, key, { method: "DELETE" });
      await load(key);
      toast("Route removed.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <AdminTopbar title="Nexistry Backend" subtitle="GHL Product Access" adminEmail={admin?.email} onRefresh={handleRefresh} onLogout={logout} />
      <main className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-4 px-5 py-5 xl:grid-cols-[0.9fr_1.1fr]">
        <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">GHL sub-accounts</h2>
            <button onClick={importEnvSubAccounts} className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-bold text-slate-100 hover:bg-white/10">
              Import env
            </button>
          </div>
          <form onSubmit={saveAccount} className="grid gap-3 p-4">
            <p className="text-xs text-slate-400">
              Use the GHL sub-account/location ID and its Private Integration Token. The buyer will be created or updated in every sub-account checked for a product.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-slate-300">Name</span>
                <input className="input" value={accountForm.name} onChange={(e) => setAccountForm({ ...accountForm, name: e.target.value })} placeholder="Nexistry Academy" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-slate-300">Key</span>
                <input className="input" value={accountForm.id} onChange={(e) => setAccountForm({ ...accountForm, id: e.target.value })} placeholder="auto from name" />
              </label>
            </div>
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-slate-300">Location ID</span>
              <input className="input font-mono" value={accountForm.locationId} onChange={(e) => setAccountForm({ ...accountForm, locationId: e.target.value })} placeholder="e.g. nb61f4OQ7o9Wsxx0zOsY" />
              <span className="mt-1 block text-xs text-slate-500">This is not the GHL login email.</span>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-slate-300">Private Integration Token</span>
              <input className="input font-mono" type="password" value={accountForm.privateKey} onChange={(e) => setAccountForm({ ...accountForm, privateKey: e.target.value })} />
            </label>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-slate-300">Business name</span>
                <input className="input" value={accountForm.businessName} onChange={(e) => setAccountForm({ ...accountForm, businessName: e.target.value })} />
              </label>
              <label className="mt-6 flex min-h-11 items-center gap-2 text-sm text-slate-200">
                <input type="checkbox" checked={accountForm.active} onChange={(e) => setAccountForm({ ...accountForm, active: e.target.checked })} />
                Active
              </label>
            </div>
            <button type="submit" className="rounded-lg bg-gradient-to-b from-blue-400 to-blue-500 px-4 py-2.5 text-sm font-extrabold text-slate-950">Save sub-account</button>
          </form>
          <div className="border-t border-white/10 p-4">
            <div className="grid gap-2">
              {subAccounts.map((a) => (
                <div key={a.id} className="rounded-lg border border-white/10 bg-white/[.03] p-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-bold text-slate-100">{a.name} {!a.active && <span className="text-xs text-amber-200">(inactive)</span>}</div>
                      <div className="font-mono text-xs text-slate-400">{a.id} · {a.locationId}</div>
                      <div className="text-xs text-slate-500">{a.hasPrivateKey ? "Private key saved" : "No private key"}</div>
                    </div>
                    <button onClick={() => deleteAccount(a.id)} className="rounded-md border border-red-400/30 px-2 py-1 text-xs font-bold text-red-200">Delete</button>
                  </div>
                </div>
              ))}
              {subAccounts.length === 0 && <div className="text-sm text-slate-400">No sub-accounts configured.</div>}
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <div className="border-b border-white/10 bg-white/[.02] p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">Product access rules</h2>
          </div>
          <div className="grid gap-3 border-b border-white/10 p-4">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-200">Route product to sub-accounts</h3>
              <p className="mt-1 text-xs text-slate-400">
                Checked sub-accounts receive a contact create/update for every paid checkout of the selected PayMongo product.
              </p>
            </div>
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-slate-300">Product</span>
              <select className="input" value={routeProductId} onChange={(e) => setRouteProductId(e.target.value)}>
                <option value="">Select product</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <div className="grid gap-2">
              {subAccounts.map((a) => {
                const route = routeProductId ? getRouteRule(routeProductId, a.id) : null;
                const checked = Boolean(route && route.enabled);
                return (
                  <label key={a.id} className="flex min-h-12 items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[.03] px-3 py-2 text-sm">
                    <span>
                      <span className="block font-semibold text-slate-100">{a.name}</span>
                      <span className="block font-mono text-xs text-slate-500">{a.locationId}</span>
                    </span>
                    <span className="flex items-center gap-3">
                      {route && !route.enabled && <span className="text-xs font-semibold text-amber-200">disabled</span>}
                      <input
                        type="checkbox"
                        disabled={!routeProductId || !a.active}
                        checked={checked}
                        onChange={(e) => toggleRoute(a, e.target.checked)}
                      />
                    </span>
                  </label>
                );
              })}
              {subAccounts.length === 0 && <div className="text-sm text-slate-400">Add a GHL sub-account first.</div>}
            </div>
          </div>
          <form onSubmit={saveRule} className="grid gap-3 p-4">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-200">Tags and fields</h3>
              <p className="mt-1 text-xs text-slate-400">Edit a route when this product should add contact tags in the selected sub-account. Payment custom fields are filled automatically.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-slate-300">Product</span>
                <select className="input" value={ruleForm.productId} onChange={(e) => setRuleForm({ ...ruleForm, productId: e.target.value })}>
                  <option value="">Select product</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-slate-300">Sub-account</span>
                <select className="input" value={ruleForm.subAccountId} onChange={(e) => setRuleForm({ ...ruleForm, subAccountId: e.target.value })}>
                  <option value="">Select sub-account</option>
                  {subAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input type="checkbox" checked={ruleForm.enabled} onChange={(e) => setRuleForm({ ...ruleForm, enabled: e.target.checked })} />
              Enabled
            </label>
            <FieldArea label="Tags to add" value={ruleForm.tags} onChange={(v) => setRuleForm({ ...ruleForm, tags: v })} placeholder={"ghl-premium\nghlintensive_course_paid"} />
            <div className="text-xs text-slate-500">Automatic fields: product, product ID, PayMongo reference, payment ID, amount, currency, cycle type, and paid date.</div>
            <button type="submit" className="rounded-lg bg-gradient-to-b from-blue-400 to-blue-500 px-4 py-2.5 text-sm font-extrabold text-slate-950">Save rule</button>
          </form>
          <div className="border-t border-white/10 p-4">
            <div className="grid gap-2">
              {rules.map((r) => (
                <div key={`${r.productId}:${r.subAccountId}`} className="rounded-lg border border-white/10 bg-white/[.03] p-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-bold text-slate-100">{r.productName || productById.get(r.productId)?.name || r.productId}</div>
                      <div className="text-xs text-slate-400">{r.subAccount?.name || r.subAccountId} · {r.enabled ? "enabled" : "disabled"}</div>
                      <div className="mt-2 grid gap-1 text-xs text-slate-500">
                        <div>Tags: {addTagsForRule(r).join(", ") || "-"}</div>
                        {r.removeTags.length > 0 && <div>Remove: {r.removeTags.join(", ")}</div>}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => editRule(r)} className="rounded-md border border-white/10 px-2 py-1 text-xs font-bold text-slate-100">Edit</button>
                      <button onClick={() => deleteRule(r)} className="rounded-md border border-red-400/30 px-2 py-1 text-xs font-bold text-red-200">Delete</button>
                    </div>
                  </div>
                </div>
              ))}
              {rules.length === 0 && <div className="text-sm text-slate-400">No product rules configured.</div>}
            </div>
          </div>
        </section>
      </main>
      <Toast message={message} />
    </div>
  );
}

function FieldArea({ label, value, onChange, placeholder, rows = 3 }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; rows?: number }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-slate-300">{label}</span>
      <textarea className="input min-h-24 font-mono text-xs" rows={rows} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </label>
  );
}
