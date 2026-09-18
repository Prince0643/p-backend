"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminTopbar } from "@/components/AdminTopbar";
import { Toast } from "@/components/Toast";
import { apiFetch } from "@/lib/api";
import { useAdminAuth } from "@/lib/useAdminAuth";
import { useToast } from "@/lib/useToast";

type Transaction = {
  id: string;
  type: "academy_product" | "clockistry_subscription";
  transactionId: string;
  customerEmail: string;
  customerName: string;
  companyId?: string;
  productId?: string;
  productName?: string;
  plan?: string;
  userCount?: number;
  amount?: number;
  status: "initiated" | "paid" | "failed";
  createdAt: string;
  updatedAt: string;
};

function pillClasses(status: string) {
  if (status === "paid") return "border-emerald-400/40 text-emerald-200";
  if (status === "initiated") return "border-amber-400/40 text-amber-200";
  return "border-red-400/40 text-red-200";
}

export default function SolutionsPage() {
  const { ready, admin, requireAuth, handleAuthError, logout } = useAdminAuth();
  const { message, toast } = useToast();

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(async (key: string, type: string, status: string) => {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    if (status) params.set("status", status);
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
    load(key, typeFilter, statusFilter).catch((e) => { if (!handleAuthError(e)) toast(e.message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requireAuth/load intentionally not deps to avoid refetch loops
  }, [ready, typeFilter, statusFilter]);

  async function handleRefresh() {
    const key = requireAuth();
    if (!key) return;
    try {
      await load(key, typeFilter, statusFilter);
      toast("Refreshed.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  const filtered = transactions.filter((t) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return `${t.customerName} ${t.customerEmail} ${t.companyId || ""} ${t.productName || ""} ${t.transactionId}`
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
              </select>
              <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">All statuses</option>
                <option value="initiated">Initiated</option>
                <option value="paid">Paid</option>
                <option value="failed">Failed</option>
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
            Local ledger of every checkout this backend has created since this tracker was deployed. Does not include
            historical transactions from before this feature existed.
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
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={8} className="p-2 text-slate-400">No transactions.</td></tr>
                )}
                {filtered.map((t) => (
                  <tr key={t.id} className="border-t border-white/10 hover:bg-white/[.03]">
                    <td className="p-2">
                      <span className={`rounded-full border px-2 py-0.5 ${pillClasses(t.status)}`}>{t.status}</span>
                    </td>
                    <td className="p-2">{t.type === "clockistry_subscription" ? "Clockistry" : "Academy"}</td>
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
                    </td>
                    <td className="p-2">{t.amount != null ? `₱${Number(t.amount).toLocaleString()}` : "-"}</td>
                    <td className="p-2">{new Date(t.createdAt).toLocaleString()}</td>
                    <td className="p-2">{new Date(t.updatedAt).toLocaleString()}</td>
                  </tr>
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
