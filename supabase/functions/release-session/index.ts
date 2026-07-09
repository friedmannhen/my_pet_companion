// Best-effort graceful release on normal close (plan §12). Only deletes the
// lease if this session still owns it, so a late/delayed release call from
// an old instance can never clobber a newer session's lease.
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getAuthedUser, serviceClient } from "../_shared/authClient.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await getAuthedUser(req);
    if (!user) return jsonResponse({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const sessionId: string | undefined = body.sessionId;

    const admin = serviceClient();
    let deleteQuery = admin.from("pet_session_leases").delete().eq("user_id", user.id);
    if (sessionId) deleteQuery = deleteQuery.eq("session_id", sessionId);
    const { error } = await deleteQuery;
    if (error) return jsonResponse({ error: error.message }, 500);

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
