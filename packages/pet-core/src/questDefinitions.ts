// Quest catalog — ported from ERP_QA_HUB src/utils/petQuestDefinitions.ts.
// NOTE: the legacy STAGE_DAILY_NORMAL_POINT_CAP record ({29,27,33,0}) was dead
// config there (the cap mechanic was removed — see rules.ts) and was not ported.
import type {
  DailyQuestCode,
  PetQuestCode,
  QuestScope,
  WeeklyQuestCode,
} from "./types";

export interface PetQuestDefinition {
  code: PetQuestCode;
  scope: QuestScope;
  title: string;
  description: string;
  rewardPoints: number;
  displayOrder: number;
}

export const DAILY_QUEST_DEFINITIONS: Record<DailyQuestCode, PetQuestDefinition> = {
  balancedCare: {
    code: "balancedCare",
    scope: "daily",
    title: "Balanced Care",
    description:
      "Complete 3 qualified feeds, 3 qualified washes, and 3 qualified pets. Same-type qualified actions must be at least 1 hour apart.",
    rewardPoints: 4,
    displayOrder: 1,
  },
  focusSession: {
    code: "focusSession",
    scope: "daily",
    title: "Focus Session",
    description: "Keep your pet alive, awake, and all stats at 70+ for 120 eligible minutes.",
    rewardPoints: 3,
    displayOrder: 2,
  },
  cleanRun: {
    code: "cleanRun",
    scope: "daily",
    title: "Clean Run",
    description: "Avoid overfeeding from 00:00 until the daily cutoff.",
    rewardPoints: 3,
    displayOrder: 3,
  },
};

// Weekly quests are designed around "4 good days out of 7": every weekly can be
// completed by playing on any 4 days of the week, so skipping days (or a
// weekend) never locks a player out of the reward.
export const WEEKLY_QUEST_TARGET_DAYS = 4;
/** Awake minutes a stat must spend at 50+ for a day to count toward a Guardian quest. */
export const GUARDIAN_MINUTES_PER_DAY = 60;

export const WEEKLY_QUEST_DEFINITIONS: Record<WeeklyQuestCode, PetQuestDefinition> = {
  noOverfeedWeek: {
    code: "noOverfeedWeek",
    scope: "weekly",
    title: "Careful Feeder",
    description: "Feed your pet on 4 different days this week without a single overfeed.",
    rewardPoints: 12,
    displayOrder: 1,
  },
  dailyPlayWeek: {
    code: "dailyPlayWeek",
    scope: "weekly",
    title: "Play Week",
    description: "Throw the ball at least 2 times on 4 different days this week.",
    rewardPoints: 10,
    displayOrder: 2,
  },
  hungerGuardian: {
    code: "hungerGuardian",
    scope: "weekly",
    title: "Hunger Guardian",
    description: "Keep hunger at 50+ for 60 awake minutes on 4 different days this week.",
    rewardPoints: 10,
    displayOrder: 3,
  },
  cleanlinessGuardian: {
    code: "cleanlinessGuardian",
    scope: "weekly",
    title: "Cleanliness Guardian",
    description: "Keep cleanliness at 50+ for 60 awake minutes on 4 different days this week.",
    rewardPoints: 10,
    displayOrder: 4,
  },
  happinessGuardian: {
    code: "happinessGuardian",
    scope: "weekly",
    title: "Happiness Guardian",
    description: "Keep happiness at 50+ for 60 awake minutes on 4 different days this week.",
    rewardPoints: 10,
    displayOrder: 5,
  },
};

export const PET_QUEST_DEFINITIONS = {
  ...DAILY_QUEST_DEFINITIONS,
  ...WEEKLY_QUEST_DEFINITIONS,
} satisfies Record<PetQuestCode, PetQuestDefinition>;

export const DAILY_QUEST_CODES = Object.keys(DAILY_QUEST_DEFINITIONS) as DailyQuestCode[];
export const WEEKLY_QUEST_CODES = Object.keys(WEEKLY_QUEST_DEFINITIONS) as WeeklyQuestCode[];

export function getQuestRewardPoints(code: PetQuestCode): number {
  return PET_QUEST_DEFINITIONS[code].rewardPoints;
}
