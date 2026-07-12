// Per-machine gameplay preferences (sound, movement mode, follow speed).
// Local-only, like the dock placement — not part of the synced save.
import { useCallback, useEffect, useState } from "react";

const PREFS_KEY = "mpc_game_prefs";

export type MovementMode = "free" | "static";
export type FollowSpeed = "slow" | "normal" | "fast";

interface GamePrefs {
  soundEnabled: boolean;
  /** "free" = normal wander behavior; "static" = "Stay" — the pet never
   * moves on its own (drag still works). */
  movementMode: MovementMode;
  /** How fast the pet chases the cursor while "Follow Me" is active. */
  followSpeed: FollowSpeed;
}

const DEFAULT_PREFS: GamePrefs = { soundEnabled: true, movementMode: "free", followSpeed: "normal" };

function loadPrefs(): GamePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<GamePrefs>) };
  } catch {
    /* corrupted — defaults */
  }
  return DEFAULT_PREFS;
}

export function useGamePrefs() {
  const [prefs, setPrefs] = useState<GamePrefs>(loadPrefs);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* quota */
    }
  }, [prefs]);

  const toggleSound = useCallback(() => {
    setPrefs((p) => ({ ...p, soundEnabled: !p.soundEnabled }));
  }, []);

  const toggleMovementMode = useCallback(() => {
    setPrefs((p) => ({ ...p, movementMode: p.movementMode === "free" ? "static" : "free" }));
  }, []);

  const setFollowSpeed = useCallback((followSpeed: FollowSpeed) => {
    setPrefs((p) => ({ ...p, followSpeed }));
  }, []);

  return { ...prefs, toggleSound, toggleMovementMode, setFollowSpeed };
}
