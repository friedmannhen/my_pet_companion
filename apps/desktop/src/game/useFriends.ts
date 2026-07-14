// Friend list on top of the `friends` table (requester/addressee + status).
// RLS already enforces everything server-side: parties read their own rows,
// requests only within a shared group (everyone shares Global), only the
// addressee accepts/declines, either side deletes. This hook is a thin
// client: list + search + the four verbs.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../supabase/client";

export interface FriendEntry {
  /** The OTHER user's id (never self). */
  userId: string;
  name: string;
  /** Who initiated — matters only while status is pending. */
  direction: "incoming" | "outgoing";
  status: "pending" | "accepted";
}

export interface PlayerSearchResult {
  userId: string;
  name: string;
  /** Existing relation with this player, if any — disables re-requesting. */
  relation: "friend" | "pending" | null;
}

interface FriendRow {
  requester_id: string;
  addressee_id: string;
  status: "pending" | "accepted" | "declined";
}

interface ProfileRow {
  id: string;
  name: string;
  email: string;
}

function nameOf(p: ProfileRow | undefined): string {
  if (!p) return "Mystery player";
  return p.name || p.email.split("@")[0] || p.email;
}

export interface UseFriends {
  friends: FriendEntry[];
  incoming: FriendEntry[];
  outgoing: FriendEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  search: (query: string) => Promise<PlayerSearchResult[]>;
  request: (userId: string) => Promise<void>;
  accept: (userId: string) => Promise<void>;
  decline: (userId: string) => Promise<void>;
  remove: (userId: string) => Promise<void>;
}

export function useFriends(userId: string | null, active: boolean): UseFriends {
  const [rows, setRows] = useState<FriendEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!supabase || !userId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from("friends")
      .select("requester_id, addressee_id, status")
      .neq("status", "declined");
    if (err) {
      setError(err.message);
      setLoading(false);
      return;
    }
    const friendRows = (data ?? []) as FriendRow[];
    const otherIds = [...new Set(friendRows.map((r) => (r.requester_id === userId ? r.addressee_id : r.requester_id)))];
    let profiles: ProfileRow[] = [];
    if (otherIds.length > 0) {
      const { data: profs } = await supabase.from("profiles").select("id, name, email").in("id", otherIds);
      profiles = (profs ?? []) as ProfileRow[];
    }
    const byId = new Map(profiles.map((p) => [p.id, p]));
    setRows(
      friendRows.map((r) => {
        const otherId = r.requester_id === userId ? r.addressee_id : r.requester_id;
        return {
          userId: otherId,
          name: nameOf(byId.get(otherId)),
          direction: r.requester_id === userId ? "outgoing" : "incoming",
          status: r.status as "pending" | "accepted",
        };
      }),
    );
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const search = useCallback(
    async (query: string): Promise<PlayerSearchResult[]> => {
      const q = query.trim();
      if (!supabase || !userId || q.length < 2) return [];
      const { data } = await supabase
        .from("profiles")
        .select("id, name, email")
        .ilike("name", `%${q}%`)
        .neq("id", userId)
        .limit(8);
      const profs = (data ?? []) as ProfileRow[];
      const relationOf = (id: string): PlayerSearchResult["relation"] => {
        const row = rows.find((r) => r.userId === id);
        if (!row) return null;
        return row.status === "accepted" ? "friend" : "pending";
      };
      return profs.map((p) => ({ userId: p.id, name: nameOf(p), relation: relationOf(p.id) }));
    },
    [userId, rows],
  );

  const request = useCallback(
    async (targetId: string) => {
      if (!supabase || !userId) return;
      setError(null);
      // A previously-declined request leaves its row in place (PK is
      // requester+addressee), which would make the re-request insert
      // collide. RLS lets either side delete, and only the addressee can
      // UPDATE, so delete-then-insert is the requester's only path.
      await supabase
        .from("friends")
        .delete()
        .eq("requester_id", userId)
        .eq("addressee_id", targetId)
        .eq("status", "declined");
      const { error: err } = await supabase
        .from("friends")
        .insert({ requester_id: userId, addressee_id: targetId });
      if (err) setError(err.message);
      await refresh();
    },
    [userId, refresh],
  );

  const respond = useCallback(
    async (requesterId: string, status: "accepted" | "declined") => {
      if (!supabase || !userId) return;
      setError(null);
      const { error: err } = await supabase
        .from("friends")
        .update({ status, responded_at: new Date().toISOString() })
        .eq("requester_id", requesterId)
        .eq("addressee_id", userId);
      if (err) setError(err.message);
      await refresh();
    },
    [userId, refresh],
  );

  const accept = useCallback((id: string) => respond(id, "accepted"), [respond]);
  const decline = useCallback((id: string) => respond(id, "declined"), [respond]);

  const remove = useCallback(
    async (otherId: string) => {
      if (!supabase || !userId) return;
      setError(null);
      // The row can exist in either direction — RLS lets either party delete.
      const { error: err } = await supabase
        .from("friends")
        .delete()
        .or(
          `and(requester_id.eq.${userId},addressee_id.eq.${otherId}),and(requester_id.eq.${otherId},addressee_id.eq.${userId})`,
        );
      if (err) setError(err.message);
      await refresh();
    },
    [userId, refresh],
  );

  return {
    friends: rows.filter((r) => r.status === "accepted"),
    incoming: rows.filter((r) => r.status === "pending" && r.direction === "incoming"),
    outgoing: rows.filter((r) => r.status === "pending" && r.direction === "outgoing"),
    loading,
    error,
    refresh,
    search,
    request,
    accept,
    decline,
    remove,
  };
}
