"use client";

import { useEffect, useRef, useState } from "react";
import { AdminTopbar } from "@/components/AdminTopbar";
import { TestCards } from "@/components/TestCards";
import { useAdminAuth } from "@/lib/useAdminAuth";

// Opened in a new tab by Products > "Test checkout" with #t=<token>&p=<productId>&exp=<iso>.
// The fragment is never sent to the server, and is stripped from the address bar on load.
// The embed on this page runs in PayMongo TEST mode (nx-embed reads data-nx-test).
export default function TestCheckoutPage() {
  const { ready, admin, requireAuth, logout } = useAdminAuth();
  const [info, setInfo] = useState<{ token: string; productId: string; exp: string } | null>(null);
  const [missing, setMissing] = useState(false);
  const [origin, setOrigin] = useState("");
  const holderRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ready) return;
    if (!requireAuth()) return;
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = params.get("t") || "";
    const productId = params.get("p") || "";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the URL fragment, client-only
    setOrigin(window.location.origin);
    if (!token || !productId) {
      setMissing(true);
      return;
    }
    setInfo({ token, productId, exp: params.get("exp") || "" });
    window.history.replaceState(null, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once when auth is ready
  }, [ready]);

  useEffect(() => {
    if (!info || !origin || !holderRef.current) return;
    const holder = holderRef.current;
    holder.innerHTML = "";
    const div = document.createElement("div");
    div.setAttribute("data-nx-product", info.productId);
    div.setAttribute("data-nx-test", info.token);
    div.setAttribute("data-api-base", origin);
    holder.appendChild(div);
    const w = window as unknown as { NexistryEmbed?: { scan: () => void } };
    if (w.NexistryEmbed) {
      w.NexistryEmbed.scan();
    } else {
      const script = document.createElement("script");
      script.src = `${origin}/public/nx-embed.js`;
      script.async = true;
      holder.appendChild(script);
    }
  }, [info, origin]);

  return (
    <div className="flex flex-1 flex-col">
      <AdminTopbar
        title="Nexistry Backend"
        subtitle="Test checkout (PayMongo test mode)"
        adminEmail={admin?.email}
        onRefresh={() => {}}
        onLogout={logout}
      />
      <div className="bg-amber-400 px-5 py-3 text-center text-sm font-extrabold uppercase tracking-wide text-slate-950" role="status">
        TEST MODE — no real charge
      </div>
      <main className="mx-auto grid w-full max-w-5xl flex-1 grid-cols-1 gap-5 px-5 py-5 lg:grid-cols-2">
        <section>
          {missing && (
            <p className="rounded-xl border border-white/10 bg-white/[.03] p-4 text-sm text-slate-300">
              This page needs a fresh test token. Go to Products, select a product and click <b>Test checkout</b>.
            </p>
          )}
          <div ref={holderRef} className="rounded-xl bg-white p-4" hidden={!info} />
        </section>
        <section className="space-y-4">
          <TestCards />
          {info && (
            <div className="rounded-xl border border-white/10 bg-white/[.03] p-3.5 text-xs text-slate-300">
              <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-200">Test a live funnel page</h3>
              <p className="mb-2 text-slate-400">
                Append this to the funnel page URL to run that page&apos;s embedded checkout in test mode
                {info.exp ? ` (expires ${new Date(info.exp).toLocaleTimeString()})` : ""}:
              </p>
              <textarea
                readOnly
                className="h-20 w-full rounded-lg border border-white/10 bg-[#0c162ce6] p-2 font-mono text-[11px]"
                value={`?nx_test=${info.token}`}
              />
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
