// Global leaderboard + hall of fame reads. Every user auto-joins the Global
// group at signup, so RLS's shared-group read policies (pets, profiles,
// hall_of_fame, minigame_scores) make these plain SELECTs — the old hub's
// fetch-all-users-then-sort-client-side pattern became an indexed ORDER BY
// (pets_care_points_idx). Fetched lazily whenever the Ranks view opens.
//
// Two metric families (Phase 2, Jul 2026):
// - Pet metrics (carePoints/evolutionStage/interactions) read the pets table.
// - Minigame metrics (targetToss/rps/chess) read minigame_scores filtered by
//   game_code, with a per-game sort: Target Toss ranks by ASCENDING
//   best_score (distance — lower is better, golf-style); RPS/Chess rank by
//   DESCENDING games_won.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../supabase/client";

export type LeaderboardMetric =
  | "carePoints"
  | "evolutionStage"
  | "interactions"
  | "targetToss"
  | "rps"
  | "chess";

export const LEADERBOARD_METRICS: { metric: LeaderboardMetric; label: string; icon: string }[] = [
  { metric: "carePoints", label: "Care Points", icon: "💠" },
  { metric: "evolutionStage", label: "Evolution", icon: "✨" },
  { metric: "interactions", label: "Interactions", icon: "🤝" },
  { metric: "targetToss", label: "Target Toss", icon: "🎯" },
  { metric: "rps", label: "RPS", icon: "✊" },
  { metric: "chess", label: "Chess", icon: "♟️" },
];

/** metric → minigame_scores.game_code (null = a pets-table metric). */
const GAME_CODE_FOR_METRIC: Partial<Record<LeaderboardMetric, string>> = {
  targetToss: "target_toss",
  rps: "rps",
  chess: "chess",
};

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  petName: string;
  petType: string;
  evolutionStage: number;
  carePoints: number;
  /** feed + wash + pet + ball throws — the "Interactions" metric. */
  interactions: number;
  /** Minigame metrics only: lifetime best distance (Target Toss). */
  bestScore: number | null;
  /** Minigame metrics only: lifetime wins / games played. */
  gamesWon: number;
  gamesPlayed: number;
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

interface MinigameScoreRow {
  user_id: string;
  game_code: string;
  best_score: number | string | null;
  games_played: number;
  games_won: number;
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

    const gameCode = GAME_CODE_FOR_METRIC[metric];

    const hofPromise = supabase
      .from("hall_of_fame")
      .select("milestone_key, user_id, pet_type, claimed_at")
      .order("claimed_at", { ascending: true })
      .limit(20);

    if (gameCode) {
      // ── Minigame metric: minigame_scores filtered by game_code ──────────
      const scoresQuery = supabase
        .from("minigame_scores")
        .select("user_id, game_code, best_score, games_played, games_won")
        .eq("game_code", gameCode);
      const orderedScores =
        metric === "targetToss"
          ? // Lower best distance = better; players with no real landing yet
            // (null best_score) sort last.
            scoresQuery.order("best_score", { ascending: true, nullsFirst: false })
          : scoresQuery.order("games_won", { ascending: false });
      const [scoresRes, hofRes] = await Promise.all([orderedScores.limit(20), hofPromise]);
      if (scoresRes.error) {
        setError(scoresRes.error.message);
        setLoading(false);
        return;
      }
      const scores = (scoresRes.data ?? []) as MinigameScoreRow[];
      const hof = (hofRes.data ?? []) as HofRow[];
      const userIds = [...new Set([...scores.map((s) => s.user_id), ...hof.map((h) => h.user_id)])];
      let profiles: ProfileRow[] = [];
      let pets: PetsRankRow[] = [];
      if (userIds.length > 0) {
        const [profRes, petsRes] = await Promise.all([
          supabase.from("profiles").select("id, name, email").in("id", userIds),
          supabase
            .from("pets")
            .select("user_id, name, pet_type, evolution_stage, care_points, feed_count, wash_count, pet_count, throw_ball_count")
            .in("user_id", userIds),
        ]);
        profiles = (profRes.data ?? []) as ProfileRow[];
        pets = (petsRes.data ?? []) as PetsRankRow[];
      }
      const profileById = new Map(profiles.map((p) => [p.id, p]));
      const petByUser = new Map(pets.map((p) => [p.user_id, p]));
      setEntries(
        scores.map((s) => {
          const pet = petByUser.get(s.user_id);
          return {
            userId: s.user_id,
            displayName: displayNameOf(profileById.get(s.user_id)),
            petName: pet?.name ?? "?",
            petType: pet?.pet_type ?? "cat",
            evolutionStage: pet?.evolution_stage ?? 0,
            carePoints: Number(pet?.care_points ?? 0),
            interactions: 0,
            bestScore: s.best_score === null ? null : Number(s.best_score),
            gamesWon: s.games_won ?? 0,
            gamesPlayed: s.games_played ?? 0,
            isSelf: s.user_id === userId,
          };
        }),
      );
      setHallOfFame(
        hof.map((h) => ({
          milestoneKey: h.milestone_key,
          displayName: displayNameOf(profileById.get(h.user_id)),
          petType: h.pet_type,
          claimedAt: h.claimed_at,
          isSelf: h.user_id === userId,
        })),
      );
      setLoading(false);
      return;
    }

    // ── Pet metric: pets table (the original path) ────────────────────────
    const [petsRes, hofRes] = await Promise.all([
      supabase
        .from("pets")
        .select("user_id, name, pet_type, evolution_stage, care_points, feed_count, wash_count, pet_count, throw_ball_count")
        // One indexed fetch serves every pet metric: pull a wider page
        // ordered by care_points, re-rank client-side below. Fine at this
        // player count; revisit with a DB-side order-by if pages clip.
        .order("care_points", { ascending: false })
        .limit(50),
      hofPromise,
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
      bestScore: null,
      gamesWon: 0,
      gamesPlayed: 0,
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
