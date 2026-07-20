import { describe, expect, it } from "vitest";
import {
  applyOfflineDecay,
  clampCarePointsForProgress,
  canEvolveStage,
  proportionalPoints,
  replayOfflineGap,
} from "./decay";
import { DEFAULT_PET_RULES } from "./rules";
import { freshPetSave } from "./save";

const rules = DEFAULT_PET_RULES;
const T0 = new Date("2026-07-06T08:00:00.000Z");

function saveAt(overrides: Parameters<typeof freshPetSave>[0] = {}) {
  return freshPetSave(overrides, T0);
}

describe("proportionalPoints", () => {
  it("awards full points when the stat has full room", () => {
    expect(proportionalPoints(4, 0, 15)).toBe(4);
  });

  it("scales points down when the stat is nearly full", () => {
    // +15 intended, only 5 room → 4 × (5/15)
    expect(proportionalPoints(4, 95, 15)).toBeCloseTo(4 * (5 / 15));
  });

  it("awards zero when the stat is already full", () => {
    expect(proportionalPoints(5, 100, 40)).toBe(0);
  });
});

describe("canEvolveStage", () => {
  it("respects the default thresholds", () => {
    expect(canEvolveStage(449, 0, rules)).toBe(false);
    expect(canEvolveStage(450, 0, rules)).toBe(true);
    expect(canEvolveStage(1200, 1, rules)).toBe(true);
    expect(canEvolveStage(3500, 2, rules)).toBe(true);
  });

  it("never evolves past final stage", () => {
    expect(canEvolveStage(999999, 3, rules)).toBe(false);
  });
});

describe("clampCarePointsForProgress", () => {
  it("clamps to the pending evolution boundary", () => {
    const s = saveAt({ evolutionStage: 1, carePoints: 1100 });
    expect(clampCarePointsForProgress(s, 1500, rules)).toBe(1200);
  });

  it("respects the carePointsFloor", () => {
    const s = saveAt({ evolutionStage: 1, carePoints: 500, carePointsFloor: 450 });
    expect(clampCarePointsForProgress(s, 100, rules)).toBe(450);
  });
});

describe("applyOfflineDecay", () => {
  it("awake decay drains all three stats for a hatched pet", () => {
    const out = applyOfflineDecay(
      { hunger: 100, warmth: 50, cleanliness: 100, happiness: 100 },
      false,
      60,
      "awake",
      rules,
    );
    expect(out.hunger).toBe(100 - 0.5 * 60);
    expect(out.cleanliness).toBe(100 - 1 * 60);
    expect(out.happiness).toBe(100 - 0.5 * 60);
    expect(out.warmth).toBe(50); // untouched outside egg phase
  });

  it("sleep decay only drains the care-need stat", () => {
    const out = applyOfflineDecay(
      { hunger: 100, warmth: 50, cleanliness: 80, happiness: 80 },
      false,
      150,
      "sleep",
      rules,
    );
    expect(out.hunger).toBe(100 - (1 / 15) * 150);
    expect(out.cleanliness).toBe(80);
    expect(out.happiness).toBe(80);
  });

  it("egg phase decays warmth instead of hunger", () => {
    const out = applyOfflineDecay(
      { hunger: 70, warmth: 100, cleanliness: 80, happiness: 80 },
      true,
      60,
      "awake",
      rules,
    );
    expect(out.warmth).toBe(100 - 0.5 * 60);
    expect(out.hunger).toBe(70);
  });
});

