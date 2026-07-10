// The playable pet: single cat save, local persistence, decay driven by
// pet-core's replayOfflineGap (one shared code path for offline catch-up AND
// the live tick — a tick is just a >=60s "gap"), plus the quest engine and
// account-wide achievements (both from pet-core). Supabase is authoritative
// when signed in; localStorage is the always-on cache.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_PET_RULES,
  canEvolveStage,
  claimQuestReward,
  clampCarePointsForProgress,
  clampStat,
  countClaimableQuests,
  evaluatePassiveQuests,
  freshPetSave,
  markOverfeedQuestFailure,
  normalizePetQuestState,
  normalizePetSave,
  normalizeQuestPeriods,
  proportionalPoints,
  recordCareActionQuestProgress,
  recordThrowBallQuestProgress,
  replayOfflineGap,
  type EvolutionStage,
  type PetQuestCode,
  type PetQuestState,
  type PetSaveData,
} from "@pet/core";
import { supabase } from "../supabase/client";
import { rowToSave, saveToRow, type PetRow } from "../supabase/petRow";
import { useAchievements, type UseAchievements } from "./useAchievements";

const rules = DEFAULT_PET_RULES;
const SAVE_KEY = "mpc_pet_save_cat";
const TICK_MS = 60_000;

function loadSave(): PetSaveData {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) return normalizePetSave(JSON.parse(raw) as PetSaveData);
  } catch {
    /* corrupted save — start fresh */
  }
  return freshPetSave({ petType: "cat" });
}

function applyDecay(save: PetSaveData): PetSaveData {
  const out = replayOfflineGap(save, rules);
  if (!out) return save;
  return {
    ...save,
    hunger: out.hunger,
    warmth: out.warmth,
    cleanliness: out.cleanliness,
    happiness: out.happiness,
    carePoints: out.carePoints,
    isAlive: out.isAlive,
    isSleeping: out.isSleeping,
    sleepKind: out.sleepKind,
    sleepStartedAt: out.sleepStartedAt,
    lastDecayTick: out.lastDecayTick,
  };
}

interface QuestProgressRow {
  pet_id: string;
  user_id: string;
  day_key: string;
  week_key: string;
  daily: unknown;
  weekly: unknown;
  completion_counts: unknown;
}

export interface PetGame {
  save: PetSaveData;
  syncStatus: SyncStatus;
  /** The last Postgres/PostgREST error message, if syncStatus === "error". */
  syncError: string | null;
  isEgg: boolean;
  canHatch: boolean;
  canEvolve: boolean;
  /** 0..1 progress toward the next lifecycle step (1 when ready/final). */
  evolutionProgress: number;
  /** Care points needed for the next lifecycle step (null at final stage). */
  nextThreshold: number | null;
  /** One warming pulse — called repeatedly while the player holds the egg. */
  warmTick: () => void;
  /** Counts the warming session start (one feedCount per hold, not per pulse). */
  beginWarmSession: () => void;
  feed: () => void;
  wash: () => void;
  pet: () => void;
  throwBall: () => void;
  hatchOrEvolve: () => void;
  toggleSleep: () => void;
  restart: () => void;
  /** Rename the pet (trimmed, 1–24 chars — no-op otherwise). */
  rename: (name: string) => void;
  /** Claim a claimable daily/weekly quest — awards its care-point reward. */
  claimQuest: (code: PetQuestCode) => void;
  claimableQuestCount: number;
  achievements: UseAchievements;
  // Dev-only helpers — only reachable from the DEV-gated admin panel.
  debugApply: (patch: Partial<PetSaveData>) => void;
  debugLoadPreset: (preset: PetSaveData) => void;
  debugTimeJump: (hours: number) => void;
}

export type SyncStatus = "offline" | "loading" | "synced" | "error";

