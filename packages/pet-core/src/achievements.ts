// Achievements — ported from ERP_QA_HUB src/utils/petAchievements.ts.
// Long-term goals computed from counters that already exist on PetSaveData.
// Once earned they sit "claimable" until the player claims them, at which
// point their reward — a permanent % bonus to a care-point category — applies.
import type { AllSaves } from "./types";

/**
 * Care-point categories a % bonus can apply to:
 * "feed" → feeding/egg-warming, "wash" → washing, "play" → petting & ball throws.
 */
export type AchievementBonusCategory = "feed" | "wash" | "play";

export interface AchievementRewardType {
  category: AchievementBonusCategory;
  /** Percent bonus in 3% steps (3/6/9). */
  percent: 3 | 6 | 9;
}

export type PetAchievementCode =
  | "feed25"
  | "feed100"
  | "feed250"
  | "wash20"
  | "wash80"
  | "wash200"
  | "pet30"
  | "pet120"
  | "pet300"
  | "play30"
  | "play120"
  | "play300"
  | "firstHatch"
  | "allPetsHatched"
  | "firstFinalEvolution"
  | "globalLevel7"
  | "globalLevel14"
  | "quests10"
  | "quests30"
  | "quests60";

export type PetAchievementStatus = "claimable" | "claimed";

export interface PetAchievementEarnedEntry {
  earnedAt: string;
  status: PetAchievementStatus;
  claimedAt?: string;
}

export interface PetAchievementState {
  version: 1;
  earned: Partial<Record<PetAchievementCode, PetAchievementEarnedEntry>>;
}

export function freshAchievementState(): PetAchievementState {
  return { version: 1, earned: {} };
}

export function normalizeAchievementState(value: unknown): PetAchievementState {
  const fresh = freshAchievementState();
  if (!value || typeof value !== "object") return fresh;
  const raw = value as Partial<PetAchievementState> & {
    earned?: Record<
      string,
      { earnedAt?: string; status?: string; claimedAt?: string; rewardApplied?: boolean }
    >;
  };
  if (!raw.earned || typeof raw.earned !== "object") return fresh;

  const earned: PetAchievementState["earned"] = {};
  for (const code of Object.keys(raw.earned) as PetAchievementCode[]) {
    if (!PET_ACHIEVEMENT_DEFINITIONS[code]) continue;
    const entry = raw.earned[code];
    if (!entry?.earnedAt) continue;
    const isLegacy = entry.status === undefined && "rewardApplied" in entry;
    const status: PetAchievementStatus =
      entry.status === "claimed" || entry.status === "claimable"
        ? entry.status
        : isLegacy
          ? "claimed"
          : "claimable";
    earned[code] = {
      earnedAt: entry.earnedAt,
      status,
      claimedAt: entry.claimedAt ?? (status === "claimed" && isLegacy ? entry.earnedAt : undefined),
    };
  }
  return { version: 1, earned };
}

export interface PetAchievementDefinition {
  code: PetAchievementCode;
  title: string;
  description: string;
  icon: string;
  target: number;
  progress: (saves: AllSaves) => number;
  reward: AchievementRewardType;
  displayOrder: number;
}

// ── Cross-pet aggregate helpers (shared with leaderboards / hall of fame) ────

export function sumCounter(
  saves: AllSaves,
  pick: (s: AllSaves[keyof AllSaves]) => number,
): number {
  return Object.values(saves).reduce((total, save) => total + (pick(save) || 0), 0);
}

/** Global level = total evolution stages across all pets (max 21 with 7 pets). */
export function computeGlobalLevel(saves: AllSaves): number {
  return sumCounter(saves, (s) => s.evolutionStage);
}

export function computeTotalInteractions(saves: AllSaves): number {
  return sumCounter(
    saves,
    (s) => (s.feedCount ?? 0) + (s.washCount ?? 0) + (s.petCount ?? 0) + (s.throwBallCount ?? 0),
  );
}

export function computeTotalQuestsCompleted(saves: AllSaves): number {
  return sumCounter(saves, (s) =>
    s.quests?.completionCounts
      ? Object.values(s.quests.completionCounts).reduce((a, b) => a + (b || 0), 0)
      : 0,
  );
}

// ── Definitions ──────────────────────────────────────────────────────────────
// Tiers are sim-validated (ERP_QA_HUB scripts/petBalanceSim.mjs) to unlock
// steadily during the first 1-2 pet lifecycles.

