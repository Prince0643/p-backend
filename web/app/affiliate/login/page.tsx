"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError } from "@/lib/api";
import { useAffiliateAuth } from "@/lib/useAffiliateAuth";

export default function AffiliateLoginPage() {
  const router = useRouter();
  const { setSession } = useAffiliateAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/affiliates/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new ApiError(data?.error || `Login failed (${res.status})`);
      }
      setSession({ token: data.token, affiliateId: data.affiliate.id, email: data.affiliate.email });
      router.push("/affiliate/dashboard");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-full flex-1 items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[.03] p-6 shadow-2xl"
      >
        <div className="mb-1 text-xs font-bold uppercase tracking-widest text-blue-400">Nexistry Digital Solutions</div>
        <h1 className="mb-6 text-xl font-extrabold">Affiliate Login</h1>

        <label className="block text-sm font-semibold" htmlFor="aff-email">
          Email
        </label>
        <input
          id="aff-email"
          type="email"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1.5 mb-4 w-full rounded-lg border border-white/10 bg-[#0b1424] px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500"
        />

        <label className="block text-sm font-semibold" htmlFor="aff-password">
          Password
        </label>
        <input
          id="aff-password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1.5 mb-4 w-full rounded-lg border border-white/10 bg-[#0b1424] px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500"
        />

        {error && (
          <div className="mb-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-gradient-to-b from-blue-400 to-blue-500 px-3 py-2.5 text-sm font-extrabold text-slate-950 disabled:opacity-50"
        >
          {submitting ? "Logging in…" : "Log In"}
        </button>

        <p className="mt-4 text-center text-xs text-slate-400">
          Not an affiliate yet?{" "}
          <a href="/register" className="text-blue-400 underline">
            Register here
          </a>
          .
        </p>
      </form>
    </div>
  );
}
