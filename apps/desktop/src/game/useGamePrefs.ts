// Per-machine gameplay preferences (currently just sound). Local-only, like
// the dock placement — not part of the synced save.
import { useCallback, useEffect, useState } from "react";

const PREFS_KEY = "mpc_game_prefs";

interface GamePrefs {
  soundEnabled: boolean;
}

function loadPrefs(): GamePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { soundEnabled: true, ...(JSON.parse(raw) as Partial<GamePrefs>) };
  } catch {
    /* corrupted — defaults */
  }
  return { soundEnabled: true };
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

  return { ...prefs, toggleSound };
}
