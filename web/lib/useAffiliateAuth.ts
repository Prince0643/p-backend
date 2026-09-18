"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { UnauthorizedError } from "./api";

const STORAGE_KEY = "nx_affiliate_session";

type AffiliateSession = { token: string; affiliateId: string; email: string };

function readStoredSession(): AffiliateSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AffiliateSession) : null;
  } catch {
    return null;
  }
}

export function useAffiliateAuth() {
  const router = useRouter();
  const [session, setSessionState] = useState<AffiliateSession | null>(readStoredSession);

  const setSession = useCallback((next: AffiliateSession | null) => {
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
    router.push("/affiliate/login");
  }, [setSession, router]);

  const requireAuth = useCallback((): string | null => {
    if (session?.token) return session.token;
    router.push("/affiliate/login");
    return null;
  }, [session, router]);

  const handleAuthError = useCallback(
    (err: unknown): boolean => {
      if (err instanceof UnauthorizedError) {
        setSession(null);
        router.push("/affiliate/login");
        return true;
      }
      return false;
    },
    [setSession, router]
  );

  return {
    ready: true,
    token: session?.token || null,
    email: session?.email || null,
    isLoggedIn: Boolean(session?.token),
    setSession,
    logout,
    requireAuth,
    handleAuthError,
  };
}
