// The playable pet: single cat save, local persistence, decay driven by
// pet-core's replayOfflineGap (one shared code path for offline catch-up AND
// the live tick — a tick is just a >=60s "gap"), plus the quest engine and
// account-wide achievements (both from pet-core). Supabase is authoritative
// when signed in; localStorage is the always-on cache.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_PET_RULES,
  PET_QUEST_DEFINITIONS,
  appendHistoryEntry,
  applyCarePointPenalty,
  canEvolveStage,
  claimQuestReward,
  clampCarePointsForProgress,
  clampStat,
  countClaimableQuests,
  evaluatePassiveQuests,
  freshPetQuestState,
  freshPetSave,
  localCalendar,
  markOverfeedQuestFailure,
  normalizePetQuestState,
  normalizePetSave,
  normalizeQuestPeriods,
  proportionalPoints,
  recordCareActionQuestProgress,
  recordThrowBallQuestProgress,
  replayOfflineGap,
  type EvolutionStage,
  type HistoryEntry,
  type PetQuestCode,
  type PetQuestState,
  type PetSaveData,
  type PetType,
} from "@pet/core";
import { supabase } from "../supabase/client";
import { rowToSave, saveToRow, type PetRow } from "../supabase/petRow";
import { useAchievements, type UseAchievements } from "./useAchievements";

const rules = DEFAULT_PET_RULES;
const SAVE_KEY = "mpc_pet_save_cat";
// Tracks which account the cached local save actually belongs to (or "guest"
// before any sign-in). SAVE_KEY itself is one global slot, not per-user — so
// without this marker, signing out of one account and signing up a brand new
// one on the same machine would silently seed the new account's first cloud
// row with the previous account's stats (a real bug: a fresh signup once
// inherited 460+ care points this way). We only trust the cached save as a
// seed for a brand-new cloud row when its owner marker matches the
// currently-authenticating userId.
const SAVE_OWNER_KEY = "mpc_pet_save_owner";
const TICK_MS = 60_000;
// Quest day/week boundaries anchor to the PLAYER'S OWN local timezone (not
// the hardcoded Israel-business-hours default in pet-core, which is a
// carry-over from the original ERP widget's deployment) — computed once,
// since the runtime's timezone doesn't change mid-session.
const calendar = localCalendar();

function loadSave(): PetSaveData {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) return normalizePetSave(JSON.parse(raw) as PetSaveData, undefined, undefined, calendar);
  } catch {
    /* corrupted save — start fresh */
  }
  return freshPetSave({ petType: "cat" }, undefined, calendar);
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
  /** True from the instant warmth hits 100 (immediate red-warning visual) — see warmTick. */
  isEggOverheating: boolean;
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
  /** First-launch starter-egg pick — sets petType and clears the picker gate. */
  chooseEgg: (petType: PetType) => void;
  /** A friend petted this pet in an online room: small happiness bump, no care points (not farmable). */
  receiveSocialPet: () => void;
  /** Call when a warm-hold ends — isEggOverheating otherwise only updates
   * inside the 200ms warmTick loop, so releasing while still at 100 warmth
   * would leave the red warning glow stuck on until the next hold session. */
  clearOverheatWarning: () => void;
  /** Applies an online battle outcome: winner gains happiness + care points, loser sheds a little happiness. */
  applyBattleResult: (won: boolean) => void;
  /** Small happiness/care-point stakes for social minigames (RPS etc.). */
  applyMinigameResult: (outcome: "win" | "lose" | "tie", gameName: string) => void;
  /** Claim a claimable daily/weekly quest — awards its care-point reward. */
  claimQuest: (code: PetQuestCode) => void;
  claimableQuestCount: number;
  /** Escape hatch for history entries originating outside this hook (e.g. group join/leave, achievement claims). */
  logHistoryEvent: (entry: Omit<HistoryEntry, "id" | "at">) => void;
  achievements: UseAchievements;
  // Dev-only helpers — only reachable from the DEV-gated admin panel.
  debugApply: (patch: Partial<PetSaveData>) => void;
  debugLoadPreset: (preset: PetSaveData) => void;
  debugTimeJump: (hours: number) => void;
  debugClearCooldowns: () => void;
  debugResetQuests: () => void;
  debugResetHallOfFame: () => Promise<void>;
}

export type SyncStatus = "offline" | "loading" | "synced" | "error";

