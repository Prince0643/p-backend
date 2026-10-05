"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

type Handlers = {
  requireAuth: () => string | null;
  handleAuthError: (e: unknown) => boolean;
  toast: (m: string) => void;
};

export type CouponTarget = {
  kind: "local" | "ghl";
  location?: "global" | "main";
  ref: string;
  name?: string;
};

type ConfigCoupon = {
  code: string;
  discountPercent: number;
  active: boolean;
  origin: "local" | "ghl";
  enabled: boolean;
  eligible: boolean;
  ineligibleReason: string | null;
};

type ConfigResponse = {
  product: { kind: string; locationKey: string | null; ref: string; name: string | null };
  affiliateCouponsEnabled: boolean;
  coupons: ConfigCoupon[];
  ghlSync?: { attempted: number; errors: { code?: string; locationKey?: string; error: string }[] };
};

const SEARCH_THRESHOLD = 8;

function formatPercent(v: number) {
  const pct = v * 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <label className={`relative inline-flex shrink-0 items-center ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span className="h-6 w-11 rounded-full border border-white/20 bg-slate-700 transition peer-checked:bg-cyan-400 peer-focus-visible:ring-2 peer-focus-visible:ring-cyan-300 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-slate-900" />
      <span className="pointer-events-none absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-5" />
    </label>
  );
}

export function ProductCouponConfigPanel({
  target,
  requireAuth,
  handleAuthError,
  toast,
  onSaved,
}: { target: CouponTarget } & Handlers & { onSaved?: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [coupons, setCoupons] = useState<ConfigCoupon[]>([]);
  const [affiliate, setAffiliate] = useState(true);
  const [baseline, setBaseline] = useState<{ affiliate: boolean; disabled: string[] }>({ affiliate: true, disabled: [] });
  const [syncErrors, setSyncErrors] = useState<{ code?: string; locationKey?: string; error: string }[]>([]);
  const [filter, setFilter] = useState("");

  const { kind, location, ref, name } = target;

  const apply = useCallback((data: ConfigResponse) => {
    setCoupons(data.coupons || []);
    setAffiliate(data.affiliateCouponsEnabled !== false);
    setBaseline({
      affiliate: data.affiliateCouponsEnabled !== false,
      disabled: (data.coupons || []).filter((c) => !c.enabled).map((c) => c.code),
    });
  }, []);

  // Always call the latest auth helpers without making them load() deps (avoids refetch loops).
  const authRef = useRef({ requireAuth, handleAuthError });
  useEffect(() => {
    authRef.current = { requireAuth, handleAuthError };
  }, [requireAuth, handleAuthError]);

  const load = useCallback(async () => {
    const { requireAuth, handleAuthError } = authRef.current;
    const key = requireAuth();
    if (!key) return;
    setLoading(true);
    setError(null);
    setSyncErrors([]);
    try {
      const qs = new URLSearchParams({ kind, ref });
      if (kind === "ghl" && location) qs.set("location", location);
      const data = await apiFetch<ConfigResponse>(`/api/admin/product-coupon-config?${qs.toString()}`, key);
      apply(data);
    } catch (e) {
      if (!handleAuthError(e)) setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [kind, location, ref, apply]);

  useEffect(() => {
    load();
  }, [load]);

  const disabledCodes = useMemo(
    () => coupons.filter((c) => !c.enabled).map((c) => c.code),
    [coupons]
  );
  const dirty =
    affiliate !== baseline.affiliate ||
    disabledCodes.length !== baseline.disabled.length ||
    disabledCodes.some((c) => !baseline.disabled.includes(c));

  function setEnabled(code: string, enabled: boolean) {
    setCoupons((prev) => prev.map((c) => (c.code === code ? { ...c, enabled } : c)));
  }
  function setAll(enabled: boolean) {
    setCoupons((prev) => prev.map((c) => (c.eligible ? { ...c, enabled } : c)));
  }

  async function save() {
    const key = requireAuth();
    if (!key) return;
    setSaving(true);
    setSyncErrors([]);
    try {
      const data = await apiFetch<ConfigResponse>("/api/admin/product-coupon-config", key, {
        method: "PUT",
        body: {
          kind,
          ...(kind === "ghl" && location ? { location } : {}),
          ref,
          ...(name ? { name } : {}),
          affiliateCouponsEnabled: affiliate,
          disabledCouponCodes: disabledCodes,
        },
      });
      apply(data);
      const errs = data.ghlSync?.errors || [];
      setSyncErrors(errs);
      toast(errs.length ? `Saved, but ${errs.length} GHL sync error(s).` : "Coupon config saved.");
      onSaved?.();
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const q = filter.trim().toLowerCase();
  const visible = q ? coupons.filter((c) => c.code.toLowerCase().includes(q)) : coupons;
  const idBase = `cc-${kind}-${location || "local"}-${ref}`;

  return (
    <div className="p-4" aria-busy={loading}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wide text-slate-200">Coupons</h3>
          <p className="mt-1 text-[11px] text-slate-400">
            Choose which coupons customers can use on this product.
            {kind === "ghl" ? " Changes are pushed to GHL on save." : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty && <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[11px] font-bold text-amber-200">Unsaved changes</span>}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving || loading || !!error}
            className="rounded-lg bg-gradient-to-b from-blue-400 to-blue-500 px-3 py-2 text-sm font-extrabold text-slate-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Coupons"}
          </button>
        </div>
      </div>

      {loading && <p role="status" className="text-xs text-slate-400">Loading coupon config…</p>}

      {!loading && error && (
        <div role="alert" className="rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-xs text-red-200">
          {error}{" "}
          <button type="button" onClick={load} className="font-bold underline">Retry</button>
        </div>
      )}

      {!loading && !error && (
        <>
          {syncErrors.length > 0 && (
            <div role="alert" className="mb-3 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-xs text-amber-100">
              <div className="font-bold">Saved, but some coupons failed to sync to GHL:</div>
              <ul className="mt-1 list-disc pl-4">
                {syncErrors.map((e, i) => (
                  <li key={i}>
                    {[e.code, e.locationKey].filter(Boolean).join(" @ ")}{e.code || e.locationKey ? ": " : ""}{e.error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#0c162c8c] p-3">
            <label htmlFor={`${idBase}-aff`} className="min-w-0 cursor-pointer">
              <div className="text-sm font-extrabold">Allow affiliate coupons</div>
              <div className="mt-0.5 text-[11px] text-slate-400">Applies to all affiliate coupons as a group.</div>
            </label>
            <Switch id={`${idBase}-aff`} checked={affiliate} onChange={setAffiliate} label="Allow affiliate coupons" />
          </div>

          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold text-slate-300">General coupons ({coupons.length})</div>
            <div className="flex flex-wrap gap-2">
              {coupons.length > SEARCH_THRESHOLD && (
                <input
                  type="search"
                  aria-label="Filter coupons by code"
                  className="rounded-lg border border-white/10 bg-[#0c162ce6] px-3 py-1.5 text-sm outline-none focus:border-blue-400"
                  placeholder="Filter coupons…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              )}
              <button type="button" onClick={() => setAll(true)} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">Enable all</button>
              <button type="button" onClick={() => setAll(false)} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">Disable all</button>
            </div>
          </div>

          {coupons.length === 0 ? (
            <p className="rounded-xl border border-white/10 bg-[#0c162c8c] p-3 text-xs text-slate-400">No general coupons exist yet.</p>
          ) : visible.length === 0 ? (
            <p className="text-xs text-slate-400">No coupons match “{filter}”.</p>
          ) : (
            <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
              {visible.map((c) => {
                const id = `${idBase}-${c.code}`;
                return (
                  <li
                    key={c.code}
                    className={`flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#0c162c8c] p-3 ${c.eligible ? "" : "opacity-60"}`}
                  >
                    <label htmlFor={id} className={`min-w-0 ${c.eligible ? "cursor-pointer" : "cursor-not-allowed"}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-extrabold">{c.code}</span>
                        <span className="text-xs text-slate-300">{formatPercent(c.discountPercent)} off</span>
                        <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase text-slate-300">{c.origin}</span>
                        {!c.active && <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase text-slate-400">inactive</span>}
                      </div>
                      {!c.eligible && c.ineligibleReason && (
                        <div className="mt-1 text-[11px] text-slate-300">{c.ineligibleReason}</div>
                      )}
                    </label>
                    <Switch
                      id={id}
                      checked={c.enabled}
                      disabled={!c.eligible}
                      onChange={(v) => setEnabled(c.code, v)}
                      label={`Allow coupon ${c.code}`}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
