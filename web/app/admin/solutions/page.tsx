"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { AdminTopbar } from "@/components/AdminTopbar";
import { Toast } from "@/components/Toast";
import { apiFetch } from "@/lib/api";
import { useAdminAuth } from "@/lib/useAdminAuth";
import { useToast } from "@/lib/useToast";

type Transaction = {
  id: string;
  type: "academy_product" | "clockistry_subscription" | "ghl_order";
  transactionId: string;
  customerEmail: string;
  customerName: string;
  companyId?: string;
  productId?: string;
  productName?: string;
  plan?: string;
  userCount?: number;
  amount?: number;
  currency?: string;
  promoCode?: string;
  status: string;
  isTest?: boolean;
  ghlLocationId?: string;
  ghlLocationKey?: string | null;
  ghlOrderId?: string;
  ghlPaymentStatus?: string;
  raw?: GhlRaw;
  createdAt: string;
  updatedAt: string;
};

type GhlRaw = {
  orderStatus?: string | null;
  paymentStatus?: string | null;
  liveMode?: boolean | null;
  markAsTest?: boolean | null;
  source?: { type?: string | null; name?: string | null };
  subtotal?: number | null;
  discount?: number | null;
  tax?: number | null;
  total?: number | null;
  items?: { name?: string | null; productId?: string | null; quantity?: number | null; price?: number | null }[];
};

type LinkedRedemption = {
  id: string;
  code: string;
  status: string;
  state: "active" | "refunded" | "flagged" | string;
  affiliateEmail: string | null;
  commissionBase: number | null;
  affiliateFeeAmount: number;
  currency: string;
};

const TYPE_LABELS: Record<string, string> = {
  academy_product: "Academy",
  clockistry_subscription: "Clockistry",
  ghl_order: "GHL order",
};

function money(value: number | null | undefined, currency = "PHP") {
  if (value == null) return "-";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(value));
}

function locationLabel(t: Transaction) {
  if (!t.ghlLocationId) return "-";
  return t.ghlLocationKey ? `${t.ghlLocationKey === "global" ? "Global" : "Main"} (${t.ghlLocationId})` : t.ghlLocationId;
}

// Best-known GHL app URL for a location's orders list (the per-order deep link format isn't documented by GHL, so
// the order ID is shown copyable to paste into the orders search).
function ghlOrdersUrl(locationId: string) {
  return `https://app.gohighlevel.com/v2/location/${locationId}/payments/orders`;
}

function pillClasses(status: string) {
  if (status === "paid") return "border-emerald-400/40 text-emerald-200";
  if (status === "initiated" || status === "pending" || status === "partially_refunded") return "border-amber-400/40 text-amber-200";
  return "border-red-400/40 text-red-200";
}

