// Deterministic pet-battle resolver for online play. Both clients receive
// the same seed + both pets' stat snapshots over the realtime channel and
// replay the battle locally — identical inputs, identical outcome, so there
// is no server authority to run and nothing to trust but the shared seed.
// Framework-free on purpose (pet-core rule): the desktop client animates
// whatever this returns.

export interface BattlerSnapshot {
  name: string;
  /** 1–3 (eggs can't battle — enforce at the door, not here). */
  stage: number;
  hunger: number;
  cleanliness: number;
  happiness: number;
}

export interface BattleRound {
  /** Which side won this round. */
  winner: "a" | "b";
  move: string;
  rollA: number;
  rollB: number;
}

export interface BattleResult {
  rounds: BattleRound[];
  winner: "a" | "b";
  winsA: number;
  winsB: number;
}

/** Small, well-known deterministic PRNG — same sequence for the same seed on every client. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BATTLE_MOVES = [
  "⚡ Pounce",
  "🌀 Spin Attack",
  "💥 Headbutt",
  "✨ Dazzle",
  "🫧 Bubble Blast",
  "🌪️ Zoomies",
] as const;

/**
 * Care quality → battle power. Stage dominates (an evolved pet should
 * usually beat a baby), the day-to-day stats matter, and the roll keeps
 * upsets possible so losing isn't preordained.
 */
export function battlePower(s: BattlerSnapshot): number {
  return s.stage * 25 + s.happiness * 0.4 + s.hunger * 0.15 + s.cleanliness * 0.15;
}

export function resolveBattle(
  seed: number,
  a: BattlerSnapshot,
  b: BattlerSnapshot,
): BattleResult {
  const rng = mulberry32(seed);
  const powerA = battlePower(a);
  const powerB = battlePower(b);
  const rounds: BattleRound[] = [];
  let winsA = 0;
  let winsB = 0;

  while (rounds.length < 3) {
    const move = BATTLE_MOVES[Math.floor(rng() * BATTLE_MOVES.length)] ?? BATTLE_MOVES[0];
    // Roll range (70) deliberately exceeds the worst-case power gap ×0.5
    // (final+pampered vs baby+neglected ≈ 46) so no matchup is ever a
    // mathematically guaranteed win — upsets stay possible, just rare.
    const rollA = powerA * 0.5 + rng() * 70;
    const rollB = powerB * 0.5 + rng() * 70;
    if (rollA === rollB) continue; // replay the round from the next draws (still deterministic)
    const winner = rollA > rollB ? "a" : "b";
    if (winner === "a") winsA += 1;
    else winsB += 1;
    rounds.push({ winner, move, rollA: Math.round(rollA), rollB: Math.round(rollB) });
  }

  return { rounds, winner: winsA > winsB ? "a" : "b", winsA, winsB };
}
