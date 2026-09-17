"use client";

import { useState } from "react";

export function ApiKeyModal({
  open,
  currentKey,
  onSave,
  onClose,
}: {
  open: boolean;
  currentKey: string;
  onSave: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(currentKey);

  if (!open) return null;

  const submit = () => {
    if (!value.trim()) return;
    onSave(value);
  };

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/75 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-[#0f1b33] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 p-5">
          <h2 className="text-lg font-bold">Admin API Key</h2>
          <button
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-lg"
          >
            ×
          </button>
        </div>
        <div className="space-y-3 p-5">
          <label className="block text-sm font-semibold" htmlFor="admin-api-key-input">
            x-api-key
          </label>
          <input
            id="admin-api-key-input"
            type="password"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Enter ADMIN API key"
            className="w-full rounded-lg border border-white/10 bg-[#0b1424] px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500"
          />
          <p className="text-xs text-slate-400">
            Stored only in this browser (localStorage), sent as the <code>x-api-key</code> header on admin requests.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold text-slate-100 hover:bg-white/10"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={!value.trim()}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
