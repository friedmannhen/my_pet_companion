// Target Toss (room minigame #1) — pure, deterministic turn/score logic in
// the style of battle.ts: every client runs these same functions over the
// same ordered event log (mg-throw/mg-skip broadcasts) and derives identical
// "whose turn / who won" answers with no server authority.
//
// Rules (product decisions, Jul 2026):
// - Round-robin turns across TARGET_TOSS_ROUNDS rounds (P1r1, P2r1, ..., P1r2, ...).
// - A round is won by the smallest landing distance from the target center;
//   a skip/AFK miss (distance null) loses to any real throw.
// - Overall winner: most rounds won. Ties → sudden death among ONLY the tied
//   players (one throw each, lowest wins; still tied → repeat).

export const TARGET_TOSS_ROUNDS = 3;
export const TARGET_TOSS_GAME_CODE = "target_toss";

/** One resolved turn: a throw's landing distance, or null for a skip/miss. */
export interface TossEvent {
  userId: string;
  /** null = skipped (AFK timeout or player left) — counts as a miss. */
  distance: number | null;
}

/**
 * Whose turn is next, given the baked-in order and how many turns have
 * resolved so far. Returns null once every player has thrown `rounds` times.
 * Round is 1-based.
 */
export function nextTurn(
  order: string[],
  eventCount: number,
  rounds: number = TARGET_TOSS_ROUNDS,
): { userId: string; round: number } | null {
  if (order.length === 0) return null;
  if (eventCount >= order.length * rounds) return null;
  return {
    userId: order[eventCount % order.length]!,
    round: Math.floor(eventCount / order.length) + 1,
  };
}

/** True once the main phase's full event log is in. */
export function isPhaseComplete(
  orderLength: number,
  eventCount: number,
  rounds: number = TARGET_TOSS_ROUNDS,
): boolean {
  return orderLength > 0 && eventCount >= orderLength * rounds;
}

/**
 * The userIds with the smallest distance in one round's slice of the event
 * log (usually one, several if exactly tied). Empty if nobody landed a real
 * throw that round.
 */
export function roundWinners(order: string[], events: TossEvent[], round: number): string[] {
  const slice = events.slice((round - 1) * order.length, round * order.length);
  let best = Infinity;
  for (const e of slice) if (e.distance !== null && e.distance < best) best = e.distance;
  if (best === Infinity) return [];
  return slice.filter((e) => e.distance === best).map((e) => e.userId);
}

/** Rounds won per player across the main phase. */
export function computeStandings(
  order: string[],
  events: TossEvent[],
  rounds: number = TARGET_TOSS_ROUNDS,
): Record<string, number> {
  const standings: Record<string, number> = {};
  for (const id of order) standings[id] = 0;
  const playedRounds = Math.min(rounds, Math.floor(events.length / order.length));
  for (let r = 1; r <= playedRounds; r++) {
    for (const id of roundWinners(order, events, r)) standings[id] = (standings[id] ?? 0) + 1;
  }
  return standings;
}

/**
 * Who leads the standings. One entry = solo winner, several = sudden-death
 * contenders. (With every player skipping every round, everyone ties at 0 —
 * still resolved by sudden death, matching "remaining turns auto-skip" when
 * players leave.)
 */
export function standingsLeaders(standings: Record<string, number>): string[] {
  let best = -1;
  for (const v of Object.values(standings)) if (v > best) best = v;
  return Object.keys(standings).filter((id) => standings[id] === best);
}

/**
 * Resolve one sudden-death pass (one throw per contender, in order).
 * Returns the still-tied set: length 1 = solo winner, >1 = play another
 * pass among those. All-null passes keep everyone tied.
 */
export function resolveSuddenDeath(contenders: string[], events: TossEvent[]): string[] {
  const slice = events.slice(0, contenders.length);
  let best = Infinity;
  for (const e of slice) if (e.distance !== null && e.distance < best) best = e.distance;
  if (best === Infinity) return contenders;
  return slice.filter((e) => e.distance === best).map((e) => e.userId);
}

// ── Event-log reducer ────────────────────────────────────────────────────────
// Every client feeds the SAME ordered mg-throw/mg-skip events through this
// pure reducer, so main→sudden-death→over transitions (and the winner) are
// derived identically everywhere with no host authority after start.

/** Endless mutual-AFK sudden death is capped — still-tied players co-win. */
export const SUDDEN_DEATH_MAX_PASSES = 3;

export interface TossGameCore {
  order: string[];
  events: TossEvent[];
  /** Empty until the main phase ends in a tie. */
  sdContenders: string[];
  sdEvents: TossEvent[];
  sdPass: number;
  /** Non-empty = game over (usually one id; several = capped co-win). */
  winners: string[];
  /** Monotonic count of applied events — broadcast as a dedupe/order guard. */
  seq: number;
}

export function initTossGame(order: string[]): TossGameCore {
  return { order, events: [], sdContenders: [], sdEvents: [], sdPass: 0, winners: [], seq: 0 };
}

/** Whose turn now (null once over). `round` = sudden-death pass # in "sudden". */
export function currentTossTurn(
  g: TossGameCore,
  rounds: number = TARGET_TOSS_ROUNDS,
): { userId: string; round: number; phase: "main" | "sudden" } | null {
  if (g.winners.length > 0) return null;
  if (g.sdContenders.length === 0) {
    const t = nextTurn(g.order, g.events.length, rounds);
    return t ? { ...t, phase: "main" } : null;
  }
  const id = g.sdContenders[g.sdEvents.length];
  return id ? { userId: id, round: g.sdPass, phase: "sudden" } : null;
}

/** Append one resolved turn and derive any phase transition. Pure. */
export function applyTossEvent(
  g: TossGameCore,
  ev: TossEvent,
  rounds: number = TARGET_TOSS_ROUNDS,
): TossGameCore {
  if (g.winners.length > 0) return g;

  if (g.sdContenders.length === 0) {
    const events = [...g.events, ev];
    const next: TossGameCore = { ...g, events, seq: g.seq + 1 };
    if (!isPhaseComplete(g.order.length, events.length, rounds)) return next;
    const leaders = standingsLeaders(computeStandings(g.order, events, rounds));
    if (leaders.length === 1) return { ...next, winners: leaders };
    return { ...next, sdContenders: leaders, sdEvents: [], sdPass: 1 };
  }

  const sdEvents = [...g.sdEvents, ev];
  const next: TossGameCore = { ...g, sdEvents, seq: g.seq + 1 };
  if (sdEvents.length < g.sdContenders.length) return next;
  const tied = resolveSuddenDeath(g.sdContenders, sdEvents);
  if (tied.length === 1) return { ...next, winners: tied };
  if (g.sdPass >= SUDDEN_DEATH_MAX_PASSES) return { ...next, winners: tied };
  return { ...next, sdContenders: tied, sdEvents: [], sdPass: g.sdPass + 1 };
}
