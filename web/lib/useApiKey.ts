"use client";

import { useCallback, useState } from "react";

const STORAGE_KEY = "nx_admin_api_key";

function readStoredKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function useApiKey() {
  // Lazy initializer reads localStorage once, synchronously, during the first
  // client render - avoids a setState-in-effect render cascade for something
  // that's available immediately rather than genuinely async.
  const [apiKey, setApiKeyState] = useState<string>(readStoredKey);

  const setApiKey = useCallback((value: string) => {
    setApiKeyState(value);
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Non-fatal - key still works for the current page session via state.
    }
  }, []);

  const ensureApiKey = useCallback((): string | null => {
    if (apiKey) return apiKey;
    const value = window.prompt("Enter ADMIN API Key (x-api-key):");
    if (!value) return null;
    const trimmed = value.trim();
    setApiKey(trimmed);
    return trimmed;
  }, [apiKey, setApiKey]);

  const promptForNewKey = useCallback(() => {
    const value = window.prompt("Enter ADMIN API Key (x-api-key):", apiKey);
    if (value == null) return;
    setApiKey(value.trim());
  }, [apiKey, setApiKey]);

  // `ready` is always true now that the key loads synchronously on first render;
  // kept so pages don't need to change their `if (!ready) return;` guard.
  return { apiKey, ready: true, setApiKey, ensureApiKey, promptForNewKey };
}
