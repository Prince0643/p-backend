"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminTopbar } from "@/components/AdminTopbar";
import { Toast } from "@/components/Toast";
import { apiFetch } from "@/lib/api";
import { useAdminAuth } from "@/lib/useAdminAuth";
import { useToast } from "@/lib/useToast";

type AdminAccount = {
  id: string;
  email: string;
  createdAt: string;
  revokedAt: string | null;
  active: boolean;
};

export default function AdminsPage() {
  const { ready, admin, requireAuth, handleAuthError, logout } = useAdminAuth();
  const { message, toast } = useToast();

  const [admins, setAdmins] = useState<AdminAccount[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);

  const loadAdmins = useCallback(async (key: string) => {
    const data = await apiFetch<{ admins: AdminAccount[] }>("/api/admin/admins", key);
    setAdmins(data.admins || []);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const key = requireAuth();
    if (!key) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern
    loadAdmins(key).catch((e) => { if (!handleAuthError(e)) toast(e.message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requireAuth/loadAdmins intentionally not deps to avoid refetch loops
  }, [ready]);

  async function handleRefresh() {
    const key = requireAuth();
    if (!key) return;
    try {
      await loadAdmins(key);
      toast("Refreshed.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function handleCreate() {
    if (!email.trim() || password.length < 8) {
      toast("Email and an 8+ character password are required.");
      return;
    }
    const key = requireAuth();
    if (!key) return;
    setCreating(true);
    try {
      await apiFetch("/api/admin/admins", key, { method: "POST", body: { email, password } });
      toast(`Admin account created for ${email}.`);
      setEmail("");
      setPassword("");
      await loadAdmins(key);
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string, targetEmail: string) {
    if (!confirm(`Revoke admin account "${targetEmail}"? They will be logged out and unable to log back in.`)) return;
    const key = requireAuth();
    if (!key) return;
    try {
      await apiFetch(`/api/admin/admins/${encodeURIComponent(id)}`, key, { method: "DELETE" });
      toast("Revoked.");
      await loadAdmins(key);
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <AdminTopbar
        title="Nexistry Backend"
        subtitle="Admin Access"
        adminEmail={admin?.email}
        onRefresh={handleRefresh}
        onLogout={logout}
      />
      <main className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-4 px-5 py-5 lg:grid-cols-[1.2fr_1fr]">
        <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[.02] p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">Admin Accounts</h2>
          </div>
          <div className="flex max-h-[70vh] flex-col gap-2.5 overflow-y-auto p-2.5">
            {admins.length === 0 && (
              <div className="rounded-xl border border-white/10 bg-[#0c162c8c] p-3">
                <div className="font-extrabold">No admin accounts yet</div>
                <div className="mt-1 text-xs text-slate-400">
                  Whoever holds the server&apos;s master key can create the first one here.
                </div>
              </div>
            )}
            {admins.map((a) => (
              <div
                key={a.id}
                className="flex items-start justify-between gap-2.5 rounded-xl border border-white/10 bg-[#0c162c8c] p-3"
              >
                <div>
                  <div className="font-extrabold">{a.email}</div>
                  <div className="mt-1 text-xs text-slate-400">
                    Created {new Date(a.createdAt).toLocaleString()}
                    {!a.active && a.revokedAt && (
                      <>
                        <br />
                        Revoked {new Date(a.revokedAt).toLocaleString()}
                      </>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span
                    className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-xs ${
                      a.active ? "border-emerald-400/40 text-emerald-200" : "border-red-400/40 text-red-200"
                    }`}
                  >
                    {a.active ? "active" : "revoked"}
                  </span>
                  {a.active && (
                    <button
                      onClick={() => handleRevoke(a.id, a.email)}
                      className="rounded-lg border border-red-400/30 bg-red-400/10 px-2.5 py-1 text-xs font-bold text-red-200 hover:bg-red-400/20"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <div className="border-b border-white/10 bg-white/[.02] p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">New Admin</h2>
          </div>
          <div className="space-y-3 p-4">
            <label className="block text-sm font-semibold" htmlFor="new-admin-email">
              Email
            </label>
            <input
              id="new-admin-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="new-admin@example.com"
              className="w-full rounded-lg border border-white/10 bg-[#0b1424] px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500"
            />
            <label className="block text-sm font-semibold" htmlFor="new-admin-password">
              Password
            </label>
            <input
              id="new-admin-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="At least 8 characters"
              className="w-full rounded-lg border border-white/10 bg-[#0b1424] px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500"
            />
            <p className="text-xs text-slate-400">
              They can log in with this email/password right away. Anyone with an admin account gets the same full
              access as any other admin - there are no permission levels.
            </p>
            <button
              onClick={handleCreate}
              disabled={creating || !email.trim() || password.length < 8}
              className="w-full rounded-lg bg-gradient-to-b from-blue-400 to-blue-500 px-3 py-2 text-sm font-extrabold text-slate-950 disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create Admin Account"}
            </button>
          </div>
        </section>
      </main>
      <Toast message={message} />
    </div>
  );
}
