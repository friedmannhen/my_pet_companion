// Runtime balance rules — ported from ERP_QA_HUB src/config/petRuntimeRules.ts.
// The env-var-gated admin-override machinery was NOT ported: pet-core is pure,
// so overrides are an explicit `mergePetRules(overrides)` call and the CALLER
// (e.g. the dev-only admin panel, never a production build) decides when to
// pass them. Edge Functions always use DEFAULT_PET_RULES.
import type { EvolutionStage } from "./types";

export type EvolutionThresholds = readonly [number, number, number, number];

export interface PetStatDecayRules {
  hunger: number;
  cleanliness: number;
  happiness: number;
}

export interface PetSleepDecayRules {
  hunger: number;
}

export interface PetActionCooldownRules {
  petMs: number;
  qualifiedActionGapMs: number;
}

export interface PetQuestRuntimeRules {
  focusMinutesRequired: number;
}

export interface PetEggOverheatRules {
  /** Grace window after warmth hits 100% before overwarming penalties start. */
  graceMs: number;
}

export interface PetSleepRules {
  /** How long a manual "tuck-in" sleep protects the pet (stats floored, no care-point drain). */
  protectedMaxMs: number;
  /** Stats can't decay below this value while protected sleep is active. */
  protectedStatFloor: number;
}

export interface PetCarePointDecayRules {
  /** Care points lost per minute for EACH stat sitting at exactly 0
   *  (2026-07-20 rebalance: neglect only costs care points once a stat has
   *  fully bottomed out — low-but-nonzero stats cost nothing). At 0.05
   *  that's 3 pts/hour per empty stat, 72/day — slow but real, and still
   *  bounded by carePointsFloor. */
  perMinutePerZeroStat: number;
}

export interface PetProgressionRuntimeRules {
  disableDailyNormalCap: boolean;
  disableCarePointBoundary: boolean;
  disableCarePointDecay: boolean;
  disableStatDecay: boolean;
}

export interface PetRuntimeRules {
  evolutionThresholds: EvolutionThresholds;
  stageDailyNormalPointCap: Record<EvolutionStage, number>;
  decay: PetStatDecayRules;
  sleepDecay: PetSleepDecayRules;
  autoSleepMs: number;
  actionCooldowns: PetActionCooldownRules;
  quest: PetQuestRuntimeRules;
  eggOverheat: PetEggOverheatRules;
  sleep: PetSleepRules;
  carePointDecay: PetCarePointDecayRules;
  progression: PetProgressionRuntimeRules;
}

// Thresholds tuned by ERP_QA_HUB scripts/petBalanceSim.mjs with the daily cap
// removed: a "regular" player (8h/day, ~6 care visits/day, weekdays) without
// quest bonuses hatches in 5 active days, reaches adult ~day 16 and final ~day 45.
export const DEFAULT_EGG_HATCH_POINTS = 450;

export const DEFAULT_EVOLUTION_THRESHOLDS: EvolutionThresholds = [
  0,
  DEFAULT_EGG_HATCH_POINTS,
  1200,
  3500,
];

/**
 * Legacy daily normal-point cap — the cap mechanic was removed in favor of
 * larger stage thresholds; kept only so save schemas stay compatible.
 * (The stale {29,27,33,0} record in ERP_QA_HUB petQuestDefinitions.ts was dead
 * config and was deliberately NOT ported — this no-cap version is authoritative.)
 */
export const DEFAULT_STAGE_DAILY_NORMAL_POINT_CAP: Record<EvolutionStage, number> = {
  0: Number.MAX_SAFE_INTEGER,
  1: Number.MAX_SAFE_INTEGER,
  2: Number.MAX_SAFE_INTEGER,
  3: Number.MAX_SAFE_INTEGER,
};

