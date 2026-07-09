// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/** Service-role client — bypasses RLS. Only ever used server-side, never shipped to a client. */
export function serviceClient(): any {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

/** Resolves the authenticated user from the incoming request's Authorization header (the caller's JWT, forwarded automatically by supabase-js). */
export async function getAuthedUser(req: Request): Promise<{ id: string } | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const anon = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data, error } = await anon.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}
