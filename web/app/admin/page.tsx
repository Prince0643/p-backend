"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AdminPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/admin/dashboard");
  }, [router]);

  return (
    <main className="flex flex-1 items-center justify-center px-6 text-sm text-slate-400">
      Opening admin dashboard...
    </main>
  );
}
