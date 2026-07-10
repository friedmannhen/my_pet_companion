// Grab-able care items that live in the SideDock "kitchen": a pile of food
// pieces (each one you throw disappears from the pile and regrows 5 minutes
// later) and a single ball (leaves its slot while the pet is playing fetch,
// returns when the sequence ends). Food respawn state persists across app
// restarts via localStorage; the ball intentionally does NOT persist — if
// the app dies mid-fetch there's no sequence left to return it, so it's
// simply back on next launch.
import { useCallback, useEffect, useState } from "react";

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

  const takeFood = useCallback((slot: number): boolean => {
    let taken = false;
    setFoodRespawnAt((prev) => {
      if (slot < 0 || slot >= prev.length || (prev[slot] ?? 0) > Date.now()) return prev;
      taken = true;
      const next = [...prev];
      next[slot] = Date.now() + FOOD_RESPAWN_MS;
      return next;
    });
    return taken;
  }, []);

  const takeBall = useCallback((): boolean => {
    let taken = false;
    setBallOut((out) => {
      if (out) return out;
      taken = true;
      return true;
    });
    return taken;
  }, []);

  const returnBall = useCallback(() => setBallOut(false), []);

  return {
    foodReady: foodRespawnAt.map((t) => t <= now),
    foodEtaMs: foodRespawnAt.map((t) => Math.max(0, t - now)),
    takeFood,
    ballReady: !ballOut,
    takeBall,
    returnBall,
  };
}
