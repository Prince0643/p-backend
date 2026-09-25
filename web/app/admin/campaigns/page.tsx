"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminTopbar } from "@/components/AdminTopbar";
import { Toast } from "@/components/Toast";
import { apiFetch } from "@/lib/api";
import { useAdminAuth } from "@/lib/useAdminAuth";
import { useToast } from "@/lib/useToast";

type Campaign = {
  id: string;
  name: string;
  slug: string;
  couponCode: string;
  destinationUrl: string;
  notes: string;
  active: boolean;
  link: string;
  createdAt: string;
  updatedAt: string;
  affiliate: { id: string; firstName: string; lastName: string; email: string } | null;
  stats: {
    paidCount: number;
    pendingCount: number;
    revenue: number;
    discountTotal: number;
    commissionTotal: number;
  };
};

const TRACKING_SNIPPET = '<script src="https://api.nexistrydigitalsolutions.com/public/nx-ref.js" async></script>';

function money(value: number, currency = "PHP") {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

type Coupon = { code: string; active: boolean; affiliateEmail: string };

const emptyForm = {
  name: "",
  slug: "",
  couponCode: "",
  destinationUrl: "",
  notes: "",
  active: "true",
};

export default function CampaignsPage() {
  const { ready, admin, requireAuth, handleAuthError, logout } = useAdminAuth();
  const { message, toast } = useToast();

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadCampaigns = useCallback(async (key: string) => {
    const data = await apiFetch<{ campaigns: Campaign[] }>("/api/admin/campaigns", key);
    setCampaigns(data.campaigns || []);
  }, []);

  const loadCoupons = useCallback(async (key: string) => {
    const data = await apiFetch<{ coupons: Coupon[] }>("/api/admin/coupons", key);
    setCoupons(data.coupons || []);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const key = requireAuth();
    if (!key) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern
    loadCampaigns(key).catch((e) => { if (!handleAuthError(e)) toast(e.message); });
    loadCoupons(key).catch((e) => { if (!handleAuthError(e)) toast(e.message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requireAuth/load fns intentionally not deps to avoid refetch loops
  }, [ready]);

  function fillForm(c: Campaign | null) {
    setSelectedId(c?.id || null);
    setUrlError(null);
    setForm({
      name: c?.name || "",
      slug: c?.slug || "",
      couponCode: c?.couponCode || "",
      destinationUrl: c?.destinationUrl || "",
      notes: c?.notes || "",
      active: c ? String(!!c.active) : "true",
    });
  }

  async function handleRefresh() {
    const key = requireAuth();
    if (!key) return;
    try {
      await loadCampaigns(key);
      await loadCoupons(key);
      toast("Refreshed.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  function validateUrlClientSide(value: string): string | null {
    if (!value.trim()) return "Destination URL is required.";
    try {
      const u = new URL(value);
      if (u.protocol !== "https:" && u.protocol !== "http:") return "URL must use http or https.";
    } catch {
      return "Enter a valid absolute URL (e.g. https://nexistryacademy.com/offer).";
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const key = requireAuth();
    if (!key) return;

    const urlProblem = validateUrlClientSide(form.destinationUrl);
    setUrlError(urlProblem);
    if (urlProblem) return;

    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      couponCode: form.couponCode.trim().toUpperCase(),
      destinationUrl: form.destinationUrl.trim(),
      notes: form.notes,
      active: form.active === "true",
    };
    if (form.slug.trim()) payload.slug = form.slug.trim().toLowerCase();

    setSaving(true);
    try {
      const method = selectedId ? "PUT" : "POST";
      const path = selectedId ? `/api/admin/campaigns/${encodeURIComponent(selectedId)}` : "/api/admin/campaigns";
      const data = await apiFetch<{ campaign: Campaign }>(path, key, { method, body: payload });
      toast("Saved.");
      await loadCampaigns(key);
      fillForm(data.campaign);
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!selectedId) return;
    if (!confirm("Delete this campaign? This cannot be undone.")) return;
    const key = requireAuth();
    if (!key) return;
    try {
      await apiFetch(`/api/admin/campaigns/${encodeURIComponent(selectedId)}`, key, { method: "DELETE" });
      toast("Deleted.");
      fillForm(null);
      await loadCampaigns(key);
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function handleToggleActive(c: Campaign) {
    const key = requireAuth();
    if (!key) return;
    try {
      const data = await apiFetch<{ campaign: Campaign }>(`/api/admin/campaigns/${encodeURIComponent(c.id)}`, key, {
        method: "PUT",
        body: { active: !c.active },
      });
      toast(data.campaign.active ? "Campaign activated." : "Campaign deactivated.");
      await loadCampaigns(key);
      if (selectedId === c.id) fillForm(data.campaign);
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function copyLink(c: Campaign) {
    try {
      await navigator.clipboard.writeText(c.link);
      setCopiedId(c.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast("Could not copy - select and copy the link manually.");
    }
  }

  async function copyTrackingSnippet() {
    try {
      await navigator.clipboard.writeText(TRACKING_SNIPPET);
      setCopiedSnippet(true);
      setTimeout(() => setCopiedSnippet(false), 2000);
    } catch {
      toast("Could not copy - select and copy the snippet manually.");
    }
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return campaigns;
    const q = search.toLowerCase();
    return campaigns.filter((c) =>
      `${c.name} ${c.slug} ${c.couponCode} ${c.destinationUrl} ${c.affiliate?.email || ""}`.toLowerCase().includes(q)
    );
  }, [campaigns, search]);

  return (
    <div className="flex flex-1 flex-col">
      <AdminTopbar
        title="Nexistry Backend"
        subtitle="Affiliate Campaign Links"
        adminEmail={admin?.email}
        onRefresh={handleRefresh}
        onLogout={logout}
      />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-5 pb-16 pt-5">
        <details className="group rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <summary className="cursor-pointer list-none p-3.5 text-xs font-bold uppercase tracking-wide text-slate-200">
            Install tracking on checkout pages
          </summary>
          <div className="border-t border-white/10 p-3.5">
            <p className="text-xs text-slate-400">
              Paste this into each GHL funnel&apos;s Settings → Head tracking code.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <pre className="flex-1 overflow-x-auto rounded-lg border border-white/10 bg-[#0c162ce6] p-2.5 text-[11px]">
                <code>{TRACKING_SNIPPET}</code>
              </pre>
              <button
                onClick={copyTrackingSnippet}
                className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-bold hover:bg-white/10"
              >
                {copiedSnippet ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        </details>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr]">
        <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">Campaigns</h2>
            <div className="flex gap-2">
              <input
                className="rounded-lg border border-white/10 bg-[#0c162ce6] px-3 py-2 text-sm outline-none focus:border-blue-400"
                placeholder="Search campaigns…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button onClick={() => fillForm(null)} className="rounded-lg bg-blue-400 hover:bg-blue-300 px-3 py-2 text-sm font-extrabold text-slate-950">
                New Campaign
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
                  <th className="p-2.5">Name</th>
                  <th className="p-2.5">Affiliate</th>
                  <th className="p-2.5">Coupon</th>
                  <th className="p-2.5">Sales</th>
                  <th className="p-2.5">Revenue</th>
                  <th className="p-2.5">Commission</th>
                  <th className="p-2.5">Destination</th>
                  <th className="p-2.5">Link</th>
                  <th className="p-2.5">Active</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={9} className="p-3 text-slate-400">
                      No campaigns yet. Create one to generate a shareable affiliate link.
                    </td>
                  </tr>
                )}
                {filtered.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => fillForm(c)}
                    className={`cursor-pointer border-t border-white/10 hover:bg-white/[.03] ${
                      selectedId === c.id ? "bg-blue-400/10" : ""
                    }`}
                  >
                    <td className="p-2.5 font-bold">
                      {c.name}
                      <div className="font-mono text-[10px] text-slate-400">/{c.slug}</div>
                    </td>
                    <td className="p-2.5">
                      {c.affiliate ? (
                        <>
                          {c.affiliate.firstName} {c.affiliate.lastName}
                          <div className="text-slate-400">{c.affiliate.email}</div>
                        </>
                      ) : (
                        <span className="text-slate-400">Unlinked</span>
                      )}
                    </td>
                    <td className="p-2.5 font-mono">{c.couponCode}</td>
                    <td className="p-2.5">
                      {c.stats.paidCount}
                      {c.stats.pendingCount > 0 && (
                        <span className="ml-1 text-[10px] text-slate-400">+{c.stats.pendingCount} pending</span>
                      )}
                    </td>
                    <td className="p-2.5">{money(c.stats.revenue)}</td>
                    <td className="p-2.5">{money(c.stats.commissionTotal)}</td>
                    <td className="max-w-[160px] truncate p-2.5" title={c.destinationUrl}>
                      {c.destinationUrl}
                    </td>
                    <td className="p-2.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          copyLink(c);
                        }}
                        className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-bold hover:bg-white/10"
                      >
                        {copiedId === c.id ? "Copied!" : "Copy Link"}
                      </button>
                    </td>
                    <td className="p-2.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleActive(c);
                        }}
                        className={`rounded-full border px-2.5 py-1 text-[11px] ${
                          c.active ? "border-emerald-400/40 text-emerald-200" : "border-red-400/40 text-red-200"
                        }`}
                      >
                        {c.active ? "Active" : "Inactive"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">
              {selectedId ? "Edit Campaign" : "New Campaign"}
            </h2>
            {selectedId && (
              <button onClick={handleDelete} className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm font-extrabold text-red-200">
                Delete
              </button>
            )}
          </div>

          <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3 p-4">
            <Field label="Name">
              <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Slug" hint="Lowercase letters, numbers, hyphens. Leave blank to auto-generate from name.">
              <input
                className="input"
                pattern="[a-z0-9-]{2,60}"
                placeholder="auto-generated if blank"
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })}
              />
            </Field>
            <Field label="Affiliate / Coupon">
              <select className="input" required value={form.couponCode} onChange={(e) => setForm({ ...form, couponCode: e.target.value })}>
                <option value="">Select a coupon…</option>
                {coupons.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}
                    {c.affiliateEmail ? ` · ${c.affiliateEmail}` : ""}
                    {!c.active ? " (inactive)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Destination URL" hint="Must be on the allowed domain list. ref/campaign params are added automatically.">
              <input
                className="input"
                type="url"
                required
                placeholder="https://nexistryacademy.com/offer"
                value={form.destinationUrl}
                onChange={(e) => {
                  setForm({ ...form, destinationUrl: e.target.value });
                  setUrlError(null);
                }}
                onBlur={(e) => setUrlError(validateUrlClientSide(e.target.value))}
              />
              {urlError && <p className="mt-1 text-xs text-red-300">{urlError}</p>}
            </Field>
            <Field label="Notes">
              <input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </Field>
            <Field label="Status">
              <select className="input" value={form.active} onChange={(e) => setForm({ ...form, active: e.target.value })}>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            </Field>

            {form.destinationUrl && form.couponCode && !urlError && (
              <div className="rounded-xl border border-white/10 bg-[#0c162c66] p-3">
                <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">Link preview</div>
                <div className="break-all font-mono text-xs text-cyan-200">
                  {(() => {
                    try {
                      const u = new URL(form.destinationUrl);
                      u.searchParams.set("ref", form.couponCode.toUpperCase());
                      u.searchParams.set("campaign", form.slug ? form.slug.toLowerCase() : "(auto-slug)");
                      return u.toString();
                    } catch {
                      return "";
                    }
                  })()}
                </div>
              </div>
            )}

            <div className="flex justify-end">
              <button type="submit" disabled={saving} className="rounded-lg bg-blue-400 hover:bg-blue-300 px-4 py-2.5 text-sm font-extrabold text-slate-950 disabled:opacity-60">
                {saving ? "Saving…" : "Save Campaign"}
              </button>
            </div>
          </form>
        </section>
        </div>
      </main>
      <Toast message={message} />
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}
