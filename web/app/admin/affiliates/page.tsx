"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminTopbar } from "@/components/AdminTopbar";
import { Toast } from "@/components/Toast";
import { apiFetch } from "@/lib/api";
import { useAdminAuth } from "@/lib/useAdminAuth";
import { useToast } from "@/lib/useToast";

type Affiliate = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  contactNumber: string;
  socials: Record<string, string>;
  paymentRegion: "PH" | "GLOBAL";
  preferredBank: string;
  payoutDetails: Record<string, string>;
  termsAccepted: boolean;
  termsVersion: string;
  couponCode: string;
  status: "active" | "suspended" | "terminated";
  createdAt: string;
};

type Coupon = {
  code: string;
  active: boolean;
  discountPercent: number;
  affiliateFeePercent: number;
  maxRedemptions: number | null;
};

const STATUSES = ["active", "suspended", "terminated"] as const;

function pillClasses(status: string) {
  if (status === "active") return "border-emerald-400/40 text-emerald-200";
  if (status === "suspended") return "border-amber-400/40 text-amber-200";
  return "border-red-400/40 text-red-200";
}

function renderPayout(a: Affiliate) {
  const d = a.payoutDetails || {};
  if (a.paymentRegion === "PH") {
    if (a.preferredBank === "GCASH" || a.preferredBank === "MAYA") {
      return (
        <>
          {a.preferredBank}
          <br />
          {d.accountHolderName}
          <br />
          {d.mobileNumber}
        </>
      );
    }
    return (
      <>
        {d.bankName || a.preferredBank}
        <br />
        {d.accountName}
        <br />
        Acct: {d.accountNumber}
        <br />
        Branch: {d.bankBranch}
      </>
    );
  }
  return (
    <>
      {a.preferredBank}
      <br />
      {d.accountName}
      <br />
      {d.accountEmail}
    </>
  );
}

