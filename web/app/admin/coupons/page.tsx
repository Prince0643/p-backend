"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminTopbar } from "@/components/AdminTopbar";
import { Toast } from "@/components/Toast";
import { apiFetch } from "@/lib/api";
import { useAdminAuth } from "@/lib/useAdminAuth";
import { useToast } from "@/lib/useToast";
import { GhlCouponsPanel, CouponUsageModal } from "@/components/GhlCouponsPanel";
import { formatMoney } from "@/lib/money";

type CouponType = "affiliate" | "general";

type Coupon = {
  code: string;
  type: CouponType;
  discountPercent: number;
  affiliateFeePercent: number;
  affiliateEmail: string;
  affiliate: { id: string; name: string; email: string } | null;
  ghlLocationIds: string[] | null;
  localEnabled: boolean;
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
  source: "paymongo" | "ghl";
  channel: "local" | "global";
  currency: string;
  affiliatePaidAt: string | null;
  needsReview: boolean;
  refundedAt: string | null;
  isTest?: boolean;
};

type ImportOrdersSummary = {
  scanned: number;
  imported: number;
  refunded: number;
  flagged: number;
  skipped: { noCoupon: number; invoice: number; unknownCode: number; noAffiliate: number; testUnknownCoupon?: number };
  errors: unknown[];
};

// POST /api/admin/coupons/ghl/import-orders returns these fields at the TOP LEVEL
// (not nested under `summary`), but we tolerate a `summary` wrapper defensively.
type ImportOrdersResponse = Partial<ImportOrdersSummary> & {
  success?: boolean;
  summary?: Partial<ImportOrdersSummary>;
};

const money = formatMoney;

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

type GhlLocation = { locationId: string; name: string };

// One row per coupon PER LOCATION (services/ghlService.js syncCouponsToGhlLocations).
type GhlSyncAction =
  | "would_create"
  | "would_update"
  | "created"
  | "updated"
  | "unchanged"
  | "error"
  | "skipped_inactive";

type GhlSyncResultRow = {
  locationName?: string;
  locationId?: string;
  code: string;
  action: GhlSyncAction;
  note?: "not_syncable_status" | null;
  error?: string;
  ghlCouponId?: string | null;
};

type GhlSyncSummary = {
  locations: number;
  localCoupons: number;
  activeCoupons: number;
  created: number;
  updated: number;
  unchanged: number;
  wouldCreate: number;
  wouldUpdate: number;
  notSyncable: number;
  skippedInactive: number;
  errors: number;
  dryRun: boolean;
};

