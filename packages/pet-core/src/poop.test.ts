import { describe, expect, it } from "vitest";
import { POOP_RULES, shouldSpawnPoop } from "./poop";

describe("shouldSpawnPoop", () => {
  it("never spawns for an egg, even on a guaranteed roll", () => {
    expect(shouldSpawnPoop(true, 0, () => 0)).toBe(false);
  });

  it("spawns post-hatch when the roll passes", () => {
    expect(shouldSpawnPoop(false, 0, () => 0)).toBe(true);
  });

  it("doesn't spawn when the roll fails", () => {
    expect(shouldSpawnPoop(false, 0, () => 0.999)).toBe(false);
  });

  it("respects the on-screen cap even on a guaranteed roll", () => {
    expect(shouldSpawnPoop(false, POOP_RULES.maxOnScreen, () => 0)).toBe(false);
    expect(shouldSpawnPoop(false, POOP_RULES.maxOnScreen - 1, () => 0)).toBe(true);
  });

  it("spawn chance boundary is exclusive", () => {
    expect(shouldSpawnPoop(false, 0, () => POOP_RULES.spawnChance)).toBe(false);
    expect(shouldSpawnPoop(false, 0, () => POOP_RULES.spawnChance - 0.0001)).toBe(true);
  });
});
