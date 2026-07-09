// Grants the single "live" session lease for a user (plan §12). If another
// session already holds an unexpired lease, returns a conflict instead of
// silently double-granting — the client decides whether to force takeover.
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getAuthedUser, serviceClient } from "../_shared/authClient.ts";
import { HEARTBEAT_INTERVAL_MS, LEASE_TTL_MS } from "../_shared/lease.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await getAuthedUser(req);
    if (!user) return jsonResponse({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const sessionId: string | undefined = body.sessionId;
    const deviceType: string | undefined = body.deviceType;
    const force = body.force === true;
    if (!sessionId || !deviceType) {
      return jsonResponse({ error: "sessionId and deviceType required" }, 400);
    }

    const admin = serviceClient();
    const nowIso = new Date().toISOString();

    const { data: existing } = await admin
      .from("pet_session_leases")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    const isExpired = !existing || new Date(existing.expires_at).getTime() < Date.now();
    const isSameSession = existing?.session_id === sessionId;

    if (existing && !isExpired && !isSameSession && !force) {
      return jsonResponse({
        granted: false,
        conflict: { deviceType: existing.device_type, acquiredAt: existing.acquired_at },
      });
    }

    const expiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
    const { error: upsertError } = await admin.from("pet_session_leases").upsert({
      user_id: user.id,
      session_id: sessionId,
      device_type: deviceType,
      acquired_at: nowIso,
      last_heartbeat_at: nowIso,
      expires_at: expiresAt,
    });
    if (upsertError) return jsonResponse({ error: upsertError.message }, 500);

    return jsonResponse({ granted: true, expiresAt, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