export default function AffiliatesPage() {
  const { ready, admin, requireAuth, handleAuthError, logout } = useAdminAuth();
  const { message, toast } = useToast();

  const [affiliates, setAffiliates] = useState<Affiliate[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Affiliate | null>(null);
  const [coupon, setCoupon] = useState<Coupon | null>(null);
  const [statusChoice, setStatusChoice] = useState<string>("active");

  const loadAffiliates = useCallback(async (key: string) => {
    const data = await apiFetch<{ affiliates: Affiliate[] }>("/api/admin/affiliates", key);
    setAffiliates(data.affiliates || []);
  }, []);

  const loadDetail = useCallback(async (key: string, id: string) => {
    const data = await apiFetch<{ affiliate: Affiliate; coupon: Coupon | null }>(
      `/api/admin/affiliates/${encodeURIComponent(id)}`,
      key
    );
    setDetail(data.affiliate);
    setCoupon(data.coupon);
    setStatusChoice(data.affiliate.status);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const key = requireAuth();
    if (!key) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern
    loadAffiliates(key).catch((e) => { if (!handleAuthError(e)) toast(e.message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requireAuth/loadAffiliates intentionally not deps to avoid refetch loops
  }, [ready]);

  async function selectAffiliate(id: string) {
    setSelectedId(id);
    const key = requireAuth();
    if (!key) return;
    try {
      await loadDetail(key, id);
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function handleRefresh() {
    const key = requireAuth();
    if (!key) return;
    try {
      await loadAffiliates(key);
      if (selectedId) await loadDetail(key, selectedId);
      toast("Refreshed.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function handleUpdateStatus() {
    if (!selectedId) return;
    const verb = statusChoice !== "active" ? "Their coupon will be deactivated." : "Their coupon will be reactivated (if not already used up).";
    if (!confirm(`Set this affiliate's status to "${statusChoice}"? ${verb}`)) return;
    const key = requireAuth();
    if (!key) return;
    try {
      await apiFetch(`/api/admin/affiliates/${encodeURIComponent(selectedId)}/status`, key, {
        method: "PATCH",
        body: { status: statusChoice },
      });
      toast("Status updated.");
      await loadAffiliates(key);
      await loadDetail(key, selectedId);
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  const filtered = affiliates.filter((a) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return `${a.firstName} ${a.lastName} ${a.email} ${a.couponCode}`.toLowerCase().includes(q);
  });

  return (
    <div className="flex flex-1 flex-col">
      <AdminTopbar
        title="Nexistry Backend"
        subtitle="Affiliate Registrations"
        adminEmail={admin?.email}
        onRefresh={handleRefresh}
        onLogout={logout}
      />
      <main className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-4 px-5 py-5 lg:grid-cols-[1fr_1.2fr]">
        <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">Affiliates</h2>
            <input
              className="rounded-lg border border-white/10 bg-[#0c162ce6] px-3 py-2 text-sm outline-none focus:border-blue-400"
              placeholder="Search name, email, coupon…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex max-h-[70vh] flex-col gap-2.5 overflow-y-auto p-2.5">
            {filtered.length === 0 && (
              <div className="rounded-xl border border-white/10 bg-[#0c162c8c] p-3">
                <div className="font-extrabold">No affiliates</div>
                <div className="mt-1 text-xs text-slate-400">Registrations will appear here.</div>
              </div>
            )}
            {filtered.map((a) => (
              <div
                key={a.id}
                onClick={() => selectAffiliate(a.id)}
                className={`flex cursor-pointer items-start justify-between gap-2.5 rounded-xl border p-3 hover:border-blue-400/40 ${
                  selectedId === a.id ? "border-blue-400 bg-blue-400/10" : "border-white/10 bg-[#0c162c8c]"
                }`}
              >
                <div>
                  <div className="font-extrabold">
                    {a.firstName} {a.lastName}
                  </div>
                  <div className="mt-1 text-xs text-slate-400">
                    {a.email} · {a.paymentRegion} · <span className="font-mono">{a.couponCode}</span>
                  </div>
                </div>
                <div className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-xs ${pillClasses(a.status)}`}>{a.status}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">
              {detail ? `${detail.firstName} ${detail.lastName}` : "Select an affiliate"}
            </h2>
            {detail && (
              <div className="flex gap-2">
                <select className="input" value={statusChoice} onChange={(e) => setStatusChoice(e.target.value)}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <button onClick={handleUpdateStatus} className="rounded-lg bg-gradient-to-b from-blue-400 to-blue-500 px-3 py-2 text-sm font-extrabold text-slate-950">
                  Update Status
                </button>
              </div>
            )}
          </div>

          {!detail ? (
            <div className="p-10 text-center text-sm text-slate-400">
              Click an affiliate on the left to view their registration details, payout info, and coupon.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
              <DetailCard label="Contact">
                {detail.email}
                <br />
                {detail.contactNumber}
              </DetailCard>
              <DetailCard label="Socials">
                {Object.entries(detail.socials || {}).filter(([, v]) => v).length === 0
                  ? <span className="text-slate-400">None provided</span>
                  : Object.entries(detail.socials || {}).filter(([, v]) => v).map(([k, v]) => (
                      <div key={k}>{k}: {v}</div>
                    ))}
              </DetailCard>
              <DetailCard label={`Payout (${detail.paymentRegion})`}>{renderPayout(detail)}</DetailCard>
              <DetailCard label="Coupon">
                <span className="font-mono">{detail.couponCode}</span>
                <br />
                {coupon
                  ? `${coupon.active ? "Active" : "Inactive"} · ${coupon.discountPercent * 100}% off / ${coupon.affiliateFeePercent * 100}% fee${coupon.maxRedemptions ? ` · limit ${coupon.maxRedemptions}` : ""}`
                  : "Coupon record not found"}
                <br />
                <a href="/admin/coupons" target="_blank" className="text-blue-400 underline">
                  Manage in Coupons →
                </a>
              </DetailCard>
              <DetailCard label="Registered">{new Date(detail.createdAt).toLocaleString()}</DetailCard>
              <DetailCard label="Terms accepted">
                {detail.termsAccepted ? `Yes${detail.termsVersion ? ` (v${detail.termsVersion})` : ""}` : "No"}
              </DetailCard>
            </div>
          )}
        </section>
      </main>
      <Toast message={message} />
    </div>
  );
}

function DetailCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0c162c66] p-3">
      <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-sm leading-relaxed break-words">{children}</div>
    </div>
  );
}
