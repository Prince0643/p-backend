"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminTopbar } from "@/components/AdminTopbar";
import { Toast } from "@/components/Toast";
import { apiFetch } from "@/lib/api";
import { useAdminAuth } from "@/lib/useAdminAuth";
import { useToast } from "@/lib/useToast";

type Product = {
  id: string;
  name: string;
  amountPhp: number;
  billing: { type: string; interval?: string };
};

type Coupon = {
  code: string;
  discountPercent: number;
  affiliateFeePercent: number;
  affiliateEmail: string;
  active: boolean;
  maxRedemptions: number | null;
};

type Affiliate = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  couponCode: string;
  status: "active" | "suspended" | "terminated";
  createdAt: string;
};

type Redemption = {
  id: string;
  code: string;
  productId: string;
  email: string;
  fullName: string;
  baseAmount: number;
  discountAmount: number;
  affiliateFeeAmount: number;
  affiliateEmail: string;
  currency: string;
  status: "pending" | "paid" | "released";
  createdAt: string;
  paidAt: string | null;
};

type SolutionTransaction = {
  id: string;
  type: string;
  productName?: string;
  amount: number;
  status: string;
  createdAt: string;
};

type DashboardData = {
  products: Product[];
  coupons: Coupon[];
  affiliates: Affiliate[];
  redemptions: Redemption[];
  transactions: SolutionTransaction[];
};

const emptyData: DashboardData = {
  products: [],
  coupons: [],
  affiliates: [],
  redemptions: [],
  transactions: [],
};

const INITIAL_NOW_MS = Date.now();

