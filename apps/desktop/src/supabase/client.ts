import { createClient } from "@supabase/supabase-js";

// Publishable (anon) key only — safe to ship in the client. Every table is
// RLS-guarded; the service-role key must NEVER appear here.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && key);

// Token persistence: the renderer's localStorage for now. FOLLOW-UP (plan §
// "desktop OAuth gap"): move session tokens into the OS keychain via Electron
// safeStorage instead of renderer localStorage before any real release.
export const supabase = isSupabaseConfigured
  ? createClient(url!, key!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false, // Electron has no OAuth redirect URL to parse
      },
    })
  : null;
