// First playable slice: single cat save, local persistence, decay driven by
// pet-core's replayOfflineGap (one shared code path for offline catch-up AND
// the live tick — a tick is just a >=60s "gap"). Supabase sync arrives with
// auth; the save shape is already the one the backend schema mirrors.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_PET_RULES,
  canEvolveStage,
  clampCarePointsForProgress,
  clampStat,
  freshPetSave,
  normalizePetSave,
  proportionalPoints,
  replayOfflineGap,
  type EvolutionStage,
  type PetSaveData,
} from "@pet/core";

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

export interface PetGame {
  save: PetSaveData;
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
  // Dev-only helpers — only reachable from the DEV-gated admin panel.
  debugApply: (patch: Partial<PetSaveData>) => void;
  debugLoadPreset: (preset: PetSaveData) => void;
  debugTimeJump: (hours: number) => void;
}

export function usePetGame(): PetGame {
  // Offline catch-up happens once at load, before first render uses the save.
  const [save, setSave] = useState<PetSaveData>(() => applyDecay(loadSave()));
  const saveRef = useRef(save);
  saveRef.current = save;

  // Persist on every change.
  useEffect(() => {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(save));
    } catch {
      /* quota */
    }
  }, [save]);

  // Live decay tick — same replay path as offline catch-up.
  useEffect(() => {
    const id = setInterval(() => setSave((prev) => applyDecay(prev)), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const isEgg = save.evolutionStage === 0;

  /**
   * Shared care-action wrapper: wakes the pet (any care action counts as
   * interaction), raises one stat, and earns proportional care points.
   */
  const careAction = useCallback(
    (
      stat: "hunger" | "warmth" | "cleanliness" | "happiness",
      increase: number,
      basePoints: number,
      counter?: "feedCount" | "washCount" | "petCount" | "throwBallCount",
    ) => {
      setSave((prev) => {
        if (!prev.isAlive) return prev;
        const nowIso = new Date().toISOString();
        const before = prev[stat];
        const earned = proportionalPoints(basePoints, before, increase);
        const nextPoints = clampCarePointsForProgress(prev, prev.carePoints + earned, rules);
        const next: PetSaveData = {
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
        return next;
      });
    },
    [],
  );

  // Point bases/stat increases match the ERP hub actions (achievement
  // multipliers arrive once achievements state is wired up).
  // Warming is a hold-interaction (like the hub's hold-fire egg mini-game):
  // each pulse is a small slice; ~2s of holding ≈ one classic +20 warm action.
  const warmTick = useCallback(() => careAction("warmth", 2, 0.5), [careAction]);
  const beginWarmSession = useCallback(() => {
    setSave((prev) =>
      prev.isAlive ? { ...prev, feedCount: prev.feedCount + 1 } : prev,
    );
  }, []);
  const feed = useCallback(() => careAction("hunger", 40, 5, "feedCount"), [careAction]);
  const wash = useCallback(() => careAction("cleanliness", 60, 5, "washCount"), [careAction]);
  const pet = useCallback(() => careAction("happiness", 20, 5, "petCount"), [careAction]);
  const throwBall = useCallback(
    () => careAction("happiness", 15, 4, "throwBallCount"),
    [careAction],
  );

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

  const restart = useCallback(() => setSave(freshPetSave({ petType: "cat" })), []);

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
    debugApply,
    debugLoadPreset,
    debugTimeJump,
  };
}
