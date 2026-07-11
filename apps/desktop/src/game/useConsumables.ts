// Grab-able care items that live in the SideDock "kitchen": a pile of food
// pieces (each one you throw disappears from the pile and regrows 5 minutes
// later) and a single ball (leaves its slot while the pet is playing fetch,
// returns when the sequence ends). Food respawn state persists across app
// restarts via localStorage; the ball intentionally does NOT persist — if
// the app dies mid-fetch there's no sequence left to return it, so it's
// simply back on next launch.
import { useCallback, useEffect, useRef, useState } from "react";

export const FOOD_SLOT_COUNT = 4;
export const FOOD_RESPAWN_MS = 5 * 60 * 1000;

const FOOD_KEY = "mpc_food_slots";

/** Per-slot epoch ms when the slot respawns; 0 = available now. */
function loadFoodSlots(): number[] {
  try {
    const raw = localStorage.getItem(FOOD_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as number[];
      if (Array.isArray(parsed) && parsed.length === FOOD_SLOT_COUNT) return parsed;
    }
  } catch {
    /* corrupted — all available */
  }
  return Array(FOOD_SLOT_COUNT).fill(0);
}

export interface Consumables {
  /** Which food pile slots currently hold a piece. */
  foodReady: boolean[];
  /** Ms until the given slot respawns (0 when ready). */
  foodEtaMs: number[];
  takeFood: (slot: number) => boolean;
  ballReady: boolean;
  takeBall: () => boolean;
  returnBall: () => void;
  /** Dev-only: instantly refills the whole food pile and returns the ball. */
  resetAll: () => void;
}

export function useConsumables(): Consumables {
  const [foodRespawnAt, setFoodRespawnAt] = useState<number[]>(loadFoodSlots);
  const [ballOut, setBallOut] = useState(false);
  // Re-render tick so countdowns/respawns show without any interaction.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    try {
      localStorage.setItem(FOOD_KEY, JSON.stringify(foodRespawnAt));
    } catch {
      /* quota */
    }
  }, [foodRespawnAt]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Mirrors of the state above, read/written synchronously by
  // takeFood/takeBall so their return value is trustworthy immediately —
  // React's setState updaters (the previous approach: mutate a closure
  // variable inside the updater, return it right after calling setState)
  // only get invoked synchronously via an internal "eager bailout"
  // optimization that isn't a guaranteed contract, and empirically doesn't
  // fire reliably here (confirmed via browser testing: the state update DID
  // land — the pile item faded and started its respawn timer — but the
  // function's return value was `false` every time, so callers (grabFood/
  // grabBall) always bailed out before starting the toss/fetch sequence,
  // and for the ball specifically, before ever setting ballPhase, so
  // there's no sequence left to cancel and returnBall() never runs).
  const foodRespawnAtRef = useRef(foodRespawnAt);
  const ballOutRef = useRef(ballOut);

  const takeFood = useCallback((slot: number): boolean => {
    const prev = foodRespawnAtRef.current;
    if (slot < 0 || slot >= prev.length || (prev[slot] ?? 0) > Date.now()) return false;
    const next = [...prev];
    next[slot] = Date.now() + FOOD_RESPAWN_MS;
    foodRespawnAtRef.current = next;
    setFoodRespawnAt(next);
    return true;
  }, []);

  const takeBall = useCallback((): boolean => {
    if (ballOutRef.current) return false;
    ballOutRef.current = true;
    setBallOut(true);
    return true;
  }, []);

  const returnBall = useCallback(() => {
    ballOutRef.current = false;
    setBallOut(false);
  }, []);

  const resetAll = useCallback(() => {
    const fresh = Array(FOOD_SLOT_COUNT).fill(0);
    foodRespawnAtRef.current = fresh;
    ballOutRef.current = false;
    setFoodRespawnAt(fresh);
    setBallOut(false);
  }, []);

  return {
    foodReady: foodRespawnAt.map((t) => t <= now),
    foodEtaMs: foodRespawnAt.map((t) => Math.max(0, t - now)),
    takeFood,
    ballReady: !ballOut,
    takeBall,
    returnBall,
    resetAll,
  };
}
