// Per-machine gameplay preferences (sound, movement mode, follow speed,
// HUD/pet display sizes). Local-only, like the dock placement — not part of
// the synced save.
import { useCallback, useEffect, useState } from "react";

const PREFS_KEY = "mpc_game_prefs";

export type MovementMode = "free" | "static";
export type FollowSpeed = "slow" | "normal" | "fast";
/** HUD (SideDock subtree only — not the radial menu/tooltips) size level. */
export type HudScale = "sm" | "md" | "lg" | "xl";
/** Pet display size, percent of today's default look — shrink-only. */
export type PetScale = 100 | 90 | 80 | 70;

/** Numeric factor per HUD level, applied as a transform: scale() on the
 *  SideDock's outer wrapper. */
export const HUD_SCALE_FACTORS: Record<HudScale, number> = { sm: 0.85, md: 1, lg: 1.15, xl: 1.3 };

export const HUD_SCALE_OPTIONS: { value: HudScale; label: string }[] = [
  { value: "sm", label: "Small" },
  { value: "md", label: "Medium" },
  { value: "lg", label: "Large" },
  { value: "xl", label: "X-Large" },
];

export const PET_SCALE_OPTIONS: readonly PetScale[] = [100, 90, 80, 70];

interface GamePrefs {
  soundEnabled: boolean;
  /** "free" = normal wander behavior; "static" = "Stay" — the pet never
   * moves on its own (drag still works). */
  movementMode: MovementMode;
  /** How fast the pet chases the cursor while "Follow Me" is active. */
  followSpeed: FollowSpeed;
  /** SideDock size level (default "md" = today's exact look). */
  hudScale: HudScale;
  /** Pet size as % of the default — 100 preserves today's exact look;
   *  lower values only ever SHRINK (never bigger than default). */
  petScale: PetScale;
}

const DEFAULT_PREFS: GamePrefs = {
  soundEnabled: true,
  movementMode: "free",
  followSpeed: "normal",
  hudScale: "md",
  petScale: 100,
};

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

  const setMovementMode = useCallback((movementMode: MovementMode) => {
    setPrefs((p) => ({ ...p, movementMode }));
  }, []);

  const setFollowSpeed = useCallback((followSpeed: FollowSpeed) => {
    setPrefs((p) => ({ ...p, followSpeed }));
  }, []);

  const setHudScale = useCallback((hudScale: HudScale) => {
    setPrefs((p) => ({ ...p, hudScale }));
  }, []);

  const setPetScale = useCallback((petScale: PetScale) => {
    setPrefs((p) => ({ ...p, petScale }));
  }, []);

  return { ...prefs, toggleSound, toggleMovementMode, setMovementMode, setFollowSpeed, setHudScale, setPetScale };
}
