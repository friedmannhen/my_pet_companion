// Quest engine — ported from ERP_QA_HUB src/contexts/PetContext.tsx's inline
// quest logic (normalizeQuestPeriods / recordBalancedCareAction /
// evaluatePassiveQuests / claim handling) as pure functions taking explicit
// rules + calendar. Same design decisions as the hub:
// - Daily quests expire unclaimed at the day rollover; weeklies at the week
//   rollover (both close as "expired" with their reward discarded, recorded
//   in rewardHistory).
// - "Qualified" same-type actions must be >= qualifiedActionGapMs apart.
// - Weeklies are "4 good days out of 7" (WEEKLY_QUEST_TARGET_DAYS) so a
//   skipped weekend never locks a player out.
// - Claiming awards the reward as care points (bounded by the evolution
//   boundary like all point gains).
import type {
  DailyQuestCode,
  PetQuestCode,
  PetSaveData,
  QuestClaimState,
  QuestRewardEvent,
  WeeklyQuestCode,
} from "./types";
import {
  DAILY_QUEST_CODES,
  GUARDIAN_MINUTES_PER_DAY,
  PET_QUEST_DEFINITIONS,
  WEEKLY_QUEST_CODES,
  WEEKLY_QUEST_TARGET_DAYS,
  getQuestRewardPoints,
} from "./questDefinitions";
import {
  freshDailyQuestProgress,
  freshProgressionCapProgress,
  freshWeeklyQuestProgress,
  normalizePetQuestState,
} from "./save";
import { clampCarePointsForProgress } from "./decay";
import type { PetRuntimeRules } from "./rules";
import {
  DEFAULT_CALENDAR,
  getDayKey,
  getWeekKey,
  hasPassedDailyCutoff,
  type WorkCalendar,
} from "./workCalendar";

const QUEST_HISTORY_LIMIT = 80;

function questEventId(
  code: PetQuestCode,
  periodKey: string,
  status: "claimed" | "expired",
  iso: string,
): string {
  return `${periodKey}:${code}:${status}:${iso}`;
}

function markClaimable(
  state: QuestClaimState | undefined,
  code: PetQuestCode,
  completionCounts: Record<PetQuestCode, number>,
  iso: string,
): { nextState: QuestClaimState; completionCounts: Record<PetQuestCode, number> } {
  const current = state ?? { status: "in_progress" as const };
  if (current.status !== "in_progress") {
    return { nextState: current, completionCounts };
  }
  return {
    nextState: { ...current, status: "claimable", completedAt: iso },
    completionCounts: {
      ...completionCounts,
      [code]: (completionCounts[code] ?? 0) + 1,
    },
  };
}

function closeExpiredQuest(
  state: QuestClaimState | undefined,
  code: PetQuestCode,
  scope: "daily" | "weekly",
  periodKey: string,
  iso: string,
): { nextState: QuestClaimState; event: QuestRewardEvent } | null {
  if (state?.status !== "claimable") return null;
  const reward = getQuestRewardPoints(code);
  return {
    nextState: {
      ...state,
      status: "expired",
      expiredAt: iso,
      awardedPoints: 0,
      discardedPoints: reward,
    },
    event: {
      id: questEventId(code, periodKey, "expired", iso),
      questCode: code,
      scope,
      periodKey,
      statusAtClose: "expired",
      awardedPoints: 0,
      discardedPoints: reward,
      completedAt: state.completedAt,
      expiredAt: iso,
    },
  };
}

/**
 * Rolls quest periods forward when the day/week key has changed since the
 * save was last touched: claimable-but-unclaimed quests expire (reward
 * discarded, history recorded) and fresh period progress starts. Idempotent
 * within a period — safe to call at the top of every quest mutation.
 */
