"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { AdminTopbar } from "@/components/AdminTopbar";
import { Toast } from "@/components/Toast";
import { apiFetch } from "@/lib/api";
import { useAdminAuth } from "@/lib/useAdminAuth";
import { useToast } from "@/lib/useToast";

type CampaignStats = {
  paidCount: number;
  pendingCount: number;
  revenue: number;
  discountTotal: number;
  commissionTotal: number;
};

type AffiliateStat = {
  affiliateId: string;
  affiliateName: string;
  affiliateEmail: string;
  couponCode: string;
  stats: CampaignStats;
  statsByCurrency: Record<string, CampaignStats>;
};

type Campaign = {
  id: string;
  name: string;
  slug: string;
  siteId: string | null;
  siteName: string | null;
  siteChannel: "local" | "global" | null;
  destinationUrl: string;
  notes: string;
  active: boolean;
  linkTemplate: string;
  createdAt?: string;
  updatedAt?: string;
  // stats/statsByCurrency mirror the campaign-sites and coupons pages' pattern:
  // currency is the single currency involved, or null when the campaign spans more
  // than one - in that case statsByCurrency is the source of truth for display.
  stats: CampaignStats;
  currency: string | null;
  statsByCurrency: Record<string, CampaignStats>;
  affiliateStats: AffiliateStat[];
};

type Site = { id: string; name: string; url: string; channel: "local" | "global"; active: boolean };

const TRACKING_SNIPPET = '<script src="https://api.nexistrydigitalsolutions.com/public/nx-ref.js" async></script>';

