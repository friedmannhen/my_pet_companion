import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "./client";

const LAST_EMAIL_KEY = "mpc_last_email";
const REMEMBER_ME_KEY = "mpc_remember_me";

function readRememberMe(): boolean {
  // Default on — matches Supabase's own default persisted-session behavior.
  return localStorage.getItem(REMEMBER_ME_KEY) !== "false";
}

function readLastEmail(): string {
  try {
    return localStorage.getItem(LAST_EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}

export interface AuthState {
  configured: boolean;
  loading: boolean;
  session: Session | null;
  userId: string | null;
  email: string | null;
  error: string | null;
  /** Non-error feedback, e.g. "check your email to confirm your account". */
  notice: string | null;
  /** Last email used to sign in/up, prefilled so it never needs retyping. */
  lastEmail: string;
  /** Whether the session should survive an app restart. Persisted immediately. */
  rememberMe: boolean;
  setRememberMe: (value: boolean) => void;
  signUp: (email: string, password: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
}

export function useAuth(): AuthState {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastEmail, setLastEmailState] = useState(readLastEmail);
  const [rememberMe, setRememberMeState] = useState(readRememberMe);

  useEffect(() => {
    const client = supabase;
    if (!client) return;
    client.auth.getSession().then(({ data }) => {
      // "Remember me" was off last time — forget any session Supabase
      // auto-restored from localStorage rather than silently signing back in.
      if (data.session && !readRememberMe()) {
        void client.auth.signOut().then(() => setLoading(false));
        return;
      }
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = client.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const rememberEmail = useCallback((email: string) => {
    try {
      localStorage.setItem(LAST_EMAIL_KEY, email);
    } catch {
      /* quota */
    }
    setLastEmailState(email);
  }, []);

  const setRememberMe = useCallback((value: boolean) => {
    try {
      localStorage.setItem(REMEMBER_ME_KEY, String(value));
    } catch {
      /* quota */
    }
    setRememberMeState(value);
  }, []);

  const signUp = useCallback(
    async (email: string, password: string) => {
      if (!supabase) return;
      setError(null);
      setNotice(null);
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) {
        setError(error.message);
        return;
      }
      rememberEmail(email);
      // With "Confirm email" enabled, signUp succeeds but returns no session
      // (and a user with identities already present means this email is
      // already registered — Supabase returns that silently, no error).
      if (!data.session) {
        const alreadyRegistered = (data.user?.identities?.length ?? 0) === 0;
        setNotice(
          alreadyRegistered
            ? "That email is already registered — try signing in instead."
            : "Account created! Check your email to confirm it, then sign in.",
        );
      }
    },
    [rememberEmail],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!supabase) return;
      setError(null);
      setNotice(null);
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message);
        return;
      }
      rememberEmail(email);
    },
    [rememberEmail],
  );

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  }, []);

  return {
    configured: isSupabaseConfigured,
    loading,
    session,
    userId: session?.user.id ?? null,
    email: session?.user.email ?? null,
    error,
    notice,
    lastEmail,
    rememberMe,
    setRememberMe,
    signUp,
    signIn,
    signOut,
    clearError: () => {
      setError(null);
      setNotice(null);
    },
  };
}
