// Persisted placement for the SideDock ribbon — which side of the screen it
// docks to and how far down (the COLLAPSED anchor the user dragged it to) —
// plus which secondary panel is open, so the layout survives restarts.
// The ribbon drags vertically only; switching sides is an explicit choice in
// the Settings view, not a drag outcome. Local-only (not synced): purely
// per-machine display preferences, not game state.
//
// Multi-ribbon redesign (Jul 2026): the old independent Kitchen drawer is
// gone — its contents live inside the Home panel now, so `kitchenOpen` was
// dropped. `activePanel` is the one-at-a-time secondary panel stacked
// beneath Home; it's implicitly meaningless while the ribbon is collapsed
// (a closed ribbon shows nothing) but persists so reopening restores it.
import { useCallback, useEffect, useState } from "react";

export type RibbonSide = "left" | "right";

/** The secondary panels — one open at a time, stacked beneath Home. */
export type InfoPanelId =
  | "quests"
  | "awards"
  | "ranks"
  | "groups"
  | "friends"
  | "history"
  | "petstats"
  | "settings";

const PREFS_KEY = "mpc_ribbon_prefs";
const DEFAULT_Y = 500;

interface RibbonPrefs {
  side: RibbonSide;
  y: number;
  /** Which secondary panel is open (null = none). Mutually exclusive. */
  activePanel: InfoPanelId | null;
}

const DEFAULTS: RibbonPrefs = { side: "right", y: DEFAULT_Y, activePanel: null };

function loadPrefs(): RibbonPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const merged = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<RibbonPrefs> & { kitchenOpen?: boolean }) };
      // Drop the legacy kitchenOpen field silently (pre-redesign saves).
      const { side, y, activePanel } = merged;
      return { side, y, activePanel };
    }
  } catch {
    /* corrupted — fall back to default */
  }
  return DEFAULTS;
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

  /** Clicking the already-active panel's tab closes it. */
  const setActivePanel = useCallback((panel: InfoPanelId | null) => {
    setPrefs((p) => ({ ...p, activePanel: p.activePanel === panel ? null : panel }));
  }, []);

  return { ...prefs, setY, setSide, setActivePanel };
}