export const PET_ACHIEVEMENT_DEFINITIONS: Record<PetAchievementCode, PetAchievementDefinition> = {
  feed25: {
    code: "feed25",
    title: "Snack Time",
    description: "Feed your pets 25 times in total.",
    icon: "🍖",
    target: 25,
    progress: (saves) => sumCounter(saves, (s) => s.feedCount ?? 0),
    reward: { category: "feed", percent: 3 },
    displayOrder: 1,
  },
  feed100: {
    code: "feed100",
    title: "Regular Diner",
    description: "Feed your pets 100 times in total.",
    icon: "🍗",
    target: 100,
    progress: (saves) => sumCounter(saves, (s) => s.feedCount ?? 0),
    reward: { category: "feed", percent: 3 },
    displayOrder: 2,
  },
  feed250: {
    code: "feed250",
    title: "Master Chef",
    description: "Feed your pets 250 times in total.",
    icon: "👨‍🍳",
    target: 250,
    progress: (saves) => sumCounter(saves, (s) => s.feedCount ?? 0),
    reward: { category: "feed", percent: 3 },
    displayOrder: 3,
  },
  wash20: {
    code: "wash20",
    title: "Rinse Cycle",
    description: "Wash your pets 20 times in total.",
    icon: "🧽",
    target: 20,
    progress: (saves) => sumCounter(saves, (s) => s.washCount ?? 0),
    reward: { category: "wash", percent: 3 },
    displayOrder: 4,
  },
  wash80: {
    code: "wash80",
    title: "Squeaky Clean",
    description: "Wash your pets 80 times in total.",
    icon: "🧼",
    target: 80,
    progress: (saves) => sumCounter(saves, (s) => s.washCount ?? 0),
    reward: { category: "wash", percent: 3 },
    displayOrder: 5,
  },
  wash200: {
    code: "wash200",
    title: "Bubble Master",
    description: "Wash your pets 200 times in total.",
    icon: "🫧",
    target: 200,
    progress: (saves) => sumCounter(saves, (s) => s.washCount ?? 0),
    reward: { category: "wash", percent: 3 },
    displayOrder: 6,
  },
  pet30: {
    code: "pet30",
    title: "Good Boy",
    description: "Pet your companions 30 times in total.",
    icon: "🤗",
    target: 30,
    progress: (saves) => sumCounter(saves, (s) => s.petCount ?? 0),
    reward: { category: "play", percent: 3 },
    displayOrder: 7,
  },
  pet120: {
    code: "pet120",
    title: "Best Friends",
    description: "Pet your companions 120 times in total.",
    icon: "🥰",
    target: 120,
    progress: (saves) => sumCounter(saves, (s) => s.petCount ?? 0),
    reward: { category: "play", percent: 3 },
    displayOrder: 8,
  },
  pet300: {
    code: "pet300",
    title: "Inseparable",
    description: "Pet your companions 300 times in total.",
    icon: "💞",
    target: 300,
    progress: (saves) => sumCounter(saves, (s) => s.petCount ?? 0),
    reward: { category: "play", percent: 3 },
    displayOrder: 9,
  },
  play30: {
    code: "play30",
    title: "Fetch!",
    description: "Throw the ball 30 times in total.",
    icon: "⚾",
    target: 30,
    progress: (saves) => sumCounter(saves, (s) => s.throwBallCount ?? 0),
    reward: { category: "play", percent: 3 },
    displayOrder: 10,
  },
  play120: {
    code: "play120",
    title: "Play Ball!",
    description: "Throw the ball 120 times in total.",
    icon: "🎾",
    target: 120,
    progress: (saves) => sumCounter(saves, (s) => s.throwBallCount ?? 0),
    reward: { category: "play", percent: 3 },
    displayOrder: 11,
  },
  play300: {
    code: "play300",
    title: "MVP",
    description: "Throw the ball 300 times in total.",
    icon: "🏆",
    target: 300,
    progress: (saves) => sumCounter(saves, (s) => s.throwBallCount ?? 0),
    reward: { category: "play", percent: 3 },
    displayOrder: 12,
  },
  firstHatch: {
    code: "firstHatch",
    title: "New Life",
    description: "Hatch your first egg.",
    icon: "🐣",
    target: 1,
    progress: (saves) => (Object.values(saves).some((s) => s.hatched) ? 1 : 0),
    reward: { category: "feed", percent: 3 },
    displayOrder: 13,
  },
  allPetsHatched: {
    code: "allPetsHatched",
    title: "Full Nest",
    description: "Hatch every pet type at least once.",
    icon: "🏡",
    target: 7,
    progress: (saves) => Object.values(saves).filter((s) => s.hatched).length,
    reward: { category: "feed", percent: 6 },
    displayOrder: 14,
  },
  firstFinalEvolution: {
    code: "firstFinalEvolution",
    title: "Final Form",
    description: "Evolve any pet to its final stage.",
    icon: "🌟",
    target: 1,
    progress: (saves) => (Object.values(saves).some((s) => s.evolutionStage === 3) ? 1 : 0),
    reward: { category: "play", percent: 9 },
    displayOrder: 15,
  },
  globalLevel7: {
    code: "globalLevel7",
    title: "Rising Trainer",
    description: "Reach global level 7 (total evolution stages across all pets).",
    icon: "📈",
    target: 7,
    progress: computeGlobalLevel,
    reward: { category: "wash", percent: 6 },
    displayOrder: 16,
  },
  globalLevel14: {
    code: "globalLevel14",
    title: "Elite Trainer",
    description: "Reach global level 14 (total evolution stages across all pets).",
    icon: "🏅",
    target: 14,
    progress: computeGlobalLevel,
    reward: { category: "play", percent: 9 },
    displayOrder: 17,
  },
  quests10: {
    code: "quests10",
    title: "Adventurer",
    description: "Complete 10 quests in total.",
    icon: "🗺️",
    target: 10,
    progress: computeTotalQuestsCompleted,
    reward: { category: "feed", percent: 3 },
    displayOrder: 18,
  },
  quests30: {
    code: "quests30",
    title: "Seasoned Adventurer",
    description: "Complete 30 quests in total.",
    icon: "🧭",
    target: 30,
    progress: computeTotalQuestsCompleted,
    reward: { category: "wash", percent: 6 },
    displayOrder: 19,
  },
  quests60: {
    code: "quests60",
    title: "Legendary Adventurer",
    description: "Complete 60 quests in total.",
    icon: "⚔️",
    target: 60,
    progress: computeTotalQuestsCompleted,
    reward: { category: "play", percent: 9 },
    displayOrder: 20,
  },
};

