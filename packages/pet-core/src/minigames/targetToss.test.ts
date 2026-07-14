import { describe, expect, it } from "vitest";
import {
  applyTossEvent,
  computeStandings,
  currentTossTurn,
  initTossGame,
  isPhaseComplete,
  nextTurn,
  resolveSuddenDeath,
  roundWinners,
  standingsLeaders,
  SUDDEN_DEATH_MAX_PASSES,
  type TossEvent,
  type TossGameCore,
} from "./targetToss";

const throwEv = (userId: string, distance: number | null): TossEvent => ({ userId, distance });

describe("nextTurn", () => {
  it("round-robins 2 players across 3 rounds", () => {
    const order = ["a", "b"];
    expect(nextTurn(order, 0)).toEqual({ userId: "a", round: 1 });
    expect(nextTurn(order, 1)).toEqual({ userId: "b", round: 1 });
    expect(nextTurn(order, 2)).toEqual({ userId: "a", round: 2 });
    expect(nextTurn(order, 5)).toEqual({ userId: "b", round: 3 });
    expect(nextTurn(order, 6)).toBeNull();
  });

  it("round-robins 3 and 4 players", () => {
    expect(nextTurn(["a", "b", "c"], 4)).toEqual({ userId: "b", round: 2 });
    expect(nextTurn(["a", "b", "c", "d"], 7)).toEqual({ userId: "d", round: 2 });
    expect(nextTurn(["a", "b", "c"], 9)).toBeNull();
  });

  it("handles empty order", () => {
    expect(nextTurn([], 0)).toBeNull();
  });
});

describe("isPhaseComplete", () => {
  it("completes exactly at players × rounds", () => {
    expect(isPhaseComplete(2, 5)).toBe(false);
    expect(isPhaseComplete(2, 6)).toBe(true);
    expect(isPhaseComplete(3, 9)).toBe(true);
  });
});

describe("roundWinners / computeStandings", () => {
  const order = ["a", "b", "c"];
  // r1: a=10 b=5 c=skip → b; r2: a=3 b=7 c=4 → a; r3: a=9 b=2 c=2 → b+c tie
  const events: TossEvent[] = [
    throwEv("a", 10), throwEv("b", 5), throwEv("c", null),
    throwEv("a", 3), throwEv("b", 7), throwEv("c", 4),
    throwEv("a", 9), throwEv("b", 2), throwEv("c", 2),
  ];

  it("lowest distance wins a round; skips lose to any throw", () => {
    expect(roundWinners(order, events, 1)).toEqual(["b"]);
    expect(roundWinners(order, events, 2)).toEqual(["a"]);
    expect(roundWinners(order, events, 3)).toEqual(["b", "c"]);
  });

  it("an all-skip round has no winner", () => {
    const allSkips = [throwEv("a", null), throwEv("b", null), throwEv("c", null)];
    expect(roundWinners(order, allSkips, 1)).toEqual([]);
    expect(computeStandings(order, allSkips, 1)).toEqual({ a: 0, b: 0, c: 0 });
  });

  it("tallies rounds won (round ties award both)", () => {
    expect(computeStandings(order, events)).toEqual({ a: 1, b: 2, c: 1 });
  });

  it("only counts fully-played rounds", () => {
    // 5 events = round 2 incomplete → only round 1 tallied.
    expect(computeStandings(order, events.slice(0, 5))).toEqual({ a: 0, b: 1, c: 0 });
  });
});

