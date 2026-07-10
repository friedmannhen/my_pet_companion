import { describe, expect, it } from "vitest";
import {
  claimQuestReward,
  countClaimableQuests,
  evaluatePassiveQuests,
  markOverfeedQuestFailure,
  normalizeQuestPeriods,
  recordCareActionQuestProgress,
  recordThrowBallQuestProgress,
} from "./quests";
import { GUARDIAN_MINUTES_PER_DAY, PET_QUEST_DEFINITIONS } from "./questDefinitions";
import { DEFAULT_PET_RULES } from "./rules";
import { freshPetSave } from "./save";
import type { PetSaveData } from "./types";

const rules = DEFAULT_PET_RULES;
// Monday 08:00 UTC = 11:00 Asia/Jerusalem (IDT) — mid-week, before the 15:30 cutoff.
const T0 = new Date("2026-07-06T08:00:00.000Z");

function saveAt(overrides: Partial<PetSaveData> = {}): PetSaveData {
  return freshPetSave({ evolutionStage: 1, hunger: 60, cleanliness: 60, happiness: 60, ...overrides }, T0);
}

const hoursLater = (h: number) => new Date(T0.getTime() + h * 3600_000);
const daysLater = (d: number, h = 0) => new Date(T0.getTime() + (d * 24 + h) * 3600_000);

describe("recordCareActionQuestProgress (Balanced Care)", () => {
  it("counts qualified actions and completes at 3+3+3", () => {
    let s = saveAt();
    // 3 feeds, 3 washes, 3 pets — each same-type action 1h+ apart.
    for (let i = 0; i < 3; i++) {
      const t = hoursLater(i * 1.5);
      s = recordCareActionQuestProgress(s, "feed", rules, t);
      s = recordCareActionQuestProgress(s, "wash", rules, t);
      s = recordCareActionQuestProgress(s, "pet", rules, t);
    }
    expect(s.quests!.daily.feedQualifiedCount).toBe(3);
    expect(s.quests!.daily.quests.balancedCare.status).toBe("claimable");
    expect(s.quests!.completionCounts.balancedCare).toBe(1);
  });

  it("ignores same-type actions inside the 1h qualified gap", () => {
    let s = saveAt();
    s = recordCareActionQuestProgress(s, "feed", rules, T0);
    s = recordCareActionQuestProgress(s, "feed", rules, new Date(T0.getTime() + 10 * 60_000));
    expect(s.quests!.daily.feedQualifiedCount).toBe(1);
  });

  it("does not count unqualified (hollow) actions", () => {
    let s = saveAt();
    s = recordCareActionQuestProgress(s, "feed", rules, T0, undefined, false);
    expect(s.quests!.daily.feedQualifiedCount).toBe(0);
    expect(s.quests!.weekly.feedDaysByDayKey).toEqual({});
  });
});

describe("Careful Feeder (weekly, 4 feed days, no overfeed)", () => {
  it("completes on the 4th distinct feed day", () => {
    let s = saveAt();
    for (let d = 0; d < 4; d++) {
      s = recordCareActionQuestProgress(s, "feed", rules, daysLater(d));
    }
    expect(s.quests!.weekly.quests.noOverfeedWeek.status).toBe("claimable");
  });

  it("an overfeed poisons the whole week (but only that day's clean run)", () => {
    let s = saveAt();
    s = markOverfeedQuestFailure(s, T0);
    expect(s.quests!.daily.hadOverfeedToday).toBe(true);
    for (let d = 0; d < 4; d++) {
      s = recordCareActionQuestProgress(s, "feed", rules, daysLater(d));
    }
    expect(s.quests!.weekly.quests.noOverfeedWeek.status).toBe("in_progress");
    expect(s.quests!.weekly.hadOverfeedWeek).toBe(true);
    // The DAILY flag resets at each day rollover — a Monday overfeed doesn't
    // fail Tuesday's Clean Run.
    expect(s.quests!.daily.hadOverfeedToday).toBe(false);
  });
});

describe("recordThrowBallQuestProgress (Play Week)", () => {
  it("needs 2+ throws on 4 distinct days", () => {
    let s = saveAt();
    for (let d = 0; d < 4; d++) {
      s = recordThrowBallQuestProgress(s, daysLater(d));
      expect(s.quests!.weekly.quests.dailyPlayWeek.status).toBe("in_progress");
      s = recordThrowBallQuestProgress(s, daysLater(d, 1));
    }
    expect(s.quests!.weekly.quests.dailyPlayWeek.status).toBe("claimable");
  });
});

