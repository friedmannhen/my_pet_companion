// Friend circles: list my groups, create one (server-generated invite
// code), join by code, leave. All writes go through the security-definer
// RPCs from migration 20260711000000_group_rpcs.sql — group_memberships has
// no client INSERT policy on purpose.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../supabase/client";

export interface GroupInfo {
  id: string;
  name: string;
  inviteCode: string | null;
  groupType: string;
  role: string;
  ownerId: string | null;
}

interface MembershipRow {
  role: string;
  groups: {
    id: string;
    name: string;
    invite_code: string | null;
    group_type: string;
    owner_id: string | null;
  } | null;
}

export interface UseGroups {
  groups: GroupInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (name: string) => Promise<GroupInfo | null>;
  join: (code: string) => Promise<GroupInfo | null>;
  leave: (groupId: string) => Promise<void>;
}

export function useGroups(userId: string | null): UseGroups {
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!supabase || !userId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from("group_memberships")
      .select("role, groups(id, name, invite_code, group_type, owner_id)")
      .eq("user_id", userId);
    setLoading(false);
    if (err) {
      setError(err.message);
      return;
    }
    const rows = (data ?? []) as unknown as MembershipRow[];
    setGroups(
      rows
        .filter((r) => r.groups)
        .map((r) => ({
          id: r.groups!.id,
          name: r.groups!.name,
          inviteCode: r.groups!.invite_code,
          groupType: r.groups!.group_type,
          role: r.role,
          ownerId: r.groups!.owner_id,
        }))
        // Global first, then newest-joined last alphabetically as a stable order.
        .sort((a, b) =>
          a.groupType === "global" ? -1 : b.groupType === "global" ? 1 : a.name.localeCompare(b.name),
        ),
    );
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (name: string): Promise<GroupInfo | null> => {
      if (!supabase || !userId) return null;
      setError(null);
      const { data, error: err } = await supabase.rpc("create_group", { group_name: name });
      if (err) {
        setError(err.message);
        return null;
      }
      await refresh();
      const g = data as { id: string; name: string; invite_code: string | null; group_type: string; owner_id: string | null };
      return { id: g.id, name: g.name, inviteCode: g.invite_code, groupType: g.group_type, role: "owner", ownerId: g.owner_id };
    },
    [userId, refresh],
  );

  const join = useCallback(
    async (code: string): Promise<GroupInfo | null> => {
      if (!supabase || !userId) return null;
      setError(null);
      const { data, error: err } = await supabase.rpc("join_group", { code });
      if (err) {
        setError(err.message);
        return null;
      }
      await refresh();
      const g = data as { id: string; name: string; invite_code: string | null; group_type: string; owner_id: string | null };
      return { id: g.id, name: g.name, inviteCode: g.invite_code, groupType: g.group_type, role: "member", ownerId: g.owner_id };
    },
    [userId, refresh],
  );

  const leave = useCallback(
    async (groupId: string) => {
      if (!supabase || !userId) return;
      setError(null);
      const { error: err } = await supabase
        .from("group_memberships")
        .delete()
        .eq("user_id", userId)
        .eq("group_id", groupId);
      if (err) setError(err.message);
      await refresh();
    },
    [userId, refresh],
  );

  return { groups, loading, error, refresh, create, join, leave };
}
