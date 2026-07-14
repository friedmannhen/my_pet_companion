// Save-shape construction & normalization — ported from ERP_QA_HUB
// src/utils/petStorage.ts WITHOUT the localStorage IO (persistence is the
// client's / backend's concern; pet-core only owns the shapes).
import type {
  AllSaves,
  DailyQuestCode,
  DailyQuestProgress,
  PetQuestCode,
  PetQuestState,
  PetSaveData,
  PetSettings,
  PetType,
  ProgressionCapProgress,
  QuestClaimState,
  WeeklyQuestCode,
  WeeklyQuestProgress,
} from "./types";
import { PET_TYPES } from "./types";
import { DAILY_QUEST_CODES, WEEKLY_QUEST_CODES } from "./questDefinitions";
import { getQuestPeriodKeys, type WorkCalendar, DEFAULT_CALENDAR } from "./workCalendar";

function initialQuestClaimState(): QuestClaimState {
  return { status: "in_progress" };
}

function initialQuestMap<T extends string>(codes: readonly T[]): Record<T, QuestClaimState> {
  return Object.fromEntries(codes.map((code) => [code, initialQuestClaimState()])) as Record<
    T,
    QuestClaimState
  >;
}

function initialQuestCompletionCounts(): Record<PetQuestCode, number> {
  return Object.fromEntries(
    [...DAILY_QUEST_CODES, ...WEEKLY_QUEST_CODES].map((code) => [code, 0]),
  ) as Record<PetQuestCode, number>;
}

export function freshDailyQuestProgress(dayKey: string): DailyQuestProgress {
  return {
    dayKey,
    quests: initialQuestMap<DailyQuestCode>(DAILY_QUEST_CODES),
    feedQualifiedCount: 0,
    washQualifiedCount: 0,
    petQualifiedCount: 0,
    focusEligibleMinutes: 0,
    hadOverfeedToday: false,
    cleanRunWindowClosed: false,
    bonusAwardedToday: 0,
  };
}

export function freshWeeklyQuestProgress(weekKey: string): WeeklyQuestProgress {
  return {
    weekKey,
    quests: initialQuestMap<WeeklyQuestCode>(WEEKLY_QUEST_CODES),
    hadOverfeedWeek: false,
    playCountByDayKey: {},
    feedDaysByDayKey: {},
    hungerOkMinutesByDayKey: {},
    cleanlinessOkMinutesByDayKey: {},
    happinessOkMinutesByDayKey: {},
    bonusAwardedWeek: 0,
  };
}

export function freshProgressionCapProgress(dayKey: string): ProgressionCapProgress {
  return {
    dayKey,
    normalPointsEarnedToday: 0,
    normalPointsRejectedByCapToday: 0,
  };
}

export function freshPetQuestState(
  date: Date = new Date(),
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): PetQuestState {
  const { dayKey, weekKey } = getQuestPeriodKeys(date, calendar);
  return {
    questSchemaVersion: 1,
    daily: freshDailyQuestProgress(dayKey),
    weekly: freshWeeklyQuestProgress(weekKey),
    cap: freshProgressionCapProgress(dayKey),
    rewardHistory: [],
    completionCounts: initialQuestCompletionCounts(),
  };
}

function normalizeQuestClaimState(value: Partial<QuestClaimState> | undefined): QuestClaimState {
  return {
    status: value?.status ?? "in_progress",
    completedAt: value?.completedAt,
    claimedAt: value?.claimedAt,
    expiredAt: value?.expiredAt,
    awardedPoints: value?.awardedPoints,
    discardedPoints: value?.discardedPoints,
  };
}

