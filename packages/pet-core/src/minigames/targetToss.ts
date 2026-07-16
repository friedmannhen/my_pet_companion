// Target Toss (room minigame #1) — pure, deterministic turn/score logic in
// the style of battle.ts: every client runs these same functions over the
// same ordered event log (mg-throw/mg-skip broadcasts) and derives identical
// "whose turn / who won" answers with no server authority.
//
// Rules (product decisions, Jul 2026; scoring changed later that month):
// - Round-robin turns across TARGET_TOSS_ROUNDS rounds (P1r1, P2r1, ..., P1r2, ...).
// - Overall winner: LOWEST total distance-from-center summed across every
//   round played (golf scoring, not "most rounds won" — see
//   computeTotalDistances/totalDistanceLeaders). A miss (skip, AFK, or the
//   puck sliding off-screen) charges MISS_PENALTY_DISTANCE instead of a
//   real distance, so skipping is never better than a bad-but-real throw.
// - Ties on total → sudden death among ONLY the tied players (one throw
//   each, lowest single throw wins; still tied → repeat, capped).
// - roundWinners/computeStandings/standingsLeaders (rounds-won tally) are
//   kept for callers that want a per-round breakdown, but are NOT what
//   decides the winner anymore — that's totalDistanceLeaders.

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

/** Charged for a miss (skip/AFK/off-screen) when tallying totals — worse
 *  than any realistic on-screen distance so skipping is never a good play. */
export const MISS_PENALTY_DISTANCE = 200;

/**
 * Sum of every player's landing distance across all events so far (golf
 * scoring — lower is better). A miss (distance null) charges
 * MISS_PENALTY_DISTANCE. This is what actually decides the winner.
 */
export function computeTotalDistances(
  order: string[],
  events: TossEvent[],
  missPenalty: number = MISS_PENALTY_DISTANCE,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const id of order) totals[id] = 0;
  for (const e of events) {
    totals[e.userId] = (totals[e.userId] ?? 0) + (e.distance === null ? missPenalty : e.distance);
  }
  return totals;
}

/** Who has the LOWEST total (golf scoring). Several = exactly tied. */
export function totalDistanceLeaders(totals: Record<string, number>): string[] {
  let best = Infinity;
  for (const v of Object.values(totals)) if (v < best) best = v;
  return Object.keys(totals).filter((id) => totals[id] === best);
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
    const leaders = totalDistanceLeaders(computeTotalDistances(g.order, events));
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

// ── Seeded per-round arena layout ────────────────────────────────────────────
// The target and launcher move vertically each round for variety, but every
// player in a given round must see the SAME position (fairness — same shot,
// same round). The host picks one random seed at game start and broadcasts
// it; every client derives the round's layout from (seed, phase, round) with
// this pure function, so no extra broadcast is needed per round — same
// deterministic-shared-seed pattern as resolveBattle.

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ArenaLayout {
  /** Target ring center, as a fraction of viewport height. */
  targetNY: number;
  /** Launcher pad position, as a fraction of viewport height. */
  launchNY: number;
}

/**
 * Deterministic target/launcher Y position for a given round. Depends only
 * on (seed, phase, round) — never the player — so it's identical for every
 * participant and every throw within that round, and changes on the next.
 * Clamped to the middle 40% of the viewport (0.3..0.7) so there's always
 * plenty of room above/below to pull back regardless of pull length.
 */
export function arenaLayoutForTurn(seed: number, phase: "main" | "sudden", round: number): ArenaLayout {
  const key = phase === "main" ? round : 1000 + round;
  const rngTarget = mulberry32(seed ^ (key * 2 + 1));
  const rngLaunch = mulberry32(seed ^ (key * 2 + 2));
  return {
    targetNY: 0.3 + rngTarget() * 0.4,
    launchNY: 0.3 + rngLaunch() * 0.4,
  };
}