export function normalizeQuestPeriods(
  save: PetSaveData,
  date: Date = new Date(),
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): PetSaveData {
  let quests = normalizePetQuestState(save.quests, date, calendar);
  const dayKey = getDayKey(date, calendar);
  const weekKey = getWeekKey(date, calendar);
  const iso = date.toISOString();
  const rewardHistory = [...quests.rewardHistory];

  if (quests.daily.dayKey !== dayKey) {
    const dailyQuests = { ...quests.daily.quests };
    for (const code of DAILY_QUEST_CODES) {
      const closed = closeExpiredQuest(dailyQuests[code], code, "daily", quests.daily.dayKey, iso);
      if (closed) {
        dailyQuests[code] = closed.nextState;
        rewardHistory.unshift(closed.event);
      }
    }
    quests = {
      ...quests,
      daily: freshDailyQuestProgress(dayKey),
      cap: freshProgressionCapProgress(dayKey),
      rewardHistory: rewardHistory.slice(0, QUEST_HISTORY_LIMIT),
    };
  } else if (quests.cap.dayKey !== dayKey) {
    quests = { ...quests, cap: freshProgressionCapProgress(dayKey) };
  }

  if (quests.weekly.weekKey !== weekKey) {
    // Weeklies complete mid-week the moment their 4-day requirement is met,
    // so rollover only needs to expire whatever was left unclaimed.
    const weeklyQuests = { ...quests.weekly.quests };
    for (const code of WEEKLY_QUEST_CODES) {
      const closed = closeExpiredQuest(
        weeklyQuests[code],
        code,
        "weekly",
        quests.weekly.weekKey,
        iso,
      );
      if (closed) {
        weeklyQuests[code] = closed.nextState;
        rewardHistory.unshift(closed.event);
      }
    }
    quests = {
      ...quests,
      weekly: freshWeeklyQuestProgress(weekKey),
      rewardHistory: rewardHistory.slice(0, QUEST_HISTORY_LIMIT),
    };
  }

  return { ...save, quests };
}

function shouldCountQualifiedAction(
  lastIso: string | undefined,
  now: Date,
  rules: PetRuntimeRules,
): boolean {
  if (!lastIso) return true;
  return now.getTime() - new Date(lastIso).getTime() >= rules.actionCooldowns.qualifiedActionGapMs;
}

/** Days in a per-dayKey counter map that reached the given minimum. */
export function countQualifiedDays(map: Record<string, number>, min: number): number {
  return Object.values(map).filter((value) => value >= min).length;
}

/**
 * Records a feed/wash/pet toward Balanced Care (3+3+3 qualified actions,
 * same-type actions >= 1h apart) and — for qualified feeds — toward the
 * weekly Careful Feeder (4 distinct feed days, no overfeed all week).
 * `qualified` should be false when the action was hollow (stat already
 * full / overfeed) so it can't farm quest progress.
 */
export function recordCareActionQuestProgress(
  prev: PetSaveData,
  action: "feed" | "wash" | "pet",
  rules: PetRuntimeRules,
  date: Date = new Date(),
  calendar: WorkCalendar = DEFAULT_CALENDAR,
  qualified = true,
): PetSaveData {
  const normalized = normalizeQuestPeriods(prev, date, calendar);
  const quests = normalized.quests!;
  const iso = date.toISOString();
  const daily = { ...quests.daily, quests: { ...quests.daily.quests } };

  if (qualified) {
    if (action === "feed" && shouldCountQualifiedAction(daily.lastQualifiedFeedAt, date, rules)) {
      daily.feedQualifiedCount += 1;
      daily.lastQualifiedFeedAt = iso;
    }
    if (action === "wash" && shouldCountQualifiedAction(daily.lastQualifiedWashAt, date, rules)) {
      daily.washQualifiedCount += 1;
      daily.lastQualifiedWashAt = iso;
    }
    if (action === "pet" && shouldCountQualifiedAction(daily.lastQualifiedPetAt, date, rules)) {
      daily.petQualifiedCount += 1;
      daily.lastQualifiedPetAt = iso;
    }
  }

  let completionCounts = { ...quests.completionCounts };

  if (daily.feedQualifiedCount >= 3 && daily.washQualifiedCount >= 3 && daily.petQualifiedCount >= 3) {
    const result = markClaimable(daily.quests.balancedCare, "balancedCare", completionCounts, iso);
    daily.quests.balancedCare = result.nextState;
    completionCounts = result.completionCounts;
  }

  let weekly = quests.weekly;
  if (action === "feed" && qualified) {
    const dayKey = getDayKey(date, calendar);
    weekly = {
      ...weekly,
      quests: { ...weekly.quests },
      feedDaysByDayKey: {
        ...weekly.feedDaysByDayKey,
        [dayKey]: (weekly.feedDaysByDayKey[dayKey] ?? 0) + 1,
      },
    };
    if (
      !weekly.hadOverfeedWeek &&
      Object.keys(weekly.feedDaysByDayKey).length >= WEEKLY_QUEST_TARGET_DAYS
    ) {
      const result = markClaimable(weekly.quests.noOverfeedWeek, "noOverfeedWeek", completionCounts, iso);
      weekly.quests.noOverfeedWeek = result.nextState;
      completionCounts = result.completionCounts;
    }
  }

  return { ...normalized, quests: { ...quests, daily, weekly, completionCounts } };
}