export function usePetGame(userId: string | null): PetGame {
  // Offline catch-up + quest-period rollover happen once at load, before
  // first render uses the save.
  const [save, setSave] = useState<PetSaveData>(() =>
    normalizeQuestPeriods(applyDecay(loadSave()), new Date(), calendar),
  );
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
      // The cached local save (and its history log) only belongs to this
      // account if it was left behind by THIS account — see SAVE_OWNER_KEY.
      // Otherwise it's another account's leftovers on a shared machine.
      let localIsMine = false;
      try {
        localIsMine = localStorage.getItem(SAVE_OWNER_KEY) === userId;
      } catch {
        /* ignore */
      }
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
        // History is local-only (never synced to the pets row) — carry the
        // locally-cached log over (when it's actually this account's), or
        // the cloud-authoritative load would silently wipe it on every
        // sign-in.
        let loaded = {
          ...applyDecay(rowToSave(row)),
          history: localIsMine ? (saveRef.current.history ?? []) : [],
        };
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
            quests: normalizePetQuestState(
              {
                daily: questRow.daily as PetQuestState["daily"],
                weekly: questRow.weekly as PetQuestState["weekly"],
                completionCounts: questRow.completion_counts as PetQuestState["completionCounts"],
              },
              new Date(),
              calendar,
            ),
          };
        }
        setSave(normalizeQuestPeriods(loaded, new Date(), calendar));
      } else {
        // No cloud row yet: the cached local save is only a trustworthy seed
        // when it's this account's own — otherwise start genuinely fresh
        // rather than inheriting a previous sign-in's pet (this was the
        // "new signup starts with 460 care points" bug).
        const seeded = localIsMine ? saveRef.current : freshPetSave({ petType: "cat" }, undefined, calendar);
        if (!localIsMine) setSave(seeded);
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
      try {
        localStorage.setItem(SAVE_OWNER_KEY, userId);
      } catch {
        /* quota */
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
      () => setSave((prev) => evaluatePassiveQuests(applyDecay(prev), rules, new Date(), calendar, 1)),
      TICK_MS,
    );
    return () => clearInterval(id);
  }, []);

  const isEgg = save.evolutionStage === 0;

  // History labels show at most 2 decimals (raw floats like 60.333333 are
  // stored in before/after for data purposes, never shown).
  const fmt2 = (n: number): string => {
    const r = Math.round(n * 100) / 100;
    return Number.isInteger(r) ? String(r) : r.toFixed(2);
  };
  /** " , +2.5 ⭐" suffix when an action also moved care points. */
  const cpSuffix = (before: number, after: number): string => {
    const d = Math.round((after - before) * 100) / 100;
    if (d === 0) return "";
    return `, ${d > 0 ? "+" : ""}${fmt2(d)} care points`;
  };

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
      label: string,
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
        return appendHistoryEntry(next, {
          category: "care",
          label: `${label} — ${stat} ${fmt2(before)} → ${fmt2(next[stat])}${cpSuffix(prev.carePoints, next.carePoints)}`,
          statKey: stat,
          before,
          after: next[stat],
          delta: next[stat] - before,
        });
      });
    },
    [],
  );

  // Point bases/stat increases match the ERP hub actions; claimed
  // achievements multiply the category's base points.
  // Warming is a hold-interaction (like the hub's hold-fire egg mini-game):
  // each pulse is a small slice; ~2s of holding ≈ one classic +20 warm action.
  //
  // Overheat (ported from ERP_QA_HUB's warmEgg): once warmth hits 100,
  // continuing to hold immediately flags isEggOverheating (for the red
  // warning visual) but doesn't penalize yet — only past a short grace
  // window (rules.eggOverheat.graceMs) does it start draining happiness and
  // care points instead of gaining anything.
  const eggOverheatSinceRef = useRef<number | null>(null);
  const [isEggOverheating, setIsEggOverheating] = useState(false);

  const warmTick = useCallback(() => {
    const AMOUNT = 2;
    setSave((prev) => {
      if (!prev.isAlive || prev.isSleeping || prev.evolutionStage !== 0) return prev;
      const now = new Date();
      const nowIso = now.toISOString();
      const overheated = prev.warmth >= 100;

      if (overheated) {
        if (eggOverheatSinceRef.current === null) eggOverheatSinceRef.current = Date.now();
        setIsEggOverheating(true);
      } else {
        eggOverheatSinceRef.current = null;
        setIsEggOverheating(false);
      }

      if (overheated) {
        const pastGrace =
          eggOverheatSinceRef.current !== null &&
          Date.now() - eggOverheatSinceRef.current > rules.eggOverheat.graceMs;
        if (!pastGrace) {
          // Still within the grace window — no gain, no penalty yet.
          return { ...prev, lastInteraction: nowIso };
        }
        const nextPoints = applyCarePointPenalty(prev.carePoints, 0.5);
        const next: PetSaveData = {
          ...prev,
          happiness: clampStat(prev.happiness - 1),
          carePoints: nextPoints,
          lastInteraction: nowIso,
        };
        return recordCareActionQuestProgress(next, "feed", rules, now, calendar, false);
      }

      const before = prev.warmth;
      const applied = Math.min(AMOUNT, 100 - before);
      const earned = proportionalPoints(0.5 * multRef.current.feed, before, AMOUNT);
      const nextPoints = clampCarePointsForProgress(prev, prev.carePoints + earned, rules);
      const next: PetSaveData = {
        ...prev,
        warmth: clampStat(before + applied),
        happiness: clampStat(prev.happiness + applied * 0.25),
        carePoints: nextPoints,
        lastInteraction: nowIso,
      };
      return recordCareActionQuestProgress(next, "feed", rules, now, calendar, before < 100);
    });
  }, []);
  const beginWarmSession = useCallback(() => {
    setSave((prev) => {
      if (!prev.isAlive) return prev;
      const now = new Date();
      // One warm session counts like one feed for quests (qualified while
      // warmth still has room).
      const next = { ...prev, feedCount: prev.feedCount + 1 };
      return recordCareActionQuestProgress(next, "feed", rules, now, calendar, prev.warmth < 100);
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
        const nextPoints = applyCarePointPenalty(prev.carePoints, 5);
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
        next = recordCareActionQuestProgress(next, "feed", rules, now, calendar, false);
        next = markOverfeedQuestFailure(next, now, calendar);
        return appendHistoryEntry(next, {
          category: "penalty",
          label: `Overfed — happiness ${fmt2(next.happiness - prev.happiness)}${cpSuffix(prev.carePoints, next.carePoints)}`,
          statKey: "happiness",
          before: prev.happiness,
          after: next.happiness,
          delta: next.happiness - prev.happiness,
        });
      }
      const before = prev.hunger;
      const earned = proportionalPoints(5 * multRef.current.feed, before, 40);
      const nextPoints = clampCarePointsForProgress(prev, prev.carePoints + earned, rules);
      let next: PetSaveData = {
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
      next = recordCareActionQuestProgress(next, "feed", rules, now, calendar, before < 100);
      return appendHistoryEntry(next, {
        category: "care",
        label: `Fed — hunger ${fmt2(before)} → ${fmt2(next.hunger)}${cpSuffix(prev.carePoints, next.carePoints)}`,
        statKey: "hunger",
        before,
        after: next.hunger,
        delta: next.hunger - before,
      });
    });
  }, []);

  const wash = useCallback(
    () =>
      careAction("cleanliness", 60, 5, "wash", "Washed", "washCount", (next, now, before) =>
        recordCareActionQuestProgress(next, "wash", rules, now, calendar, before < 100),
      ),
    [careAction],
  );
  const pet = useCallback(
    () =>
      careAction("happiness", 20, 5, "play", "Petted", "petCount", (next, now, before) =>
        recordCareActionQuestProgress(next, "pet", rules, now, calendar, before < 100),
      ),
    [careAction],
  );
  const throwBall = useCallback(
    () =>
      careAction("happiness", 15, 4, "play", "Played fetch", "throwBallCount", (next, now) =>
        recordThrowBallQuestProgress(next, now, calendar),
      ),
    [careAction],
  );

  const claimQuest = useCallback((code: PetQuestCode) => {
    setSave((prev) => {
      const next = claimQuestReward(prev, code, rules, new Date(), calendar);
      const awarded = next.carePoints - prev.carePoints;
      if (awarded <= 0) return next; // not actually claimable — no-op, don't log
      return appendHistoryEntry(next, {
        category: "quest",
        label: `Quest claimed: ${PET_QUEST_DEFINITIONS[code].title} — +${fmt2(awarded)} care points`,
        statKey: "carePoints",
        before: prev.carePoints,
        after: next.carePoints,
        delta: awarded,
      });
    });
  }, []);

  const logHistoryEvent = useCallback((entry: Omit<HistoryEntry, "id" | "at">) => {
    setSave((prev) => appendHistoryEntry(prev, entry));
  }, []);

  const clearOverheatWarning = useCallback(() => {
    eggOverheatSinceRef.current = null;
    setIsEggOverheating(false);
  }, []);

  const canEvolveNow = canEvolveStage(save.carePoints, save.evolutionStage, rules);

  const hatchOrEvolve = useCallback(() => {
    eggOverheatSinceRef.current = null;
    setIsEggOverheating(false);
    setSave((prev) => {
      if (!prev.isAlive || prev.evolutionStage >= 3) return prev;
      if (!canEvolveStage(prev.carePoints, prev.evolutionStage, rules)) return prev;
      const nextStage = (prev.evolutionStage + 1) as EvolutionStage;
      const threshold = rules.evolutionThresholds[nextStage];
      const next: PetSaveData = {
        ...prev,
        evolutionStage: nextStage,
        hatched: true,
        // Points never decay back below the boundary just crossed.
        carePointsFloor: threshold,
        lastInteraction: new Date().toISOString(),
      };
      return appendHistoryEntry(next, {
        category: "evolution",
        label: prev.evolutionStage === 0 ? "Hatched!" : `Evolved: stage ${prev.evolutionStage} → ${nextStage}`,
        statKey: "evolutionStage",
        before: prev.evolutionStage,
        after: nextStage,
        delta: nextStage - prev.evolutionStage,
      });
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
      // Eggs don't sleep — they go dormant on their own (see replayOfflineGap).
      if (!prev.isAlive || prev.evolutionStage === 0) return prev;
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
    eggOverheatSinceRef.current = null;
    setIsEggOverheating(false);
    setSave(freshPetSave({ petType: "cat" }, undefined, calendar));
  }, []);

  const chooseEgg = useCallback((petType: PetType) => {
    setSave((prev) => appendHistoryEntry({ ...prev, petType, eggChosen: true }, {
      category: "evolution",
      label: `Picked starter egg: ${petType}`,
    }));
  }, []);

  const rename = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 24) return;
    setSave((prev) => ({ ...prev, name: trimmed }));
  }, []);

  const receiveSocialPet = useCallback(() => {
    setSave((prev) => {
      if (!prev.isAlive || prev.isSleeping) return prev;
      return { ...prev, happiness: clampStat(prev.happiness + 2), lastInteraction: new Date().toISOString() };
    });
  }, []);

  // Minigames grant NO progression rewards (product decision, Jul 2026) —
  // results are only logged locally and persisted to minigame_scores (via
  // record_minigame_result, called by the room layer) for future
  // achievements/leaderboards.
  const applyMinigameResult = useCallback((outcome: "win" | "lose" | "tie", gameName: string) => {
    setSave((prev) => {
      if (!prev.isAlive) return prev;
      const next: PetSaveData = { ...prev, lastInteraction: new Date().toISOString() };
      return appendHistoryEntry(next, {
        category: "social",
        label: `${gameName} — ${outcome === "win" ? "won 🏆" : outcome === "tie" ? "tie 🤝" : "lost"}`,
      });
    });
  }, []);

  const applyBattleResult = useCallback((won: boolean) => {
    setSave((prev) => {
      if (!prev.isAlive) return prev;
      const nowIso = new Date().toISOString();
      if (won) {
        const next: PetSaveData = {
          ...prev,
          happiness: clampStat(prev.happiness + 10),
          carePoints: clampCarePointsForProgress(prev, prev.carePoints + 6, rules),
          lastInteraction: nowIso,
        };
        return appendHistoryEntry(next, {
          category: "social",
          label: `Battle won — happiness +${fmt2(next.happiness - prev.happiness)}${cpSuffix(prev.carePoints, next.carePoints)}`,
          statKey: "happiness",
          before: prev.happiness,
          after: next.happiness,
          delta: next.happiness - prev.happiness,
        });
      }
      const next: PetSaveData = { ...prev, happiness: clampStat(prev.happiness - 3), lastInteraction: nowIso };
      return appendHistoryEntry(next, {
        category: "social",
        label: `Battle lost — happiness ${fmt2(next.happiness - prev.happiness)}`,
        statKey: "happiness",
        before: prev.happiness,
        after: next.happiness,
        delta: next.happiness - prev.happiness,
      });
    });
  }, []);

  // ── Dev-only helpers (reachable only from the DEV-gated admin panel) ──────
  const debugApply = useCallback((patch: Partial<PetSaveData>) => {
    setSave((prev) => ({ ...prev, ...patch, lastInteraction: new Date().toISOString() }));
  }, []);

  // Presets mean "give me this exact state NOW" — never re-route through the
  // first-launch egg picker (AdminPanel builds them from freshPetSave, whose
  // eggChosen: false would otherwise trap the dev behind the picker).
  const debugLoadPreset = useCallback((preset: PetSaveData) => setSave({ ...preset, eggChosen: true }), []);

  /**
   * Simulates "the app was closed for N hours": shifts all clocks back
   * (decay timestamps AND every interaction/cooldown timer — lastFed/
   * lastWashed/lastPetted plus the quest engine's 1h qualified-action gaps
   * — so cooldown-gated things actually clear when you jump forward far
   * enough), then replays decay.
   */
  const debugTimeJump = useCallback((hours: number) => {
    setSave((prev) => {
      const shiftMs = hours * 3_600_000;
      const shift = (iso: string) => new Date(new Date(iso).getTime() - shiftMs).toISOString();
      const quests = prev.quests
        ? {
            ...prev.quests,
            daily: {
              ...prev.quests.daily,
              lastQualifiedFeedAt: prev.quests.daily.lastQualifiedFeedAt
                ? shift(prev.quests.daily.lastQualifiedFeedAt)
                : undefined,
              lastQualifiedWashAt: prev.quests.daily.lastQualifiedWashAt
                ? shift(prev.quests.daily.lastQualifiedWashAt)
                : undefined,
              lastQualifiedPetAt: prev.quests.daily.lastQualifiedPetAt
                ? shift(prev.quests.daily.lastQualifiedPetAt)
                : undefined,
            },
          }
        : prev.quests;
      return applyDecay({
        ...prev,
        lastDecayTick: shift(prev.lastDecayTick),
        lastInteraction: shift(prev.lastInteraction),
        lastFed: shift(prev.lastFed),
        lastWashed: shift(prev.lastWashed),
        lastPetted: shift(prev.lastPetted),
        sleepStartedAt: prev.sleepStartedAt ? shift(prev.sleepStartedAt) : undefined,
        quests,
      });
    });
  }, []);

  /** Instantly clears every cooldown/gap (petting UI cooldown, quest
   * qualified-action gaps) without touching stats/decay — a quick "test the
   * next click" button distinct from a full time jump. */
  const debugClearCooldowns = useCallback(() => {
    setSave((prev) => {
      const farPast = new Date(0).toISOString();
      return {
        ...prev,
        lastFed: farPast,
        lastWashed: farPast,
        lastPetted: farPast,
        quests: prev.quests
          ? {
              ...prev.quests,
              daily: {
                ...prev.quests.daily,
                lastQualifiedFeedAt: undefined,
                lastQualifiedWashAt: undefined,
                lastQualifiedPetAt: undefined,
              },
            }
          : prev.quests,
      };
    });
  }, []);

  /** Resets quest progress/claims to fresh without touching the pet itself. */
  const debugResetQuests = useCallback(() => {
    setSave((prev) => ({ ...prev, quests: freshPetQuestState(new Date(), calendar) }));
  }, []);

  /** Deletes every hall-of-fame row this account claimed, freeing those
   * global milestones back up (dev-only — real players never get this). */
  const debugResetHallOfFame = useCallback(async () => {
    if (!supabase || !userId) return;
    hofClaimedRef.current = false;
    const { error } = await supabase.from("hall_of_fame").delete().eq("user_id", userId);
    if (error) console.error("[debug] hall of fame reset failed:", error);
  }, [userId]);

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
    isEggOverheating,
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
    chooseEgg,
    receiveSocialPet,
    applyBattleResult,
    applyMinigameResult,
    clearOverheatWarning,
    claimQuest,
    claimableQuestCount: countClaimableQuests(save),
    logHistoryEvent,
    achievements,
    debugApply,
    debugLoadPreset,
    debugTimeJump,
    debugClearCooldowns,
    debugResetQuests,
    debugResetHallOfFame,
  };
}