function money(value: number, currency = "PHP") {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

/** Renders a per-currency figure: a single formatted amount when the campaign has one
 * currency, or one line per currency when it's mixed (currency === null). */
function moneyByCurrency(
  entity: { currency?: string | null; stats: CampaignStats; statsByCurrency: Record<string, CampaignStats> },
  field: "revenue" | "commissionTotal"
) {
  if (entity.currency) {
    return money(entity.stats[field], entity.currency);
  }
  const entries = Object.entries(entity.statsByCurrency);
  if (entries.length === 0) return money(0);
  return (
    <div className="space-y-0.5">
      {entries.map(([currency, stats]) => (
        <div key={currency}>{money(stats[field], currency)}</div>
      ))}
    </div>
  );
}

const emptyForm = {
  name: "",
  slug: "",
  siteId: "",
  destinationUrl: "",
  notes: "",
  active: "true",
};

export default function CampaignsPage() {
  const { ready, admin, requireAuth, handleAuthError, logout } = useAdminAuth();
  const { message, toast } = useToast();

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadCampaigns = useCallback(async (key: string) => {
    const data = await apiFetch<{ campaigns: Campaign[] }>("/api/admin/campaigns", key);
    setCampaigns(data.campaigns || []);
  }, []);

  const loadSites = useCallback(async (key: string) => {
    const data = await apiFetch<{ sites: Site[] }>("/api/admin/campaign-sites", key);
    setSites(data.sites || []);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const key = requireAuth();
    if (!key) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern
    setLoading(true);
    Promise.all([loadCampaigns(key), loadSites(key)])
      .catch((e) => { if (!handleAuthError(e)) toast(e.message); })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requireAuth/load fns intentionally not deps to avoid refetch loops
  }, [ready]);

  function fillForm(c: Campaign | null) {
    setSelectedId(c?.id || null);
    setUrlError(null);
    setForm({
      name: c?.name || "",
      slug: c?.slug || "",
      siteId: c?.siteId || "",
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
      await loadSites(key);
      toast("Refreshed.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  function handleSiteChange(siteId: string) {
    const site = sites.find((s) => s.id === siteId);
    setForm((f) => ({
      ...f,
      siteId,
      // Prefill the destination with the site's own URL only when the admin hasn't
      // already typed something else for this site, so switching sites doesn't
      // clobber a manually-entered path.
      destinationUrl: site && (!f.destinationUrl || sites.some((s) => f.destinationUrl === s.url)) ? site.url : f.destinationUrl,
    }));
    setUrlError(null);
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

    if (!selectedId && !form.siteId) {
      toast("Select a campaign site.");
      return;
    }

    const urlProblem = validateUrlClientSide(form.destinationUrl);
    setUrlError(urlProblem);
    if (urlProblem) return;

    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      destinationUrl: form.destinationUrl.trim(),
      notes: form.notes,
      active: form.active === "true",
    };
    if (form.siteId) payload.siteId = form.siteId;
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

  async function copyLink(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
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
      `${c.name} ${c.slug} ${c.destinationUrl} ${c.siteName || ""}`.toLowerCase().includes(q)
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
        <div className="rounded-2xl border border-white/10 bg-white/[.03] p-3.5 text-xs text-slate-300 shadow-2xl">
          A campaign applies to <strong>all affiliates automatically</strong> — every affiliate gets their own
          personal link (<code className="font-mono text-cyan-200">destination?ref=THEIR_CODE&amp;campaign={"{slug}"}</code>).
          There is no per-campaign coupon to pick.
        </div>

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

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">Campaigns</h2>
            <div className="flex gap-2">
              <label className="sr-only" htmlFor="campaign-search">Search campaigns</label>
              <input
                id="campaign-search"
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
                  <th className="p-2.5"></th>
                  <th className="p-2.5">Name</th>
                  <th className="p-2.5">Site</th>
                  <th className="p-2.5">Sales</th>
                  <th className="p-2.5">Revenue</th>
                  <th className="p-2.5">Commission</th>
                  <th className="p-2.5">Destination</th>
                  <th className="p-2.5">Link template</th>
                  <th className="p-2.5">Active</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={9} className="p-3 text-slate-400">Loading campaigns…</td>
                  </tr>
                )}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={9} className="p-3 text-slate-400">
                      No campaigns yet. Create one to generate a shareable affiliate link template.
                    </td>
                  </tr>
                )}
                {filtered.map((c) => {
                  const isExpanded = expandedId === c.id;
                  return (
                    <Fragment key={c.id}>
                      <tr
                        onClick={() => fillForm(c)}
                        className={`cursor-pointer border-t border-white/10 hover:bg-white/[.03] ${
                          selectedId === c.id ? "bg-blue-400/10" : ""
                        }`}
                      >
                        <td className="p-2.5">
                          <button
                            type="button"
                            aria-expanded={isExpanded}
                            aria-controls={`campaign-breakdown-${c.id}`}
                            aria-label={isExpanded ? `Collapse per-affiliate breakdown for ${c.name}` : `Expand per-affiliate breakdown for ${c.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedId(isExpanded ? null : c.id);
                            }}
                            className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-bold hover:bg-white/10"
                          >
                            {isExpanded ? "▾" : "▸"}
                          </button>
                        </td>
                        <td className="p-2.5 font-bold">
                          {c.name}
                          <div className="font-mono text-[10px] text-slate-400">/{c.slug}</div>
                        </td>
                        <td className="p-2.5">
                          {c.siteName ? (
                            <>
                              {c.siteName}
                              <span className={`ml-1.5 rounded-full border px-1.5 py-0.5 text-[10px] ${c.siteChannel === "global" ? "border-cyan-400/40 text-cyan-200" : "border-blue-400/40 text-blue-200"}`}>
                                {c.siteChannel === "global" ? "Global" : "Local"}
                              </span>
                            </>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="p-2.5">
                          {c.stats.paidCount}
                          {c.stats.pendingCount > 0 && (
                            <span className="ml-1 text-[10px] text-slate-400">+{c.stats.pendingCount} pending</span>
                          )}
                        </td>
                        <td className="p-2.5">{moneyByCurrency(c, "revenue")}</td>
                        <td className="p-2.5">{moneyByCurrency(c, "commissionTotal")}</td>
                        <td className="max-w-[160px] truncate p-2.5" title={c.destinationUrl}>
                          {c.destinationUrl}
                        </td>
                        <td className="p-2.5">
                          <div className="flex items-center gap-1.5">
                            <code className="max-w-[140px] truncate font-mono text-[10px] text-cyan-200" title={c.linkTemplate}>
                              {c.linkTemplate}
                            </code>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                copyLink(c.linkTemplate, c.id);
                              }}
                              className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-bold hover:bg-white/10"
                            >
                              {copiedId === c.id ? "Copied!" : "Copy"}
                            </button>
                          </div>
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
                      {isExpanded && (
                        <tr id={`campaign-breakdown-${c.id}`} className="border-t border-white/5 bg-[#0a122480]">
                          <td colSpan={9} className="p-3">
                            <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">
                              Per-affiliate breakdown
                            </div>
                            {c.affiliateStats.length === 0 ? (
                              <p className="text-xs text-slate-400">No affiliate activity on this campaign yet.</p>
                            ) : (
                              <div className="overflow-x-auto">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-left text-[10px] uppercase tracking-wide text-slate-500">
                                      <th className="p-1.5">Affiliate</th>
                                      <th className="p-1.5">Code</th>
                                      <th className="p-1.5">Sales</th>
                                      <th className="p-1.5">Revenue</th>
                                      <th className="p-1.5">Commission</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {c.affiliateStats.map((a) => (
                                      <tr key={a.affiliateId} className="border-t border-white/5">
                                        <td className="p-1.5">
                                          {a.affiliateName}
                                          <div className="text-slate-500">{a.affiliateEmail}</div>
                                        </td>
                                        <td className="p-1.5 font-mono">{a.couponCode}</td>
                                        <td className="p-1.5">
                                          {a.stats.paidCount}
                                          {a.stats.pendingCount > 0 && (
                                            <span className="ml-1 text-[10px] text-slate-500">+{a.stats.pendingCount} pending</span>
                                          )}
                                        </td>
                                        <td className="p-1.5">{moneyByCurrency(a, "revenue")}</td>
                                        <td className="p-1.5">{moneyByCurrency(a, "commissionTotal")}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
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
            <Field label="Site" hint="Only active sites are shown. The destination URL below is prefilled from the site's URL.">
              <select
                className="input"
                required={!selectedId}
                value={form.siteId}
                onChange={(e) => handleSiteChange(e.target.value)}
              >
                <option value="">Select a campaign site…</option>
                {sites.filter((s) => s.active || s.id === form.siteId).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.channel === "global" ? "Global" : "Local"}
                    {!s.active ? " (inactive)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Destination URL" hint="Must be on the selected site's host. ref/campaign params are added automatically per affiliate.">
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

            {form.destinationUrl && !urlError && (
              <div className="rounded-xl border border-white/10 bg-[#0c162c66] p-3">
                <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">Link template preview</div>
                <div className="break-all font-mono text-xs text-cyan-200">
                  {(() => {
                    try {
                      const u = new URL(form.destinationUrl);
                      u.searchParams.set("ref", "{CODE}");
                      u.searchParams.set("campaign", form.slug ? form.slug.toLowerCase() : "(auto-slug)");
                      return u.toString();
                    } catch {
                      return "";
                    }
                  })()}
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  {"{CODE}"} is replaced with each affiliate&apos;s own coupon code on their dashboard.
                </p>
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