/** Ball throws count toward Play Week (2+ throws on 4 distinct days). */
export function recordThrowBallQuestProgress(
  prev: PetSaveData,
  date: Date = new Date(),
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): PetSaveData {
  const normalized = normalizeQuestPeriods(prev, date, calendar);
  const quests = normalized.quests!;
  const dayKey = getDayKey(date, calendar);
  const iso = date.toISOString();
  const weekly = {
    ...quests.weekly,
    quests: { ...quests.weekly.quests },
    playCountByDayKey: {
      ...quests.weekly.playCountByDayKey,
      [dayKey]: (quests.weekly.playCountByDayKey[dayKey] ?? 0) + 1,
    },
  };

  let completionCounts = { ...quests.completionCounts };
  if (countQualifiedDays(weekly.playCountByDayKey, 2) >= WEEKLY_QUEST_TARGET_DAYS) {
    const result = markClaimable(weekly.quests.dailyPlayWeek, "dailyPlayWeek", completionCounts, iso);
    weekly.quests.dailyPlayWeek = result.nextState;
    completionCounts = result.completionCounts;
  }

  return { ...normalized, quests: { ...quests, weekly, completionCounts } };
}

/** Overfeeding fails today's Clean Run and this week's Careful Feeder. */
export function markOverfeedQuestFailure(
  prev: PetSaveData,
  date: Date = new Date(),
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): PetSaveData {
  const normalized = normalizeQuestPeriods(prev, date, calendar);
  const quests = normalized.quests!;
  return {
    ...normalized,
    quests: {
      ...quests,
      daily: { ...quests.daily, hadOverfeedToday: true },
      weekly: { ...quests.weekly, hadOverfeedWeek: true },
    },
  };
}

/**
 * Time-based quest progress, called from the decay/tick path with how many
 * awake minutes elapsed: Guardian per-day stat minutes, Focus Session
 * eligible minutes, and the Clean Run daily-cutoff close.
 */
export function evaluatePassiveQuests(
  prev: PetSaveData,
  rules: PetRuntimeRules,
  date: Date = new Date(),
  calendar: WorkCalendar = DEFAULT_CALENDAR,
  eligibleMinutes = 1,
): PetSaveData {
  const normalized = normalizeQuestPeriods(prev, date, calendar);
  const quests = normalized.quests!;
  const iso = date.toISOString();
  const dayKey = getDayKey(date, calendar);
  let daily = { ...quests.daily, quests: { ...quests.daily.quests } };

  // Guardian quests: while the pet is awake and alive, each stat at 50+
  // accrues minutes toward today's counter (capped at the per-day
  // requirement). A day qualifies at GUARDIAN_MINUTES_PER_DAY; the quest
  // completes on the 4th qualified day of the week.
  const guardianActive = normalized.isAlive && !normalized.isSleeping && eligibleMinutes > 0;
  const accrueGuardianMinutes = (
    map: Record<string, number>,
    statOk: boolean,
  ): Record<string, number> =>
    guardianActive && statOk
      ? { ...map, [dayKey]: Math.min(GUARDIAN_MINUTES_PER_DAY, (map[dayKey] ?? 0) + eligibleMinutes) }
      : map;
  const primaryNeed = normalized.evolutionStage === 0 ? normalized.warmth : normalized.hunger;

  const weekly = {
    ...quests.weekly,
    quests: { ...quests.weekly.quests },
    hungerOkMinutesByDayKey: accrueGuardianMinutes(
      quests.weekly.hungerOkMinutesByDayKey,
      primaryNeed >= 50,
    ),
    cleanlinessOkMinutesByDayKey: accrueGuardianMinutes(
      quests.weekly.cleanlinessOkMinutesByDayKey,
      normalized.cleanliness >= 50,
    ),
    happinessOkMinutesByDayKey: accrueGuardianMinutes(
      quests.weekly.happinessOkMinutesByDayKey,
      normalized.happiness >= 50,
    ),
  };

  if (
    normalized.isAlive &&
    !normalized.isSleeping &&
    normalized.hunger >= 70 &&
    normalized.cleanliness >= 70 &&
    normalized.happiness >= 70
  ) {
    daily.focusEligibleMinutes = Math.min(
      rules.quest.focusMinutesRequired,
      daily.focusEligibleMinutes + eligibleMinutes,
    );
  }

  let completionCounts = { ...quests.completionCounts };

  if (daily.focusEligibleMinutes >= rules.quest.focusMinutesRequired) {
    const result = markClaimable(daily.quests.focusSession, "focusSession", completionCounts, iso);
    daily.quests.focusSession = result.nextState;
    completionCounts = result.completionCounts;
  }

  if (hasPassedDailyCutoff(date, calendar) && !daily.cleanRunWindowClosed) {
    const cleanRunResult = daily.hadOverfeedToday
      ? null
      : markClaimable(daily.quests.cleanRun, "cleanRun", completionCounts, iso);
    if (cleanRunResult) completionCounts = cleanRunResult.completionCounts;
    daily = {
      ...daily,
      cleanRunWindowClosed: true,
      quests: {
        ...daily.quests,
        cleanRun: cleanRunResult ? cleanRunResult.nextState : daily.quests.cleanRun,
      },
    };
  }

  const guardianChecks: Array<[WeeklyQuestCode, Record<string, number>]> = [
    ["hungerGuardian", weekly.hungerOkMinutesByDayKey],
    ["cleanlinessGuardian", weekly.cleanlinessOkMinutesByDayKey],
    ["happinessGuardian", weekly.happinessOkMinutesByDayKey],
  ];
  for (const [code, minutesByDay] of guardianChecks) {
    if (countQualifiedDays(minutesByDay, GUARDIAN_MINUTES_PER_DAY) >= WEEKLY_QUEST_TARGET_DAYS) {
      const result = markClaimable(weekly.quests[code], code, completionCounts, iso);
      weekly.quests[code] = result.nextState;
      completionCounts = result.completionCounts;
    }
  }

  return { ...normalized, quests: { ...quests, daily, weekly, completionCounts } };
}

