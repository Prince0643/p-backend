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
  const [keyModalOpen, setKeyModalOpen] = useState(false);

  const setApiKey = useCallback((value: string) => {
    setApiKeyState(value);
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Non-fatal - key still works for the current page session via state.
    }
  }, []);

  // Returns the cached key, or null (and opens the entry modal) if none is
  // set yet. Callers already treat a null return as "abort this action" -
  // same as when this used to return null on a cancelled window.prompt().
  const ensureApiKey = useCallback((): string | null => {
    if (apiKey) return apiKey;
    setKeyModalOpen(true);
    return null;
  }, [apiKey]);

  // Opens the entry modal to set or change the key, regardless of whether
  // one is already cached (used by the "Set API Key" button).
  const promptForNewKey = useCallback(() => {
    setKeyModalOpen(true);
  }, []);

  const closeKeyModal = useCallback(() => setKeyModalOpen(false), []);

  const saveApiKey = useCallback(
    (value: string) => {
      setApiKey(value.trim());
      setKeyModalOpen(false);
      // A full reload is simplest and matches how every page already loads
      // its data from a mount effect keyed off the cached key - this avoids
      // threading a "retry now" callback through every ensureApiKey() call
      // site across the admin pages.
      window.location.reload();
    },
    [setApiKey]
  );

  // `ready` is always true now that the key loads synchronously on first render;
  // kept so pages don't need to change their `if (!ready) return;` guard.
  return {
    apiKey,
    ready: true,
    setApiKey,
    ensureApiKey,
    promptForNewKey,
    keyModalOpen,
    closeKeyModal,
    saveApiKey,
  };
}