describe("replayOfflineGap", () => {
  it("returns null for sub-minute gaps", () => {
    const s = saveAt();
    expect(replayOfflineGap(s, rules, new Date(T0.getTime() + 30_000))).toBeNull();
  });

  it("returns null for dead pets", () => {
    const s = saveAt({ isAlive: false });
    expect(replayOfflineGap(s, rules, new Date(T0.getTime() + 3_600_000))).toBeNull();
  });

  it("awake at close: transitions to auto-sleep after autoSleepMs idle", () => {
    // 3h gap awake-at-close with fresh lastInteraction: 60 min awake decay,
    // then 120 min sleep decay, ending asleep (auto).
    const s = saveAt({ evolutionStage: 1, hatched: true, hunger: 90, cleanliness: 90, happiness: 90 });
    const now = new Date(T0.getTime() + 3 * 3_600_000);
    const out = replayOfflineGap(s, rules, now)!;
    expect(out).not.toBeNull();
    expect(out.isSleeping).toBe(true);
    expect(out.sleepKind).toBe("auto");
    // 60 awake mins at 0.5/min + 120 sleep mins at 1/15 per min
    expect(out.hunger).toBeCloseTo(90 - 0.5 * 60 - (1 / 15) * 120, 5);
    // cleanliness only decays during the awake segment
    expect(out.cleanliness).toBeCloseTo(90 - 1 * 60, 5);
    expect(out.isAlive).toBe(true);
    expect(out.elapsedMinutes).toBe(180);
  });

  it("manual protected sleep: hunger decays toward the floor (10), cleanliness/happiness untouched", () => {
    const s = saveAt({
      evolutionStage: 1,
      hatched: true,
      hunger: 40,
      cleanliness: 35,
      happiness: 30,
      isSleeping: true,
      sleepKind: "manual",
      sleepStartedAt: T0.toISOString(),
    });
    // 48h gap — inside the 72h protection window. Hunger decays at the
    // normal sleep rate but stops at protectedStatFloor instead of freezing
    // outright or falling to 0 (2026-07-20 rebalance).
    const now = new Date(T0.getTime() + 48 * 3_600_000);
    const out = replayOfflineGap(s, rules, now)!;
    expect(out.hunger).toBe(rules.sleep.protectedStatFloor);
    expect(out.cleanliness).toBe(35);
    expect(out.happiness).toBe(30);
    expect(out.isAlive).toBe(true);
    expect(out.carePoints).toBe(s.carePoints); // floor keeps hunger > 0 → no penalty
  });

  it("manual protected sleep: a stat already below the floor at tuck-in isn't raised", () => {
    const s = saveAt({
      evolutionStage: 1,
      hatched: true,
      hunger: 6, // already below protectedStatFloor (10)
      isSleeping: true,
      sleepKind: "manual",
      sleepStartedAt: T0.toISOString(),
    });
    const now = new Date(T0.getTime() + 24 * 3_600_000);
    const out = replayOfflineGap(s, rules, now)!;
    expect(out.hunger).toBe(6); // frozen exactly where it was, never raised to the floor
    expect(out.carePoints).toBe(s.carePoints);
  });

  it("manual protected sleep: floor lifts after the 72h window, remainder decays and charges normally", () => {
    const s = saveAt({
      evolutionStage: 1,
      hatched: true,
      hunger: 80,
      carePoints: 1000,
      isSleeping: true,
      sleepKind: "manual",
      sleepStartedAt: T0.toISOString(),
    });
    // 72h protected (floors at 10) + 10h (600 min) of UNPROTECTED sleep decay
    // beyond it: 10 → 0 after 150 of those 600 min, then sits at 0 for the
    // remaining 450 — only those 450 min cost care points.
    const now = new Date(T0.getTime() + (72 + 10) * 3_600_000);
    const out = replayOfflineGap(s, rules, now)!;
    expect(out.hunger).toBe(0);
    expect(out.isAlive).toBe(true);
    expect(out.carePoints).toBeCloseTo(1000 - rules.carePointDecay.perMinutePerZeroStat * 450, 5);
  });

  it("hunger clamps at 0 instead of killing the pet (Phase C: death removed)", () => {
    const s = saveAt({
      evolutionStage: 1,
      hatched: true,
      hunger: 5,
      isSleeping: true,
      sleepKind: "auto",
      sleepStartedAt: T0.toISOString(),
    });
    // Old behavior: 5 hunger at 1/15 per min → would have "died" after 75
    // min; give it 3h and confirm it instead just bottoms out at 0, alive.
    const now = new Date(T0.getTime() + 3 * 3_600_000);
    const out = replayOfflineGap(s, rules, now)!;
    expect(out.hunger).toBe(0);
    expect(out.isAlive).toBe(true);
  });

  it("eggs never sleep: long idle gap ends dormant-but-awake, cooling at the sleep rate", () => {
    const s = saveAt({ evolutionStage: 0, warmth: 90 });
    // 3h gap, fresh lastInteraction: 60 attended min at awake rate, then
    // 120 dormant min at the (gentler) sleep rate — but isSleeping stays false.
    const now = new Date(T0.getTime() + 3 * 3_600_000);
    const out = replayOfflineGap(s, rules, now)!;
    expect(out.isSleeping).toBe(false);
    expect(out.sleepKind).toBeUndefined();
    expect(out.warmth).toBeCloseTo(90 - 0.5 * 60 - (1 / 15) * 120, 5);
    expect(out.isAlive).toBe(true);
  });

  it("eggs never die: warmth bottoms out at 0 with the pet still alive", () => {
    const s = saveAt({ evolutionStage: 0, warmth: 5 });
    const now = new Date(T0.getTime() + 24 * 3_600_000);
    const out = replayOfflineGap(s, rules, now)!;
    expect(out.warmth).toBe(0);
    expect(out.isAlive).toBe(true);
    expect(out.isSleeping).toBe(false);
  });

  it("wakes a legacy sleeping-egg save", () => {
    const s = saveAt({
      evolutionStage: 0,
      warmth: 80,
      isSleeping: true,
      sleepKind: "auto",
      sleepStartedAt: T0.toISOString(),
    });
    const now = new Date(T0.getTime() + 2 * 3_600_000);
    const out = replayOfflineGap(s, rules, now)!;
    expect(out.isSleeping).toBe(false);
    // Already "sleeping" at close → whole gap is dormant cooling.
    expect(out.warmth).toBeCloseTo(80 - (1 / 15) * 120, 5);
  });

  it("a low-but-nonzero stat costs nothing (2026-07-20 rebalance: only a zeroed stat drains points)", () => {
    const s = saveAt({
      evolutionStage: 1,
      hatched: true,
      hunger: 10, // low, but a 60 min sleep-rate decay (4 pts) never reaches 0
      cleanliness: 10,
      happiness: 10,
      carePoints: 600,
      isSleeping: true,
      sleepKind: "auto",
      sleepStartedAt: T0.toISOString(),
    });
    const now = new Date(T0.getTime() + 3_600_000); // 60 min
    const out = replayOfflineGap(s, rules, now)!;
    expect(out.isAlive).toBe(true);
    expect(out.hunger).toBeGreaterThan(0);
    expect(out.carePoints).toBe(600); // nothing lost — no stat ever hit 0
  });

  it("care points drain only for the minutes a stat actually sat at 0, at the flat per-minute rate", () => {
    const s = saveAt({
      evolutionStage: 1,
      hatched: true,
      hunger: 5, // 5 ÷ (1/15 per min) = 75 min to reach 0
      carePoints: 1000,
      isSleeping: true,
      sleepKind: "auto",
      sleepStartedAt: T0.toISOString(),
    });
    const now = new Date(T0.getTime() + 200 * 60_000); // 200 min
    const out = replayOfflineGap(s, rules, now)!;
    expect(out.hunger).toBe(0);
    // Zero for 200 - 75 = 125 of the 200 minutes.
    expect(out.carePoints).toBeCloseTo(1000 - rules.carePointDecay.perMinutePerZeroStat * 125, 5);
  });

  it("only charges the minutes a stat spent at 0, not the whole segment or gap it's in", () => {
    // Awake 60 min: hunger 60 → 30, never 0 → this segment costs nothing.
    // Sleep 500 min: hunger 30 reaches 0 after 450 of those 500 min — only
    // the last 50 min cost anything. (Guards the same "charged for the
    // whole absence" shape of bug the pre-rebalance model had, just
    // re-expressed for the only-at-zero rule.)
    const s = saveAt({
      evolutionStage: 1,
      hatched: true,
      hunger: 60,
      cleanliness: 100,
      happiness: 100,
      carePoints: 1000,
    });
    const now = new Date(T0.getTime() + 560 * 60_000); // 60 awake + 500 sleep
    const out = replayOfflineGap(s, rules, now)!;
    expect(out.hunger).toBe(0);
    expect(out.carePoints).toBeCloseTo(1000 - rules.carePointDecay.perMinutePerZeroStat * 50, 5);
  });

  it("multiple zeroed stats stack additively", () => {
    // All three start at 0 already, for a 10-minute awake segment.
    const s = saveAt({
      evolutionStage: 1,
      hatched: true,
      hunger: 0,
      cleanliness: 0,
      happiness: 0,
      carePoints: 1000,
    });
    const now = new Date(T0.getTime() + 10 * 60_000);
    const out = replayOfflineGap(s, rules, now)!;
    expect(out.carePoints).toBeCloseTo(1000 - rules.carePointDecay.perMinutePerZeroStat * 3 * 10, 5);
  });
});
