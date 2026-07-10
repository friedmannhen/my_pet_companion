// Persisted placement for the edge control ribbon (RibbonDock.tsx) — which
// side of the screen it docks to, and how far down. Free continuous drag
// (not discrete presets) — the user drops the tab anywhere along either
// edge. Local-only (not synced): purely a per-machine display preference,
// not game state.
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

  const setDock = useCallback((side: RibbonSide, y: number) => {
    setPrefs({ side, y });
  }, []);

  return { ...prefs, setDock };
}
