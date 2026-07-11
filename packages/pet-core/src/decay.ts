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
  isAlive: boolean;
  isSleeping: boolean;
  sleepKind?: "manual" | "auto";
  sleepStartedAt?: string;
  lastDecayTick: string;
  /** Whole minutes elapsed — callers feed this into passive quest evaluation. */
  elapsedMinutes: number;
}

/**
 * Replays a closed-app gap in real segments instead of applying a single decay
 * rate to the whole gap: awake decay only continues until auto-sleep would
 * have kicked in (autoSleepMs after the last interaction), then sleep decay
 * takes over; a manual "tuck-in" sleep stays frozen until its protection
 * window elapses, after which normal sleep decay (and death) resumes.
 *
 * Returns null when the gap is under a minute (the live tick handles it) or
 * the pet is already dead.
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
  let isAlive = true;
  let sleepingAtEnd = prev.isSleeping;
  let sleepKindAtEnd = prev.sleepKind;
  let sleepStartedAtEnd = prev.sleepStartedAt;

  const wasManualProtected =
    prev.isSleeping && prev.sleepKind === "manual" && !!prev.sleepStartedAt;

  if (wasManualProtected) {
    const protectedUntil =
      new Date(prev.sleepStartedAt!).getTime() + rules.sleep.protectedMaxMs;
    const frozenMs = Math.max(0, Math.min(totalMs, protectedUntil - lastTick));
    const remainderMs = totalMs - frozenMs;
    // Frozen segment: stats untouched, floored if already below the protection floor.
    stats = {
      hunger: Math.max(stats.hunger, rules.sleep.protectedStatFloor),
      warmth: Math.max(stats.warmth, rules.sleep.protectedStatFloor),
      cleanliness: Math.max(stats.cleanliness, rules.sleep.protectedStatFloor),
      happiness: Math.max(stats.happiness, rules.sleep.protectedStatFloor),
    };
    if (remainderMs > 0) {
      // Protection expired mid-gap — sleep decay (and death) resumes for the remainder.
      stats = applyOfflineDecay(stats, isEggPhase, remainderMs / 60_000, "sleep", rules);
      const careNeed = isEggPhase ? stats.warmth : stats.hunger;
      isAlive = careNeed > 0;
    }
  } else if (prev.isSleeping) {
    // Auto-sleep at close: sleep decay for the entire gap.
    stats = applyOfflineDecay(stats, isEggPhase, totalMs / 60_000, "sleep", rules);
    const careNeed = isEggPhase ? stats.warmth : stats.hunger;
    isAlive = careNeed > 0;
  } else {
    // Awake at close: awake decay only until auto-sleep would have kicked in.
    const idleAtClose = lastTick - new Date(prev.lastInteraction ?? prev.lastFed).getTime();
    const msUntilAutoSleep = Math.max(0, rules.autoSleepMs - idleAtClose);
    const awakeMs = Math.min(totalMs, msUntilAutoSleep);
    stats = applyOfflineDecay(stats, isEggPhase, awakeMs / 60_000, "awake", rules);
    let careNeed = isEggPhase ? stats.warmth : stats.hunger;
    isAlive = careNeed > 0;

    const sleepMs = totalMs - awakeMs;
    if (isAlive && sleepMs > 0) {
      stats = applyOfflineDecay(stats, isEggPhase, sleepMs / 60_000, "sleep", rules);
      careNeed = isEggPhase ? stats.warmth : stats.hunger;
      isAlive = careNeed > 0;
      sleepingAtEnd = true;
      sleepKindAtEnd = "auto";
      sleepStartedAtEnd = new Date(lastTick + awakeMs).toISOString();
    }
  }

  const mins = totalMs / 60_000;
  const careNeed = isEggPhase ? stats.warmth : stats.hunger;
  const penaltyRate =
    (careNeed < 20 ? 0.5 : 0) +
    (stats.cleanliness < 20 ? 0.3 : 0) +
    (stats.happiness < 20 ? 0.2 : 0);
  const floor = prev.carePointsFloor ?? 0;
  const carePoints =
    wasManualProtected || computeCanEvolve(prev, rules) || rules.progression.disableCarePointDecay
      ? prev.carePoints
      : Math.max(floor, prev.carePoints - penaltyRate * mins);

  return {
    hunger: stats.hunger,
    warmth: stats.warmth,
    cleanliness: stats.cleanliness,
    happiness: stats.happiness,
    carePoints,
    isAlive,
    isSleeping: isAlive ? sleepingAtEnd : prev.isSleeping,
    sleepKind: isAlive ? sleepKindAtEnd : prev.sleepKind,
    sleepStartedAt: isAlive ? sleepStartedAtEnd : prev.sleepStartedAt,
    lastDecayTick: now.toISOString(),
    elapsedMinutes: Math.floor(mins),
  };
}