type GhlSyncResponse = {
  summary: GhlSyncSummary;
  results: GhlSyncResultRow[];
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
  localEnabled: "true",
  ghlAllLocations: "true",
  ghlLocationIds: [] as string[],
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
  const [typeFilter, setTypeFilter] = useState<"" | CouponType>("");
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [selectedCoupon, setSelectedCoupon] = useState<Coupon | null>(null);
  const [form, setForm] = useState(emptyForm);

  const [ghlLocations, setGhlLocations] = useState<GhlLocation[]>([]);
  const [loadingGhlLocations, setLoadingGhlLocations] = useState(false);

  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [payoutFilter, setPayoutFilter] = useState("");
  const [selectedRedemptionIds, setSelectedRedemptionIds] = useState<Set<string>>(new Set());
  const [importingOrders, setImportingOrders] = useState(false);
  const [ghlCoupons, setGhlCoupons] = useState<GhlCoupon[]>([]);
  const [ghlErrors, setGhlErrors] = useState<GhlCouponError[]>([]);
  const [ghlStatusFilter, setGhlStatusFilter] = useState("");
  const [ghlSearch, setGhlSearch] = useState("");
  const [loadingGhlCoupons, setLoadingGhlCoupons] = useState(false);
  const [dryRunningSync, setDryRunningSync] = useState(false);
  const [syncingGhlCoupons, setSyncingGhlCoupons] = useState(false);
  const [ghlSyncPlan, setGhlSyncPlan] = useState<GhlSyncResponse | null>(null);
  const [ghlSyncResult, setGhlSyncResult] = useState<GhlSyncResponse | null>(null);
  const [usageCode, setUsageCode] = useState<string | null>(null);
  const [panelRefresh, setPanelRefresh] = useState(0);

  const loadCoupons = useCallback(async (key: string, type: "" | CouponType) => {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    const data = await apiFetch<{ coupons: Coupon[] }>(
      `/api/admin/coupons${params.toString() ? `?${params}` : ""}`,
      key
    );
    setCoupons(data.coupons || []);
  }, []);

  const loadGhlLocations = useCallback(async (key: string) => {
    setLoadingGhlLocations(true);
    try {
      const data = await apiFetch<{ locations: GhlLocation[] }>("/api/admin/coupons/ghl-locations", key);
      setGhlLocations(data.locations || []);
    } finally {
      setLoadingGhlLocations(false);
    }
  }, []);

  const loadRedemptions = useCallback(async (key: string, code: string | null, status: string, payout: string) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (code) params.set("code", code);
    if (payout) params.set("payout", payout);
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
    loadCoupons(key, typeFilter).catch((e) => { if (!handleAuthError(e)) toast(e.message); });
    loadGhlLocations(key).catch((e) => { if (!handleAuthError(e)) toast(e.message); });
    loadRedemptions(key, null, "", "").catch((e) => { if (!handleAuthError(e)) toast(e.message); });
    setLoadingGhlCoupons(true);
    loadGhlCoupons(key, "", "")
      .catch((e) => { if (!handleAuthError(e)) toast(e.message); })
      .finally(() => setLoadingGhlCoupons(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requireAuth/load fns intentionally not deps to avoid refetch loops
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    const key = requireAuth();
    if (!key) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refetch when the filter changes
    loadCoupons(key, typeFilter).catch((e) => { if (!handleAuthError(e)) toast(e.message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requireAuth/load fns intentionally not deps to avoid refetch loops
  }, [typeFilter]);

  function fillForm(c: Coupon | null) {
    setSelectedCode(c?.code || null);
    setSelectedCoupon(c);
    setGhlSyncPlan(null);
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
      localEnabled: c ? String(!!c.localEnabled) : "true",
      ghlAllLocations: c ? String(c.ghlLocationIds === null) : "true",
      ghlLocationIds: c?.ghlLocationIds || [],
    });
  }

  async function handleRefresh() {
    const key = requireAuth();
    if (!key) return;
    try {
      await loadCoupons(key, typeFilter);
      await loadGhlLocations(key);
      await loadRedemptions(key, selectedCode, statusFilter, payoutFilter);
      await loadGhlCoupons(key, ghlStatusFilter, ghlSearch);
      setPanelRefresh((n) => n + 1);
      toast("Refreshed.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  function toggleGhlLocation(locationId: string) {
    setForm((f) => {
      const has = f.ghlLocationIds.includes(locationId);
      return {
        ...f,
        ghlLocationIds: has ? f.ghlLocationIds.filter((id) => id !== locationId) : [...f.ghlLocationIds, locationId],
      };
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const key = requireAuth();
    if (!key) return;

    const isAffiliateCoupon = selectedCoupon?.type === "affiliate";

    const payload: Record<string, unknown> = {
      code: form.code.trim().toUpperCase(),
      discountPercent: Number(form.discountPercent) / 100,
      expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      maxRedemptions: form.maxRedemptions ? Number(form.maxRedemptions) : null,
      productIds: form.productIds.split(",").map((s) => s.trim()).filter(Boolean),
      active: form.active === "true",
      notes: form.notes,
    };

    if (!isAffiliateCoupon) {
      // General coupons: no affiliate fee/email, but local checkout + GHL location scoping apply.
      payload.affiliateFeePercent = 0;
      payload.affiliateEmail = "";
      payload.localEnabled = form.localEnabled === "true";
      payload.ghlLocationIds = form.ghlAllLocations === "true" ? null : form.ghlLocationIds;
      if (!selectedCode) payload.type = "general";
    }

    try {
      const method = selectedCode ? "PUT" : "POST";
      const path = selectedCode
        ? `/api/admin/coupons/${encodeURIComponent(payload.code as string)}`
        : "/api/admin/coupons";
      const data = await apiFetch<{ coupon: Coupon }>(path, key, { method, body: payload });
      toast("Saved.");
      await loadCoupons(key, typeFilter);
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
      await loadCoupons(key, typeFilter);
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function handleLoadRedemptions() {
    const key = requireAuth();
    if (!key) return;
    try {
      await loadRedemptions(key, selectedCode, statusFilter, payoutFilter);
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

  async function handleDryRunSync() {
    const key = requireAuth();
    if (!key) return;
    setDryRunningSync(true);
    setGhlSyncResult(null);
    try {
      const data = await apiFetch<GhlSyncResponse>("/api/admin/coupons/ghl/sync?dryRun=1", key, { method: "POST" });
      setGhlSyncPlan(data);
      toast("Dry run complete - review the plan below before applying.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    } finally {
      setDryRunningSync(false);
    }
  }

  async function handleConfirmSync() {
    if (!confirm("Apply this sync plan? This will create and update GHL coupons in every listed location.")) return;
    const key = requireAuth();
    if (!key) return;
    setSyncingGhlCoupons(true);
    try {
      const data = await apiFetch<GhlSyncResponse>("/api/admin/coupons/ghl/sync", key, { method: "POST" });
      setGhlSyncResult(data);
      setGhlSyncPlan(null);
      await loadGhlCoupons(key, ghlStatusFilter, ghlSearch);
      toast("GHL sync applied.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    } finally {
      setSyncingGhlCoupons(false);
    }
  }

  async function handleMarkPaid() {
    if (selectedRedemptionIds.size === 0) return toast("Select at least one redemption.");
    if (!confirm(`Mark ${selectedRedemptionIds.size} redemption(s) as paid out?`)) return;
    const key = requireAuth();
    if (!key) return;
    try {
      await apiFetch("/api/admin/coupons/redemptions/mark-paid", key, {
        method: "POST",
        body: { ids: Array.from(selectedRedemptionIds) },
      });
      toast("Marked as paid out.");
      setSelectedRedemptionIds(new Set());
      await loadRedemptions(key, selectedCode, statusFilter, payoutFilter);
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  // Payout can only be marked for redemptions whose CUSTOMER payment already
  // cleared (status 'paid') and that haven't been paid out to the affiliate yet.
  function canSelectForPayout(r: Redemption) {
    return r.status === "paid" && !r.affiliatePaidAt && !r.isTest;
  }

  function toggleRedemption(id: string) {
    setSelectedRedemptionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleImportOrders() {
    const key = requireAuth();
    if (!key) return;
    setImportingOrders(true);
    try {
      const data = await apiFetch<ImportOrdersResponse>("/api/admin/coupons/ghl/import-orders", key, {
        method: "POST",
        body: {},
      });
      // The endpoint returns these fields at the top level, but tolerate a
      // `summary` wrapper too in case that ever changes.
      const s = data.summary || data;
      const errorCount = s.errors?.length ?? 0;
      toast(
        `Imported ${s.imported ?? 0} of ${s.scanned ?? 0} scanned` +
          `${s.refunded ? `, ${s.refunded} refunded` : ""}${s.flagged ? `, ${s.flagged} flagged` : ""}` +
          `${errorCount ? `, ${errorCount} error${errorCount === 1 ? "" : "s"}` : ""}.`
      );
      await loadRedemptions(key, selectedCode, statusFilter, payoutFilter);
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    } finally {
      setImportingOrders(false);
    }
  }

  const filtered = coupons.filter((c) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      c.code.toLowerCase().includes(q) ||
      c.affiliateEmail.toLowerCase().includes(q) ||
      (c.affiliate?.name || "").toLowerCase().includes(q)
    );
  });

  const affiliateLinkedCount = ghlCoupons.filter((c) => c.affiliate).length;
  const isAffiliateCoupon = selectedCoupon?.type === "affiliate";

  const ACTION_LABELS: Record<GhlSyncAction, string> = {
    would_create: "Would create",
    would_update: "Would update",
    created: "Created",
    updated: "Updated",
    unchanged: "Unchanged",
    error: "Error",
    skipped_inactive: "Skipped (inactive)",
  };

  const ACTION_STYLES: Record<GhlSyncAction, string> = {
    would_create: "border-emerald-400/40 text-emerald-200",
    would_update: "border-amber-400/40 text-amber-200",
    created: "border-emerald-400/40 text-emerald-200",
    updated: "border-amber-400/40 text-amber-200",
    unchanged: "border-white/15 text-slate-300",
    error: "border-red-400/40 text-red-200",
    skipped_inactive: "border-white/10 text-slate-500",
  };

  function renderSyncPlan(plan: GhlSyncResponse, title: string) {
    const s = plan.summary;
    const rows = plan.results || [];
    // Group rows by location so admins can scan changes per GHL location.
    const byLocation = new Map<string, GhlSyncResultRow[]>();
    for (const r of rows) {
      const key = r.locationId || r.locationName || "unassigned";
      if (!byLocation.has(key)) byLocation.set(key, []);
      byLocation.get(key)!.push(r);
    }

    return (
      <div className="m-3.5 rounded-xl border border-blue-300/20 bg-blue-300/10 p-3 text-xs text-blue-100">
        <div className="mb-2 font-bold uppercase tracking-wide text-blue-200">{title}</div>
        {s && (
          <div className="mb-2 grid gap-2 sm:grid-cols-5">
            {s.dryRun ? (
              <>
                <Metric label="Would create" value={s.wouldCreate ?? 0} />
                <Metric label="Would update" value={s.wouldUpdate ?? 0} />
                <Metric label="Unchanged" value={s.unchanged ?? 0} />
                <Metric label="Not syncable" value={s.notSyncable ?? 0} />
                <Metric label="Errors" value={s.errors ?? 0} />
              </>
            ) : (
              <>
                <Metric label="Created" value={s.created ?? 0} />
                <Metric label="Updated" value={s.updated ?? 0} />
                <Metric label="Unchanged" value={s.unchanged ?? 0} />
                <Metric label="Not syncable" value={s.notSyncable ?? 0} />
                <Metric label="Errors" value={s.errors ?? 0} />
              </>
            )}
          </div>
        )}

        {s && s.errors > 0 && (
          <div className="mb-2 rounded-lg border border-red-400/30 bg-red-400/10 p-2 font-bold text-red-200">
            {s.errors} coupon{s.errors === 1 ? "" : "s"} could not be synced - see the Error rows below.
          </div>
        )}

        {rows.length === 0 ? (
          <p className="text-blue-200/70">No coupons to sync.</p>
        ) : (
          <div className="space-y-3">
            {Array.from(byLocation.entries()).map(([locKey, locRows]) => (
              <div key={locKey} className="overflow-x-auto rounded-lg border border-blue-300/10">
                <div className="border-b border-blue-300/10 bg-blue-300/5 px-2 py-1 font-bold text-blue-100">
                  {locRows[0].locationName || locRows[0].locationId || "Inactive coupons (no location)"}
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wide text-blue-200/70">
                      <th className="p-1.5">Code</th>
                      <th className="p-1.5">Action</th>
                      <th className="p-1.5">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {locRows.map((r, i) => (
                      <tr key={`${r.code}-${i}`} className="border-t border-blue-300/10">
                        <td className="p-1.5 font-mono">{r.code}</td>
                        <td className="p-1.5">
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] ${ACTION_STYLES[r.action]}`}>
                            {ACTION_LABELS[r.action]}
                          </span>
                        </td>
                        <td className="p-1.5">
                          {r.action === "error" && r.error ? (
                            <span className="text-red-200">{r.error}</span>
                          ) : r.note === "not_syncable_status" ? (
                            <span className="text-amber-200">Status differs in GHL - change it in GHL.</span>
                          ) : (
                            <span className="text-blue-200/50">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <AdminTopbar
        title="Nexistry Backend"
        subtitle="Coupons + Affiliate Payout Tracking"
        adminEmail={admin?.email}
        onRefresh={handleRefresh}
        onLogout={logout}
      />
      <main className="mx-auto grid w-full min-w-0 max-w-6xl flex-1 grid-cols-1 gap-4 px-5 pb-28 pt-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section className="flex min-w-0 flex-col rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">Coupons</h2>
            <div className="flex flex-wrap gap-2">
              <label className="sr-only" htmlFor="coupon-search">Search coupons</label>
              <input
                id="coupon-search"
                className="rounded-lg border border-white/10 bg-[#0c162ce6] px-3 py-2 text-sm outline-none focus:border-blue-400"
                placeholder="Search coupons…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <label className="sr-only" htmlFor="coupon-type-filter">Filter by coupon type</label>
              <select
                id="coupon-type-filter"
                className="input w-auto"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as "" | CouponType)}
              >
                <option value="">All types</option>
                <option value="affiliate">Affiliate</option>
                <option value="general">General</option>
              </select>
              <button onClick={() => fillForm(null)} className="rounded-lg bg-blue-400 hover:bg-blue-300 px-3 py-2 text-sm font-extrabold text-slate-950">
                New Coupon
              </button>
            </div>
          </div>
          <div className="flex max-h-[50vh] flex-col gap-2.5 overflow-y-auto p-2.5 lg:h-0 lg:max-h-none lg:min-h-0 lg:flex-1">
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
                  <div className="flex items-center gap-2">
                    <span className="font-extrabold">{c.code}</span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] ${
                        c.type === "affiliate" ? "border-purple-400/40 text-purple-200" : "border-cyan-400/40 text-cyan-200"
                      }`}
                    >
                      {c.type === "affiliate" ? "Affiliate" : "General"}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-slate-400">
                    {(c.discountPercent * 100).toFixed(0)}% off
                    {c.affiliateFeePercent ? ` · ${(c.affiliateFeePercent * 100).toFixed(0)}% affiliate fee` : ""} ·{" "}
                    {c.expiresAt ? `expires ${new Date(c.expiresAt).toLocaleString()}` : "no expiry"}
                  </div>
                  {c.affiliate && (
                    <div className="mt-1 text-[11px] text-slate-500">
                      {c.affiliate.name || c.affiliate.email} · {c.affiliate.email}
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <div className={`rounded-full border px-2.5 py-1 text-xs ${c.active ? "border-emerald-400/40 text-emerald-200" : "border-red-400/40 text-red-200"}`}>
                    {c.active ? "Active" : "Inactive"}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setUsageCode(c.code); }}
                    aria-label={`View usage of ${c.code}`}
                    className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-bold hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-blue-400"
                  >
                    View usage
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="min-w-0 rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
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

          {isAffiliateCoupon && (
            <div className="m-4 rounded-xl border border-purple-300/25 bg-purple-300/10 p-3 text-xs text-purple-100">
              <div className="font-bold uppercase tracking-wide text-purple-200">Affiliate coupon</div>
              <p className="mt-1">
                Affiliate codes are created automatically at registration; they carry the affiliate&apos;s fee, allow
                unlimited customers, but each customer can use an affiliate discount only once ever — across all
                affiliate codes.
              </p>
              {selectedCoupon?.affiliate && (
                <p className="mt-2 font-semibold text-purple-50">
                  Linked to: {selectedCoupon.affiliate.name || selectedCoupon.affiliate.email} ({selectedCoupon.affiliate.email})
                </p>
              )}
            </div>
          )}

          <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
            <Field label="Code" hint="Uppercased automatically. Letters, numbers, - and _ only, up to 50 characters.">
              <input className="input uppercase" required maxLength={50} disabled={isAffiliateCoupon} value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })} />
            </Field>
            <Field label="Discount %">
              <input className="input" type="number" min={0} max={100} step="0.01" required value={form.discountPercent}
                onChange={(e) => setForm({ ...form, discountPercent: e.target.value })} />
            </Field>
            <Field label="Affiliate fee %" hint={isAffiliateCoupon ? undefined : "Not applicable to general coupons."}>
              <input className="input" type="number" min={0} max={100} step="0.01" disabled={!isAffiliateCoupon} value={isAffiliateCoupon ? form.affiliateFeePercent : ""}
                onChange={(e) => setForm({ ...form, affiliateFeePercent: e.target.value })} />
            </Field>
            <Field label="Affiliate email" hint={isAffiliateCoupon ? undefined : "Not applicable to general coupons."}>
              <input className="input" type="email" disabled={!isAffiliateCoupon} value={isAffiliateCoupon ? form.affiliateEmail : ""}
                onChange={(e) => setForm({ ...form, affiliateEmail: e.target.value })} />
            </Field>
            <Field label="Expires at" hint="Leave blank for no expiry.">
              <input className="input" type="datetime-local" value={form.expiresAt}
                onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
            </Field>
            <Field label="Max redemptions" hint="Total limit across all customers. Leave blank for unlimited.">
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

            {!isAffiliateCoupon && (
              <>
                <div className="sm:col-span-2">
                  <span className="mb-1.5 block text-xs font-semibold text-slate-300">Checkout availability</span>
                  <label className="flex min-h-[36px] cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-white/5">
                    <input
                      type="checkbox"
                      checked={form.localEnabled === "true"}
                      onChange={(e) => setForm({ ...form, localEnabled: e.target.checked ? "true" : "false" })}
                    />
                    <span>Enable for Local (PayMongo) checkout</span>
                  </label>
                </div>

                <div className="sm:col-span-2">
                  <span className="mb-1.5 block text-xs font-semibold text-slate-300">GHL locations</span>
                  <label className="flex min-h-[36px] cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-white/5">
                    <input
                      type="checkbox"
                      checked={form.ghlAllLocations === "true"}
                      onChange={(e) => setForm({ ...form, ghlAllLocations: e.target.checked ? "true" : "false" })}
                    />
                    <span>All locations</span>
                  </label>
                  {form.ghlAllLocations !== "true" && (
                    <fieldset className="mt-1.5 max-h-40 overflow-y-auto rounded-lg border border-white/10 bg-[#0c162ce6] p-2.5">
                      <legend className="sr-only">Select GHL locations for this coupon</legend>
                      {loadingGhlLocations && <div className="p-2 text-xs text-slate-400">Loading locations…</div>}
                      {!loadingGhlLocations && ghlLocations.length === 0 && (
                        <div className="p-2 text-xs text-slate-400">No GHL locations found.</div>
                      )}
                      {ghlLocations.map((loc) => (
                        <label key={loc.locationId} className="flex min-h-[36px] cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-white/5">
                          <input
                            type="checkbox"
                            checked={form.ghlLocationIds.includes(loc.locationId)}
                            onChange={() => toggleGhlLocation(loc.locationId)}
                          />
                          <span>{loc.name}</span>
                        </label>
                      ))}
                    </fieldset>
                  )}
                </div>
              </>
            )}

            <div className="sm:col-span-2">
              <Field
                label="Notes"
                hint="Each customer can use this code once. Recurring products: discount applies to the first payment only."
              >
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
              <label className="sr-only" htmlFor="redemption-status-filter">Filter by customer payment status</label>
              <select id="redemption-status-filter" className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">All statuses</option>
                <option value="pending">Pending</option>
                <option value="paid">Paid</option>
                <option value="released">Released</option>
              </select>
              <label className="sr-only" htmlFor="redemption-payout-filter">Filter by affiliate payout status</label>
              <select id="redemption-payout-filter" className="input" value={payoutFilter} onChange={(e) => setPayoutFilter(e.target.value)}>
                <option value="">All payouts</option>
                <option value="unpaid">Unpaid</option>
                <option value="paid">Paid out</option>
              </select>
              <button onClick={handleLoadRedemptions} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold">
                Load
              </button>
              <button
                onClick={handleImportOrders}
                disabled={importingOrders}
                className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-sm font-bold text-cyan-100 disabled:opacity-60"
              >
                {importingOrders ? "Importing…" : "Import GHL Sales"}
              </button>
              <button onClick={handleMarkPaid} className="rounded-lg bg-blue-400 hover:bg-blue-300 px-3 py-2 text-sm font-extrabold text-slate-950">
                Mark Selected Paid Out
              </button>
            </div>
          </div>
          <div className="overflow-x-auto px-3.5 pb-8">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
                  <th className="p-2"></th>
                  <th className="p-2">Source</th>
                  <th className="p-2">Code</th>
                  <th className="p-2">Payment Ref</th>
                  <th className="p-2">Customer</th>
                  <th className="p-2">Base</th>
                  <th className="p-2">Discount</th>
                  <th className="p-2">Affiliate Fee</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Payout</th>
                  <th className="p-2">Date</th>
                </tr>
              </thead>
              <tbody>
                {redemptions.length === 0 && (
                  <tr><td colSpan={11} className="p-2 text-slate-400">No redemptions loaded.</td></tr>
                )}
                {redemptions.map((r) => {
                  const selectable = canSelectForPayout(r);
                  return (
                    <tr key={r.id} className="border-t border-white/10 hover:bg-white/[.03]">
                      <td className="p-2">
                        <input
                          type="checkbox"
                          aria-label={`Select redemption ${r.paymentReference} for payout`}
                          disabled={!selectable}
                          checked={selectedRedemptionIds.has(r.id)}
                          onChange={() => toggleRedemption(r.id)}
                        />
                      </td>
                      <td className="p-2">
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] ${r.channel === "global" ? "border-cyan-400/40 text-cyan-200" : "border-blue-400/40 text-blue-200"}`}>
                          {r.channel === "global" ? "Global" : "Local"}
                        </span>
                        {r.isTest && (
                          <span className="ml-1 rounded-full border border-fuchsia-300/40 bg-fuchsia-400/10 px-2 py-0.5 text-[10px] font-bold uppercase text-fuchsia-200">TEST</span>
                        )}
                      </td>
                      <td className="p-2">{r.code}</td>
                      <td className="p-2">{r.paymentReference}</td>
                      <td className="p-2">
                        {r.fullName}
                        <br />
                        <span className="text-slate-400">{r.email}</span>
                      </td>
                      <td className="p-2">{money(r.baseAmount, r.currency)}</td>
                      <td className="p-2">{money(r.discountAmount, r.currency)}</td>
                      <td className="p-2">{money(r.affiliateFeeAmount, r.currency)}</td>
                      <td className={`p-2 ${r.status === "paid" ? "text-emerald-300" : "text-amber-300"}`}>{r.status}</td>
                      <td className="p-2">
                        {r.refundedAt ? (
                          <span className="font-bold text-red-300">Refunded</span>
                        ) : r.isTest ? (
                          <span className="text-fuchsia-200">Not payable (test)</span>
                        ) : r.affiliatePaidAt ? (
                          <span className="text-emerald-300">Paid out {new Date(r.affiliatePaidAt).toLocaleDateString()}</span>
                        ) : r.needsReview ? (
                          <span className="font-bold text-amber-300">Needs review</span>
                        ) : (
                          <span className="text-slate-400">Unpaid</span>
                        )}
                      </td>
                      <td className="p-2">{new Date(r.createdAt).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <GhlCouponsPanel handlers={{ requireAuth, handleAuthError, toast }} ready={ready} refreshKey={panelRefresh} />

        <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl lg:col-span-2 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
            <div>
              <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">GHL Sync &amp; Raw Fetch</h2>
              <div className="mt-1 text-xs text-slate-400">
                {ghlCoupons.length} codes fetched · {affiliateLinkedCount} matched to affiliates
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="sr-only" htmlFor="ghl-coupon-search">Search GHL coupons</label>
              <input
                id="ghl-coupon-search"
                className="input w-52"
                placeholder="Search GHL coupons…"
                value={ghlSearch}
                onChange={(e) => setGhlSearch(e.target.value)}
              />
              <label className="sr-only" htmlFor="ghl-coupon-status-filter">Filter GHL coupons by status</label>
              <select id="ghl-coupon-status-filter" className="input w-36" value={ghlStatusFilter} onChange={(e) => setGhlStatusFilter(e.target.value)}>
                <option value="">All statuses</option>
                <option value="scheduled">Scheduled</option>
                <option value="active">Active</option>
                <option value="expired">Expired</option>
              </select>
              <button onClick={handleLoadGhlCoupons} disabled={loadingGhlCoupons} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold disabled:opacity-60">
                {loadingGhlCoupons ? "Loading…" : "Fetch GHL"}
              </button>
              <button onClick={handleDryRunSync} disabled={dryRunningSync} className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-sm font-bold text-cyan-100 disabled:opacity-60">
                {dryRunningSync ? "Checking…" : "Preview Sync to GHL"}
              </button>
              {ghlSyncPlan && (ghlSyncPlan.summary.wouldCreate ?? 0) + (ghlSyncPlan.summary.wouldUpdate ?? 0) > 0 && (
                <button onClick={handleConfirmSync} disabled={syncingGhlCoupons} className="rounded-lg bg-blue-400 hover:bg-blue-300 px-3 py-2 text-sm font-extrabold text-slate-950 disabled:opacity-60">
                  {syncingGhlCoupons ? "Syncing…" : "Confirm & Apply"}
                </button>
              )}
            </div>
          </div>

          {ghlSyncPlan && renderSyncPlan(ghlSyncPlan, "Planned changes (dry run - nothing written yet)")}
          {ghlSyncResult && renderSyncPlan(ghlSyncResult, "Sync applied")}

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
      {usageCode && (
        <CouponUsageModal code={usageCode} onClose={() => setUsageCode(null)} handlers={{ requireAuth, handleAuthError, toast }} />
      )}
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
