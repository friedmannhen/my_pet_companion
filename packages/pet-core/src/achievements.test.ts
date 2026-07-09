import { describe, expect, it } from "vitest";
import {
  computeCategoryBonusMultipliers,
  computeGlobalLevel,
  evaluateAchievements,
  freshAchievementState,
  normalizeAchievementState,
  percentToStars,
  type PetAchievementState,
} from "./achievements";
import { freshAllSaves } from "./save";

const T0 = new Date("2026-07-06T08:00:00.000Z");

describe("evaluateAchievements", () => {
  it("finds nothing claimable on a fresh account", () => {
    expect(evaluateAchievements(freshAllSaves(T0), freshAchievementState())).toEqual([]);
  });

  it("flags counter achievements once the cross-pet total reaches the target", () => {
    const saves = freshAllSaves(T0);
    saves.cat.feedCount = 20;
    saves.dog.feedCount = 5;
    const claimable = evaluateAchievements(saves, freshAchievementState());
    expect(claimable).toContain("feed25");
    expect(claimable).not.toContain("feed100");
  });

  it("does not re-flag already-earned codes", () => {
    const saves = freshAllSaves(T0);
    saves.cat.feedCount = 25;
    const state: PetAchievementState = {
      version: 1,
      earned: { feed25: { earnedAt: T0.toISOString(), status: "claimable" } },
    };
    expect(evaluateAchievements(saves, state)).not.toContain("feed25");
  });

  it("flags firstHatch from the hatched flag", () => {
    const saves = freshAllSaves(T0);
    saves.phoenix.hatched = true;
    expect(evaluateAchievements(saves, freshAchievementState())).toContain("firstHatch");
  });
});

describe("bonus math", () => {
  it("only claimed rewards contribute to multipliers", () => {
    const state: PetAchievementState = {
      version: 1,
      earned: {
        feed25: { earnedAt: T0.toISOString(), status: "claimed", claimedAt: T0.toISOString() },
        feed100: { earnedAt: T0.toISOString(), status: "claimable" },
      },
    };
    const mult = computeCategoryBonusMultipliers(state);
    expect(mult.feed).toBeCloseTo(1.03);
    expect(mult.wash).toBe(1);
    expect(mult.play).toBe(1);
  });

  it("percentToStars: 15% = 2 full + 1 half", () => {
    expect(percentToStars(15)).toEqual({ full: 2, half: 1 });
  });
});

describe("normalizeAchievementState", () => {
  it("treats legacy rewardApplied entries as claimed", () => {
    const legacy = {
      version: 1,
      earned: { feed25: { earnedAt: T0.toISOString(), rewardApplied: true } },
    };
    const state = normalizeAchievementState(legacy);
    expect(state.earned.feed25?.status).toBe("claimed");
    expect(state.earned.feed25?.claimedAt).toBe(T0.toISOString());
  });

  it("drops unknown codes and returns fresh state for garbage", () => {
    expect(normalizeAchievementState(null)).toEqual(freshAchievementState());
    const state = normalizeAchievementState({
      version: 1,
      earned: { notReal: { earnedAt: T0.toISOString() } },
    });
    expect(Object.keys(state.earned)).toHaveLength(0);
  });
});

describe("computeGlobalLevel", () => {
  it("sums evolution stages across pets", () => {
    const saves = freshAllSaves(T0);
    saves.cat.evolutionStage = 3;
    saves.phoenix.evolutionStage = 2;
    expect(computeGlobalLevel(saves)).toBe(5);
  });
});
