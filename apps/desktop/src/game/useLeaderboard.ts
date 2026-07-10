// Global leaderboard + hall of fame reads. Every user auto-joins the Global
// group at signup, so RLS's shared-group read policies (pets, profiles,
// hall_of_fame) make these plain SELECTs — the old hub's
// fetch-all-users-then-sort-client-side pattern became an indexed ORDER BY
// (pets_care_points_idx). Fetched lazily whenever the Ranks view opens.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../supabase/client";

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  petName: string;
  petType: string;
  evolutionStage: number;
  carePoints: number;
  isSelf: boolean;
}

export interface HallOfFameEntry {
  milestoneKey: string;
  displayName: string;
  petType: string | null;
  claimedAt: string;
  isSelf: boolean;
}

interface PetsRankRow {
  user_id: string;
  name: string;
  pet_type: string;
  evolution_stage: number;
  care_points: number;
}

interface ProfileRow {
  id: string;
  name: string;
  email: string;
}

interface HofRow {
  milestone_key: string;
  user_id: string;
  pet_type: string | null;
  claimed_at: string;
}

function displayNameOf(profile: ProfileRow | undefined): string {
  if (!profile) return "Mystery player";
  if (profile.name) return profile.name;
  return profile.email.split("@")[0] ?? profile.email;
}

export function useLeaderboard(userId: string | null, active: boolean) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [hallOfFame, setHallOfFame] = useState<HallOfFameEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!supabase || !userId) return;
    setLoading(true);
    setError(null);
    const [petsRes, hofRes] = await Promise.all([
      supabase
        .from("pets")
        .select("user_id, name, pet_type, evolution_stage, care_points")
        .order("care_points", { ascending: false })
        .limit(20),
      supabase
        .from("hall_of_fame")
        .select("milestone_key, user_id, pet_type, claimed_at")
        .order("claimed_at", { ascending: true })
        .limit(20),
    ]);
    if (petsRes.error) {
      setError(petsRes.error.message);
      setLoading(false);
      return;
    }
    const pets = (petsRes.data ?? []) as PetsRankRow[];
    const hof = (hofRes.data ?? []) as HofRow[];

    const userIds = [...new Set([...pets.map((p) => p.user_id), ...hof.map((h) => h.user_id)])];
    let profiles: ProfileRow[] = [];
    if (userIds.length > 0) {
      const { data } = await supabase.from("profiles").select("id, name, email").in("id", userIds);
      profiles = (data ?? []) as ProfileRow[];
    }
    const byId = new Map(profiles.map((p) => [p.id, p]));

    setEntries(
      pets.map((p) => ({
        userId: p.user_id,
        displayName: displayNameOf(byId.get(p.user_id)),
        petName: p.name,
        petType: p.pet_type,
        evolutionStage: p.evolution_stage,
        carePoints: Number(p.care_points),
        isSelf: p.user_id === userId,
      })),
    );
    setHallOfFame(
      hof.map((h) => ({
        milestoneKey: h.milestone_key,
        displayName: displayNameOf(byId.get(h.user_id)),
        petType: h.pet_type,
        claimedAt: h.claimed_at,
        isSelf: h.user_id === userId,
      })),
    );
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  return { entries, hallOfFame, loading, error, refresh };
}