export const DEFAULT_PET_RULES: PetRuntimeRules = {
  evolutionThresholds: DEFAULT_EVOLUTION_THRESHOLDS,
  stageDailyNormalPointCap: DEFAULT_STAGE_DAILY_NORMAL_POINT_CAP,
  decay: {
    hunger: 0.5,
    cleanliness: 1,
    happiness: 0.5,
  },
  sleepDecay: {
    hunger: 1 / 15,
  },
  autoSleepMs: 60 * 60_000,
  actionCooldowns: {
    petMs: 5 * 60 * 1000,
    qualifiedActionGapMs: 60 * 60_000,
  },
  quest: {
    focusMinutesRequired: 120,
  },
  eggOverheat: {
    graceMs: 1000,
  },
  sleep: {
    protectedMaxMs: 72 * 3600_000,
    protectedStatFloor: 10,
  },
  carePointDecay: {
    perMinutePerZeroStat: 0.05,
  },
  progression: {
    disableDailyNormalCap: false,
    disableCarePointBoundary: false,
    disableCarePointDecay: false,
    disableStatDecay: false,
  },
};

export interface PetRuleOverrides {
  disableDailyNormalCap?: boolean;
  disableCarePointBoundary?: boolean;
  disableCarePointDecay?: boolean;
  disableStatDecay?: boolean;
  evolutionThresholds?: EvolutionThresholds;
  stageDailyNormalPointCap?: Partial<Record<EvolutionStage, number>>;
  decay?: Partial<PetStatDecayRules>;
  sleepDecay?: Partial<PetSleepDecayRules>;
  autoSleepMs?: number;
  actionCooldowns?: Partial<PetActionCooldownRules>;
  quest?: Partial<PetQuestRuntimeRules>;
  sleep?: Partial<PetSleepRules>;
  carePointDecay?: Partial<PetCarePointDecayRules>;
}

/** Pure merge of dev/test overrides onto the defaults. Callers gate WHEN this runs. */
export function mergePetRules(overrides?: PetRuleOverrides): PetRuntimeRules {
  if (!overrides) return DEFAULT_PET_RULES;

  const stageDailyNormalPointCap = {
    ...DEFAULT_PET_RULES.stageDailyNormalPointCap,
    ...overrides.stageDailyNormalPointCap,
  };
  if (overrides.disableDailyNormalCap) {
    stageDailyNormalPointCap[0] = Number.MAX_SAFE_INTEGER;
    stageDailyNormalPointCap[1] = Number.MAX_SAFE_INTEGER;
    stageDailyNormalPointCap[2] = Number.MAX_SAFE_INTEGER;
    stageDailyNormalPointCap[3] = Number.MAX_SAFE_INTEGER;
  }

  return {
    evolutionThresholds: overrides.evolutionThresholds ?? DEFAULT_PET_RULES.evolutionThresholds,
    stageDailyNormalPointCap,
    decay: { ...DEFAULT_PET_RULES.decay, ...overrides.decay },
    sleepDecay: { ...DEFAULT_PET_RULES.sleepDecay, ...overrides.sleepDecay },
    autoSleepMs: overrides.autoSleepMs ?? DEFAULT_PET_RULES.autoSleepMs,
    actionCooldowns: { ...DEFAULT_PET_RULES.actionCooldowns, ...overrides.actionCooldowns },
    quest: { ...DEFAULT_PET_RULES.quest, ...overrides.quest },
    eggOverheat: { ...DEFAULT_PET_RULES.eggOverheat },
    sleep: { ...DEFAULT_PET_RULES.sleep, ...overrides.sleep },
    carePointDecay: { ...DEFAULT_PET_RULES.carePointDecay, ...overrides.carePointDecay },
    progression: {
      disableDailyNormalCap:
        overrides.disableDailyNormalCap ?? DEFAULT_PET_RULES.progression.disableDailyNormalCap,
      disableCarePointBoundary:
        overrides.disableCarePointBoundary ?? DEFAULT_PET_RULES.progression.disableCarePointBoundary,
      disableCarePointDecay:
        overrides.disableCarePointDecay ?? DEFAULT_PET_RULES.progression.disableCarePointDecay,
      disableStatDecay:
        overrides.disableStatDecay ?? DEFAULT_PET_RULES.progression.disableStatDecay,
    },
  };
}
