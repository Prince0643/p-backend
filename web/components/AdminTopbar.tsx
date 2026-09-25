"use client";

import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";

const NAV = [
  { href: "/admin/dashboard", label: "Dashboard" },
  { href: "/admin/products", label: "Products" },
  { href: "/admin/coupons", label: "Coupons" },
  { href: "/admin/campaigns", label: "Campaigns" },
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
      <div className="mx-auto grid max-w-6xl gap-3 px-5 py-3.5">
        <BrandMark size="sm" subtitle={`${subtitle || title}${adminEmail ? ` · ${adminEmail}` : ""}`} />
        <nav className="-mx-1 overflow-x-auto px-1" aria-label="Admin navigation">
          <div className="flex w-max items-center gap-2">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="min-h-11 whitespace-nowrap rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold text-slate-100 hover:bg-white/10"
              >
                {item.label}
              </Link>
            ))}
            <button
              onClick={onRefresh}
              className="min-h-11 whitespace-nowrap rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold text-slate-100 hover:bg-white/10"
            >
              Refresh
            </button>
            <button
              onClick={onLogout}
              className="min-h-11 whitespace-nowrap rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm font-semibold text-red-200 hover:bg-red-400/20"
            >
              Log Out
            </button>
          </div>
        </nav>
      </div>
    </header>
  );
}