function GhlAudit({ transaction: t, redemption, onCopied }: { transaction: Transaction; redemption: LinkedRedemption | null; onCopied: () => void }) {
  const raw = t.raw || {};
  const cur = t.currency || "USD";
  const orderId = t.ghlOrderId || t.transactionId.replace(/^ghl:/, "");
  const live = raw.liveMode ?? !t.isTest;
  return (
    <div className="grid gap-3 text-xs md:grid-cols-2">
      <div className="space-y-1">
        <div className="font-bold uppercase tracking-wide text-slate-300">GHL order</div>
        <div>
          Order ID: <code className="select-all">{orderId}</code>{" "}
          <button
            className="underline"
            onClick={() => navigator.clipboard?.writeText(orderId).then(onCopied).catch(() => {})}
          >
            Copy
          </button>
        </div>
        <div>
          Location: {locationLabel(t)}
          {t.ghlLocationId && (
            <>
              {" "}
              <a className="underline" href={ghlOrdersUrl(t.ghlLocationId)} target="_blank" rel="noreferrer">
                Open orders in GHL
              </a>{" "}
              <span className="text-slate-500">(search the order ID there)</span>
            </>
          )}
        </div>
        <div>Payment status: {t.ghlPaymentStatus || raw.paymentStatus || "-"} (order: {raw.orderStatus || "-"})</div>
        <div>Mode: {live ? "Live" : "TEST (markAsTest / liveMode=false)"}</div>
        <div>Created in GHL: {new Date(t.createdAt).toLocaleString()}</div>
        <div>Source: {raw.source?.name || "-"} {raw.source?.type ? `(${raw.source.type})` : ""}</div>
        <div>
          Subtotal {money(raw.subtotal, cur)} - discount {money(raw.discount, cur)} + tax {money(raw.tax, cur)} = total paid{" "}
          <b>{money(raw.total ?? t.amount, cur)}</b>
        </div>
        <div>
          Products:
          <ul className="ml-4 list-disc text-slate-300">
            {(raw.items || []).map((item, idx) => (
              <li key={`${item.productId}-${idx}`}>
                {item.name || "(unnamed)"} <span className="text-slate-500">{item.productId}</span>
                {item.price != null ? ` - ${money(item.price, cur)}` : ""}
              </li>
            ))}
            {(raw.items || []).length === 0 && <li>{t.productName || "-"}</li>}
          </ul>
        </div>
      </div>
      <div className="space-y-1">
        <div className="font-bold uppercase tracking-wide text-slate-300">Affiliate credit (coupon_redemptions)</div>
        {t.isTest ? (
          <div className="text-fuchsia-200">Not credited (test mode).</div>
        ) : !t.promoCode ? (
          <div className="text-slate-400">No coupon used - nothing to credit.</div>
        ) : !redemption ? (
          <div className="text-amber-200">Coupon {t.promoCode} used, but no redemption recorded (yet).</div>
        ) : (
          <>
            <div>Coupon: {redemption.code}</div>
            <div>Affiliate credited: {redemption.affiliateEmail || "unassigned"}</div>
            <div>Commission base: {money(redemption.commissionBase, redemption.currency)}</div>
            <div>Affiliate fee: {money(redemption.affiliateFeeAmount, redemption.currency)}</div>
            <div>
              Redemption status: <b>{redemption.state}</b> ({redemption.status})
            </div>
            <div className="text-slate-500">Record: {redemption.id}</div>
          </>
        )}
      </div>
    </div>
  );
}

