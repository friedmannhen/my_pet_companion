import type { HistoryEntry, PetSaveData } from "./types";

/** Ring-buffer cap — newest-first, oldest entries drop off past this. */
export const HISTORY_MAX_ENTRIES = 200;

/** Appends a history entry (newest-first) and caps the buffer at HISTORY_MAX_ENTRIES. */
export function appendHistoryEntry(
  save: PetSaveData,
  entry: Omit<HistoryEntry, "id" | "at"> & { at?: string },
): PetSaveData {
  const full: HistoryEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: entry.at ?? new Date().toISOString(),
    ...entry,
  };
  return { ...save, history: [full, ...(save.history ?? [])].slice(0, HISTORY_MAX_ENTRIES) };
}