describe("standingsLeaders / resolveSuddenDeath", () => {
  it("solo leader wins outright", () => {
    expect(standingsLeaders({ a: 2, b: 1, c: 0 })).toEqual(["a"]);
  });

  it("tied leaders go to sudden death", () => {
    expect(standingsLeaders({ a: 1, b: 1, c: 1 })).toEqual(["a", "b", "c"]);
    expect(standingsLeaders({ a: 0, b: 0 })).toEqual(["a", "b"]); // all-skip game still resolves
  });

  it("sudden death: lowest wins, ties repeat with the still-tied subset", () => {
    // 3-way tie → pass 1: a=5 b=5 c=9 → a+b still tied.
    expect(resolveSuddenDeath(["a", "b", "c"], [throwEv("a", 5), throwEv("b", 5), throwEv("c", 9)])).toEqual(["a", "b"]);
    // pass 2 among a+b: a=4 b=6 → a wins.
    expect(resolveSuddenDeath(["a", "b"], [throwEv("a", 4), throwEv("b", 6)])).toEqual(["a"]);
  });

  it("sudden death with skips: any real throw beats a skip; all skips stay tied", () => {
    expect(resolveSuddenDeath(["a", "b"], [throwEv("a", null), throwEv("b", 20)])).toEqual(["b"]);
    expect(resolveSuddenDeath(["a", "b"], [throwEv("a", null), throwEv("b", null)])).toEqual(["a", "b"]);
  });
});

describe("applyTossEvent reducer", () => {
  const play = (g: TossGameCore, evs: TossEvent[]) => evs.reduce((acc, e) => applyTossEvent(acc, e), g);

  it("plays a full 2-player game with a solo winner", () => {
    let g = initTossGame(["a", "b"]);
    expect(currentTossTurn(g)).toEqual({ userId: "a", round: 1, phase: "main" });
    g = play(g, [
      throwEv("a", 5), throwEv("b", 10), // r1 → a
      throwEv("a", 8), throwEv("b", 2),  // r2 → b
      throwEv("a", 1), throwEv("b", 9),  // r3 → a
    ]);
    expect(g.winners).toEqual(["a"]);
    expect(currentTossTurn(g)).toBeNull();
    expect(g.seq).toBe(6);
  });

  it("tied main phase flows into sudden death among only the tied players", () => {
    let g = initTossGame(["a", "b", "c"]);
    g = play(g, [
      throwEv("a", 1), throwEv("b", 9), throwEv("c", 9), // r1 → a
      throwEv("a", 9), throwEv("b", 1), throwEv("c", 9), // r2 → b
      throwEv("a", 9), throwEv("b", 9), throwEv("c", 1), // r3 → c → 3-way tie
    ]);
    expect(g.winners).toEqual([]);
    expect(g.sdContenders).toEqual(["a", "b", "c"]);
    expect(currentTossTurn(g)).toEqual({ userId: "a", round: 1, phase: "sudden" });
    // pass 1: a & b tie at 3, c out → pass 2 shrinks to [a, b]
    g = play(g, [throwEv("a", 3), throwEv("b", 3), throwEv("c", 7)]);
    expect(g.sdContenders).toEqual(["a", "b"]);
    expect(g.sdPass).toBe(2);
    g = play(g, [throwEv("a", 4), throwEv("b", 2)]);
    expect(g.winners).toEqual(["b"]);
  });

  it("caps endless all-skip sudden death as a co-win", () => {
    let g = initTossGame(["a", "b"]);
    // Force a 0-0 tie (all skips) then keep skipping through every pass.
    g = play(g, Array.from({ length: 6 }, (_, i) => throwEv(i % 2 ? "b" : "a", null)));
    expect(g.sdContenders).toEqual(["a", "b"]);
    for (let pass = 0; pass < SUDDEN_DEATH_MAX_PASSES; pass++) {
      g = play(g, [throwEv("a", null), throwEv("b", null)]);
    }
    expect(g.winners).toEqual(["a", "b"]);
  });

  it("ignores events after the game is over", () => {
    let g = initTossGame(["a", "b"]);
    g = play(g, [throwEv("a", 1), throwEv("b", 2), throwEv("a", 1), throwEv("b", 2), throwEv("a", 1), throwEv("b", 2)]);
    expect(g.winners).toEqual(["a"]);
    const after = applyTossEvent(g, throwEv("b", 0));
    expect(after).toBe(g);
  });
});
