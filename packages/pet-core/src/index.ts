// @pet/core — framework-agnostic pet game logic.
// No React/DOM/storage imports allowed in this package: it is shared by the
// Electron renderer, future clients, and Supabase Edge Functions (Deno).
// Ported from ERP_QA_HUB (see PET_GAME_TRANSFORMATION_PLAN.md §4).

export * from "./types";
export * from "./rules";
export * from "./workCalendar";
export * from "./questDefinitions";
export * from "./save";
export * from "./decay";
export * from "./quests";
export * from "./achievements";
