// @pet/core — framework-agnostic pet game logic.
// No React/DOM imports allowed in this package: it is shared by the
// Electron renderer, future clients, and Supabase Edge Functions (Deno).
//
// Populated by porting from ERP_QA_HUB (see PET_GAME_TRANSFORMATION_PLAN.md §4):
//   petRuntimeRules, petStorage save shapes, quest defs/time keys,
//   achievements, proportionalPoints + offline decay-replay.

export const PET_TYPES = [
  "cat",
  "dog",
  "dino",
  "dragon",
  "ghost",
  "robot",
  "phoenix",
] as const;
export type PetType = (typeof PET_TYPES)[number];

/** Pets shipping in the MVP roster (the two with real art). */
export const MVP_PET_TYPES: readonly PetType[] = ["cat", "phoenix"];

export type EvolutionStage = 0 | 1 | 2 | 3;

export type PetAnimState =
  | "idle"
  | "walk"
  | "eat"
  | "hungry"
  | "dirty"
  | "happy"
  | "wash"
  | "fetch"
  | "sleep"
  | "dead"
  | "evolve"
  | "overfed"
  | "overheated";
