import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "./client";

export interface AuthState {
  configured: boolean;
  loading: boolean;
  session: Session | null;
  userId: string | null;
  email: string | null;
  error: string | null;
  /** Non-error feedback, e.g. "check your email to confirm your account". */
  notice: string | null;
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

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    if (!supabase) return;
    setError(null);
    setNotice(null);
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      setError(error.message);
      return;
    }
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
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    if (!supabase) return;
    setError(null);
    setNotice(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
  }, []);

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
    signUp,
    signIn,
    signOut,
    clearError: () => {
      setError(null);
      setNotice(null);
    },
  };
}
