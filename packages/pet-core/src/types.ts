// Core domain types — ported from ERP_QA_HUB src/types/pet.ts.
// Framework-agnostic: no React/DOM/storage references.

export const PET_TYPES = [
  "cat",
  "dog",
  "dino",
  "dragon",
  "ghost",
  "robot",
  "phoenix",
] as const;
export type PetType = (typeof PET_TYPES)[number];

/** Pets shipping in the MVP roster (the two with real art). */
export const MVP_PET_TYPES: readonly PetType[] = ["cat", "phoenix"];

export type EvolutionStage = 0 | 1 | 2 | 3;

export type PetAnimState =
  | "idle"
  | "walk"
  | "eat"
  | "hungry"
  | "dirty"
  | "happy"
  | "wash"
  | "fetch"
  | "sleep"
  | "dead"
  | "evolve"
  | "overfed"
  | "overheated";

export type QuestScope = "daily" | "weekly";
export type QuestStatus = "in_progress" | "claimable" | "claimed" | "expired";

export type DailyQuestCode = "balancedCare" | "focusSession" | "cleanRun";
export type WeeklyQuestCode =
  | "noOverfeedWeek"
  | "dailyPlayWeek"
  | "hungerGuardian"
  | "cleanlinessGuardian"
  | "happinessGuardian";
export type PetQuestCode = DailyQuestCode | WeeklyQuestCode;

export interface QuestClaimState {
  status: QuestStatus;
  completedAt?: string;
  claimedAt?: string;
  expiredAt?: string;
  awardedPoints?: number;
  discardedPoints?: number;
}

export interface DailyQuestProgress {
  dayKey: string;
  quests: Record<DailyQuestCode, QuestClaimState>;
  feedQualifiedCount: number;
  washQualifiedCount: number;
  petQualifiedCount: number;
  lastQualifiedFeedAt?: string;
  lastQualifiedWashAt?: string;
  lastQualifiedPetAt?: string;
  focusEligibleMinutes: number;
  hadOverfeedToday: boolean;
  cleanRunWindowClosed: boolean;
  bonusAwardedToday: number;
}

export interface WeeklyQuestProgress {
  weekKey: string;
  quests: Record<WeeklyQuestCode, QuestClaimState>;
  hadOverfeedWeek: boolean;
  playCountByDayKey: Record<string, number>;
  /** Meaningful feeds per dayKey — drives the weekly feeding quest (4 distinct days). */
  feedDaysByDayKey: Record<string, number>;
  /** Awake minutes per dayKey each stat spent at 50+ — drives the Guardian quests. */
  hungerOkMinutesByDayKey: Record<string, number>;
  cleanlinessOkMinutesByDayKey: Record<string, number>;
  happinessOkMinutesByDayKey: Record<string, number>;
  bonusAwardedWeek: number;
}

export interface ProgressionCapProgress {
  dayKey: string;
  normalPointsEarnedToday: number;
  normalPointsRejectedByCapToday: number;
}

export interface QuestRewardEvent {
  id: string;
  questCode: PetQuestCode;
  scope: QuestScope;
  periodKey: string;
  statusAtClose: "claimed" | "expired";
  awardedPoints: number;
  discardedPoints: number;
  completedAt?: string;
  claimedAt?: string;
  expiredAt?: string;
}

export interface PetQuestState {
  questSchemaVersion: 1;
  daily: DailyQuestProgress;
  weekly: WeeklyQuestProgress;
  cap: ProgressionCapProgress;
  rewardHistory: QuestRewardEvent[];
  completionCounts: Record<PetQuestCode, number>;
  lastQuestMenuOpenedAt?: string;
}

export interface PetSaveData {
  petType: PetType;
  name: string;
  hunger: number; // 0–100 (0 = dead from starvation)
  /** Egg-only incubator warmth meter. Used while evolutionStage === 0 instead of hunger. */
  warmth: number; // 0–100 (0 = dead from cold in egg phase)
  cleanliness: number; // 0–100
  happiness: number; // 0–100
  evolutionStage: EvolutionStage;
  carePoints: number; // accumulates for evolution
  /** Minimum carePoints can decay to — set to the stage threshold once evolved/hatched. */
  carePointsFloor?: number;
  /** True once the pet has hatched from its egg (manual hatch at 200 care points). */
  hatched?: boolean;
  /** True once the player has picked their starter egg on first launch. Existing saves are treated as already-chosen (see normalizePetSave). */
  eggChosen?: boolean;

  lastFed: string; // ISO string
  lastWashed: string;
  lastPetted: string;
  birthDate: string;
  lastDecayTick: string;
  isAlive: boolean;
  isSleeping: boolean;
  /** Distinguishes a manual "tuck-in" (protected) from an idle auto-sleep. Undefined while awake. */
  sleepKind?: "manual" | "auto";
  /** ISO timestamp when the current sleep started — drives the manual-sleep protection window. */
  sleepStartedAt?: string;
  lastInteraction: string; // ISO — tracks idle time for auto-sleep
  feedCount: number;
  washCount: number;
  petCount: number;
  throwBallCount: number;
  overfeedCount: number;
  /** Poops cleaned up (dragged to the trash can). Cloud-synced like the
   *  other counters — future achievements/statistics will key off it. */
  poopCleanedCount: number;
  quests?: PetQuestState;
  history?: HistoryEntry[];
}

export type HistoryEventCategory = "care" | "quest" | "achievement" | "evolution" | "penalty" | "social";

/** A single timestamped, human-readable log entry — "what happened and what changed". */
export interface HistoryEntry {
  id: string;
  at: string; // ISO timestamp
  category: HistoryEventCategory;
  label: string;
  statKey?: string;
  before?: number;
  after?: number;
  delta?: number;
}

export type AllSaves = Record<PetType, PetSaveData>;

export interface PetSettings {
  mode: "static" | "free";
  soundEnabled: boolean;
  notificationFrequency: "always" | "normal" | "silent";
  showPet: boolean;
  followSpeed: "slow" | "normal" | "fast";
}