export default function SolutionsPage() {
  const { ready, admin, requireAuth, handleAuthError, logout } = useAdminAuth();
  const { message, toast } = useToast();

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [modeFilter, setModeFilter] = useState("");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ transaction: Transaction; redemption: LinkedRedemption | null } | null>(null);

  const load = useCallback(async (key: string, type: string, status: string, mode: string) => {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    if (status) params.set("status", status);
    if (mode) params.set("isTest", mode === "test" ? "true" : "false");
    const data = await apiFetch<{ transactions: Transaction[] }>(
      `/api/admin/solutions${params.toString() ? `?${params}` : ""}`,
      key
    );
    setTransactions(data.transactions || []);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const key = requireAuth();
    if (!key) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern
    load(key, typeFilter, statusFilter, modeFilter).catch((e) => { if (!handleAuthError(e)) toast(e.message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requireAuth/load intentionally not deps to avoid refetch loops
  }, [ready, typeFilter, statusFilter, modeFilter]);

  async function handleRefresh() {
    const key = requireAuth();
    if (!key) return;
    try {
      await load(key, typeFilter, statusFilter, modeFilter);
      toast("Refreshed.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function toggleDetail(t: Transaction) {
    if (openId === t.id) {
      setOpenId(null);
      return;
    }
    const key = requireAuth();
    if (!key) return;
    setOpenId(t.id);
    setDetail(null);
    try {
      const data = await apiFetch<{ transaction: Transaction; redemption?: LinkedRedemption | null }>(
        `/api/admin/solutions/${encodeURIComponent(t.transactionId)}`,
        key
      );
      setDetail({ transaction: data.transaction, redemption: data.redemption ?? null });
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  const filtered = transactions.filter((t) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return `${t.customerName} ${t.customerEmail} ${t.companyId || ""} ${t.productName || ""} ${t.transactionId} ${t.promoCode || ""}`
      .toLowerCase()
      .includes(q);
  });

  return (
    <div className="flex flex-1 flex-col">
      <AdminTopbar
        title="Nexistry Backend"
        subtitle="Digital Solutions Tracker"
        adminEmail={admin?.email}
        onRefresh={handleRefresh}
        onLogout={logout}
      />
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-5">
        <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">Transactions</h2>
            <div className="flex flex-wrap gap-2">
              <select className="input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                <option value="">All types</option>
                <option value="academy_product">Academy Product</option>
                <option value="clockistry_subscription">Clockistry Subscription</option>
                <option value="ghl_order">GHL Order</option>
              </select>
              <select className="input" value={modeFilter} onChange={(e) => setModeFilter(e.target.value)}>
                <option value="">Live + test</option>
                <option value="live">Live only</option>
                <option value="test">Test only</option>
              </select>
              <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">All statuses</option>
                <option value="initiated">Initiated</option>
                <option value="paid">Paid</option>
                <option value="failed">Failed</option>
                <option value="pending">Pending</option>
                <option value="refunded">Refunded</option>
                <option value="partially_refunded">Partially refunded</option>
              </select>
              <input
                className="input"
                placeholder="Search name, email, company, transaction ID…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <div className="border-b border-white/10 p-3.5 text-xs text-slate-400">
            Local ledger of every checkout this backend has created since this tracker was deployed, plus every native
            GHL order (live and test mode, imported every 10 minutes). Test orders are excluded from revenue totals.
          </div>
          <div className="overflow-x-auto p-3.5">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
                  <th className="p-2">Status</th>
                  <th className="p-2">Type</th>
                  <th className="p-2">Transaction ID</th>
                  <th className="p-2">Customer</th>
                  <th className="p-2">Company/Product</th>
                  <th className="p-2">Amount</th>
                  <th className="p-2">Created</th>
                  <th className="p-2">Updated</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={9} className="p-2 text-slate-400">No transactions.</td></tr>
                )}
                {filtered.map((t) => (
                  <Fragment key={t.id}>
                    <tr className="border-t border-white/10 hover:bg-white/[.03]">
                      <td className="p-2">
                        <span className={`rounded-full border px-2 py-0.5 ${pillClasses(t.status)}`}>{t.status}</span>
                        {t.isTest && (
                          <span className="ml-1 rounded-full border border-fuchsia-400/50 px-2 py-0.5 font-bold text-fuchsia-200">TEST</span>
                        )}
                      </td>
                      <td className="p-2">
                        {TYPE_LABELS[t.type] || t.type}
                        {t.type === "ghl_order" && (
                          <>
                            <br />
                            <span className="text-slate-400">{locationLabel(t)}</span>
                          </>
                        )}
                      </td>
                      <td className="p-2">{t.transactionId}</td>
                      <td className="p-2">
                        {t.customerName}
                        <br />
                        <span className="text-slate-400">{t.customerEmail}</span>
                      </td>
                      <td className="p-2">
                        {t.type === "clockistry_subscription" ? (
                          <>
                            {t.companyId}
                            <br />
                            <span className="text-slate-400">{t.plan} × {t.userCount}</span>
                          </>
                        ) : (
                          <>
                            {t.productName}
                            <br />
                            <span className="text-slate-400">{t.productId}</span>
                          </>
                        )}
                        {t.promoCode && (
                          <>
                            <br />
                            <span className="text-emerald-300">Promo: {t.promoCode}</span>
                          </>
                        )}
                      </td>
                      <td className="p-2">{t.amount != null ? money(t.amount, t.currency || "PHP") : "-"}</td>
                      <td className="p-2">{new Date(t.createdAt).toLocaleString()}</td>
                      <td className="p-2">{new Date(t.updatedAt).toLocaleString()}</td>
                      <td className="p-2">
                        {t.type === "ghl_order" && (
                          <button className="underline" onClick={() => toggleDetail(t)}>
                            {openId === t.id ? "Hide" : "Audit"}
                          </button>
                        )}
                      </td>
                    </tr>
                    {openId === t.id && (
                      <tr className="border-t border-white/10 bg-white/[.02]">
                        <td colSpan={9} className="p-3">
                          {detail && detail.transaction.id === t.id ? (
                            <GhlAudit transaction={detail.transaction} redemption={detail.redemption} onCopied={() => toast("Order ID copied.")} />
                          ) : (
                            <span className="text-slate-400">Loading…</span>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
      <Toast message={message} />
    </div>
  );
}
