// Refreshes the caller's session lease. Returns ok:false when this session
// no longer owns the lease (another instance force-took-over) — the client
// treats that as "you were signed out elsewhere" (plan §12).
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getAuthedUser, serviceClient } from "../_shared/authClient.ts";
import { LEASE_TTL_MS } from "../_shared/lease.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await getAuthedUser(req);
    if (!user) return jsonResponse({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const sessionId: string | undefined = body.sessionId;
    if (!sessionId) return jsonResponse({ error: "sessionId required" }, 400);

    const admin = serviceClient();
    const { data: existing } = await admin
      .from("pet_session_leases")
      .select("session_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!existing || existing.session_id !== sessionId) {
      return jsonResponse({ ok: false, reason: "not_owner" });
    }

    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
    const { error } = await admin
      .from("pet_session_leases")
      .update({ last_heartbeat_at: nowIso, expires_at: expiresAt })
      .eq("user_id", user.id)
      .eq("session_id", sessionId);
    if (error) return jsonResponse({ error: error.message }, 500);

    return jsonResponse({ ok: true, expiresAt });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
