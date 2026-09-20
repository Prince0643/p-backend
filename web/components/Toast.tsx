"use client";

export function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="fixed bottom-4 right-4 max-w-sm rounded-xl border border-white/10 bg-[#0c162cf2] px-4 py-3 text-sm text-slate-100 shadow-2xl">
      {message}
    </div>
  );
}
