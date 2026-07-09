// Maps between the pet-core PetSaveData (camelCase, ISO strings) and the
// Postgres `pets` row (snake_case, timestamptz). Only the columns the schema
// defines are synced; quests/achievements get their own sync later.
import { normalizePetSave, type PetSaveData, type PetType } from "@pet/core";

export interface PetRow {
  id?: string;
  user_id: string;
  pet_type: PetType;
  name: string;
  hunger: number;
  warmth: number;
  cleanliness: number;
  happiness: number;
  evolution_stage: number;
  care_points: number;
  care_points_floor: number;
  hatched: boolean;
  is_alive: boolean;
  is_sleeping: boolean;
  sleep_kind: "manual" | "auto" | null;
  sleep_started_at: string | null;
  last_fed: string;
  last_washed: string;
  last_petted: string;
  last_interaction: string;
  last_decay_tick: string;
  birth_date: string;
  feed_count: number;
  wash_count: number;
  pet_count: number;
  throw_ball_count: number;
  overfeed_count: number;
}

export function saveToRow(save: PetSaveData, userId: string): PetRow {
  return {
    user_id: userId,
    pet_type: save.petType,
    name: save.name,
    hunger: save.hunger,
    warmth: save.warmth,
    cleanliness: save.cleanliness,
    happiness: save.happiness,
    evolution_stage: save.evolutionStage,
    care_points: save.carePoints,
    care_points_floor: save.carePointsFloor ?? 0,
    hatched: save.hatched ?? false,
    is_alive: save.isAlive,
    is_sleeping: save.isSleeping,
    sleep_kind: save.sleepKind ?? null,
    sleep_started_at: save.sleepStartedAt ?? null,
    last_fed: save.lastFed,
    last_washed: save.lastWashed,
    last_petted: save.lastPetted,
    last_interaction: save.lastInteraction,
    last_decay_tick: save.lastDecayTick,
    birth_date: save.birthDate,
    feed_count: save.feedCount,
    wash_count: save.washCount,
    pet_count: save.petCount,
    throw_ball_count: save.throwBallCount,
    overfeed_count: save.overfeedCount,
  };
}

export function rowToSave(row: PetRow): PetSaveData {
  return normalizePetSave({
    petType: row.pet_type,
    name: row.name,
    hunger: Number(row.hunger),
    warmth: Number(row.warmth),
    cleanliness: Number(row.cleanliness),
    happiness: Number(row.happiness),
    evolutionStage: row.evolution_stage as PetSaveData["evolutionStage"],
    carePoints: Number(row.care_points),
    carePointsFloor: Number(row.care_points_floor),
    hatched: row.hatched,
    isAlive: row.is_alive,
    isSleeping: row.is_sleeping,
    sleepKind: row.sleep_kind ?? undefined,
    sleepStartedAt: row.sleep_started_at ?? undefined,
    lastFed: row.last_fed,
    lastWashed: row.last_washed,
    lastPetted: row.last_petted,
    lastInteraction: row.last_interaction,
    lastDecayTick: row.last_decay_tick,
    birthDate: row.birth_date,
    feedCount: row.feed_count,
    washCount: row.wash_count,
    petCount: row.pet_count,
    throwBallCount: row.throw_ball_count,
    overfeedCount: row.overfeed_count,
  });
}