function money(value: number, currency = "PHP") {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

function shortDate(value: string | null) {
  if (!value) return "Not paid";
  return new Intl.DateTimeFormat("en-PH", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function phtLocalToUtcMs(date: Date) {
  return Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours() - 8,
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  );
}

function getCommissionPeriod(now = new Date()) {
  const phtNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Manila" }));
  const saturday = 6;
  const resetHour = 19;

  const currentWeekReset = new Date(phtNow);
  let daysSinceSaturday = phtNow.getDay() - saturday;
  if (daysSinceSaturday < 0) daysSinceSaturday += 7;
  currentWeekReset.setDate(phtNow.getDate() - daysSinceSaturday);
  currentWeekReset.setHours(resetHour, 0, 0, 0);

  const periodStart = new Date(currentWeekReset);
  if (phtNow < currentWeekReset) {
    periodStart.setDate(currentWeekReset.getDate() - 7);
  }

  const periodEnd = new Date(periodStart);
  periodEnd.setDate(periodStart.getDate() + 7);

  return {
    periodStartMs: phtLocalToUtcMs(periodStart),
    periodEndMs: phtLocalToUtcMs(periodEnd),
    startLabel: periodStart.toLocaleDateString("en-PH", { month: "short", day: "numeric" }),
    endLabel: periodEnd.toLocaleDateString("en-PH", { weekday: "long", month: "short", day: "numeric" }),
  };
}

function getNextPayout(now = new Date()) {
  const phtNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Manila" }));
  const next = new Date(phtNow);
  next.setHours(19, 0, 0, 0);
  const saturday = 6;
  let daysUntil = saturday - phtNow.getDay();
  if (daysUntil < 0 || (daysUntil === 0 && phtNow >= next)) daysUntil += 7;
  next.setDate(phtNow.getDate() + daysUntil);
  const diff = Math.max(0, next.getTime() - phtNow.getTime());
  const period = getCommissionPeriod(now);
  return {
    label: next.toLocaleDateString("en-PH", { weekday: "long", month: "short", day: "numeric" }),
    days: Math.floor(diff / 86400000),
    hours: Math.floor((diff % 86400000) / 3600000),
    minutes: Math.floor((diff % 3600000) / 60000),
    seconds: Math.floor((diff % 60000) / 1000),
    phtTime: phtNow.toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    periodStartMs: period.periodStartMs,
    periodEndMs: period.periodEndMs,
    periodLabel: `${period.startLabel} - ${period.endLabel}`,
  };
}

function statusClass(status: string) {
  if (status === "active" || status === "paid" || status === "completed") return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
  if (status === "pending") return "border-amber-300/30 bg-amber-300/10 text-amber-100";
  if (status === "released" || status === "suspended") return "border-sky-300/30 bg-sky-300/10 text-sky-100";
  return "border-red-300/30 bg-red-300/10 text-red-100";
}

export default function AdminDashboardPage() {
  const { ready, admin, requireAuth, handleAuthError, logout } = useAdminAuth();
  const { message, toast } = useToast();
  const [data, setData] = useState<DashboardData>(emptyData);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [clock, setClock] = useState(() => getNextPayout());
  const [nowMs, setNowMs] = useState(INITIAL_NOW_MS);

  const loadDashboard = useCallback(
    async (key: string) => {
      setLoading(true);
      try {
        const [productsRes, couponsRes, affiliatesRes, redemptionsRes, solutionsRes] = await Promise.all([
          apiFetch<{ products: Product[] }>("/api/admin/products", key),
          apiFetch<{ coupons: Coupon[] }>("/api/admin/coupons", key),
          apiFetch<{ affiliates: Affiliate[] }>("/api/admin/affiliates", key),
          apiFetch<{ redemptions: Redemption[] }>("/api/admin/coupons/redemptions", key),
          apiFetch<{ transactions: SolutionTransaction[] }>("/api/admin/solutions", key),
        ]);
        setData({
          products: productsRes.products || [],
          coupons: couponsRes.coupons || [],
          affiliates: affiliatesRes.affiliates || [],
          redemptions: redemptionsRes.redemptions || [],
          transactions: solutionsRes.transactions || [],
        });
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    const id = window.setInterval(() => {
      setClock(getNextPayout());
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const key = requireAuth();
    if (!key) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-auth-ready matches the existing admin pages.
    loadDashboard(key).catch((e) => { if (!handleAuthError(e)) toast(e.message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- auth helpers intentionally omitted to avoid refetch loops
  }, [ready, loadDashboard]);

  async function handleRefresh() {
    const key = requireAuth();
    if (!key) return;
    try {
      await loadDashboard(key);
      toast("Dashboard refreshed.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  const stats = useMemo(() => {
    const period = getCommissionPeriod(new Date(nowMs));
    const paid = data.redemptions.filter((r) => r.status === "paid");
    const weeklyPaid = paid.filter((r) => {
      const paidMs = new Date(r.paidAt || r.createdAt).getTime();
      return paidMs >= period.periodStartMs && paidMs < period.periodEndMs;
    });
    const pending = data.redemptions.filter((r) => r.status === "pending");
    const activeAffiliates = data.affiliates.filter((a) => a.status === "active");
    const activeCoupons = data.coupons.filter((c) => c.active);
    const weeklyRevenue = weeklyPaid.reduce((sum, r) => sum + Number(r.baseAmount || 0), 0);
    const weeklyCommission = weeklyPaid.reduce((sum, r) => sum + Number(r.affiliateFeeAmount || 0), 0);
    const totalCommission = paid.reduce((sum, r) => sum + Number(r.affiliateFeeAmount || 0), 0);
    const solutionRevenue = data.transactions
      .filter((t) => t.status === "completed" || t.status === "paid")
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);

    return {
      activeAffiliates: activeAffiliates.length,
      activeCoupons: activeCoupons.length,
      weeklySales: weeklyPaid.length,
      weeklyRevenue,
      weeklyCommission,
      totalCommission,
      pendingHolds: pending.length,
      solutionRevenue,
    };
  }, [data, nowMs]);

  const affiliateRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const period = getCommissionPeriod(new Date(nowMs));
    return data.affiliates
      .map((affiliate) => {
        const redemptions = data.redemptions.filter(
          (r) => r.affiliateEmail === affiliate.email || r.code === affiliate.couponCode
        );
        const paid = redemptions.filter((r) => {
          const paidMs = new Date(r.paidAt || r.createdAt).getTime();
          return r.status === "paid" && paidMs >= period.periodStartMs && paidMs < period.periodEndMs;
        });
        return {
          ...affiliate,
          redemptions: redemptions.length,
          paidRedemptions: paid.length,
          revenue: paid.reduce((sum, r) => sum + Number(r.baseAmount || 0), 0),
          commission: paid.reduce((sum, r) => sum + Number(r.affiliateFeeAmount || 0), 0),
        };
      })
      .filter((row) => {
        if (!q) return true;
        return `${row.firstName} ${row.lastName} ${row.email} ${row.couponCode} ${row.id}`.toLowerCase().includes(q);
      })
      .sort((a, b) => b.commission - a.commission || b.paidRedemptions - a.paidRedemptions);
  }, [data.affiliates, data.redemptions, search, nowMs]);

  const recentRedemptions = useMemo(
    () => [...data.redemptions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 8),
    [data.redemptions]
  );

  return (
    <div className="flex flex-1 flex-col">
      <AdminTopbar
        title="Nexistry Core"
        subtitle="Admin Dashboard"
        adminEmail={admin?.email}
        onRefresh={handleRefresh}
        onLogout={logout}
      />
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 px-5 py-5">
        <section className="grid gap-4 lg:grid-cols-[1.15fr_.85fr]">
          <div className="rounded-2xl border border-white/10 bg-white/[.035] p-5 shadow-2xl">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">Live tracking</div>
                <h1 className="mt-2 text-2xl font-extrabold text-white sm:text-3xl">Commission and affiliate control</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
                  Current PHT commission week, paid coupon redemptions, active affiliate status, and product coverage across the backend.
                </p>
              </div>
              <div className="flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-xs font-bold text-emerald-200">
                <span className="h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_16px_rgba(110,231,183,.9)]" />
                LIVE
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Weekly sales" value={String(stats.weeklySales)} detail={`${money(stats.weeklyRevenue)} revenue`} />
              <Metric label="Weekly commission" value={money(stats.weeklyCommission)} detail={`${money(stats.totalCommission)} all time`} />
              <Metric label="Active affiliates" value={String(stats.activeAffiliates)} detail={`${data.affiliates.length} total registered`} />
              <Metric label="Active coupons" value={String(stats.activeCoupons)} detail={`${stats.pendingHolds} pending holds`} />
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#09111fe6] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs font-bold uppercase tracking-[0.18em] text-slate-400">Next payout</div>
                <div className="mt-2 text-xl font-extrabold text-white">{clock.label}</div>
                <p className="mt-1 text-sm text-slate-400">Saturday 7:00 PM PHT. Current PHT: {clock.phtTime}</p>
                <p className="mt-1 text-xs text-slate-500">Current commission period: {clock.periodLabel}</p>
              </div>
              <button
                onClick={handleRefresh}
                disabled={loading}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold text-slate-100 hover:bg-white/10 disabled:opacity-50"
              >
                {loading ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            <div className="mt-5 grid grid-cols-4 gap-2">
              <CountdownUnit label="Days" value={clock.days} />
              <CountdownUnit label="Hours" value={clock.hours} />
              <CountdownUnit label="Mins" value={clock.minutes} />
              <CountdownUnit label="Secs" value={clock.seconds} />
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 border-t border-white/10 pt-4 text-sm">
              <div>
                <div className="text-slate-400">Products</div>
                <div className="mt-1 text-lg font-extrabold">{data.products.length}</div>
              </div>
              <div>
                <div className="text-slate-400">Solution revenue</div>
                <div className="mt-1 text-lg font-extrabold">{money(stats.solutionRevenue)}</div>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-[1fr_.8fr]">
          <div className="rounded-2xl border border-white/10 bg-white/[.035] shadow-2xl">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 p-4">
              <div>
                <h2 className="text-sm font-extrabold uppercase tracking-wide text-slate-100">Affiliate performance</h2>
                <p className="mt-1 text-xs text-slate-400">Search by name, email, affiliate ID, or coupon code.</p>
              </div>
              <input
                className="input max-w-xs"
                placeholder="Search affiliates..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[780px] text-left text-sm">
                <thead className="border-b border-white/10 bg-white/[.025] text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="p-3">Affiliate</th>
                    <th className="p-3">Coupon</th>
                    <th className="p-3">Status</th>
                    <th className="p-3 text-right">Sales</th>
                    <th className="p-3 text-right">Revenue</th>
                    <th className="p-3 text-right">Commission</th>
                  </tr>
                </thead>
                <tbody>
                  {affiliateRows.map((row) => (
                    <tr key={row.id} className="border-b border-white/5 hover:bg-white/[.035]">
                      <td className="p-3">
                        <div className="font-bold text-slate-100">{row.firstName} {row.lastName}</div>
                        <div className="text-xs text-slate-400">{row.email}</div>
                      </td>
                      <td className="p-3 font-mono text-blue-200">{row.couponCode}</td>
                      <td className="p-3">
                        <span className={`rounded-full border px-2.5 py-1 text-xs font-bold uppercase ${statusClass(row.status)}`}>
                          {row.status}
                        </span>
                      </td>
                      <td className="p-3 text-right font-bold">{row.paidRedemptions}</td>
                      <td className="p-3 text-right">{money(row.revenue)}</td>
                      <td className="p-3 text-right font-extrabold text-emerald-200">{money(row.commission)}</td>
                    </tr>
                  ))}
                  {affiliateRows.length === 0 && (
                    <tr>
                      <td className="p-6 text-center text-slate-400" colSpan={6}>No affiliates match the current search.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[.035] shadow-2xl">
            <div className="border-b border-white/10 p-4">
              <h2 className="text-sm font-extrabold uppercase tracking-wide text-slate-100">Recent redemptions</h2>
              <p className="mt-1 text-xs text-slate-400">Newest coupon reservations and paid transactions.</p>
            </div>
            <div className="divide-y divide-white/10">
              {recentRedemptions.map((r) => (
                <div key={r.id} className="grid grid-cols-[1fr_auto] gap-3 p-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-bold text-blue-200">{r.code}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${statusClass(r.status)}`}>
                        {r.status}
                      </span>
                    </div>
                    <div className="mt-1 text-sm text-slate-200">{r.fullName || r.email || "Unknown customer"}</div>
                    <div className="mt-1 text-xs text-slate-400">{r.productId || "Any product"} · {shortDate(r.paidAt || r.createdAt)}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-extrabold text-white">{money(r.baseAmount, r.currency)}</div>
                    <div className="text-xs text-emerald-200">{money(r.affiliateFeeAmount, r.currency)} fee</div>
                  </div>
                </div>
              ))}
              {recentRedemptions.length === 0 && (
                <div className="p-6 text-center text-sm text-slate-400">No redemptions recorded yet.</div>
              )}
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-4">
          <QuickLink href="/admin/products" label="Products" value={`${data.products.length} catalog items`} />
          <QuickLink href="/admin/coupons" label="Coupons" value={`${data.coupons.length} total codes`} />
          <QuickLink href="/admin/affiliates" label="Affiliates" value={`${stats.activeAffiliates} active`} />
          <QuickLink href="/admin/solutions" label="Solutions" value={money(stats.solutionRevenue)} />
        </section>
      </main>
      <Toast message={message} />
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#08101ee6] p-4">
      <div className="text-xs font-bold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-2 text-2xl font-extrabold text-white">{value}</div>
      <div className="mt-1 text-xs text-slate-400">{detail}</div>
    </div>
  );
}

function CountdownUnit({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-blue-300/20 bg-blue-300/10 p-3 text-center">
      <div className="text-xl font-extrabold text-white">{String(value).padStart(2, "0")}</div>
      <div className="mt-1 text-[10px] font-bold uppercase tracking-wide text-blue-100">{label}</div>
    </div>
  );
}

function QuickLink({ href, label, value }: { href: string; label: string; value: string }) {
  return (
    <Link href={href} className="rounded-2xl border border-white/10 bg-white/[.035] p-4 shadow-2xl hover:bg-white/[.06]">
      <div className="text-xs font-bold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-2 text-lg font-extrabold text-white">{value}</div>
    </Link>
  );
}
