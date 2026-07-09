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

  it("manual protected sleep: stats frozen within the protection window", () => {
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
    // 48h gap — inside the 72h protection window.
    const now = new Date(T0.getTime() + 48 * 3_600_000);
    const out = replayOfflineGap(s, rules, now)!;
    expect(out.hunger).toBe(40);
    expect(out.cleanliness).toBe(35);
    expect(out.happiness).toBe(30);
    expect(out.isAlive).toBe(true);
    expect(out.carePoints).toBe(s.carePoints); // frozen while protected
  });

  it("manual protected sleep: decay resumes after the 72h window", () => {
    const s = saveAt({
      evolutionStage: 1,
      hatched: true,
      hunger: 80,
      isSleeping: true,
      sleepKind: "manual",
      sleepStartedAt: T0.toISOString(),
    });
    // 72h protected + 10h of sleep decay beyond it: 80 - (1/15)*600 = 40.
    const now = new Date(T0.getTime() + (72 + 10) * 3_600_000);
    const out = replayOfflineGap(s, rules, now)!;
    expect(out.hunger).toBeCloseTo(80 - (1 / 15) * 10 * 60, 5);
    expect(out.isAlive).toBe(true);
  });

  it("kills the pet when the care-need stat hits zero during the gap", () => {
    const s = saveAt({
      evolutionStage: 1,
      hatched: true,
      hunger: 5,
      isSleeping: true,
      sleepKind: "auto",
      sleepStartedAt: T0.toISOString(),
    });
    // 5 hunger at 1/15 per min → dead after 75 min; give it 3h.
    const now = new Date(T0.getTime() + 3 * 3_600_000);
    const out = replayOfflineGap(s, rules, now)!;
    expect(out.hunger).toBe(0);
    expect(out.isAlive).toBe(false);
  });

  it("applies the low-stat care-point penalty for unprotected gaps", () => {
    const s = saveAt({
      evolutionStage: 1,
      hatched: true,
      hunger: 10, // < 20 → 0.5/min penalty (still >0 after 60 min sleep decay)
      cleanliness: 10, // < 20 → 0.3/min
      happiness: 10, // < 20 → 0.2/min
      carePoints: 600,
      isSleeping: true,
      sleepKind: "auto",
      sleepStartedAt: T0.toISOString(),
    });
    const now = new Date(T0.getTime() + 3_600_000); // 60 min
    const out = replayOfflineGap(s, rules, now)!;
    expect(out.isAlive).toBe(true);
    expect(out.carePoints).toBeCloseTo(600 - (0.5 + 0.3 + 0.2) * 60, 5);
  });
});
