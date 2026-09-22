"use client";

import Link from "next/link";

const NAV = [
  { href: "/admin/dashboard", label: "Dashboard" },
  { href: "/admin/products", label: "Products" },
  { href: "/admin/coupons", label: "Coupons" },
  { href: "/admin/affiliates", label: "Affiliates" },
  { href: "/admin/solutions", label: "Solutions" },
  { href: "/admin/admins", label: "Admins" },
];

export function AdminTopbar({
  title,
  subtitle,
  adminEmail,
  onRefresh,
  onLogout,
}: {
  title: string;
  subtitle: string;
  adminEmail?: string | null;
  onRefresh: () => void;
  onLogout: () => void;
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-white/10 bg-[#0b1220c0] backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-3.5">
        <div>
          <div className="text-sm font-extrabold tracking-wide">{title}</div>
          <div className="text-xs text-slate-400">
            {subtitle}
            {adminEmail ? ` · ${adminEmail}` : ""}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold text-slate-100 hover:bg-white/10"
            >
              {item.label}
            </Link>
          ))}
          <button
            onClick={onRefresh}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold text-slate-100 hover:bg-white/10"
          >
            Refresh
          </button>
          <button
            onClick={onLogout}
            className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm font-semibold text-red-200 hover:bg-red-400/20"
          >
            Log Out
          </button>
        </div>
      </div>
    </header>
  );
}
