// Decay, care-point math and the offline catch-up replay — extracted from
// ERP_QA_HUB src/contexts/PetContext.tsx (proportionalPoints, applyOfflineDecay
// and the offline-catch-up effect) as pure functions taking explicit rules.
// This same code is meant to run in clients AND server-side (Edge Functions)
// for authoritative recompute — keep it dependency-free and deterministic.
import type { EvolutionStage, PetSaveData } from "./types";
import type { PetRuntimeRules } from "./rules";

export function clampStat(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/**
 * Scales care-point earnings to the actual stat improvement.
 * If an action intends to raise a stat by `intendedIncrease` but the stat
 * already has only `room` left, the points earned are reduced proportionally.
 *   e.g. throwBall intends +15 happiness, only 5 missing → 4 × (5/15) ≈ 1.33 pts
 */
export function proportionalPoints(
  base: number,
  statBefore: number,
  intendedIncrease: number,
): number {
  const room = Math.max(0, 100 - statBefore);
  const actualIncrease = Math.min(intendedIncrease, room);
  return base * (actualIncrease / intendedIncrease);
}

/** True once carePoints has reached the threshold for the NEXT lifecycle step. */
export function canEvolveStage(
  pts: number,
  stage: EvolutionStage,
  rules: PetRuntimeRules,
): boolean {
  if (stage >= 3) return false;
  return pts >= rules.evolutionThresholds[(stage + 1) as 1 | 2 | 3];
}

/** Whether the given save is currently "ready to evolve" — used to freeze carePoints. */
export function computeCanEvolve(s: PetSaveData, rules: PetRuntimeRules): boolean {
  return canEvolveStage(s.carePoints, s.evolutionStage, rules);
}

/**
 * The care-point ceiling the pet is currently progressing toward.
 * Prevents points from overflowing a pending hatch/evolution boundary.
 */
export function getCurrentCarePointBoundary(
  s: PetSaveData,
  rules: PetRuntimeRules,
): number | null {
  if (s.evolutionStage >= 3) return null;
  if (rules.progression.disableCarePointBoundary) return null;
  return rules.evolutionThresholds[(s.evolutionStage + 1) as 1 | 2 | 3];
}

/** Applies floor/ceiling rules so care points never overflow a pending evolution boundary. */
export function clampCarePointsForProgress(
  s: PetSaveData,
  nextCarePoints: number,
  rules: PetRuntimeRules,
): number {
  const floor = s.carePointsFloor ?? 0;
  const boundary = getCurrentCarePointBoundary(s, rules);
  const floored = Math.max(floor, nextCarePoints);
  return boundary === null ? floored : Math.min(boundary, floored);
}

/**
 * Deducts a deliberate misuse penalty (overfeeding, egg overheating) from
 * care points. Deliberately does NOT go through clampCarePointsForProgress's
 * carePointsFloor — that floor exists only to stop passive neglect decay
 * from eating into points already spent on the current evolution stage; a
 * penalty for an active bad action must actually bite even right after
 * evolving/hatching (when points sit at/near that floor), or it's a no-op.
 */
export function applyCarePointPenalty(carePoints: number, amount: number): number {
  return Math.max(0, carePoints - amount);
}

export interface DecayableStats {
  hunger: number;
  warmth: number;
  cleanliness: number;
  happiness: number;
}

/**
 * Applies one continuous decay segment (used to replay offline catch-up gaps
 * piecewise). "awake" decays all stats at the normal rate; "sleep" only decays
 * the care-need stat (egg warmth / hunger), matching live decay.
 */
export function applyOfflineDecay(
  stats: DecayableStats,
  isEggPhase: boolean,
  minutes: number,
  kind: "awake" | "sleep",
  rules: PetRuntimeRules,
): DecayableStats {
  if (rules.progression.disableStatDecay || minutes <= 0) return stats;
  const careRate = kind === "sleep" ? rules.sleepDecay.hunger : rules.decay.hunger;
  const hunger = isEggPhase ? stats.hunger : clampStat(stats.hunger - careRate * minutes);
  const warmth = !isEggPhase ? stats.warmth : clampStat(stats.warmth - careRate * minutes);
  if (kind === "sleep") {
    return { hunger, warmth, cleanliness: stats.cleanliness, happiness: stats.happiness };
  }
  const cleanliness = clampStat(stats.cleanliness - rules.decay.cleanliness * minutes);
  const happiness = clampStat(stats.happiness - rules.decay.happiness * minutes);
  return { hunger, warmth, cleanliness, happiness };
}

export interface OfflineReplayResult {
  hunger: number;
  warmth: number;
  cleanliness: number;
  happiness: number;
  carePoints: number;
  /** Always true (Phase C, plan-deathDecayMinigameBalance.md: hard death was
   *  removed — hunger/warmth clamp at 0 instead of ending the save). Kept on
   *  the result shape for API stability; see PetSaveData.isAlive for the
   *  legacy-save revival note. */
  isAlive: boolean;
  isSleeping: boolean;
  sleepKind?: "manual" | "auto";
  sleepStartedAt?: string;
  lastDecayTick: string;
  /** Whole minutes elapsed — callers feed this into passive quest evaluation. */
  elapsedMinutes: number;
}

/**
 * How many of a segment's `minutes` a stat actually spent sitting at
 * exactly 0, given it started the segment at `startValue` and decays
 * linearly at `ratePerMin` (0 = frozen this segment — e.g. cleanliness/
 * happiness during sleep). A stat that starts and stays above 0 the whole
 * segment contributes 0; one that was already at 0 the whole time
 * contributes the full segment.
 */
function minutesAtZero(startValue: number, ratePerMin: number, minutes: number): number {
  if (minutes <= 0) return 0;
  if (ratePerMin <= 0) return startValue <= 0 ? minutes : 0;
  const timeToZero = startValue / ratePerMin;
  return Math.max(0, minutes - timeToZero);
}

/**
 * A segment's neglect care-point cost (2026-07-20 rebalance,
 * plan-deathDecayMinigameBalance.md follow-up): care points now drain ONLY
 * for the minutes a stat sat at exactly 0 — a stat that's merely low costs
 * nothing. Computed from the segment's START values (not end-state) so a
 * stat that only bottoms out partway through a long segment is charged
 * only for the sliver of time it was actually empty, at
 * `rules.carePointDecay.perMinutePerZeroStat` per empty stat (summed
 * across all three: careNeed, cleanliness, happiness).
 */
function segmentZeroStatPenalty(
  startStats: DecayableStats,
  careNeedStart: number,
  minutes: number,
  kind: "awake" | "sleep",
  rules: PetRuntimeRules,
): number {
  if (minutes <= 0) return 0;
  const careRate = kind === "sleep" ? rules.sleepDecay.hunger : rules.decay.hunger;
  const cleanRate = kind === "sleep" ? 0 : rules.decay.cleanliness;
  const happyRate = kind === "sleep" ? 0 : rules.decay.happiness;
  const zeroMinutes =
    minutesAtZero(careNeedStart, careRate, minutes) +
    minutesAtZero(startStats.cleanliness, cleanRate, minutes) +
    minutesAtZero(startStats.happiness, happyRate, minutes);
  return zeroMinutes * rules.carePointDecay.perMinutePerZeroStat;
}

/**
 * Applies protected (manual tuck-in) sleep's floor to a decaying careNeed
 * value: decays toward `floor` and stops there — UNLESS the stat already
 * started the segment at or below the floor, in which case protection just
 * freezes it exactly where it was (never raises it up to the floor).
 */
function protectedFloorValue(start: number, decayed: number, floor: number): number {
  const effectiveFloor = start <= floor ? start : floor;
  return Math.max(effectiveFloor, decayed);
}

/**
 * Replays a closed-app gap in real segments instead of applying a single decay
 * rate to the whole gap: awake decay only continues until auto-sleep would
 * have kicked in (autoSleepMs after the last interaction), then sleep decay
 * takes over; a manual "tuck-in" sleep decays hunger toward (but never past)
 * `protectedStatFloor` until its protection window elapses, after which
 * normal (unfloored) sleep decay resumes for the remainder. Hunger (or egg
 * warmth) clamps at 0 and stays there — it no longer ends the save.
 *
 * Care points only drain for the minutes a stat spent sitting at exactly 0
 * (2026-07-20 rebalance) — a merely-low stat costs nothing, and protected
 * sleep's floor keeps hunger above 0 the whole protected portion, so it
 * costs nothing either. Still bounded below by carePointsFloor.
 *
 * Returns null when the gap is under a minute (the live tick handles it) or
 * `prev.isAlive` is already false — a state that should no longer occur for
 * any save produced by this function, but is preserved as a defensive no-op
 * for a legacy save from before hard death was removed; callers are
 * responsible for reviving such a save once, on load (see usePetGame.ts).
 */
export function replayOfflineGap(
  prev: PetSaveData,
  rules: PetRuntimeRules,
  now: Date = new Date(),
): OfflineReplayResult | null {
  if (!prev.isAlive) return null;

  const lastTick = new Date(prev.lastDecayTick).getTime();
  const totalMs = now.getTime() - lastTick;
  if (totalMs < 60_000) return null;

  const isEggPhase = prev.evolutionStage === 0;
  let stats: DecayableStats = {
    hunger: prev.hunger,
    warmth: prev.warmth,
    cleanliness: prev.cleanliness,
    happiness: prev.happiness,
  };
  let sleepingAtEnd = prev.isSleeping;
  let sleepKindAtEnd = prev.sleepKind;
  let sleepStartedAtEnd = prev.sleepStartedAt;
  let penaltyAccum = 0;

  // Eggs don't sleep. After the attended window (autoSleepMs of idle) an egg
  // goes DORMANT instead: it keeps cooling at the same gentle rate sleep
  // decay uses (identical balance, no sleep flag/ZZZ), and a fully cold egg
  // never dies — warmth bottoms out at 0 and hatch progress stalls, with the
  // care-point neglect decay below as the real cost of abandonment.
  if (isEggPhase) {
    const idleAtClose = lastTick - new Date(prev.lastInteraction ?? prev.lastFed).getTime();
    const msUntilDormant = prev.isSleeping ? 0 : Math.max(0, rules.autoSleepMs - idleAtClose);
    const attendedMs = Math.min(totalMs, msUntilDormant);
    const dormantMs = totalMs - attendedMs;

    penaltyAccum += segmentZeroStatPenalty(stats, stats.warmth, attendedMs / 60_000, "awake", rules);
    stats = applyOfflineDecay(stats, true, attendedMs / 60_000, "awake", rules);

    penaltyAccum += segmentZeroStatPenalty(stats, stats.warmth, dormantMs / 60_000, "sleep", rules);
    stats = applyOfflineDecay(stats, true, dormantMs / 60_000, "sleep", rules);

    const floor = prev.carePointsFloor ?? 0;
    const carePoints =
      computeCanEvolve(prev, rules) || rules.progression.disableCarePointDecay
        ? prev.carePoints
        : Math.max(floor, prev.carePoints - penaltyAccum);

    return {
      hunger: stats.hunger,
      warmth: stats.warmth,
      cleanliness: stats.cleanliness,
      happiness: stats.happiness,
      carePoints,
      isAlive: true,
      // Wake any legacy sleeping-egg saves from before this rule existed.
      isSleeping: false,
      sleepKind: undefined,
      sleepStartedAt: undefined,
      lastDecayTick: now.toISOString(),
      elapsedMinutes: Math.floor(totalMs / 60_000),
    };
  }

  const wasManualProtected =
    prev.isSleeping && prev.sleepKind === "manual" && !!prev.sleepStartedAt;

  if (wasManualProtected) {
    const protectedUntil =
      new Date(prev.sleepStartedAt!).getTime() + rules.sleep.protectedMaxMs;
    const frozenMs = Math.max(0, Math.min(totalMs, protectedUntil - lastTick));
    const remainderMs = totalMs - frozenMs;

    if (frozenMs > 0) {
      // Protected portion: hunger DOES decay (sleep rate) but is floored at
      // protectedStatFloor — never raised UP to the floor if it started
      // below it (2026-07-20 rebalance — the old behavior froze every stat
      // completely and could even raise a low stat to the floor). Cleanliness/
      // happiness are untouched here same as any other sleep segment — sleep
      // decay never touches them regardless of protection. Floored careNeed
      // never reaches 0 by construction, so this segment never contributes
      // to the zero-stat penalty — protection's actual payoff.
      const hungerStart = stats.hunger;
      const decayed = applyOfflineDecay(stats, false, frozenMs / 60_000, "sleep", rules);
      stats = { ...stats, hunger: protectedFloorValue(hungerStart, decayed.hunger, rules.sleep.protectedStatFloor) };
    }
    if (remainderMs > 0) {
      // Protection expired mid-gap — normal (unfloored) sleep decay and the
      // zero-stat penalty both resume for the remainder only.
      penaltyAccum += segmentZeroStatPenalty(stats, stats.hunger, remainderMs / 60_000, "sleep", rules);
      stats = applyOfflineDecay(stats, false, remainderMs / 60_000, "sleep", rules);
    }
  } else if (prev.isSleeping) {
    // Auto-sleep at close: sleep decay for the entire gap.
    penaltyAccum += segmentZeroStatPenalty(stats, stats.hunger, totalMs / 60_000, "sleep", rules);
    stats = applyOfflineDecay(stats, isEggPhase, totalMs / 60_000, "sleep", rules);
  } else {
    // Awake at close: awake decay only until auto-sleep would have kicked in.
    const idleAtClose = lastTick - new Date(prev.lastInteraction ?? prev.lastFed).getTime();
    const msUntilAutoSleep = Math.max(0, rules.autoSleepMs - idleAtClose);
    const awakeMs = Math.min(totalMs, msUntilAutoSleep);
    penaltyAccum += segmentZeroStatPenalty(stats, stats.hunger, awakeMs / 60_000, "awake", rules);
    stats = applyOfflineDecay(stats, isEggPhase, awakeMs / 60_000, "awake", rules);

    const sleepMs = totalMs - awakeMs;
    if (sleepMs > 0) {
      penaltyAccum += segmentZeroStatPenalty(stats, stats.hunger, sleepMs / 60_000, "sleep", rules);
      stats = applyOfflineDecay(stats, isEggPhase, sleepMs / 60_000, "sleep", rules);
      sleepingAtEnd = true;
      sleepKindAtEnd = "auto";
      sleepStartedAtEnd = new Date(lastTick + awakeMs).toISOString();
    }
  }

  const floor = prev.carePointsFloor ?? 0;
  const carePoints =
    computeCanEvolve(prev, rules) || rules.progression.disableCarePointDecay
      ? prev.carePoints
      : Math.max(floor, prev.carePoints - penaltyAccum);

  return {
    hunger: stats.hunger,
    warmth: stats.warmth,
    cleanliness: stats.cleanliness,
    happiness: stats.happiness,
    carePoints,
    isAlive: true,
    isSleeping: sleepingAtEnd,
    sleepKind: sleepKindAtEnd,
    sleepStartedAt: sleepStartedAtEnd,
    lastDecayTick: now.toISOString(),
    elapsedMinutes: Math.floor(totalMs / 60_000),
  };
}
