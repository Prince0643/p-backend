"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { ProductCouponConfigPanel, type CouponTarget } from "@/components/ProductCouponConfigPanel";

type Handlers = {
  requireAuth: () => string | null;
  handleAuthError: (e: unknown) => boolean;
  toast: (m: string) => void;
};

type GhlLocation = {
  key: "global" | "main";
  locationId: string;
  products: { id: string; name: string; price: number | null }[];
  error?: string;
};

const LABELS: Record<string, string> = { global: "Global", main: "Main" };

export function GhlProductsPanel({ requireAuth, handleAuthError, toast, refreshToken }: Handlers & { refreshToken?: number }) {
  const [locations, setLocations] = useState<GhlLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CouponTarget | null>(null);
  const [syncing, setSyncing] = useState(false);

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
    try {
      const data = await apiFetch<{ locations: GhlLocation[] }>("/api/admin/ghl-products", key);
      setLocations(data.locations || []);
    } catch (e) {
      if (!handleAuthError(e)) setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshToken]);

  async function syncNow() {
    const key = requireAuth();
    if (!key) return;
    setSyncing(true);
    try {
      const data = await apiFetch<{ results: unknown[]; errors: { code?: string; locationKey?: string; error: string }[] }>(
        "/api/admin/product-coupon-config/ghl-sync",
        key,
        { method: "POST" }
      );
      const errs = data.errors || [];
      const ok = (data.results || []).length;
      if (errs.length) {
        const first = errs[0];
        toast(`Synced ${ok}; ${errs.length} error(s). First: ${[first.code, first.locationKey].filter(Boolean).join(" @ ")} ${first.error}`.replace(/\s+/g, " "));
      } else {
        toast(`GHL sync complete (${ok} updated).`);
      }
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
        <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">GHL products</h2>
        <button
          type="button"
          onClick={syncNow}
          disabled={syncing}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 disabled:opacity-50"
        >
          {syncing ? "Syncing…" : "Sync to GHL now"}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[1fr_1.2fr]">
        <div className="flex flex-col gap-4">
          {loading && <p role="status" className="text-xs text-slate-400">Loading GHL products…</p>}
          {!loading && error && (
            <div role="alert" className="rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-xs text-red-200">
              {error} <button type="button" onClick={load} className="font-bold underline">Retry</button>
            </div>
          )}
          {!loading && !error && locations.length === 0 && (
            <p className="text-xs text-slate-400">No GHL locations configured.</p>
          )}
          {!loading && !error && locations.map((loc) => (
            <div key={loc.key}>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-300">{LABELS[loc.key] || loc.key}</h3>
              {loc.error && (
                <div role="alert" className="mb-2 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-xs text-red-200">{loc.error}</div>
              )}
              {!loc.error && loc.products.length === 0 && <p className="text-xs text-slate-400">No products in this location.</p>}
              <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
                {loc.products.map((p) => {
                  const active = selected?.kind === "ghl" && selected.location === loc.key && selected.ref === p.id;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        aria-pressed={active}
                        onClick={() => setSelected({ kind: "ghl", location: loc.key, ref: p.id, name: p.name })}
                        className={`flex w-full items-start justify-between gap-2.5 rounded-xl border p-3 text-left hover:border-blue-400/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 ${
                          active ? "border-blue-400 bg-blue-400/10" : "border-white/10 bg-[#0c162c8c]"
                        }`}
                      >
                        <span>
                          <span className="block font-extrabold">{p.name}</span>
                          <span className="mt-1 block text-xs text-slate-400">
                            {p.id}{p.price != null ? ` · ${Number(p.price).toLocaleString()}` : ""}
                          </span>
                        </span>
                        <span className="rounded-full border border-white/10 px-2.5 py-1 text-xs">Coupons</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <div className="rounded-xl border border-white/10 bg-[#0c162c40]">
          {selected ? (
            <>
              <div className="border-b border-white/10 px-4 py-2 text-xs text-slate-300">
                {selected.name} · {LABELS[selected.location || ""] || selected.location}
              </div>
              <ProductCouponConfigPanel
                key={`${selected.location}:${selected.ref}`}
                target={selected}
                requireAuth={requireAuth}
                handleAuthError={handleAuthError}
                toast={toast}
              />
            </>
          ) : (
            <p className="p-4 text-xs text-slate-400">Select a GHL product to configure its coupons.</p>
          )}
        </div>
      </div>
    </section>
  );
}