export const PET_ACHIEVEMENT_CODES = (
  Object.keys(PET_ACHIEVEMENT_DEFINITIONS) as PetAchievementCode[]
).sort(
  (a, b) => PET_ACHIEVEMENT_DEFINITIONS[a].displayOrder - PET_ACHIEVEMENT_DEFINITIONS[b].displayOrder,
);

// ── Evaluation ───────────────────────────────────────────────────────────────

/** Codes whose target is reached but that are not yet in the earned map (become "claimable"). */
export function evaluateAchievements(
  saves: AllSaves,
  state: PetAchievementState | undefined,
): PetAchievementCode[] {
  const earned = state?.earned ?? {};
  return PET_ACHIEVEMENT_CODES.filter((code) => {
    if (earned[code]) return false;
    const def = PET_ACHIEVEMENT_DEFINITIONS[code];
    return def.progress(saves) >= def.target;
  });
}

export function countClaimableAchievements(state: PetAchievementState | undefined): number {
  if (!state) return 0;
  return Object.values(state.earned).filter((entry) => entry?.status === "claimable").length;
}

/** Combined care-point % bonus per category from CLAIMED achievement rewards only. */
export function computeCategoryBonusPercents(
  state: PetAchievementState | undefined,
): Record<AchievementBonusCategory, number> {
  const totals: Record<AchievementBonusCategory, number> = { feed: 0, wash: 0, play: 0 };
  if (!state) return totals;
  for (const code of Object.keys(state.earned) as PetAchievementCode[]) {
    const entry = state.earned[code];
    if (entry?.status !== "claimed") continue;
    const reward = PET_ACHIEVEMENT_DEFINITIONS[code]?.reward;
    if (reward) totals[reward.category] += reward.percent;
  }
  return totals;
}

/** Category bonus expressed as a multiplier (e.g. 9% -> 1.09) for use in point math. */
export function computeCategoryBonusMultipliers(
  state: PetAchievementState | undefined,
): Record<AchievementBonusCategory, number> {
  const percents = computeCategoryBonusPercents(state);
  return {
    feed: 1 + percents.feed / 100,
    wash: 1 + percents.wash / 100,
    play: 1 + percents.play / 100,
  };
}

/** Star math: 1 full star = 6%, half star = 3% (e.g. 15% -> 2 full + 1 half). */
export function percentToStars(percent: number): { full: number; half: number } {
  const steps = Math.round(Math.max(0, percent) / 3); // each step = 3%
  return { full: Math.floor(steps / 2), half: steps % 2 };
}

/** Human label for the actions a bonus category boosts. */
export function describeBonusActions(category: AchievementBonusCategory): string {
  return category === "feed" ? "feeding" : category === "wash" ? "washing" : "petting & playing";
}

export function describeReward(reward: AchievementRewardType): string {
  return `+${reward.percent}% care points when ${describeBonusActions(reward.category)}`;
}