describe("evaluatePassiveQuests", () => {
  it("accrues focus minutes only while awake with all stats 70+", () => {
    let s = saveAt({ hunger: 80, cleanliness: 80, happiness: 80 });
    s = evaluatePassiveQuests(s, rules, T0, undefined, 60);
    expect(s.quests!.daily.focusEligibleMinutes).toBe(60);
    s = evaluatePassiveQuests(s, rules, hoursLater(1), undefined, 60);
    expect(s.quests!.daily.quests.focusSession.status).toBe("claimable");
  });

  it("does not accrue focus minutes when a stat is low or pet asleep", () => {
    let s = saveAt({ happiness: 40 });
    s = evaluatePassiveQuests(s, rules, T0, undefined, 60);
    expect(s.quests!.daily.focusEligibleMinutes).toBe(0);
    let asleep = saveAt({ hunger: 90, cleanliness: 90, happiness: 90, isSleeping: true });
    asleep = evaluatePassiveQuests(asleep, rules, T0, undefined, 60);
    expect(asleep.quests!.daily.focusEligibleMinutes).toBe(0);
  });

  it("guardian quests complete after 60 ok-minutes on 4 days", () => {
    let s = saveAt({ hunger: 90 });
    for (let d = 0; d < 4; d++) {
      s = evaluatePassiveQuests(s, rules, daysLater(d), undefined, GUARDIAN_MINUTES_PER_DAY);
    }
    expect(s.quests!.weekly.quests.hungerGuardian.status).toBe("claimable");
  });

  it("clean run closes claimable after the daily cutoff without overfeed", () => {
    let s = saveAt();
    // 14:00 UTC = 17:00 Jerusalem — past the 15:30 local cutoff.
    s = evaluatePassiveQuests(s, rules, new Date("2026-07-06T14:00:00.000Z"));
    expect(s.quests!.daily.cleanRunWindowClosed).toBe(true);
    expect(s.quests!.daily.quests.cleanRun.status).toBe("claimable");
  });

  it("clean run fails after an overfeed", () => {
    let s = saveAt();
    s = markOverfeedQuestFailure(s, T0);
    s = evaluatePassiveQuests(s, rules, new Date("2026-07-06T14:00:00.000Z"));
    expect(s.quests!.daily.quests.cleanRun.status).toBe("in_progress");
  });
});

describe("claimQuestReward", () => {
  it("awards the reward points and marks claimed", () => {
    let s = saveAt();
    for (let d = 0; d < 4; d++) s = recordCareActionQuestProgress(s, "feed", rules, daysLater(d));
    expect(countClaimableQuests(s)).toBe(1);
    const before = s.carePoints;
    const claimed = claimQuestReward(s, "noOverfeedWeek", rules, daysLater(3, 1));
    expect(claimed.carePoints).toBe(before + PET_QUEST_DEFINITIONS.noOverfeedWeek.rewardPoints);
    expect(claimed.quests!.weekly.quests.noOverfeedWeek.status).toBe("claimed");
    expect(claimed.quests!.rewardHistory[0]?.statusAtClose).toBe("claimed");
    expect(countClaimableQuests(claimed)).toBe(0);
  });

  it("claiming twice does not double-award", () => {
    let s = saveAt();
    for (let d = 0; d < 4; d++) s = recordCareActionQuestProgress(s, "feed", rules, daysLater(d));
    const once = claimQuestReward(s, "noOverfeedWeek", rules, daysLater(3, 1));
    const twice = claimQuestReward(once, "noOverfeedWeek", rules, daysLater(3, 2));
    expect(twice.carePoints).toBe(once.carePoints);
  });

  it("does nothing for an in-progress quest", () => {
    const s = saveAt();
    const claimed = claimQuestReward(s, "balancedCare", rules, T0);
    expect(claimed.carePoints).toBe(s.carePoints);
    expect(claimed.quests!.daily.quests.balancedCare.status).toBe("in_progress");
  });
});

describe("normalizeQuestPeriods (rollover)", () => {
  it("expires unclaimed claimable dailies at day rollover and records history", () => {
    let s = saveAt();
    for (let i = 0; i < 3; i++) {
      const t = hoursLater(i * 1.5);
      s = recordCareActionQuestProgress(s, "feed", rules, t);
      s = recordCareActionQuestProgress(s, "wash", rules, t);
      s = recordCareActionQuestProgress(s, "pet", rules, t);
    }
    expect(s.quests!.daily.quests.balancedCare.status).toBe("claimable");
    const nextDay = daysLater(1);
    const rolled = normalizeQuestPeriods(s, nextDay);
    expect(rolled.quests!.daily.quests.balancedCare.status).toBe("in_progress");
    expect(rolled.quests!.daily.feedQualifiedCount).toBe(0);
    const expired = rolled.quests!.rewardHistory.find((e) => e.questCode === "balancedCare");
    expect(expired?.statusAtClose).toBe("expired");
    expect(expired?.discardedPoints).toBe(PET_QUEST_DEFINITIONS.balancedCare.rewardPoints);
  });

  it("weekly progress survives day rollovers within the same week", () => {
    let s = saveAt();
    s = recordCareActionQuestProgress(s, "feed", rules, T0);
    const rolled = normalizeQuestPeriods(s, daysLater(1));
    expect(Object.keys(rolled.quests!.weekly.feedDaysByDayKey)).toHaveLength(1);
  });

  it("weekly resets across the week boundary", () => {
    let s = saveAt();
    s = recordCareActionQuestProgress(s, "feed", rules, T0);
    // Next Monday — past the Sunday-06:00 Jerusalem reset.
    const rolled = normalizeQuestPeriods(s, daysLater(7));
    expect(rolled.quests!.weekly.feedDaysByDayKey).toEqual({});
  });

  it("is idempotent within the same day", () => {
    const s = saveAt();
    const a = normalizeQuestPeriods(s, hoursLater(1));
    const b = normalizeQuestPeriods(a, hoursLater(2));
    expect(b.quests!.daily.dayKey).toBe(a.quests!.daily.dayKey);
    expect(b.quests!.rewardHistory).toHaveLength(0);
  });
});
