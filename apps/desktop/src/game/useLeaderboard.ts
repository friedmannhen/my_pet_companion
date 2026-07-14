// Global leaderboard + hall of fame reads. Every user auto-joins the Global
// group at signup, so RLS's shared-group read policies (pets, profiles,
// hall_of_fame) make these plain SELECTs — the old hub's
// fetch-all-users-then-sort-client-side pattern became an indexed ORDER BY
// (pets_care_points_idx). Fetched lazily whenever the Ranks view opens.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../supabase/client";

// Ranking metrics, mirroring the old hub's leaderboard filter pills — only
// the ones this schema can serve from the pets row are kept.
export type LeaderboardMetric = "carePoints" | "evolutionStage" | "interactions";

export const LEADERBOARD_METRICS: { metric: LeaderboardMetric; label: string; icon: string }[] = [
  { metric: "carePoints", label: "Care Points", icon: "💠" },
  { metric: "evolutionStage", label: "Evolution", icon: "✨" },
  { metric: "interactions", label: "Interactions", icon: "🤝" },
];

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  petName: string;
  petType: string;
  evolutionStage: number;
  carePoints: number;
  /** feed + wash + pet + ball throws — the "Interactions" metric. */
  interactions: number;
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
  feed_count: number;
  wash_count: number;
  pet_count: number;
  throw_ball_count: number;
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

export function useLeaderboard(userId: string | null, active: boolean, metric: LeaderboardMetric = "carePoints") {
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
        .select("user_id, name, pet_type, evolution_stage, care_points, feed_count, wash_count, pet_count, throw_ball_count")
        // One indexed fetch serves every metric: pull a wider page ordered by
        // care_points, re-rank client-side below. Fine at this player count;
        // revisit with a proper DB-side order-by if pages start clipping.
        .order("care_points", { ascending: false })
        .limit(50),
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

    const mapped = pets.map((p) => ({
      userId: p.user_id,
      displayName: displayNameOf(byId.get(p.user_id)),
      petName: p.name,
      petType: p.pet_type,
      evolutionStage: p.evolution_stage,
      carePoints: Number(p.care_points),
      interactions: (p.feed_count ?? 0) + (p.wash_count ?? 0) + (p.pet_count ?? 0) + (p.throw_ball_count ?? 0),
      isSelf: p.user_id === userId,
    }));
    const valueOf = (e: LeaderboardEntry) =>
      metric === "evolutionStage" ? e.evolutionStage : metric === "interactions" ? e.interactions : e.carePoints;
    // care_points as the stable tiebreak so equal stages/counts still rank sensibly.
    mapped.sort((a, b) => valueOf(b) - valueOf(a) || b.carePoints - a.carePoints);
    setEntries(mapped.slice(0, 20));
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
  }, [userId, metric]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  return { entries, hallOfFame, loading, error, refresh };
}
