import { describe, expect, it } from "vitest";
import { mulberry32, resolveBattle, type BattlerSnapshot } from "./battle";

const strong: BattlerSnapshot = { name: "Final", stage: 3, hunger: 90, cleanliness: 90, happiness: 90 };
const weak: BattlerSnapshot = { name: "Baby", stage: 1, hunger: 30, cleanliness: 30, happiness: 30 };
const even: BattlerSnapshot = { name: "Twin", stage: 2, hunger: 60, cleanliness: 60, happiness: 60 };

describe("mulberry32", () => {
  it("is deterministic for a seed and in [0,1)", () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    for (let i = 0; i < 100; i++) {
      const va = a();
      expect(va).toBe(b());
      expect(va).toBeGreaterThanOrEqual(0);
      expect(va).toBeLessThan(1);
    }
  });
});

describe("resolveBattle", () => {
  it("same seed + same snapshots => identical result on both 'clients'", () => {
    const r1 = resolveBattle(42, strong, weak);
    const r2 = resolveBattle(42, strong, weak);
    expect(r2).toEqual(r1);
  });

  it("plays exactly 3 decided rounds and winner matches round wins", () => {
    const r = resolveBattle(7, even, { ...even, name: "Other" });
    expect(r.rounds).toHaveLength(3);
    expect(r.winsA + r.winsB).toBe(3);
    expect(r.winner).toBe(r.winsA > r.winsB ? "a" : "b");
  });

  it("a well-cared final-stage pet dominates a neglected baby, but rounds can still be lost", () => {
    let strongWins = 0;
    let weakRoundWins = 0;
    for (let seed = 0; seed < 300; seed++) {
      const r = resolveBattle(seed, strong, weak);
      if (r.winner === "a") strongWins++;
      weakRoundWins += r.winsB;
    }
    expect(strongWins).toBeGreaterThan(255); // dominant…
    expect(weakRoundWins).toBeGreaterThan(0); // …but never a foregone conclusion
  });

  it("evenly matched pets split outcomes roughly evenly across seeds", () => {
    let aWins = 0;
    for (let seed = 0; seed < 300; seed++) {
      if (resolveBattle(seed, even, { ...even, name: "Mirror" }).winner === "a") aWins++;
    }
    expect(aWins).toBeGreaterThan(100);
    expect(aWins).toBeLessThan(200);
  });
});
