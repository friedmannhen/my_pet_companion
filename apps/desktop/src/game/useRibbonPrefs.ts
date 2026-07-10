// Persisted placement for the SideDock tab — which side of the screen it
// docks to and how far down. The tab drags vertically only; switching
// sides is an explicit choice in the Settings view, not a drag outcome.
// Local-only (not synced): purely a per-machine display preference, not
// game state.
import { useCallback, useEffect, useState } from "react";

export type RibbonSide = "left" | "right";

const PREFS_KEY = "mpc_ribbon_prefs";
const DEFAULT_Y = 500;

function loadPrefs(): { side: RibbonSide; y: number } {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return JSON.parse(raw) as { side: RibbonSide; y: number };
  } catch {
    /* corrupted — fall back to default */
  }
  return { side: "right", y: DEFAULT_Y };
}

export function useRibbonPrefs() {
  const [prefs, setPrefs] = useState(loadPrefs);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* quota */
    }
  }, [prefs]);

  const setY = useCallback((y: number) => {
    setPrefs((p) => ({ ...p, y }));
  }, []);

  const setSide = useCallback((side: RibbonSide) => {
    setPrefs((p) => ({ ...p, side }));
  }, []);

  return { ...prefs, setY, setSide };
}
