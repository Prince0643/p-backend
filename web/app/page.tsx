import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <BrandMark size="lg" subtitle="Admin and affiliate portal" />
      <h1 className="max-w-xl bg-gradient-to-br from-white via-cyan-100 to-amber-100 bg-clip-text text-4xl font-bold text-transparent">
        Portal Console
      </h1>
      <div className="flex flex-wrap justify-center gap-3">
        <Link
          href="/register"
          className="rounded-xl bg-gradient-to-br from-cyan-300 via-sky-400 to-amber-300 px-5 py-3 font-bold text-slate-950"
        >
          Affiliate Registration
        </Link>
        <Link
          href="/affiliate/login"
          className="rounded-xl border border-white/10 bg-white/5 px-5 py-3 font-bold text-slate-100 hover:bg-white/10"
        >
          Affiliate Login
        </Link>
        <Link
          href="/admin/dashboard"
          className="rounded-xl border border-white/10 bg-white/5 px-5 py-3 font-bold text-slate-100 hover:bg-white/10"
        >
          Admin Console
        </Link>
      </div>
    </main>
  );
}
