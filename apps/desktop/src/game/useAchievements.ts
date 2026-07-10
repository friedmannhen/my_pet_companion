// Account-wide achievements: lifetime counters cross tiers → "claimable";
// claiming applies a permanent % care-point bonus per category (pet-core's
// computeCategoryBonusMultipliers). State lives in the `achievements` table
// (one row per user × code) with a localStorage cache so the UI is instant
// on launch; the cloud is authoritative on sign-in.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PET_ACHIEVEMENT_DEFINITIONS,
  computeCategoryBonusMultipliers,
  countClaimableAchievements,
  evaluateAchievements,
  freshAchievementState,
  freshAllSaves,
  normalizeAchievementState,
  type AchievementBonusCategory,
  type AllSaves,
  type PetAchievementCode,
  type PetAchievementState,
  type PetSaveData,
} from "@pet/core";
import { supabase } from "../supabase/client";

const CACHE_KEY = "mpc_achievements";

interface AchievementRow {
  user_id: string;
  achievement_code: string;
  status: "claimable" | "claimed";
  earned_at: string;
  claimed_at: string | null;
}

function loadCache(): PetAchievementState {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) return normalizeAchievementState(JSON.parse(raw));
  } catch {
    /* corrupted */
  }
  return freshAchievementState();
}

function rowsToState(rows: AchievementRow[]): PetAchievementState {
  const state = freshAchievementState();
  for (const row of rows) {
    const code = row.achievement_code as PetAchievementCode;
    if (!PET_ACHIEVEMENT_DEFINITIONS[code]) continue;
    state.earned[code] = {
      earnedAt: row.earned_at,
      status: row.status,
      claimedAt: row.claimed_at ?? undefined,
    };
  }
  return state;
}

/** The MVP has one live pet; wrap it in a full AllSaves for the aggregate progress fns. */
export function savesForProgress(save: PetSaveData): AllSaves {
  const all = freshAllSaves();
  all[save.petType] = save;
  return all;
}

export interface UseAchievements {
  state: PetAchievementState;
  claimableCount: number;
  multipliers: Record<AchievementBonusCategory, number>;
  progress: (code: PetAchievementCode) => number;
  claim: (code: PetAchievementCode) => void;
  /** Dev-only: wipes local cache + cloud rows back to fresh. Note the pet's
   * own lifetime counters aren't touched, so already-crossed tiers will
   * immediately re-populate as claimable on the next evaluation pass —
   * that's expected for a reset-for-testing tool. */
  resetAll: () => Promise<void>;
}

export function useAchievements(userId: string | null, save: PetSaveData): UseAchievements {
  const [state, setState] = useState<PetAchievementState>(loadCache);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(state));
    } catch {
      /* quota */
    }
  }, [state]);

  // Cloud load on sign-in — authoritative when rows exist.
  useEffect(() => {
    if (!supabase || !userId) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("achievements")
        .select("*")
        .eq("user_id", userId);
      if (cancelled || error || !data) return;
      if (data.length > 0) setState(rowsToState(data as AchievementRow[]));
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Evaluate tier crossings whenever the save changes (lightly debounced —
  // save updates can burst during warming/decay).
  useEffect(() => {
    const timer = setTimeout(() => {
      const newlyEarned = evaluateAchievements(savesForProgress(save), stateRef.current);
      if (newlyEarned.length === 0) return;
      const earnedAt = new Date().toISOString();
      setState((prev) => {
        const next: PetAchievementState = { ...prev, earned: { ...prev.earned } };
        for (const code of newlyEarned) {
          if (!next.earned[code]) next.earned[code] = { earnedAt, status: "claimable" };
        }
        return next;
      });
      if (supabase && userId) {
        void supabase
          .from("achievements")
          .upsert(
            newlyEarned.map((code) => ({
              user_id: userId,
              achievement_code: code,
              status: "claimable" as const,
              earned_at: earnedAt,
            })),
            { onConflict: "user_id,achievement_code", ignoreDuplicates: true },
          )
          .then(({ error }) => {
            if (error) console.error("[achievements] upsert failed:", error);
          });
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [save, userId]);

  const claim = useCallback(
    (code: PetAchievementCode) => {
      const claimedAt = new Date().toISOString();
      setState((prev) => {
        const entry = prev.earned[code];
        if (!entry || entry.status !== "claimable") return prev;
        return {
          ...prev,
          earned: { ...prev.earned, [code]: { ...entry, status: "claimed", claimedAt } },
        };
      });
      if (supabase && userId) {
        void supabase
          .from("achievements")
          .update({ status: "claimed", claimed_at: claimedAt })
          .eq("user_id", userId)
          .eq("achievement_code", code)
          .then(({ error }) => {
            if (error) console.error("[achievements] claim failed:", error);
          });
      }
    },
    [userId],
  );

  const progress = useCallback(
    (code: PetAchievementCode) => PET_ACHIEVEMENT_DEFINITIONS[code].progress(savesForProgress(save)),
    [save],
  );

  const resetAll = useCallback(async () => {
    setState(freshAchievementState());
    if (!supabase || !userId) return;
    const { error } = await supabase.from("achievements").delete().eq("user_id", userId);
    if (error) console.error("[achievements] reset failed:", error);
  }, [userId]);

  return {
    state,
    claimableCount: countClaimableAchievements(state),
    multipliers: computeCategoryBonusMultipliers(state),
    progress,
    claim,
    resetAll,
  };
}
