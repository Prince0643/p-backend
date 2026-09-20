"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { UnauthorizedError } from "./api";

const STORAGE_KEY = "nx_admin_session";

type AdminSession = { token: string; admin: { id: string | null; email: string | null } };

function readStoredSession(): AdminSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AdminSession) : null;
  } catch {
    return null;
  }
}

export function useAdminAuth() {
  const router = useRouter();
  // Start at null on both server and client so the initial render always matches
  // (localStorage doesn't exist during SSR/static export) - the real session is
  // read after mount, in the effect below, which is client-only by definition.
  const [session, setSessionState] = useState<AdminSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Reads localStorage, which doesn't exist during SSR/static export - must
    // happen client-side, after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSessionState(readStoredSession());
    setReady(true);
  }, []);

  const setSession = useCallback((next: AdminSession | null) => {
    setSessionState(next);
    try {
      if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Non-fatal - session still works for the current page via state.
    }
  }, []);

  const logout = useCallback(() => {
    setSession(null);
    router.push("/admin/login");
  }, [setSession, router]);

  /** Requires a token to be present, redirecting to login if not. Call at the top of a page's mount effect. */
  const requireAuth = useCallback((): string | null => {
    if (session?.token) return session.token;
    router.push("/admin/login");
    return null;
  }, [session, router]);

  /** Pass to catch blocks around apiFetch calls - redirects to login on an expired/invalid session. */
  const handleAuthError = useCallback(
    (err: unknown): boolean => {
      if (err instanceof UnauthorizedError) {
        setSession(null);
        router.push("/admin/login");
        return true;
      }
      return false;
    },
    [setSession, router]
  );

  return {
    ready,
    token: session?.token || null,
    admin: session?.admin || null,
    isLoggedIn: Boolean(session?.token),
    setSession,
    logout,
    requireAuth,
    handleAuthError,
  };
}
