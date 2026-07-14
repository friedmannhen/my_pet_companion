// Shared pet visuals: the cat is the only type with real art (MVP roster);
// every other type renders as an emoji stand-in until its sheets land.
// Used by both the local pet (GameView) and remote pets in online rooms.
import babyBody from "../assets/pets/black_cat/baby/baby_body.png";
import babyTail from "../assets/pets/black_cat/baby/baby_tail.png";
import catAdult from "../assets/pets/black_cat/black_cat_adult.png";
import catAdultBlink from "../assets/pets/black_cat/black_cat_adult_blink.png";
import catFinal from "../assets/pets/black_cat/black_cat_final.png";
import catFinalBlink from "../assets/pets/black_cat/black_cat_final_blink.png";
import catFinalSleep from "../assets/pets/black_cat/black_cat__final_sleep.png";

// Baby is authored as layered pieces (tail behind, body on top, blink-only
// wink overlay — see GameView's BABY_LAYERS). `idle`/`blink` here fall back
// to the body-only pose for callers that only want a single flat image;
// CAT_BABY_LAYERS exposes the tail layer too for composited rendering
// (RemotePets composites body+tail so a friend's baby cat isn't missing its
// tail remotely — the wink overlay is local-only since remote pets don't
// track the other player's blink state).
export const CAT_SPRITES: Record<number, { idle: string; blink: string; sleep?: string }> = {
  1: { idle: babyBody, blink: babyBody },
  2: { idle: catAdult, blink: catAdultBlink },
  3: { idle: catFinal, blink: catFinalBlink, sleep: catFinalSleep },
};

export const CAT_BABY_LAYERS = { body: babyBody, tail: babyTail };

export const PET_TYPE_EMOJI: Record<string, string> = {
  cat: "🐱",
  dog: "🐶",
  dino: "🦖",
  dragon: "🐉",
  ghost: "👻",
  robot: "🤖",
  phoenix: "🐦‍🔥",
};

/** Sprite URL for a pet, or null when only an emoji stand-in exists. */
export function spriteFor(petType: string, stage: number): string | null {
  if (petType === "cat") return CAT_SPRITES[stage]?.idle ?? null;
  return null;
}

export function emojiFor(petType: string): string {
  return PET_TYPE_EMOJI[petType] ?? "🐾";
}
