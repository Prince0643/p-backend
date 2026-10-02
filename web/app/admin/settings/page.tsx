"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminTopbar } from "@/components/AdminTopbar";
import { Toast } from "@/components/Toast";
import { apiFetch } from "@/lib/api";
import { useAdminAuth } from "@/lib/useAdminAuth";
import { useToast } from "@/lib/useToast";

type LegalSettings = { termsUrl: string | null; privacyUrl: string | null };

export default function SettingsPage() {
  const { ready, admin, requireAuth, handleAuthError, logout } = useAdminAuth();
  const { message, toast } = useToast();

  const [termsUrl, setTermsUrl] = useState("");
  const [privacyUrl, setPrivacyUrl] = useState("");

  const load = useCallback(async (key: string) => {
    const data = await apiFetch<{ settings: LegalSettings }>("/api/admin/settings", key);
    setTermsUrl(data.settings.termsUrl || "");
    setPrivacyUrl(data.settings.privacyUrl || "");
  }, []);

  useEffect(() => {
    if (!ready) return;
    const key = requireAuth();
    if (!key) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern
    load(key).catch((e) => { if (!handleAuthError(e)) toast(e.message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requireAuth/load intentionally not deps to avoid refetch loops
  }, [ready]);

  async function handleRefresh() {
    const key = requireAuth();
    if (!key) return;
    try {
      await load(key);
      toast("Refreshed.");
    } catch (e) {
      if (!handleAuthError(e)) toast((e as Error).message);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const key = requireAuth();
    if (!key) return;
    try {
      const data = await apiFetch<{ settings: LegalSettings }>("/api/admin/settings", key, {
        method: "PUT",
        body: { termsUrl: termsUrl.trim(), privacyUrl: privacyUrl.trim() },
      });
      setTermsUrl(data.settings.termsUrl || "");
      setPrivacyUrl(data.settings.privacyUrl || "");
      toast("Saved.");
    } catch (err) {
      if (!handleAuthError(err)) toast((err as Error).message);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <AdminTopbar
        title="Nexistry Backend"
        subtitle="Settings"
        adminEmail={admin?.email}
        onRefresh={handleRefresh}
        onLogout={logout}
      />
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-5">
        <section className="rounded-2xl border border-white/10 bg-white/[.03] shadow-2xl">
          <div className="border-b border-white/10 bg-white/[.02] p-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">Checkout legal links</h2>
          </div>
          <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3 p-4">
            <p className="text-xs text-slate-400">
              When a link is set, the embedded checkout requires buyers to tick an agreement box before paying.
              A product can override either link on its own page; leave both blank here to require no agreement.
            </p>
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-slate-300">Terms &amp; Conditions link</span>
              <input className="input" type="url" placeholder="https://example.com/terms" maxLength={2048} value={termsUrl}
                onChange={(e) => setTermsUrl(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-slate-300">Privacy Policy link</span>
              <input className="input" type="url" placeholder="https://example.com/privacy" maxLength={2048} value={privacyUrl}
                onChange={(e) => setPrivacyUrl(e.target.value)} />
            </label>
            <div className="flex justify-end">
              <button type="submit" className="rounded-lg bg-gradient-to-b from-blue-400 to-blue-500 px-4 py-2.5 text-sm font-extrabold text-slate-950">
                Save
              </button>
            </div>
          </form>
        </section>
      </main>
      <Toast message={message} />
    </div>
  );
}
