"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError } from "@/lib/api";
import { useAdminAuth } from "@/lib/useAdminAuth";
import { BrandMark } from "@/components/BrandMark";

export default function AdminLoginPage() {
  const router = useRouter();
  const { setSession } = useAdminAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new ApiError(data?.error || `Login failed (${res.status})`);
      }
      setSession({ token: data.token, admin: data.admin });
      router.push("/admin/dashboard");
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
        <div className="mb-5">
          <BrandMark subtitle="Admin Console" />
        </div>
        <h1 className="mb-1 text-xl font-extrabold">Admin Console Login</h1>
        <Link href="/" className="mb-6 inline-block text-xs text-slate-400 underline hover:text-slate-300">
          ← Not an admin? Go back
        </Link>

        <label className="block text-sm font-semibold" htmlFor="admin-email">
          Email
        </label>
        <input
          id="admin-email"
          type="email"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1.5 mb-4 w-full rounded-lg border border-white/10 bg-[#0b1424] px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-300"
        />

        <label className="block text-sm font-semibold" htmlFor="admin-password">
          Password
        </label>
        <input
          id="admin-password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1.5 mb-4 w-full rounded-lg border border-white/10 bg-[#0b1424] px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-300"
        />

        {error && (
          <div className="mb-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="brand-action w-full py-2.5"
        >
          {submitting ? "Logging in…" : "Log In"}
        </button>

        <p className="mt-4 text-center text-xs text-slate-400">
          Need access? Ask an existing admin to create an account for you from the Admins page.
        </p>
      </form>
    </div>
  );
}