export function normalizePetQuestState(
  value: Partial<PetQuestState> | undefined,
  date: Date = new Date(),
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): PetQuestState {
  const fresh = freshPetQuestState(date, calendar);
  const daily = value?.daily;
  const weekly = value?.weekly;
  const cap = value?.cap;
  const hasPersistedCompletionCounts =
    value?.completionCounts && typeof value.completionCounts === "object";
  const completionCounts = hasPersistedCompletionCounts
    ? { ...fresh.completionCounts, ...value.completionCounts }
    : Array.isArray(value?.rewardHistory)
      ? value.rewardHistory.reduce(
          (counts, event) => {
            counts[event.questCode] = (counts[event.questCode] ?? 0) + 1;
            return counts;
          },
          { ...fresh.completionCounts },
        )
      : { ...fresh.completionCounts };

  if (!hasPersistedCompletionCounts) {
    for (const code of DAILY_QUEST_CODES) {
      const state = daily?.quests?.[code];
      if (state?.completedAt && state.status !== "in_progress") {
        completionCounts[code] = Math.max(completionCounts[code] ?? 0, 1);
      }
    }
    for (const code of WEEKLY_QUEST_CODES) {
      const state = weekly?.quests?.[code];
      if (state?.completedAt && state.status !== "in_progress") {
        completionCounts[code] = Math.max(completionCounts[code] ?? 0, 1);
      }
    }
  }

  return {
    questSchemaVersion: 1,
    daily: {
      ...fresh.daily,
      ...daily,
      quests: Object.fromEntries(
        DAILY_QUEST_CODES.map((code) => [code, normalizeQuestClaimState(daily?.quests?.[code])]),
      ) as Record<DailyQuestCode, QuestClaimState>,
    },
    weekly: {
      ...fresh.weekly,
      ...weekly,
      quests: Object.fromEntries(
        WEEKLY_QUEST_CODES.map((code) => [code, normalizeQuestClaimState(weekly?.quests?.[code])]),
      ) as Record<WeeklyQuestCode, QuestClaimState>,
      playCountByDayKey: { ...(weekly?.playCountByDayKey ?? {}) },
      feedDaysByDayKey: { ...(weekly?.feedDaysByDayKey ?? {}) },
      hungerOkMinutesByDayKey: { ...(weekly?.hungerOkMinutesByDayKey ?? {}) },
      cleanlinessOkMinutesByDayKey: { ...(weekly?.cleanlinessOkMinutesByDayKey ?? {}) },
      happinessOkMinutesByDayKey: { ...(weekly?.happinessOkMinutesByDayKey ?? {}) },
    },
    cap: { ...fresh.cap, ...cap },
    rewardHistory: Array.isArray(value?.rewardHistory) ? value.rewardHistory : [],
    completionCounts,
    lastQuestMenuOpenedAt: value?.lastQuestMenuOpenedAt,
  };
}

export function normalizePetSave(
  save: PetSaveData,
  type: PetType = save.petType,
  date: Date = new Date(),
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): PetSaveData {
  return {
    ...save,
    petType: type,
    hatched: save.hatched ?? (save.carePoints ?? 0) >= 200,
    // Saves that predate the egg-picker already have a pet in progress — only
    // a genuinely fresh save (freshPetSave) starts with eggChosen: false.
    eggChosen: save.eggChosen ?? true,
    warmth: save.warmth ?? save.hunger ?? 50,
    carePointsFloor: save.carePointsFloor ?? 0,
    // Eggs don't sleep (they go dormant instead, see replayOfflineGap) — wake
    // any legacy sleeping-egg save on load.
    isSleeping: save.evolutionStage === 0 ? false : save.isSleeping,
    // Legacy saves predate manual/auto sleep distinction — treat any persisted
    // sleep as "auto" (unprotected) since we have no tuck-in start time for it.
    sleepKind: save.isSleeping && save.evolutionStage !== 0 ? (save.sleepKind ?? "auto") : undefined,
    sleepStartedAt: save.isSleeping && save.evolutionStage !== 0 ? save.sleepStartedAt : undefined,
    quests: normalizePetQuestState(save.quests, date, calendar),
    history: Array.isArray(save.history) ? save.history : [],
  };
}

/** Default display name for each pet type. */
export const PET_NAMES: Record<PetType, string> = {
  cat: "Pixel",
  dog: "Rex",
  dino: "Dino",
  dragon: "Ember",
  ghost: "Spooky",
  robot: "Byte",
  phoenix: "Pyra",
};

export const DEFAULT_SETTINGS: PetSettings = {
  mode: "free",
  soundEnabled: true,
  notificationFrequency: "normal",
  showPet: true,
  followSpeed: "normal",
};

/** Create a brand-new save for a pet type (all stats at defaults, fresh timestamps). */
export function freshPetSave(
  overrides?: Partial<PetSaveData>,
  date: Date = new Date(),
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): PetSaveData {
  const type = (overrides?.petType ?? "cat") as PetType;
  const n = date.toISOString();
  const base: PetSaveData = {
    petType: type,
    name: PET_NAMES[type],
    hunger: 50,
    warmth: 50,
    cleanliness: 20,
    happiness: 20,
    evolutionStage: 0,
    carePoints: 0,
    carePointsFloor: 0,
    hatched: false,
    eggChosen: false,

    isAlive: true,
    isSleeping: false,
    feedCount: 0,
    washCount: 0,
    petCount: 0,
    throwBallCount: 0,
    overfeedCount: 0,
    birthDate: n,
    lastDecayTick: n,
    lastFed: n,
    lastWashed: n,
    lastPetted: n,
    lastInteraction: n,
    quests: freshPetQuestState(date, calendar),
    history: [],
  };

  return overrides ? { ...base, ...overrides } : base;
}

/** Build a full AllSaves map with fresh data for every pet type. */
export function freshAllSaves(
  date: Date = new Date(),
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): AllSaves {
  return Object.fromEntries(
    PET_TYPES.map((type) => [type, freshPetSave({ petType: type }, date, calendar)]),
  ) as AllSaves;
}
