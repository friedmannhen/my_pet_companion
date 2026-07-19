// Poop cleanup mechanic — pure spawn/reward rules, in the same
// tunable-rules style as rules.ts/decay.ts. The client (GameView) decides
// WHEN to roll a spawn (after a feed lands) and owns the drag-to-trash-can
// gesture; this module only owns the numbers and the spawn gate.
//
// Product rules (Jul 2026 plan):
// - Only a hatched pet poops — an egg (stage 0) never does. Callers must
//   pass isEgg so the gate can't be forgotten.
// - Spawn is probabilistic per feed event, capped so the screen can't fill
//   with uncleaned poop.
// - Cleaning grants a SMALL care-point + happiness bump — deliberately
//   smaller than a full feed/wash/pet action (numbers are a tunable
//   placeholder, not final). No daily-cap interaction to worry about: the
//   old daily normal-point cap is dead code (see rules.ts).

export const POOP_RULES = {
  /** Chance a poop spawns after one feed event. */
  spawnChance: 0.35,
  /** Delay window between the feed and the pet's pre-poop wiggle. */
  minDelayMs: 3_000,
  maxDelayMs: 8_000,
  /** No new spawns while this many uncleaned poops are already out. */
  maxOnScreen: 3,
  /** Happiness bump for cleaning one up. */
  happinessBonus: 3,
  /** Base care points for cleaning one up (before achievement % bonus). */
  basePoints: 2,
} as const;

/**
 * Should a poop spawn after this feed? Pure gate: eggs never poop, and the
 * on-screen cap blocks further spawns. `rng` is injectable for tests.
 */
export function shouldSpawnPoop(
  isEgg: boolean,
  onScreenCount: number,
  rng: () => number = Math.random,
): boolean {
  if (isEgg) return false;
  if (onScreenCount >= POOP_RULES.maxOnScreen) return false;
  return rng() < POOP_RULES.spawnChance;
}