export function usePetGame(userId: string | null): PetGame {
  // Offline catch-up + quest-period rollover happen once at load, before
  // first render uses the save.
  const [save, setSave] = useState<PetSaveData>(() => normalizeQuestPeriods(applyDecay(loadSave())));
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("offline");
  const [syncError, setSyncError] = useState<string | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const petIdRef = useRef<string | null>(null);

  const achievements = useAchievements(userId, save);
  const multRef = useRef(achievements.multipliers);
  multRef.current = achievements.multipliers;

  // localStorage is the always-on offline cache regardless of auth.
  useEffect(() => {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(save));
    } catch {
      /* quota */
    }
  }, [save]);

  // ── Cloud load on sign-in ────────────────────────────────────────────────
  // Owner reads/writes its own pets row directly (RLS: "pets: owner full
  // access"). Cloud is authoritative when a row exists (server last_decay_tick
  // drives correct decay); otherwise the local save is pushed up as the seed.
  useEffect(() => {
    if (!supabase || !userId) {
      setSyncStatus("offline");
      return;
    }
    let cancelled = false;
    setSyncStatus("loading");
    (async () => {
      const { data, error } = await supabase
        .from("pets")
        .select("*")
        .eq("user_id", userId)
        .eq("pet_type", "cat")
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        console.error("[pet-sync] load failed:", error);
        setSyncError(`load: ${error.message} (${error.code ?? "no code"})`);
        setSyncStatus("error");
        return;
      }
      if (data) {
        const row = data as PetRow & { id: string };
        petIdRef.current = row.id;
        let loaded = applyDecay(rowToSave(row));
        // Quest progress rides in its own row (pets table stays scalar).
        const { data: qp } = await supabase
          .from("pet_quest_progress")
          .select("*")
          .eq("pet_id", row.id)
          .maybeSingle();
        if (cancelled) return;
        if (qp) {
          const questRow = qp as QuestProgressRow;
          loaded = {
            ...loaded,
            quests: normalizePetQuestState({
              daily: questRow.daily as PetQuestState["daily"],
              weekly: questRow.weekly as PetQuestState["weekly"],
              completionCounts: questRow.completion_counts as PetQuestState["completionCounts"],
            }),
          };
        }
        setSave(normalizeQuestPeriods(loaded));
      } else {
        const seeded = saveRef.current;
        const { data: inserted, error: insErr } = await supabase
          .from("pets")
          .insert(saveToRow(seeded, userId))
          .select("id")
          .single();
        if (cancelled) return;
        if (insErr) {
          console.error("[pet-sync] seed insert failed:", insErr);
          setSyncError(`insert: ${insErr.message} (${insErr.code ?? "no code"})`);
          setSyncStatus("error");
          return;
        }
        petIdRef.current = (inserted as { id: string }).id;
      }
      setSyncError(null);
      setSyncStatus("synced");
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // ── Cloud push (debounced) ───────────────────────────────────────────────
  const pushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!supabase || !userId || syncStatus === "loading") return;
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(async () => {
      const current = saveRef.current;
      const { error } = await supabase!
        .from("pets")
        .upsert(saveToRow(current, userId), { onConflict: "user_id,pet_type" });
      if (error) {
        console.error("[pet-sync] push failed:", error);
        setSyncError(`push: ${error.message} (${error.code ?? "no code"})`);
        setSyncStatus("error");
        return;
      }
      const quests = current.quests;
      if (petIdRef.current && quests) {
        const { error: qErr } = await supabase!.from("pet_quest_progress").upsert(
          {
            pet_id: petIdRef.current,
            user_id: userId,
            day_key: quests.daily.dayKey,
            week_key: quests.weekly.weekKey,
            daily: quests.daily,
            weekly: quests.weekly,
            completion_counts: quests.completionCounts,
          },
          { onConflict: "pet_id" },
        );
        if (qErr) console.error("[pet-sync] quest push failed:", qErr);
      }
      setSyncError(null);
      setSyncStatus("synced");
    }, 2000);
    return () => {
      if (pushTimer.current) clearTimeout(pushTimer.current);
    };
  }, [save, userId, syncStatus]);

  // Live decay tick — same replay path as offline catch-up, plus passive
  // quest progress (guardian/focus minutes, clean-run cutoff) for the one
  // awake minute that just elapsed.
  useEffect(() => {
    const id = setInterval(
      () => setSave((prev) => evaluatePassiveQuests(applyDecay(prev), rules, new Date(), undefined, 1)),
      TICK_MS,
    );
    return () => clearInterval(id);
  }, []);

  const isEgg = save.evolutionStage === 0;

  /**
   * Shared care-action wrapper: wakes the pet (any care action counts as
   * interaction), raises one stat, earns proportional care points (with the
   * claimed-achievement % bonus for the category), and records quest
   * progress via the optional transform.
   */
  const careAction = useCallback(
    (
      stat: "hunger" | "warmth" | "cleanliness" | "happiness",
      increase: number,
      basePoints: number,
      bonusCategory: "feed" | "wash" | "play",
      counter?: "feedCount" | "washCount" | "petCount" | "throwBallCount",
      recordQuests?: (next: PetSaveData, now: Date, statBefore: number) => PetSaveData,
    ) => {
      setSave((prev) => {
        if (!prev.isAlive) return prev;
        const now = new Date();
        const nowIso = now.toISOString();
        const before = prev[stat];
        const earned = proportionalPoints(basePoints * multRef.current[bonusCategory], before, increase);
        const nextPoints = clampCarePointsForProgress(prev, prev.carePoints + earned, rules);
        let next: PetSaveData = {
          ...prev,
          [stat]: clampStat(before + increase),
          carePoints: nextPoints,
          isSleeping: false,
          sleepKind: undefined,
          sleepStartedAt: undefined,
          lastInteraction: nowIso,
          ...(stat === "hunger" ? { lastFed: nowIso } : {}),
          ...(stat === "cleanliness" ? { lastWashed: nowIso } : {}),
          ...(stat === "happiness" ? { lastPetted: nowIso } : {}),
        };
        if (counter) next[counter] = (prev[counter] ?? 0) + 1;
        if (recordQuests) next = recordQuests(next, now, before);
        return next;
      });
    },
    [],
  );

  // Point bases/stat increases match the ERP hub actions; claimed
  // achievements multiply the category's base points.
  // Warming is a hold-interaction (like the hub's hold-fire egg mini-game):
  // each pulse is a small slice; ~2s of holding ≈ one classic +20 warm action.
  const warmTick = useCallback(() => careAction("warmth", 2, 0.5, "feed"), [careAction]);
  const beginWarmSession = useCallback(() => {
    setSave((prev) => {
      if (!prev.isAlive) return prev;
      const now = new Date();
      // One warm session counts like one feed for quests (qualified while
      // warmth still has room).
      const next = { ...prev, feedCount: prev.feedCount + 1 };
      return recordCareActionQuestProgress(next, "feed", rules, now, undefined, prev.warmth < 100);
    });
  }, []);

  // Feeding a pet whose hunger is already maxed is an overfeed (ERP_QA_HUB's
  // PetContext.tsx feed()): no hunger to gain, and it costs happiness/care
  // points instead — the deterrent against spamming Feed for free points.
  // It also fails today's Clean Run and this week's Careful Feeder.
  const feed = useCallback(() => {
    setSave((prev) => {
      if (!prev.isAlive) return prev;
      const now = new Date();
      const nowIso = now.toISOString();
      const isEggPhase = prev.evolutionStage === 0;
      if (!isEggPhase && prev.hunger >= 100) {
        const nextPoints = clampCarePointsForProgress(prev, prev.carePoints - 5, rules);
        let next: PetSaveData = {
          ...prev,
          happiness: clampStat(prev.happiness - 5),
          carePoints: nextPoints,
          isSleeping: false,
          sleepKind: undefined,
          sleepStartedAt: undefined,
          lastInteraction: nowIso,
          lastFed: nowIso,
          feedCount: prev.feedCount + 1,
          overfeedCount: (prev.overfeedCount ?? 0) + 1,
        };
        next = recordCareActionQuestProgress(next, "feed", rules, now, undefined, false);
        return markOverfeedQuestFailure(next, now);
      }
      const before = prev.hunger;
      const earned = proportionalPoints(5 * multRef.current.feed, before, 40);
      const nextPoints = clampCarePointsForProgress(prev, prev.carePoints + earned, rules);
      const next: PetSaveData = {
        ...prev,
        hunger: clampStat(before + 40),
        carePoints: nextPoints,
        isSleeping: false,
        sleepKind: undefined,
        sleepStartedAt: undefined,
        lastInteraction: nowIso,
        lastFed: nowIso,
        feedCount: prev.feedCount + 1,
      };
      return recordCareActionQuestProgress(next, "feed", rules, now, undefined, before < 100);
    });
  }, []);

  const wash = useCallback(
    () =>
      careAction("cleanliness", 60, 5, "wash", "washCount", (next, now, before) =>
        recordCareActionQuestProgress(next, "wash", rules, now, undefined, before < 100),
      ),
    [careAction],
  );
  const pet = useCallback(
    () =>
      careAction("happiness", 20, 5, "play", "petCount", (next, now, before) =>
        recordCareActionQuestProgress(next, "pet", rules, now, undefined, before < 100),
      ),
    [careAction],
  );
  const throwBall = useCallback(
    () =>
      careAction("happiness", 15, 4, "play", "throwBallCount", (next, now) =>
        recordThrowBallQuestProgress(next, now),
      ),
    [careAction],
  );

  const claimQuest = useCallback((code: PetQuestCode) => {
    setSave((prev) => claimQuestReward(prev, code, rules));
  }, []);

  const canEvolveNow = canEvolveStage(save.carePoints, save.evolutionStage, rules);

  const hatchOrEvolve = useCallback(() => {
    setSave((prev) => {
      if (!prev.isAlive || prev.evolutionStage >= 3) return prev;
      if (!canEvolveStage(prev.carePoints, prev.evolutionStage, rules)) return prev;
      const nextStage = (prev.evolutionStage + 1) as EvolutionStage;
      const threshold = rules.evolutionThresholds[nextStage];
      return {
        ...prev,
        evolutionStage: nextStage,
        hatched: true,
        // Points never decay back below the boundary just crossed.
        carePointsFloor: threshold,
        lastInteraction: new Date().toISOString(),
      };
    });
  }, []);

  // Hall of fame: reaching the final stage claims the global "first final
  // evolution" milestones (overall + per pet type). The DB's unique index
  // makes this a race-free first-claim — losers just hit the conflict.
  const hofClaimedRef = useRef(false);
  useEffect(() => {
    if (save.evolutionStage !== 3 || hofClaimedRef.current) return;
    hofClaimedRef.current = true;
    if (!supabase || !userId) return;
    const claims = [
      { milestone_key: "first_final_evolution", user_id: userId, pet_type: save.petType },
      { milestone_key: `first_final_${save.petType}`, user_id: userId, pet_type: save.petType },
    ];
    for (const claim of claims) {
      void supabase
        .from("hall_of_fame")
        .insert(claim)
        .then(({ error }) => {
          // 23505 = someone else already holds the milestone — expected.
          if (error && error.code !== "23505") {
            console.error("[hall-of-fame] claim failed:", error);
          }
        });
    }
  }, [save.evolutionStage, save.petType, userId]);

  const toggleSleep = useCallback(() => {
    setSave((prev) => {
      if (!prev.isAlive) return prev;
      const nowIso = new Date().toISOString();
      if (prev.isSleeping) {
        return {
          ...prev,
          isSleeping: false,
          sleepKind: undefined,
          sleepStartedAt: undefined,
          lastInteraction: nowIso,
        };
      }
      // Manual tuck-in = protected sleep (72h freeze window).
      return {
        ...prev,
        isSleeping: true,
        sleepKind: "manual",
        sleepStartedAt: nowIso,
        lastInteraction: nowIso,
      };
    });
  }, []);

  const restart = useCallback(() => {
    hofClaimedRef.current = false;
    setSave(freshPetSave({ petType: "cat" }));
  }, []);

  const rename = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 24) return;
    setSave((prev) => ({ ...prev, name: trimmed }));
  }, []);

  // ── Dev-only helpers (reachable only from the DEV-gated admin panel) ──────
  const debugApply = useCallback((patch: Partial<PetSaveData>) => {
    setSave((prev) => ({ ...prev, ...patch, lastInteraction: new Date().toISOString() }));
  }, []);

  const debugLoadPreset = useCallback((preset: PetSaveData) => setSave(preset), []);

  /** Simulates "the app was closed for N hours": shifts all clocks back, then replays. */
  const debugTimeJump = useCallback((hours: number) => {
    setSave((prev) => {
      const shiftMs = hours * 3_600_000;
      const shift = (iso: string) => new Date(new Date(iso).getTime() - shiftMs).toISOString();
      return applyDecay({
        ...prev,
        lastDecayTick: shift(prev.lastDecayTick),
        lastInteraction: shift(prev.lastInteraction),
        sleepStartedAt: prev.sleepStartedAt ? shift(prev.sleepStartedAt) : undefined,
      });
    });
  }, []);

  const nextThreshold =
    save.evolutionStage >= 3 ? null : rules.evolutionThresholds[(save.evolutionStage + 1) as 1 | 2 | 3];
  const prevThreshold = rules.evolutionThresholds[save.evolutionStage];
  const evolutionProgress =
    nextThreshold === null
      ? 1
      : Math.min(1, (save.carePoints - prevThreshold) / (nextThreshold - prevThreshold));

  return {
    save,
    syncStatus,
    syncError,
    isEgg,
    canHatch: isEgg && canEvolveNow,
    canEvolve: !isEgg && canEvolveNow,
    evolutionProgress,
    nextThreshold,
    warmTick,
    beginWarmSession,
    feed,
    wash,
    pet,
    throwBall,
    hatchOrEvolve,
    toggleSleep,
    restart,
    rename,
    claimQuest,
    claimableQuestCount: countClaimableQuests(save),
    achievements,
    debugApply,
    debugLoadPreset,
    debugTimeJump,
  };
}