/**
 * Claims a claimable quest: awards its reward as care points (bounded by the
 * pending evolution boundary) and records the claim in rewardHistory.
 * Returns the save unchanged (but period-normalized) if the quest isn't
 * claimable. NOTE: with multiple pets, mirror the claim onto the other saves
 * (hub's propagateQuestClaim) so switching pets can't double-claim — the MVP
 * has a single active pet, so that arrives with the multi-pet roster.
 */
export function claimQuestReward(
  prev: PetSaveData,
  code: PetQuestCode,
  rules: PetRuntimeRules,
  date: Date = new Date(),
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): PetSaveData {
  const normalized = normalizeQuestPeriods(prev, date, calendar);
  const quests = normalized.quests!;
  const iso = date.toISOString();
  const definition = PET_QUEST_DEFINITIONS[code];
  const reward = definition.rewardPoints;

  if (definition.scope === "daily") {
    const current = quests.daily.quests[code as DailyQuestCode];
    if (current?.status !== "claimable") return normalized;
    return {
      ...normalized,
      carePoints: clampCarePointsForProgress(normalized, normalized.carePoints + reward, rules),
      lastInteraction: iso,
      quests: {
        ...quests,
        daily: {
          ...quests.daily,
          bonusAwardedToday: quests.daily.bonusAwardedToday + reward,
          quests: {
            ...quests.daily.quests,
            [code]: { ...current, status: "claimed", claimedAt: iso, awardedPoints: reward, discardedPoints: 0 },
          },
        },
        rewardHistory: [
          {
            id: questEventId(code, quests.daily.dayKey, "claimed", iso),
            questCode: code,
            scope: "daily" as const,
            periodKey: quests.daily.dayKey,
            statusAtClose: "claimed" as const,
            awardedPoints: reward,
            discardedPoints: 0,
            completedAt: current.completedAt,
            claimedAt: iso,
          },
          ...quests.rewardHistory,
        ].slice(0, QUEST_HISTORY_LIMIT),
      },
    };
  }

  const current = quests.weekly.quests[code as WeeklyQuestCode];
  if (current?.status !== "claimable") return normalized;
  return {
    ...normalized,
    carePoints: clampCarePointsForProgress(normalized, normalized.carePoints + reward, rules),
    lastInteraction: iso,
    quests: {
      ...quests,
      weekly: {
        ...quests.weekly,
        bonusAwardedWeek: quests.weekly.bonusAwardedWeek + reward,
        quests: {
          ...quests.weekly.quests,
          [code]: { ...current, status: "claimed", claimedAt: iso, awardedPoints: reward, discardedPoints: 0 },
        },
      },
      rewardHistory: [
        {
          id: questEventId(code, quests.weekly.weekKey, "claimed", iso),
          questCode: code,
          scope: "weekly" as const,
          periodKey: quests.weekly.weekKey,
          statusAtClose: "claimed" as const,
          awardedPoints: reward,
          discardedPoints: 0,
          completedAt: current.completedAt,
          claimedAt: iso,
        },
        ...quests.rewardHistory,
      ].slice(0, QUEST_HISTORY_LIMIT),
    },
  };
}

export function countClaimableQuests(save: PetSaveData): number {
  const quests = save.quests;
  if (!quests) return 0;
  return [...Object.values(quests.daily.quests), ...Object.values(quests.weekly.quests)].filter(
    (quest) => quest.status === "claimable",
  ).length;
}
