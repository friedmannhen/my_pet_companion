// The actual pet overlay + care loop. Only ever mounted while signed in
// (see App.tsx) — this repo is online-only by design (plan MVP decision),
// so no pet exists to render or play with before authentication.
//
// UI architecture (per design intent): the overlay shows ONLY the pet, a
// compact radial interaction menu, and the SideDock (edge tab + fused
// slide-out drawer) — never a stock Electron window. All stats/progress and
// the grab-able care items (food pile, ball, sponge) live in the SideDock.
//
// Movement/interaction mechanics (wander springs, drag-glide throw,
// feed/wash/ball gestures, particle timings) are ported from ERP_QA_HUB's
// usePetMovement.ts / PetOverlay.tsx / PetEffects.tsx — see those files'
// history for the original reference implementation this was studied from.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useDragControls,
  useMotionValue,
  useMotionValueEvent,
  useSpring,
  useTransform,
} from "framer-motion";
import { computeTotalDistances, POOP_RULES, shouldSpawnPoop, TARGET_TOSS_ROUNDS, MISS_PENALTY_DISTANCE } from "@pet/core";
import type { AuthState } from "../supabase/useAuth";
import { supabase } from "../supabase/client";
import { usePetGame, formatDuration } from "./usePetGame";
import { EggSelect } from "./EggSelect";
import { useSessionLease } from "../session/useSessionLease";
import { usePetMovement } from "./usePetMovement";
import { PetEffects, type PetFxTrigger } from "./PetEffects";
import { AdminPanel } from "./AdminPanel";
import { RadialMenu, type RadialAction } from "./RadialMenu";
import { Tooltip } from "./Tooltip";
import { throwArc } from "./throwPhysics";
import { SideDock } from "./SideDock";
import { useRibbonPrefs } from "./useRibbonPrefs";
import { useAppUpdate } from "./useAppUpdate";
import { useConsumables } from "./useConsumables";
import { useGamePrefs } from "./useGamePrefs";
import { useGroups } from "./useGroups";
import { useRoom, RPS_REVEAL_MS } from "../online/useRoom";
import { useNotifications, ROOM_INVITE_TTL_MS } from "../online/useNotifications";
import { RemotePets } from "../online/RemotePets";
import { RoomBar } from "../online/RoomBar";
import { TargetToss } from "./minigames/TargetToss";
import { RockPaperScissors } from "./minigames/RockPaperScissors";
import { ChessPanel } from "./minigames/Chess";
import type { ChessGame, RpsMove } from "../online/useRoom";
import * as Sounds from "./petSounds";
import { setClickableOverride } from "../overlay/clickableOverride";
import "./petAnimations.css";
import babyBody from "../assets/pets/black_cat/baby/baby_body.png";
import babyTail from "../assets/pets/black_cat/baby/baby_tail.png";
import babyWink from "../assets/pets/black_cat/baby/baby_wink.png";
import catAdult from "../assets/pets/black_cat/black_cat_adult.png";
import catAdultBlink from "../assets/pets/black_cat/black_cat_adult_blink.png";
import catFinal from "../assets/pets/black_cat/black_cat_final.png";
import catFinalBlink from "../assets/pets/black_cat/black_cat_final_blink.png";
import catFinalSleep from "../assets/pets/black_cat/black_cat__final_sleep.png";
import eggIdle from "../assets/pets/black_cat/egg/1.png";
import eggCrack1 from "../assets/pets/black_cat/egg/2.png";
import eggCrack2 from "../assets/pets/black_cat/egg/3.png";
import eggCrack3 from "../assets/pets/black_cat/egg/4.png";
import eggBack from "../assets/pets/black_cat/egg/BACK.png";
import eggBottom from "../assets/pets/black_cat/egg/BOTTOM.png";
import eggTop from "../assets/pets/black_cat/egg/TOP.png";
import eggShard1 from "../assets/pets/black_cat/egg/crack1.png";
import eggShard2 from "../assets/pets/black_cat/egg/crack2.png";

const PET_SIZE = 128;
// Display scale (product decision, Jul 2026): hatched pets render at 0.7.
// ROBUST CENTERING MECHANISM: every pet asset is authored on the same square
// canvas, and the sprite always renders at the full PET_SIZE cell — the
// visual shrink is a CSS `transform: scale()` on a dedicated wrapper with
// transform-origin at the cell's center. The layout box (movement math,
// drag hitbox, popup/panel anchors, PetEffects' inset:0 overlay) never
// changes size, so the art stays dead-center at ANY scale — no per-scale
// position guessing. The scale is animated (not stepped) and stays 1 for
// the whole egg/hatch cutscene, easing to 0.7 only after the pet jumps out
// of the shell.
const PET_DISPLAY_SCALE = 0.7;
// The unhatched egg idles at half the pet's cell size; once the hatch
// cutscene starts it grows to HATCH_SIZE (1.5x PET_SIZE) and moves to
// screen-center — see the hatchCenter/hatchCutsceneActive state below.
const EGG_IDLE_SIZE = PET_SIZE / 2;
const HATCH_SIZE = Math.round(PET_SIZE * 1.5);
// Shared resting line (offset from the hatch stage's center) that both the
// fallen top shell and the crack shards settle onto, so they visually sit
// on the same "ground" instead of at random heights.
const HATCH_GROUND_DY = 74;

// Baby stage is composited from layered pieces (per-stage subfolder
// convention: apps/desktop/src/assets/pets/<pet>/<stage>/*) instead of one
// flat pose image — tail behind, body (open eyes) on top, and a wink
// overlay swapped in on top of that for the blink pose. Adult/final still
// use the older flat-file convention (SPRITES) until their layered assets
// land — copy this same split when they do.
const BABY_LAYERS = { body: babyBody, tail: babyTail, wink: babyWink };

const SPRITES: Record<number, { idle: string; blink: string; sleep?: string }> = {
  2: { idle: catAdult, blink: catAdultBlink },
  3: { idle: catFinal, blink: catFinalBlink, sleep: catFinalSleep },
};

// Egg hatch: a phased sequence of individual (non-sheet) frames, matching
// how every other pet stage is already authored in this repo (one PNG per
// pose, not a grid sheet — see petSprites.ts). Unlike a plain timer, each
// crack phase now waits for the player to click the egg again (see
// advanceHatch) — only the post-burst tail (settle/jump/wander/fade) below
// still runs on a timer.
const EGG_SPRITES = { idle: eggIdle, crack1: eggCrack1, crack2: eggCrack2, crack3: eggCrack3 };
const EGG_HATCH_TIMING = {
  // How long the pet sits wiggling inside the burst-open shell before it
  // jumps out.
  seatedMs: 5000,
  // Duration of the jump-out arc itself.
  jumpMs: 750,
  // Duration of the "happy" wiggle right after landing outside the shell.
  happyMs: 700,
  // How long the pet wanders freely before the leftover shell/shards fade
  // (at least 5s so the shell stays on screen a while after the jump).
  wanderMs: 5200,
  fadeMs: 800,
};

const chipStyle: React.CSSProperties = {
  cursor: "pointer",
  border: "none",
  borderRadius: 7,
  padding: "4px 8px",
  fontSize: 11,
  background: "rgba(255,255,255,0.12)",
  color: "#fff",
};

const bannerStyle: React.CSSProperties = {
  position: "fixed",
  left: "50%",
  top: 24,
  transform: "translateX(-50%)",
  padding: "6px 14px",
  borderRadius: 999,
  background: "rgba(20,20,26,0.85)",
  color: "#fde68a",
  fontSize: 12,
  fontWeight: 600,
  pointerEvents: "none",
  zIndex: 20000,
};

const THROW_EASE: [number, number, number, number] = [0.3, 0, 1, 1];
const PET_COOLDOWN_MS = 5 * 60 * 1000;
// The pet's own container can render as high as 25200 (menu open, Part G) —
// the scrub sponge/bubbles and the warm-lamp cursor must stay comfortably
// above that so they never disappear behind the pet's body while in use.
const ABOVE_PET_Z = 25300;
/** Drop-on-nest radius (px, center-to-center) for dragging the pet/egg
 *  straight onto the [data-homeslot] element to send it home. */
const NEST_DROP_RADIUS = 90;

// throwArc lives in throwPhysics.ts now (shared with the Target Toss
// minigame) — same math, pure extraction.

interface DeltaPopup {
  id: number;
  icon: string;
  value: number;
  bornAt: number;
}

function fmtDelta(v: number): string {
  const rounded = Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${v > 0 ? "+" : ""}${rounded}`;
}

function fmtCooldown(ms: number): string {
  return ms >= 60_000 ? `${Math.ceil(ms / 60_000)}m` : `${Math.max(1, Math.ceil(ms / 1000))}s`;
}

export function GameView({ auth, clickable }: { auth: AuthState; clickable: boolean }) {
  const game = usePetGame(auth.userId);
  const lease = useSessionLease(auth.userId);
  const { save } = game;

  const ribbon = useRibbonPrefs();
  const appUpdate = useAppUpdate();
  // update_ready notice (Phase 0.5): a persistent, directly-actionable toast
  // the moment an update finishes downloading — local-only (synthesized from
  // appUpdate state, never broadcast), no TTL auto-clear (only an explicit
  // "Later"/install dismisses it). After dismissal a tab badge persists.
  const [updateToastDismissed, setUpdateToastDismissed] = useState(false);
  useEffect(() => {
    if (appUpdate.updateState !== "ready") setUpdateToastDismissed(false);
  }, [appUpdate.updateState]);
  const showUpdateToast = appUpdate.updateState === "ready" && !updateToastDismissed;
  const consumables = useConsumables();
  const prefs = useGamePrefs();
  const soundRef = useRef(prefs.soundEnabled);
  soundRef.current = prefs.soundEnabled;
  const sfx = useCallback((play: () => void) => {
    if (soundRef.current) play();
  }, []);

  // DEV-only on-screen event log (renderer console isn't visible without
  // --enable-logging, so surface the last few gesture/sequence events right
  // in the overlay — this is how we diagnose "the grab did nothing").
  const [debugLines, setDebugLines] = useState<string[]>([]);
  const dbg = useCallback((msg: string) => {
    if (!import.meta.env.DEV) return;
    console.log("[game]", msg);
    const t = new Date();
    const stamp = `${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
    setDebugLines((prev) => [...prev.slice(-3), `${stamp} ${msg}`]);
  }, []);
  const [statsOpen, setStatsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [feedPhase, setFeedPhase] = useState<"idle" | "held" | "released" | "eating">("idle");
  const [ballPhase, setBallPhase] = useState<"idle" | "held" | "playing">("idle");
  const [isEvolving, setIsEvolving] = useState(false);
  // Egg hatch sequence — see advanceHatch and EGG_HATCH_TIMING. "idle" =
  // normal small unhatched egg at its wander position; wiggle/crack1-3 are
  // click-gated (advanceHatch moves to the next one) and rendered centered
  // + enlarged (hatchCenter/HATCH_SIZE); "burst" is the shell splitting
  // open — from there the REAL pet (not a decorative copy) sits in the
  // shell, wiggles, then jumps out by animating movement.x/y directly, so
  // it's the actual playable pet the whole time, never a fake stand-in.
  const [eggPhase, setEggPhase] = useState<"idle" | "wiggle" | "crack1" | "crack2" | "crack3" | "burst">("idle");
  const [eggShards, setEggShards] = useState<{ id: number; src: string; dx: number; dy: number; rotate: number }[]>([]);
  const eggTopX = useMotionValue(0);
  const eggTopY = useMotionValue(0);
  const eggTopRotate = useMotionValue(0);
  // Fixed screen position (top-left) for the enlarged HATCH_SIZE hatch
  // stage, computed once from the viewport when the player clicks to start
  // — the shell (back/bottom/top/shards) lives here for the whole
  // sequence, decoupled from the pet's own wander position.
  const [hatchCenter, setHatchCenter] = useState<{ x: number; y: number } | null>(null);
  // True from the first hatch click until the pet has jumped clear of the
  // shell and handed control back to normal wander. Used to gate the pet's
  // own container's clicks/z-index during the cutscene — NOT to hide the
  // pet itself (see visual's computation: the real pet shows again as soon
  // as eggPhase reaches "burst", sitting right in the shell).
  const [hatchCutsceneActive, setHatchCutsceneActive] = useState(false);
  const [petSeatedWiggling, setPetSeatedWiggling] = useState(false);
  const [petHappyWiggling, setPetHappyWiggling] = useState(false);
  const [eggLeftoverFading, setEggLeftoverFading] = useState(false);
  // Every setTimeout the hatch sequence schedules gets tracked here so an
  // abandoned attempt (e.g. the player resets to a fresh egg via the admin
  // panel mid-sequence) can have ALL its pending timers cancelled — without
  // this, a stray timer from an abandoned run could fire well into the
  // NEXT attempt and silently corrupt its state (this was the root cause
  // of the hatch stage drifting further right on each retry).
  const hatchTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearHatchTimers = useCallback(() => {
    hatchTimersRef.current.forEach(clearTimeout);
    hatchTimersRef.current = [];
  }, []);
  const scheduleHatch = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      hatchTimersRef.current = hatchTimersRef.current.filter((x) => x !== id);
      fn();
    }, ms);
    hatchTimersRef.current.push(id);
  }, []);
  useEffect(() => clearHatchTimers, [clearHatchTimers]);
  const [cleaningMode, setCleaningMode] = useState(false);
  // Egg warm mode: entered from the SideDock's lamp (replaces feed/ball
  // while the pet is an egg) — the cursor becomes a glowing light source and
  // holding it over the egg runs the same warmTick loop the old direct
  // hold-on-egg gesture used.
  const [warmingMode, setWarmingMode] = useState(false);
  const [warmCursor, setWarmCursor] = useState({ x: -200, y: -200 });
  const [warmHeld, setWarmHeld] = useState(false);
  const warmHeldRef = useRef(false);
  const [scrubHeld, setScrubHeld] = useState(false);
  const [scrubbingEffectively, setScrubbingEffectively] = useState(false);
  const [scrubProgress, setScrubProgress] = useState(0);
  const [scrubCursor, setScrubCursor] = useState({ x: 0, y: 0 });
  const [bubbles, setBubbles] = useState<
    { id: string; x: number; y: number; dx: number; dy: number; arcY: number; size: number; duration: number; rotate: number }[]
  >([]);
  const [fxTrigger, setFxTrigger] = useState<PetFxTrigger>(null);
  const [happyPulse, setHappyPulse] = useState(false);
  const [evolvePulse, setEvolvePulse] = useState(false);
  const [blinking, setBlinking] = useState(false);
  // "Follow Me" — chases the cursor; overrides Stay/Free-Roam while active
  // and is force-cancelled below whenever the pet becomes non-interactive.
  const [isFollowing, setIsFollowing] = useState(false);
  // "Send Home" (Part F): the pet was walked to the dock's nest slot and
  // parks there. Cleared by dragging the pet away or picking Free Roam /
  // Follow Me again — never times out on its own.
  const [sentHome, setSentHome] = useState(false);
  const sentHomeRef = useRef(false);
  sentHomeRef.current = sentHome;
  // Once the walk arrives, the pet "enters" the nest: the roaming sprite
  // fades/scales away and stays HIDDEN (even with the menus closed — this
  // is the quiet-time feature); the Home panel's nest slot shows the idle
  // asset instead, and clicking the slot is what releases the pet again.
  const [petNested, setPetNested] = useState(false);
  const petNestedRef = useRef(false);
  petNestedRef.current = petNested;
  // Transient "coming out of the nest" pulse: scale grows back from 0 (the
  // framer spring on the display-scale wrapper already animates this once
  // petNested flips false) with an extra wiggle layered on top for flair.
  const [petExitingNest, setPetExitingNest] = useState(false);
  // wakeFromNest is declared after grabFood/grabBall (which need to call it
  // when the pet is grabbed for a care action while nested) — forward
  // reference via a ref, same pattern as throwFoodRef/runBallFetchRef.
  const wakeFromNestRef = useRef<() => void>(() => {});

  // True while the pet is mid-action in a way that needs it to stand still
  // and not be interrupted: no wander, no drag, no menu-open tap. Any
  // interaction that's more than a single click (feed throw, ball fetch,
  // scrubbing, evolving) sets this.
  const petBusy = cleaningMode || warmingMode || feedPhase !== "idle" || ballPhase !== "idle" || isEvolving;

  // Freeze wandering while a takeover elsewhere just kicked this device off
  // its lease — a visible behavior change (not just a buried settings
  // button) so it's unmistakable this session lost ownership.
  const stationary = save.isSleeping || !save.isAlive || game.isEgg || lease.status === "kicked";
  // Follow Me pauses while the radial menu is open or the pet is busy, same
  // gating as wander — cancelled outright once `stationary` applies (egg,
  // sleeping, dead, kicked) by the effect just below.
  const followingActive = isFollowing && !stationary && !menuOpen && !petBusy;
  const movement = usePetMovement({
    active: !stationary && !menuOpen && !petBusy && !followingActive && prefs.movementMode === "free",
    following: followingActive,
    followSpeed: prefs.followSpeed,
  });

  useEffect(() => {
    if (stationary) setIsFollowing(false);
  }, [stationary]);

  // Drag-lag lean: an overdamped spring chases the container's real
  // position; the (small) gap between them becomes a lean offset on the
  // inner sprite wrapper, giving the body a trailing "squash" feel while
  // being dragged instead of rigidly snapping to the cursor.
  const lagX = useSpring(movement.x, { stiffness: 300, damping: 42 });
  const lagY = useSpring(movement.y, { stiffness: 300, damping: 42 });
  const leanX = useTransform(() => lagX.get() - movement.x.get());
  const leanY = useTransform(() => lagY.get() - movement.y.get());

  // Idle-liveliness motion values (framer-driven breathing squash + gesture
  // tilt) — driven/reset by the idleBreathing effect further down; they get
  // their own dedicated wrapper node so they can't clobber anything else.
  const breatheScaleX = useMotionValue(1);
  const breatheScaleY = useMotionValue(1);
  const gestureRotate = useMotionValue(0);

  // Blink loop — 3–7s randomized, occasional double-blink.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        if (!alive) return;
        setBlinking(true);
        setTimeout(() => {
          if (!alive) return;
          setBlinking(false);
          if (Math.random() < 0.2) {
            setTimeout(() => alive && setBlinking(true), 120);
            setTimeout(() => alive && setBlinking(false), 270);
          }
          schedule();
        }, 150);
      }, 3000 + Math.random() * 4000);
    };
    schedule();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  // ── Floating stat-delta popups ───────────────────────────────────────────
  // After a deliberate care action (never ambient decay), diff the save
  // before/after and float the real per-stat changes above the pet:
  // "+40 🍖", "+5 ⭐", red "-5 ❤️" on an overfeed, etc. Diffing (rather than
  // hardcoding the intended amounts) means proportional care points and
  // clamped stats show what was actually earned. expectDeltaRef is armed
  // right before each action call; rapid repeats (egg warming pulses)
  // merge into a recent popup for the same stat instead of stacking spam.
  const [deltaPopups, setDeltaPopups] = useState<DeltaPopup[]>([]);
  const deltaIdRef = useRef(0);
  const prevSaveRef = useRef(save);
  const expectDeltaRef = useRef(false);

  useEffect(() => {
    const prev = prevSaveRef.current;
    prevSaveRef.current = save;
    if (!expectDeltaRef.current) return;
    expectDeltaRef.current = false;
    const diffs: [number, string][] = [
      [save.hunger - prev.hunger, "🍖"],
      [save.warmth - prev.warmth, "🔥"],
      [save.cleanliness - prev.cleanliness, "🧼"],
      [save.happiness - prev.happiness, "❤️"],
      [save.carePoints - prev.carePoints, "⭐"],
    ];
    const now = Date.now();
    setDeltaPopups((popups) => {
      let next = [...popups];
      for (const [value, icon] of diffs) {
        if (Math.abs(value) < 0.05) continue;
        const mergeable = next.find(
          (p) => p.icon === icon && now - p.bornAt < 1200 && Math.sign(p.value) === Math.sign(value),
        );
        if (mergeable) {
          next = next.map((p) => (p.id === mergeable.id ? { ...p, value: p.value + value } : p));
        } else {
          next.push({ id: ++deltaIdRef.current, icon, value, bornAt: now });
        }
      }
      return next.slice(-8);
    });
    // Sweep expired popups a beat after the 2s float finishes.
    const sweep = setTimeout(
      () => setDeltaPopups((prev2) => prev2.filter((p) => Date.now() - p.bornAt < 2050)),
      2200,
    );
    return () => clearTimeout(sweep);
  }, [save]);

  /** Arms the delta-diff for the save change the wrapped action causes. */
  const withDeltas = useCallback((fn: () => void) => {
    expectDeltaRef.current = true;
    fn();
  }, []);

  // Starvation onset — plays once when hunger bottoms out (Phase C: hard
  // death was removed, hunger clamps at 0 and stays interactive instead of
  // ending the save — see plan-deathDecayMinigameBalance.md). Reuses the
  // same somber cue that used to mark death, since it still fits "this
  // needs attention now," and the same one-shot-on-transition shape.
  const isDistressed = !game.isEgg && save.isAlive && save.hunger <= 0;
  const wasDistressedRef = useRef(isDistressed);
  useEffect(() => {
    if (!wasDistressedRef.current && isDistressed) {
      sfx(Sounds.playDeath);
      setFxTrigger("distressed");
      setTimeout(() => setFxTrigger((t) => (t === "distressed" ? null : t)), 1800);
    }
    wasDistressedRef.current = isDistressed;
  }, [isDistressed, sfx]);

  // Overheat warning particles — burst once as it starts, matching how
  // other one-shot pulses (pulseHappy etc.) already work here.
  const wasOverheatingRef = useRef(false);
  useEffect(() => {
    if (!wasOverheatingRef.current && game.isEggOverheating) {
      setFxTrigger("overheated");
      setTimeout(() => setFxTrigger((t) => (t === "overheated" ? null : t)), 1600);
    }
    wasOverheatingRef.current = game.isEggOverheating;
  }, [game.isEggOverheating]);

  // Petting cooldown (ERP_QA_HUB's petRules.actionCooldowns.petMs) — without
  // this, Pet is a free, instantly-repeatable happiness/care-point source.
  const [petCooldownMs, setPetCooldownMs] = useState(0);
  useEffect(() => {
    const tick = () => {
      setPetCooldownMs(Math.max(0, PET_COOLDOWN_MS - (Date.now() - new Date(save.lastPetted).getTime())));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [save.lastPetted]);

  // Hold-to-warm (hub-style egg mini-game).
  const holdRef = useRef<{ interval?: ReturnType<typeof setInterval>; heldLong: boolean }>({ heldLong: false });
  const gameRef = useRef(game);
  gameRef.current = game;

  const stopWarmHold = useCallback(() => {
    const hold = holdRef.current;
    if (hold.interval) clearInterval(hold.interval);
    hold.interval = undefined;
    // The red overheat glow is only kept fresh by the 200ms warmTick loop —
    // releasing while still at 100 warmth would otherwise leave it stuck on
    // forever (no more ticks to notice warmth dropped/session ended).
    gameRef.current.clearOverheatWarning();
  }, []);

  const startWarmHold = useCallback(() => {
    const hold = holdRef.current;
    hold.heldLong = false;
    if (hold.interval) clearInterval(hold.interval);
    hold.interval = setInterval(() => {
      if (!hold.heldLong) {
        hold.heldLong = true;
        gameRef.current.beginWarmSession();
      }
      expectDeltaRef.current = true;
      gameRef.current.warmTick();
    }, 200);
  }, []);

  // ── Egg warm mode (entered from the SideDock lamp) ───────────────────────
  // Same bounded-modal shape as wash-scrub: whole-screen clickable override,
  // OS focus for Escape, right-click/Esc/✕ cancels. The light-source cursor
  // brightens while actually warming (held over the egg).
  const endWarming = useCallback(() => {
    stopWarmHold();
    warmHeldRef.current = false;
    setWarmHeld(false);
    setWarmingMode(false);
    setClickableOverride(false);
    window.overlay.setFocusable(false);
  }, [stopWarmHold]);

  const startWarming = useCallback(() => {
    if (!save.isAlive || !gameRef.current.isEgg) return;
    setStatsOpen(false);
    setMenuOpen(false);
    setWarmingMode(true);
    setClickableOverride(true);
    window.overlay.setClickable(true);
    window.overlay.setFocusable(true);
  }, [save.isAlive]);

  useEffect(() => {
    if (!warmingMode) return;
    // The egg hatched (or died) mid-mode — nothing left to warm.
    if (!game.isEgg || !save.isAlive) {
      endWarming();
      return;
    }

    const overEgg = (e: MouseEvent) => {
      const PAD = 20;
      const petX = movement.x.get();
      const petY = movement.y.get();
      return (
        e.clientX >= petX - PAD &&
        e.clientX <= petX + PET_SIZE + PAD &&
        e.clientY >= petY - PAD &&
        e.clientY <= petY + PET_SIZE + PAD
      );
    };
    // Ref mirror, not the state value — the held/not-held transition must be
    // read synchronously inside these handlers (see the useConsumables
    // eager-bailout note: never rely on setState side effects for that).
    const setHeld = (held: boolean) => {
      if (held === warmHeldRef.current) return;
      warmHeldRef.current = held;
      setWarmHeld(held);
      if (held) startWarmHold();
      else stopWarmHold();
    };
    const onMove = (e: MouseEvent) => {
      setWarmCursor({ x: e.clientX, y: e.clientY });
      // Drifting off the egg while holding pauses the warm ticks, exactly
      // like the old onPointerLeave on the direct hold gesture.
      setHeld((e.buttons & 1) === 1 && overEgg(e));
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || !overEgg(e)) return;
      setHeld(true);
    };
    const onUp = () => setHeld(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") endWarming();
    };
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      endWarming();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    window.addEventListener("contextmenu", onContext);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onContext);
    };
  }, [warmingMode, game.isEgg, save.isAlive, endWarming, startWarmHold, stopWarmHold, movement]);

  const pulseHappy = useCallback(() => {
    setFxTrigger("happy");
    setHappyPulse(true);
    setTimeout(() => setHappyPulse(false), 700);
    setTimeout(() => setFxTrigger((t) => (t === "happy" ? null : t)), 900);
  }, []);

  // ── Poop cleanup mechanic ────────────────────────────────────────────────
  // Post-hatch only (an egg never poops — shouldSpawnPoop gates on isEgg).
  // After a feed lands, a poop may spawn: the pet does a quick wiggle first
  // (same transient-class pattern as petSeatedWiggling), then the poop
  // slides/fades in just below the pet. It's dragged onto the trash can in
  // the Kitchen drawer (the [data-trashcan] element) for a small
  // happiness/care-point bump. Uncleaned poops are session-only state.
  const [poops, setPoops] = useState<{ id: number; x: number; y: number }[]>([]);
  const [petPoopWiggling, setPetPoopWiggling] = useState(false);
  // True while a poop is being dragged directly over the Kitchen's trash
  // can — lets SideDock enlarge/highlight the can so the drop target is
  // obvious before the player releases (same hit-test rect as dropPoop).
  const [poopOverTrash, setPoopOverTrash] = useState(false);
  const poopIdRef = useRef(0);
  const poopsRef = useRef(poops);
  poopsRef.current = poops;
  const poopTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Real-time throttle backing POOP_RULES.minGapMs — session-only (resets on
  // reload), matching the rest of the poop mechanic's session-only state.
  const lastPoopSpawnAtRef = useRef<number>(-Infinity);
  useEffect(
    () => () => {
      poopTimersRef.current.forEach(clearTimeout);
    },
    [],
  );

  const schedulePoopSpawn = useCallback(() => {
    const msSinceLastSpawn = Date.now() - lastPoopSpawnAtRef.current;
    if (!shouldSpawnPoop(gameRef.current.isEgg, poopsRef.current.length, msSinceLastSpawn)) return;
    lastPoopSpawnAtRef.current = Date.now();
    const delay = POOP_RULES.minDelayMs + Math.random() * (POOP_RULES.maxDelayMs - POOP_RULES.minDelayMs);
    const t1 = setTimeout(() => {
      if (gameRef.current.isEgg || !gameRef.current.save.isAlive) return;
      // Wiggle first ("something's coming"), then the poop slides in below.
      setPetPoopWiggling(true);
      const t2 = setTimeout(() => setPetPoopWiggling(false), 700);
      const t3 = setTimeout(() => {
        const px = movement.x.get() + PET_SIZE / 2 - 14 + (Math.random() * 36 - 18);
        const py = movement.y.get() + PET_SIZE - 26;
        setPoops((prev) => [...prev, { id: ++poopIdRef.current, x: px, y: py }]);
        dbg("poop spawned 💩");
      }, 550);
      poopTimersRef.current.push(t2, t3);
    }, delay);
    poopTimersRef.current.push(t1);
  }, [movement, dbg]);

  // Restart/regression to egg clears any uncleaned poop (an egg can't have
  // pooped, and the trash can is hidden during the egg phase anyway).
  useEffect(() => {
    if (game.isEgg) setPoops([]);
  }, [game.isEgg]);

  /** Release handler for a dragged poop: over the Kitchen's trash can →
   *  cleaned (small reward), anywhere else → it just stays put. Guarded by
   *  id so the native-pointerup trigger and any late framer onDragEnd can't
   *  double-clean the same poop. */
  const isOverTrash = useCallback((pointX: number, pointY: number) => {
    const can = document.querySelector("[data-trashcan]")?.getBoundingClientRect();
    return !!can && pointX >= can.left - 8 && pointX <= can.right + 8 && pointY >= can.top - 8 && pointY <= can.bottom + 8;
  }, []);

  const dropPoop = useCallback(
    (id: number, pointX: number, pointY: number) => {
      if (!poopsRef.current.some((p) => p.id === id)) return; // already handled
      const hit = isOverTrash(pointX, pointY);
      setPoopOverTrash(false);
      if (!hit) return;
      setPoops((prev) => prev.filter((p) => p.id !== id));
      poopsRef.current = poopsRef.current.filter((p) => p.id !== id);
      expectDeltaRef.current = true;
      gameRef.current.cleanPoop();
      pulseHappy();
      sfx(Sounds.playSplash);
      dbg("poop cleaned 🗑️");
    },
    [isOverTrash, pulseHappy, sfx, dbg],
  );

  // ── Online: groups + realtime room ──────────────────────────────────────
  const groupsApi = useGroups(auth.userId);
  const myName = auth.displayName || auth.email?.split("@")[0] || "Player";
  // Personal realtime inbox (friend requests/accepts, room invites) — no DB
  // persistence, works with or without an active room.
  const notifications = useNotifications(auth.userId, myName);
  // Lets notification clicks open the dock at a specific view.
  const [dockViewRequest, setDockViewRequest] = useState<{ view: "friends" | "groups"; n: number } | null>(null);
  const openDockAt = useCallback((view: "friends" | "groups") => {
    setStatsOpen(true);
    setDockViewRequest((prev) => ({ view, n: (prev?.n ?? 0) + 1 }));
  }, []);
  const onSocialPet = useCallback(
    (fromName: string) => {
      game.receiveSocialPet();
      pulseHappy();
      sfx(Sounds.playSqueak);
      dbg(`petted by ${fromName} 🤗`);
    },
    [game, pulseHappy, sfx, dbg],
  );
  const onBattleResolved = useCallback(
    (won: boolean, opponentName: string) => {
      expectDeltaRef.current = true;
      game.applyBattleResult(won);
      if (won) {
        pulseHappy();
        sfx(Sounds.playEvolution);
      } else {
        sfx(Sounds.playHungry);
      }
      dbg(won ? `won battle vs ${opponentName} 🏆` : `lost battle vs ${opponentName}`);
    },
    [game, pulseHappy, sfx, dbg],
  );
  const onMinigameResolved = useCallback(
    (outcome: "win" | "lose" | "tie", opponentName: string, matchId: string, myMove: RpsMove) => {
      // No progression rewards for minigames — just the history log + a
      // server-authoritative match record (Phase A,
      // plan-deathDecayMinigameBalance.md): each client submits its OWN raw
      // move, not a self-derived win/loss boolean — the match only resolves
      // (and minigame_scores updates) once BOTH participants' submissions
      // are in, computed server-side. Replaces the old direct
      // record_minigame_result self-report call.
      game.applyMinigameResult(outcome, "Rock-Paper-Scissors");
      if (supabase && matchId) {
        void supabase
          .rpc("submit_minigame_result", { p_match_id: matchId, p_payload: { move: myMove } })
          .then(({ error }) => {
            if (error) dbg(`minigame score save failed: ${error.message}`);
          });
      }
      if (outcome === "win") {
        // The modal holds a 3s reveal drumroll — celebrate when it lands,
        // not the instant the (already-known) outcome resolves.
        setTimeout(() => {
          pulseHappy();
          sfx(Sounds.playSqueak);
        }, RPS_REVEAL_MS);
      }
      dbg(`RPS vs ${opponentName}: ${outcome}`);
    },
    [game, pulseHappy, sfx, dbg],
  );
  // Chess resolution: fires once per DECISIVE ending (checkmate/resignation)
  // or draw, on each player's own client. Abandoned (cancelled) games never
  // reach here — no score impact by design.
  const onChessResolved = useCallback(
    (outcome: "win" | "lose" | "tie", opponentName: string) => {
      game.applyMinigameResult(outcome, "Chess");
      if (supabase) {
        void supabase
          .rpc("record_minigame_result", { p_game_code: "chess", p_distance: null, p_won: outcome === "win" })
          .then(({ error }) => {
            if (error) dbg(`chess score save failed: ${error.message}`);
          });
      }
      if (outcome === "win") {
        pulseHappy();
        sfx(Sounds.playEvolution);
      }
      dbg(`chess vs ${opponentName}: ${outcome}`);
    },
    [game, pulseHappy, sfx, dbg],
  );

  const room = useRoom({
    userId: auth.userId,
    displayName: myName,
    save,
    isEgg: game.isEgg,
    onSocialPet,
    onBattleResolved,
    onMinigameResolved,
    onChessResolved,
  });

  // Poke (chess): a targeted "it's your move" nudge through the personal
  // user-inbox — reaches the opponent even if they minimized the board or
  // left the room (missed only if their app is fully closed). The payload
  // carries groupId + gameId so tapping the toast deep-links back here.
  const pokeChessOpponent = useCallback(
    (opponentId: string, chessGame: ChessGame) => {
      if (!room.activeGroup) return;
      notifications.sendTo(opponentId, {
        kind: "chess_poke",
        fromName: myName,
        groupId: room.activeGroup.id,
        groupName: room.activeGroup.name,
        gameId: chessGame.id,
      });
      dbg("chess poke sent 👉");
    },
    [notifications, myName, room.activeGroup, dbg],
  );

  // Chess notices auto-clear after a few seconds.
  useEffect(() => {
    if (!room.chessNotice) return;
    const id = setTimeout(room.clearChessNotice, 5000);
    return () => clearTimeout(id);
  }, [room.chessNotice, room.clearChessNotice]);

  // "Your turn" local notification (mirrors update_ready's LOCAL-ONLY
  // pattern): derived purely from the already-synced room.chessGames — no
  // new broadcast kind. Tracks the last-seen currentTurn per game and fires
  // exactly on the opponent→me transition (never on load, never re-fires
  // for an unchanged turn). Suppressed while that game's board is already
  // open in front of the player — a toast would be pure noise then.
  const chessTurnSeenRef = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!auth.userId) return;
    for (const g of room.chessGames) {
      const prior = chessTurnSeenRef.current[g.id];
      chessTurnSeenRef.current[g.id] = g.currentTurn;
      if (g.status !== "active") continue;
      if (g.playerAId !== auth.userId && g.playerBId !== auth.userId) continue;
      if (prior === undefined || prior === g.currentTurn) continue;
      if (prior === auth.userId || g.currentTurn !== auth.userId) continue;
      if (room.openChessGameId === g.id && !room.chessMinimized) continue;
      const opponentId = g.playerAId === auth.userId ? g.playerBId : g.playerAId;
      const opponentName = room.members.find((m) => m.userId === opponentId)?.name ?? "Your opponent";
      notifications.setLocalToast({
        kind: "chess_turn",
        fromName: opponentName,
        fromId: opponentId,
        groupId: room.activeGroup?.id,
        gameId: g.id,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.chessGames, auth.userId]);

  const myActiveChessGames = auth.userId
    ? room.chessGames.filter(
      (g) => g.status === "active" && (g.playerAId === auth.userId || g.playerBId === auth.userId),
    )
    : [];
  const openChessGame = room.openChessGameId
    ? room.chessGames.find((g) => g.id === room.openChessGameId) ?? null
    : null;

  // Room-invite spam guard: one outstanding invite per friend at a time,
  // cleared when they join, when they explicitly decline (notifications
  // .lastDecline), or after 60s either way (backstop for a lost decline).
  const [pendingRoomInvites, setPendingRoomInvites] = useState<Record<string, number>>({});
  const inviteFriendToRoom = useCallback(
    (friendId: string, group: { id: string; name: string; inviteCode: string | null }) => {
      setPendingRoomInvites((prev) => {
        if (prev[friendId] && Date.now() - prev[friendId] < ROOM_INVITE_TTL_MS) return prev; // already pending
        return { ...prev, [friendId]: Date.now() };
      });
      notifications.sendTo(friendId, {
        kind: "room_invite",
        fromName: myName,
        groupId: group.id,
        groupName: group.name,
        inviteCode: group.inviteCode ?? undefined,
      });
    },
    [notifications, myName],
  );
  // 60s backstop — most invites clear sooner via the decline/join effects below.
  useEffect(() => {
    if (Object.keys(pendingRoomInvites).length === 0) return;
    const id = setInterval(() => {
      setPendingRoomInvites((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const fid of Object.keys(next)) {
          if (Date.now() - next[fid]! > ROOM_INVITE_TTL_MS) {
            delete next[fid];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 2000);
    return () => clearInterval(id);
  }, [pendingRoomInvites]);
  // The recipient declined (manually or their own 60s timeout) — clear
  // instantly instead of waiting out our own timer.
  useEffect(() => {
    const d = notifications.lastDecline;
    if (!d) return;
    setPendingRoomInvites((prev) => {
      if (!(d.fromId in prev)) return prev;
      const next = { ...prev };
      delete next[d.fromId];
      return next;
    });
  }, [notifications.lastDecline]);
  // The invited friend showed up in my room's presence — they accepted.
  useEffect(() => {
    if (!room.activeGroup) return;
    const present = new Set(room.members.map((m) => m.userId));
    setPendingRoomInvites((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const fid of Object.keys(next)) {
        if (present.has(fid)) {
          delete next[fid];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [room.activeGroup, room.members]);

  const roomMemberIds = room.members.map((m) => m.userId);

  // While a minigame overlay is open, freeze the local pet (no drag, no
  // wander, no radial menu) — the full-screen overlay already visually
  // covers/intercepts clicks, this is belt-and-suspenders.
  const inMinigame = !!room.tossGame || !!room.minigame;

  // Target Toss game over → each participant logs its OWN result exactly
  // once: a history entry (no progression rewards, same rule as RPS) plus a
  // submission to the server-authoritative match (Phase A,
  // plan-deathDecayMinigameBalance.md) — my TOTAL distance across the whole
  // game (matching targetToss.ts's actual golf-scoring winner rule), not
  // just my best single throw. The match (and minigame_scores) only
  // resolves once every participant has submitted; the local win/lose the
  // UI already shows came from the same deterministic shared-seed replay
  // every client ran, so it always agrees with the eventual server result.
  const tossRecordedRef = useRef(false);
  useEffect(() => {
    const g = room.tossGame;
    if (!g) {
      tossRecordedRef.current = false;
      return;
    }
    if (g.core.winners.length === 0 || tossRecordedRef.current || !auth.userId) return;
    if (!g.core.order.includes(auth.userId)) return;
    tossRecordedRef.current = true;
    const won = g.core.winners.includes(auth.userId);
    const myTotal = computeTotalDistances(g.core.order, g.core.events)[auth.userId] ?? 0;
    game.applyMinigameResult(won ? "win" : "lose", "Target Toss");
    if (supabase && g.matchId) {
      void supabase
        .rpc("submit_minigame_result", { p_match_id: g.matchId, p_payload: { total_distance: myTotal } })
        .then(({ error }) => {
          if (error) dbg(`toss score save failed: ${error.message}`);
        });
    }
    if (won) {
      pulseHappy();
      sfx(Sounds.playEvolution);
    }
  }, [room.tossGame, auth.userId, game, pulseHappy, sfx, dbg]);

  // "Give up" in Target Toss: the quitter's local loss records immediately
  // (history-only, no economy impact either way — Phase B decision), but
  // the server match can only resolve once EVERY participant has
  // submitted, so this submits a total inflated by MISS_PENALTY_DISTANCE
  // for each of my remaining unplayed turns — guarantees I can't still
  // "win" server-side after quitting, without needing a separate
  // quit-early RPC path.
  const forfeitToss = useCallback(() => {
    game.applyMinigameResult("lose", "Target Toss");
    const g = room.tossGame;
    if (supabase && g && auth.userId && g.matchId) {
      const totals = computeTotalDistances(g.core.order, g.core.events);
      const turnsTaken = g.core.events.filter((e) => e.userId === auth.userId).length;
      const remainingTurns = Math.max(0, TARGET_TOSS_ROUNDS - turnsTaken);
      const total = (totals[auth.userId] ?? 0) + remainingTurns * MISS_PENALTY_DISTANCE;
      void supabase
        .rpc("submit_minigame_result", { p_match_id: g.matchId, p_payload: { total_distance: total } })
        .then(({ error }) => {
          if (error) dbg(`toss forfeit save failed: ${error.message}`);
        });
    }
    room.forfeitTossGame();
    dbg("gave up Target Toss 🏳️");
  }, [game, room, dbg, auth.userId]);

  // Publish my pet's position (normalized to screen fraction so every
  // member's monitor maps it proportionally) while in a room.
  useEffect(() => {
    if (!room.activeGroup) return;
    const id = setInterval(() => {
      room.updateMyPosition(
        (movement.x.get() + PET_SIZE / 2) / window.innerWidth,
        (movement.y.get() + PET_SIZE / 2) / window.innerHeight,
      );
    }, 150);
    return () => clearInterval(id);
  }, [room, movement]);

  // Product rule: eggs can't be online. If the pet regresses to an egg
  // (restart) while in a room, drop the connection.
  useEffect(() => {
    if (game.isEgg && room.activeGroup) room.leaveRoom();
  }, [game.isEgg, room]);

  // ── Feed & Ball: real grab → drag → release-to-throw ────────────────────
  // Earlier rounds of this exact gesture were unreliable, but the actual
  // cause (found via live browser reproduction, see useConsumables.ts) was
  // that takeFood/takeBall's synchronous return value was wrong — every
  // grab silently bailed out before the throw sequence ever started, no
  // matter how the gesture itself was built. With that fixed, real drag
  // physics is back, using the same handoff pattern as the pet's own proven
  // drag-throw (usePetMovement.ts): a `useDragControls` instance lets the
  // pile icon's pointerdown hand off an already-in-progress drag session to
  // the always-mounted floating food element (dragListener=false so it only
  // starts via that explicit `.start()` call, never its own pointerdown) —
  // this avoids the earlier "cross-element drag handoff" distrust, since
  // the floating element IS the thing that's actually dragged throughout.
  // A near-zero release velocity (a plain click, or a tiny nudge) still
  // gracefully falls back to an auto-toss in a random nearby direction.
  const foodX = useMotionValue(0);
  const foodY = useMotionValue(0);
  const foodScaleX = useMotionValue(1);
  const foodScaleY = useMotionValue(1);
  const foodRotate = useMotionValue(0);
  const foodOpacity = useMotionValue(0);
  const foodCanceledRef = useRef(false);
  const foodDragControls = useDragControls();
  const foodVelRef = useRef({ vx: 0, vy: 0, lastX: 0, lastY: 0, lastT: 0 });
  // framer-motion's onDragEnd never fires for a press+release with zero
  // pointer movement in between (confirmed via live testing: a plain click
  // left the sequence permanently stuck in "held", which cascades into
  // petBusy=true forever — the exact "everything dead" deadlock reported
  // historically). This native listener is the release trigger of record;
  // onDragEnd is a secondary path for real drags. foodReleasedRef makes
  // whichever fires first win and the other a no-op. Attached synchronously
  // inside grabFood (not a useEffect) — a useEffect-based listener can lose
  // the race against a very fast click completing before the effect commits
  // (this exact race was a real, previously-fixed bug in an earlier round).
  const foodReleasedRef = useRef(false);
  const foodUpListenerRef = useRef<(() => void) | null>(null);
  // Which pile slot the currently-held piece came from — cancelFeed needs
  // this to give it back (consumables.returnFood) if the grab never
  // actually reaches throwFood.
  const grabbedFoodSlotRef = useRef(0);

  // Feed/ball stay available while nested — grabbing either wakes the pet
  // automatically (see grabFood/grabBall) so the action just starts.
  // Cleaning doesn't make sense on a hidden/nested pet, so it's blocked.
  const canFeed = save.isAlive && !save.isSleeping && !game.isEgg && !petBusy;
  const canPlayBall = save.isAlive && !save.isSleeping && !game.isEgg && !petBusy;
  const canClean = save.isAlive && !save.isSleeping && save.cleanliness < 100 && !petBusy && !petNested;

  const throwFoodRef = useRef<(vx: number, vy: number) => void>(() => { });

  const grabFood = useCallback(
    (e: React.PointerEvent, slot: number) => {
      if (!canFeed) {
        dbg(`feed blocked (busy=${petBusy} sleep=${save.isSleeping} egg=${game.isEgg})`);
        return;
      }
      if (!consumables.takeFood(slot)) {
        dbg(`feed: slot ${slot} not ready`);
        return;
      }
      dbg(`feed: took slot ${slot}`);
      grabbedFoodSlotRef.current = slot;
      // Grabbing food while the pet is nested wakes it automatically — the
      // exit (scale-up + wiggle) plays concurrently with the throw, and the
      // pet's own walkTo-to-eat at the end carries it clear of the nest.
      wakeFromNestRef.current();
      // The dock/kitchen deliberately STAY open during the drag-throw (the
      // kitchen is its own drawer now) — only the radial menu closes.
      setMenuOpen(false);
      foodCanceledRef.current = false;
      foodReleasedRef.current = false;
      // The whole window needs to accept mouse input for the drag to track
      // across the entire screen, not just while over the (normally
      // click-through) pile icon. NOT setFocusable: overlay.focus() is a
      // real OS focus-steal — the documented cause of the old "background
      // app freezes" bug — clickability alone is enough for dragging.
      setClickableOverride(true);
      window.overlay.setClickable(true);
      const px = e.clientX - 20;
      const py = e.clientY - 20;
      foodX.set(px);
      foodY.set(py);
      foodScaleX.set(1);
      foodScaleY.set(1);
      foodRotate.set(0);
      foodOpacity.set(1);
      foodVelRef.current = { vx: 0, vy: 0, lastX: px, lastY: py, lastT: performance.now() };
      setFeedPhase("held");
      foodDragControls.start(e);

      const onNativeUp = () => {
        if (foodReleasedRef.current) return;
        foodReleasedRef.current = true;
        window.removeEventListener("pointerup", onNativeUp);
        foodUpListenerRef.current = null;
        throwFoodRef.current(foodVelRef.current.vx, foodVelRef.current.vy);
      };
      foodUpListenerRef.current = onNativeUp;
      window.addEventListener("pointerup", onNativeUp);
    },
    [canFeed, consumables, dbg, petBusy, save.isSleeping, game.isEgg, foodDragControls, foodX, foodY, foodScaleX, foodScaleY, foodRotate, foodOpacity],
  );

  const onFoodDrag = useCallback(() => {
    const now = performance.now();
    const ref = foodVelRef.current;
    const dt = now - ref.lastT;
    if (dt > 0 && dt < 100) {
      ref.vx = ((foodX.get() - ref.lastX) / dt) * 1000;
      ref.vy = ((foodY.get() - ref.lastY) / dt) * 1000;
    }
    ref.lastX = foodX.get();
    ref.lastY = foodY.get();
    ref.lastT = now;
  }, [foodX, foodY]);

  const onFoodDragEnd = useCallback(() => {
    if (foodReleasedRef.current) return;
    foodReleasedRef.current = true;
    if (foodUpListenerRef.current) {
      window.removeEventListener("pointerup", foodUpListenerRef.current);
      foodUpListenerRef.current = null;
    }
    throwFoodRef.current(foodVelRef.current.vx, foodVelRef.current.vy);
  }, []);

  const throwFood = useCallback(
    async (vx: number, vy: number) => {
      setFeedPhase("released");
      dbg("feed thrown");
      // try/finally: NOTHING may leave feedPhase stuck ≠ idle — petBusy
      // would lock every later grab/menu forever (that exact deadlock is
      // what made "worked once, then nothing works" happen previously).
      try {
        const GLIDE = 0.35;
        const speed = Math.hypot(vx, vy);
        let landX: number;
        let landY: number;
        if (speed < 60) {
          // Barely-moved release (a plain click) — still toss it somewhere
          // nearby rather than requiring a real flick every time.
          const ang = Math.random() * Math.PI * 2;
          landX = foodX.get() + Math.cos(ang) * 90;
          landY = foodY.get() + Math.sin(ang) * 90;
        } else {
          landX = foodX.get() + vx * GLIDE;
          landY = foodY.get() + vy * GLIDE;
        }
        landX = Math.min(Math.max(landX, 20), window.innerWidth - 60);
        landY = Math.min(Math.max(landY, 60), window.innerHeight - 100);

        const dist = Math.hypot(landX - foodX.get(), landY - foodY.get());
        await throwArc({
          x: foodX,
          y: foodY,
          rotate: foodRotate,
          scaleX: foodScaleX,
          scaleY: foodScaleY,
          toX: landX,
          toY: landY,
          arcHeight: Math.min(200, Math.max(50, dist * 0.5)),
          duration: Math.min(0.85, Math.max(0.3, dist / 1100)),
          spinDegrees: 320 + Math.random() * 280 + Math.min(300, speed * 0.12),
        });
        // Landing bounce with a small squash-and-stretch: squash flat on
        // impact, stretch tall as the bounce carries it back up, squash
        // again on the second touchdown, then settle to normal size.
        foodScaleX.set(1.18);
        foodScaleY.set(0.85);
        await Promise.all([
          animate(foodY, landY - 14, { duration: 0.12, ease: "easeOut" }),
          animate(foodScaleX, 0.9, { duration: 0.12, ease: "easeOut" }),
          animate(foodScaleY, 1.14, { duration: 0.12, ease: "easeOut" }),
        ]);
        await Promise.all([
          animate(foodY, landY, { duration: 0.1, ease: "easeIn" }),
          animate(foodScaleX, 1.12, { duration: 0.1, ease: "easeIn" }),
          animate(foodScaleY, 0.88, { duration: 0.1, ease: "easeIn" }),
        ]);
        await Promise.all([
          animate(foodScaleX, 1, { duration: 0.16, ease: "easeOut" }),
          animate(foodScaleY, 1, { duration: 0.16, ease: "easeOut" }),
        ]);

        if (foodCanceledRef.current) return;
        await movement.walkTo(landX - 24, landY - 48);
        if (foodCanceledRef.current) return;

        setFeedPhase("eating");
        const wasOverfed = !game.isEgg && game.save.hunger >= 100;
        setFxTrigger(wasOverfed ? "overfed" : "eat");
        sfx(Sounds.playNom);
        expectDeltaRef.current = true;
        game.feed();
        dbg("feed eaten");
        // A fed pet may need to poop a little while later (post-hatch only).
        schedulePoopSpawn();
        await new Promise((r) => setTimeout(r, 450));
        await Promise.all([
          animate(foodScaleX, 0, { duration: 0.3, ease: "easeIn" }),
          animate(foodScaleY, 0, { duration: 0.3, ease: "easeIn" }),
        ]);
      } catch (err) {
        console.error("[feed] sequence failed:", err);
        dbg(`feed FAILED: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        foodOpacity.set(0);
        foodScaleX.set(1);
        foodScaleY.set(1);
        setFxTrigger(null);
        setFeedPhase("idle");
        setClickableOverride(false);
        window.overlay.setClickable(false);
      }
    },
    [foodX, foodY, foodScaleX, foodScaleY, foodRotate, foodOpacity, movement, game, sfx, dbg, schedulePoopSpawn],
  );
  throwFoodRef.current = (vx, vy) => void throwFood(vx, vy);

  const cancelFeed = useCallback(() => {
    if (feedPhase === "idle") return;
    foodCanceledRef.current = true;
    foodOpacity.set(0);
    if (feedPhase === "held") {
      // Never reached throwFood, so its finally never runs — clean up here.
      // Also block the still-pending native pointerup listener (and
      // framer's onDragEnd) from firing a throw after the fact.
      foodReleasedRef.current = true;
      if (foodUpListenerRef.current) {
        window.removeEventListener("pointerup", foodUpListenerRef.current);
        foodUpListenerRef.current = null;
      }
      setFeedPhase("idle");
      setClickableOverride(false);
      window.overlay.setClickable(false);
      // Give the piece back — it was never actually thrown/eaten (mirrors
      // cancelBall's consumables.returnBall() below).
      consumables.returnFood(grabbedFoodSlotRef.current);
    }
    dbg("feed canceled");
  }, [feedPhase, foodOpacity, dbg, consumables]);

  useEffect(() => {
    if (feedPhase === "idle") return;
    // Right-click only — no Escape here (see throwFood's comment on why
    // this doesn't grant OS focus).
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      cancelFeed();
    };
    window.addEventListener("contextmenu", onContext);
    return () => window.removeEventListener("contextmenu", onContext);
  }, [feedPhase, cancelFeed]);

  // ── Ball: same grab → drag → release-to-throw as food for the initial
  // toss; the fetch-and-throw-back-at-the-screen flourish afterward stays a
  // fully automatic sequence (the pet's own action, not user-dragged).
  const ballX = useMotionValue(0);
  const ballY = useMotionValue(0);
  const ballScaleX = useMotionValue(0);
  const ballScaleY = useMotionValue(0);
  const ballRotate = useMotionValue(0);
  const ballOpacity = useMotionValue(0);
  const ballCanceledRef = useRef(false);
  const ballDragControls = useDragControls();
  const ballVelRef = useRef({ vx: 0, vy: 0, lastX: 0, lastY: 0, lastT: 0 });
  // See foodReleasedRef's comment: framer-motion's onDragEnd never fires for
  // a zero-movement press+release, so a native pointerup listener (attached
  // synchronously, not via useEffect) is the release trigger of record.
  const ballReleasedRef = useRef(false);
  const ballUpListenerRef = useRef<(() => void) | null>(null);
  const runBallFetchRef = useRef<(vx: number, vy: number) => void>(() => { });

  const grabBall = useCallback(
    (e: React.PointerEvent) => {
      if (!canPlayBall) {
        dbg(`ball blocked (busy=${petBusy} sleep=${save.isSleeping} egg=${game.isEgg})`);
        return;
      }
      if (!consumables.takeBall()) {
        dbg("ball: not in slot");
        return;
      }
      dbg("ball: taken");
      // Grabbing the ball while nested wakes the pet automatically (see
      // grabFood's matching comment).
      wakeFromNestRef.current();
      // Kitchen stays open during the drag-throw (see grabFood's comment).
      setMenuOpen(false);
      ballCanceledRef.current = false;
      ballReleasedRef.current = false;
      setClickableOverride(true);
      window.overlay.setClickable(true);
      const px = e.clientX - 17;
      const py = e.clientY - 17;
      ballX.set(px);
      ballY.set(py);
      ballScaleX.set(1);
      ballScaleY.set(1);
      ballRotate.set(0);
      ballOpacity.set(1);
      ballVelRef.current = { vx: 0, vy: 0, lastX: px, lastY: py, lastT: performance.now() };
      setBallPhase("held");
      ballDragControls.start(e);

      const onNativeUp = () => {
        if (ballReleasedRef.current) return;
        ballReleasedRef.current = true;
        window.removeEventListener("pointerup", onNativeUp);
        ballUpListenerRef.current = null;
        runBallFetchRef.current(ballVelRef.current.vx, ballVelRef.current.vy);
      };
      ballUpListenerRef.current = onNativeUp;
      window.addEventListener("pointerup", onNativeUp);
    },
    [canPlayBall, consumables, dbg, petBusy, save.isSleeping, game.isEgg, ballDragControls, ballX, ballY, ballScaleX, ballScaleY, ballRotate, ballOpacity],
  );

  const onBallDrag = useCallback(() => {
    const now = performance.now();
    const ref = ballVelRef.current;
    const dt = now - ref.lastT;
    if (dt > 0 && dt < 100) {
      ref.vx = ((ballX.get() - ref.lastX) / dt) * 1000;
      ref.vy = ((ballY.get() - ref.lastY) / dt) * 1000;
    }
    ref.lastX = ballX.get();
    ref.lastY = ballY.get();
    ref.lastT = now;
  }, [ballX, ballY]);

  const onBallDragEnd = useCallback(() => {
    if (ballReleasedRef.current) return;
    ballReleasedRef.current = true;
    if (ballUpListenerRef.current) {
      window.removeEventListener("pointerup", ballUpListenerRef.current);
      ballUpListenerRef.current = null;
    }
    runBallFetchRef.current(ballVelRef.current.vx, ballVelRef.current.vy);
  }, []);

  const runBallFetch = useCallback(
    async (vx: number, vy: number) => {
      setBallPhase("playing");
      dbg("ball thrown");
      // try/finally: the ball MUST return to its slot and ballPhase MUST
      // reach idle no matter what fails mid-sequence — a stuck "playing" is
      // exactly the "Out playing… forever, everything dead" lockup reported
      // live.
      try {
        const GLIDE = 0.35;
        const speed = Math.hypot(vx, vy);
        let landX: number;
        let landY: number;
        if (speed < 60) {
          const ang = Math.random() * Math.PI * 2;
          landX = ballX.get() + Math.cos(ang) * 100;
          landY = ballY.get() + Math.sin(ang) * 100;
        } else {
          landX = ballX.get() + vx * GLIDE;
          landY = ballY.get() + vy * GLIDE;
        }
        landX = Math.min(Math.max(landX, 20), window.innerWidth - 60);
        landY = Math.min(Math.max(landY, 60), window.innerHeight - 100);

        // Flight: ballistic arc + spin to the landing spot, driven by release velocity.
        const dist = Math.hypot(landX - ballX.get(), landY - ballY.get());
        await throwArc({
          x: ballX,
          y: ballY,
          rotate: ballRotate,
          scaleX: ballScaleX,
          scaleY: ballScaleY,
          toX: landX,
          toY: landY,
          arcHeight: Math.min(220, Math.max(55, dist * 0.55)),
          duration: Math.min(0.9, Math.max(0.32, dist / 1050)),
          spinDegrees: 380 + Math.random() * 340 + Math.min(340, speed * 0.14),
        });
        // Gravity bounce (2 diminishing hops) with matching squash-and-
        // stretch, tapering down with the bounce height.
        ballScaleX.set(1.2);
        ballScaleY.set(0.82);
        await Promise.all([
          animate(ballY, landY - 24, { duration: 0.16, ease: "easeOut" }),
          animate(ballScaleX, 0.9, { duration: 0.16, ease: "easeOut" }),
          animate(ballScaleY, 1.14, { duration: 0.16, ease: "easeOut" }),
        ]);
        await Promise.all([
          animate(ballY, landY, { duration: 0.13, ease: "easeIn" }),
          animate(ballScaleX, 1.12, { duration: 0.13, ease: "easeIn" }),
          animate(ballScaleY, 0.9, { duration: 0.13, ease: "easeIn" }),
        ]);
        await Promise.all([
          animate(ballY, landY - 10, { duration: 0.1, ease: "easeOut" }),
          animate(ballScaleX, 0.96, { duration: 0.1, ease: "easeOut" }),
          animate(ballScaleY, 1.06, { duration: 0.1, ease: "easeOut" }),
        ]);
        await Promise.all([
          animate(ballY, landY, { duration: 0.09, ease: "easeIn" }),
          animate(ballScaleX, 1, { duration: 0.12, ease: "easeOut" }),
          animate(ballScaleY, 1, { duration: 0.12, ease: "easeOut" }),
        ]);

        if (ballCanceledRef.current) return;
        // Pet runs to the ball.
        await movement.walkTo(landX - 24, landY - 48);
        if (ballCanceledRef.current) return;

        // Grab: ball snaps to the pet with a quick bounce.
        expectDeltaRef.current = true;
        game.throwBall();
        pulseHappy();
        dbg("ball fetched");
        ballX.set(movement.x.get() + 40);
        ballY.set(movement.y.get() + 15);
        await Promise.all([animate(ballScaleX, 1.5, { duration: 0.08 }), animate(ballScaleY, 1.5, { duration: 0.08 })]);
        await Promise.all([animate(ballScaleX, 1, { duration: 0.1 }), animate(ballScaleY, 1, { duration: 0.1 })]);

        // Throw back at the screen: grows toward center then fades.
        await Promise.all([
          animate(ballX, window.innerWidth / 2 - 32, { duration: 0.65, ease: THROW_EASE }),
          animate(ballY, window.innerHeight / 2 - 32, { duration: 0.65, ease: THROW_EASE }),
          animate(ballScaleX, 16, { duration: 0.65, ease: THROW_EASE }),
          animate(ballScaleY, 16, { duration: 0.65, ease: THROW_EASE }),
          animate(ballOpacity, 0, { duration: 0.65, ease: THROW_EASE }),
        ]);
      } catch (err) {
        console.error("[ball] sequence failed:", err);
        dbg(`ball FAILED: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        ballOpacity.set(0);
        ballScaleX.set(0);
        ballScaleY.set(0);
        ballX.set(-200);
        ballY.set(-200);
        consumables.returnBall();
        setBallPhase("idle");
        setClickableOverride(false);
        window.overlay.setClickable(false);
      }
    },
    [movement, game, pulseHappy, consumables, ballX, ballY, ballScaleX, ballScaleY, ballRotate, ballOpacity, dbg],
  );
  runBallFetchRef.current = (vx, vy) => void runBallFetch(vx, vy);

  const cancelBall = useCallback(() => {
    if (ballPhase === "idle") return;
    ballCanceledRef.current = true;
    ballOpacity.set(0);
    if (ballPhase === "held") {
      // Never reached runBallFetch, so its finally never runs — clean up
      // here, including giving the ball back (runBallFetch would have).
      ballReleasedRef.current = true;
      if (ballUpListenerRef.current) {
        window.removeEventListener("pointerup", ballUpListenerRef.current);
        ballUpListenerRef.current = null;
      }
      setBallPhase("idle");
      setClickableOverride(false);
      window.overlay.setClickable(false);
      consumables.returnBall();
    }
    dbg("ball canceled");
  }, [ballPhase, ballOpacity, dbg, consumables]);

  useEffect(() => {
    if (ballPhase === "idle") return;
    // Right-click only — see runBallFetch's comment.
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      cancelBall();
    };
    window.addEventListener("contextmenu", onContext);
    return () => window.removeEventListener("contextmenu", onContext);
  }, [ballPhase, cancelBall]);

  // ── Wash: hold sponge + scrub (entered from the SideDock's sponge) ──────
  const scrubHeldRef = useRef(false);
  const scrubTargetRef = useRef(1000);
  const lastScrubPointRef = useRef<{ x: number; y: number } | null>(null);
  const lastScrubAtRef = useRef<number | null>(null);
  const scrubEffectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bubbleSpawnRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const scrubCursorRef = useRef({ x: 0, y: 0 });

  const endCleaning = useCallback((completed: boolean) => {
    if (completed) {
      sfx(Sounds.playSplash);
      expectDeltaRef.current = true;
      gameRef.current.wash();
    }
    setCleaningMode(false);
    setScrubHeld(false);
    scrubHeldRef.current = false;
    setScrubbingEffectively(false);
    setScrubProgress(0);
    setBubbles([]);
    lastScrubPointRef.current = null;
    lastScrubAtRef.current = null;
    setClickableOverride(false);
    // Restore the normal non-focusable overlay (see main.ts's comment on
    // focusable:false — holding OS focus outside a deliberate, bounded
    // interaction like this one is what caused apps behind the overlay to
    // appear frozen).
    window.overlay.setFocusable(false);
  }, [sfx]);

  const startCleaning = useCallback(() => {
    if (!save.isAlive || save.isSleeping || save.cleanliness >= 100) return;
    setStatsOpen(false);
    setMenuOpen(false);
    const missing = Math.max(0, 100 - Math.round(save.cleanliness));
    scrubTargetRef.current = Math.min(10, Math.max(1, missing / 10)) * 1000;
    setScrubProgress(0);
    setCleaningMode(true);
    setClickableOverride(true);
    window.overlay.setClickable(true);
    // Scrubbing is a bounded, deliberate modal interaction (like the
    // AuthPanel's text inputs) — needs real OS keyboard focus for Escape to
    // reach the renderer at all, since the overlay is non-focusable by
    // default and a non-focusable window never receives key events.
    window.overlay.setFocusable(true);
  }, [save.isAlive, save.isSleeping, save.cleanliness]);

  useEffect(() => {
    if (!cleaningMode) return;

    const onMove = (e: MouseEvent) => {
      scrubCursorRef.current = { x: e.clientX, y: e.clientY };
      setScrubCursor(scrubCursorRef.current);

      // Only progress (and only count as "actively scrubbing" for the
      // particle effects) while the sponge is actually over the pet — a
      // forgiving padded box around its current (frozen, non-wandering)
      // position, not a pixel-exact hitbox.
      const PAD = 20;
      const petX = movement.x.get();
      const petY = movement.y.get();
      const overPet =
        e.clientX >= petX - PAD &&
        e.clientX <= petX + PET_SIZE + PAD &&
        e.clientY >= petY - PAD &&
        e.clientY <= petY + PET_SIZE + PAD;

      if (!scrubHeldRef.current || (e.buttons & 1) !== 1 || !overPet) {
        if (!overPet) {
          setScrubbingEffectively(false);
          lastScrubPointRef.current = null;
          lastScrubAtRef.current = null;
        }
        return;
      }

      const nextPoint = { x: e.clientX, y: e.clientY };
      const prevPoint = lastScrubPointRef.current;
      const now = performance.now();
      const prevAt = lastScrubAtRef.current;
      lastScrubPointRef.current = nextPoint;
      lastScrubAtRef.current = now;
      if (!prevPoint || prevAt === null) return;

      const dx = nextPoint.x - prevPoint.x;
      const dy = nextPoint.y - prevPoint.y;
      if (Math.sqrt(dx * dx + dy * dy) < 2) return;

      const elapsed = Math.max(0, Math.min(120, now - prevAt));
      setScrubbingEffectively(true);
      if (scrubEffectTimeoutRef.current) clearTimeout(scrubEffectTimeoutRef.current);
      scrubEffectTimeoutRef.current = setTimeout(() => setScrubbingEffectively(false), 150);

      setScrubProgress((prev) => {
        const next = Math.min(scrubTargetRef.current, prev + elapsed);
        if (next >= scrubTargetRef.current) setTimeout(() => endCleaning(true), 0);
        return next;
      });
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      setScrubHeld(true);
      scrubHeldRef.current = true;
      lastScrubAtRef.current = performance.now();
    };
    const onUp = () => {
      setScrubHeld(false);
      scrubHeldRef.current = false;
      setScrubbingEffectively(false);
      lastScrubPointRef.current = null;
      lastScrubAtRef.current = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") endCleaning(false);
    };
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      endCleaning(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    window.addEventListener("contextmenu", onContext);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onContext);
    };
  }, [cleaningMode, endCleaning, movement]);

  // Bubble particle spawn loop while actively scrubbing. Reads scrubCursorRef
  // (not the scrubCursor state) so this effect doesn't depend on it — mouse
  // move events fire far faster than 170ms, and depending on the state here
  // would tear down and recreate the interval on every single move, so it
  // would never actually survive long enough to fire.
  useEffect(() => {
    if (!cleaningMode || !scrubbingEffectively) return;
    bubbleSpawnRef.current = setInterval(() => {
      const origin = scrubCursorRef.current;
      const count = Math.random() < 0.72 ? 1 : 2;
      const next = Array.from({ length: count }, (_, i) => {
        const dir = Math.random() < 0.5 ? -1 : 1;
        const dist = 90 + Math.random() * 150;
        return {
          id: `${Date.now()}-${i}-${Math.random()}`,
          x: origin.x - 30 + Math.random() * 60,
          y: origin.y - 20 + Math.random() * 30,
          dx: dir * dist,
          dy: 26 + Math.random() * 46,
          arcY: -(46 + Math.random() * 82),
          size: 10 + Math.random() * 18,
          duration: 0.78 + Math.random() * 0.55,
          rotate: dir * (120 + Math.random() * 260),
        };
      });
      setBubbles((prev) => [...prev.slice(-28), ...next]);
    }, 170);
    return () => clearInterval(bubbleSpawnRef.current);
  }, [cleaningMode, scrubbingEffectively]);

  // The actual pet sprite for the current stage — factored out so both the
  // normal (post-hatch) slot below AND the hatch stage's "pet sitting in
  // the burst-open shell" moment can render the exact same thing.
  const renderPetSprite = (): React.ReactNode => {
    if (save.evolutionStage === 1) {
      // Baby stage is layered (tail behind, body on top, wink overlay
      // swapped in for the blink pose) instead of a flat pose image.
      return (
        <div style={{ position: "relative", width: PET_SIZE, height: PET_SIZE }}>
          <img
            src={BABY_LAYERS.tail}
            width={PET_SIZE}
            height={PET_SIZE}
            draggable={false}
            alt=""
            style={{ position: "absolute", inset: 0, zIndex: 0 }}
          />
          <img
            src={BABY_LAYERS.body}
            width={PET_SIZE}
            height={PET_SIZE}
            draggable={false}
            alt={save.name}
            style={{ position: "absolute", inset: 0, zIndex: 1 }}
          />
          {(blinking || save.isSleeping) && (
            <img
              src={BABY_LAYERS.wink}
              width={PET_SIZE}
              height={PET_SIZE}
              draggable={false}
              alt=""
              style={{ position: "absolute", inset: 0, zIndex: 2 }}
            />
          )}
        </div>
      );
    }
    const stageSprites = SPRITES[save.evolutionStage];
    if (!stageSprites) return null;
    const src =
      save.isSleeping && stageSprites.sleep
        ? stageSprites.sleep
        : blinking || save.isSleeping
          ? stageSprites.blink
          : stageSprites.idle;
    return (
      <img
        src={src}
        width={PET_SIZE}
        height={PET_SIZE}
        draggable={false}
        alt={save.name}
      />
    );
  };

  // Sprite selection: the still-waiting egg is small (EGG_IDLE_SIZE) and
  // flashes/wiggles once ready to hatch. While the click-gated crack
  // sequence is running (wiggle/crack1-3), this slot renders nothing —
  // that part of the cutscene lives in the centered/enlarged hatch stage
  // overlay instead. The instant the shell bursts, game.isEgg flips false
  // and this slot goes straight back to rendering the REAL pet
  // (renderPetSprite()) — it sits right in the shell and later jumps out
  // by animating its own movement.x/y, never a decorative stand-in.
  // (Phase C removed the dead/🪦 branch that used to live here — hunger
  // clamping at 0 no longer ends the save, so the pet's own sprite always
  // renders; distress is communicated via the hunger bubble in PetEffects
  // and the one-shot "distressed" particle burst above, not a tombstone.)
  let visual: React.ReactNode;
  if (game.isEgg && eggPhase === "idle") {
    visual = (
      <img
        src={EGG_SPRITES.idle}
        width={EGG_IDLE_SIZE}
        height={EGG_IDLE_SIZE}
        draggable={false}
        className={game.canHatch ? "egg-anim-wiggle egg-anim-ready-flash" : undefined}
        alt="Egg"
      />
    );
  } else if (game.isEgg) {
    visual = null;
  } else {
    visual = renderPetSprite();
  }

  const spawnEggShards = useCallback((count: number) => {
    setEggShards((prev) => [
      ...prev,
      ...Array.from({ length: count }, (_, i) => {
        const dir = Math.random() < 0.5 ? -1 : 1;
        return {
          id: Date.now() + i + Math.random(),
          src: i % 2 === 0 ? eggShard1 : eggShard2,
          dx: dir * (30 + Math.random() * 90),
          // All shards settle on the same ground line the top shell falls
          // to (HATCH_GROUND_DY), just with a little jitter.
          dy: HATCH_GROUND_DY + (Math.random() * 16 - 8),
          rotate: dir * (140 + Math.random() * 200),
        };
      }),
    ]);
  }, []);

  // Egg -> baby ("hatch") is a click-gated cutscene: the player opens the
  // radial menu on a ready egg and picks "Evolve!" (see radialActions
  // below) to start it — moves the egg to a centered, 1.5x-enlarged "hatch
  // stage" (hatchCenter/HATCH_SIZE) and starts it wiggling. Each further
  // click on that centered egg advances one crack frame and throws more
  // shell shards onto the ground than the last. The final click bursts the
  // shell open — from there it's automatic: the REAL pet (game.isEgg is
  // already false by then, so `visual` renders it normally) sits in the
  // shell wiggling, then jumps out by animating its own movement.x/y in an
  // arc — never a decorative stand-in — and the leftover shell + shards
  // stay at hatchCenter, fading out a few seconds later.
  const advanceHatch = useCallback(() => {
    if (eggPhase === "idle") {
      if (!game.canHatch) return;
      setMenuOpen(false);
      // Defensive reset: if a previous attempt was abandoned mid-sequence
      // (e.g. reset to a fresh egg via the admin panel), this guarantees a
      // clean slate instead of stray timers/motion values from that
      // abandoned run corrupting the new one (see hatchTimersRef above —
      // this was the actual cause of the hatch stage drifting rightward on
      // repeated attempts).
      clearHatchTimers();
      setEggShards([]);
      setPetSeatedWiggling(false);
      setPetHappyWiggling(false);
      setEggLeftoverFading(false);
      eggTopX.set(0);
      eggTopY.set(0);
      eggTopRotate.set(0);

      setHatchCenter({ x: window.innerWidth / 2 - HATCH_SIZE / 2, y: window.innerHeight / 2 - HATCH_SIZE / 2 });
      setHatchCutsceneActive(true);
      setIsEvolving(true);
      setEggPhase("wiggle");
      return;
    }
    if (eggPhase === "wiggle") {
      setEggPhase("crack1");
      spawnEggShards(2);
      sfx(Sounds.playCrack);
      return;
    }
    if (eggPhase === "crack1") {
      setEggPhase("crack2");
      spawnEggShards(3);
      sfx(Sounds.playCrack);
      return;
    }
    if (eggPhase === "crack2") {
      setEggPhase("crack3");
      spawnEggShards(4);
      sfx(Sounds.playCrack);
      return;
    }
    if (eggPhase !== "crack3") return;

    // Final click: burst the shell open. Everything after this is timed,
    // not click-gated.
    setEggPhase("burst");
    sfx(Sounds.playCrack);
    sfx(Sounds.playEvolution);
    game.hatchOrEvolve();
    const t = EGG_HATCH_TIMING;

    // Snap the REAL pet (not a copy) into the shell's center — this is
    // what `visual` renders from here on, since game.isEgg is now false.
    const center = hatchCenter;
    const petOffset = (HATCH_SIZE - PET_SIZE) / 2;
    const seatX = (center?.x ?? 0) + petOffset;
    const seatY = (center?.y ?? 0) + petOffset;
    movement.x.set(seatX);
    movement.y.set(seatY);
    // The inner sprite wrapper's "lean" offset (leanX/leanY, near the top
    // of this component) is `lagX/lagY - movement.x/y`, where lagX/lagY is
    // an overdamped spring chasing movement.x/y — by design, so ordinary
    // wander/drag motion gives the body a trailing squash-lean instead of
    // rigidly snapping to the cursor. But that spring can't tell an
    // intentional instant teleport (this seat snap) from a huge, fast
    // drag: right after the `.set()` above, lagX/lagY are still miles from
    // the new seat position, so leanX/leanY briefly reports the ENTIRE
    // jump distance — visually, the pet appears to slide in from outside
    // the shell instead of just appearing seated. `.jump()` (unlike
    // `.set()`) resets a spring's value AND velocity immediately, with no
    // animation, so snapping lagX/lagY here too keeps leanX/leanY at 0
    // through the teleport.
    lagX.jump(seatX);
    lagY.jump(seatY);
    setPetSeatedWiggling(true);

    // Top shell: thrown farther and lands rotated a full 180deg (upside
    // down), on the same ground line the shards settle on.
    void animate(eggTopY, [0, -190, HATCH_GROUND_DY], { duration: 0.9, ease: ["easeOut", "easeIn"], times: [0, 0.4, 1] });
    void animate(eggTopX, 60, { duration: 0.9, ease: "easeOut" });
    void animate(eggTopRotate, 180, { duration: 0.9, ease: "easeOut" });

    scheduleHatch(() => {
      // Jump-out: the REAL pet's own position (movement.x/y) animates in
      // an arc higher than the egg itself, landing just outside the
      // shell — so what you see jumping IS the actual playable pet, not a
      // decorative stand-in that later hands off to it.
      setPetSeatedWiggling(false);
      const landX = seatX + HATCH_SIZE * 0.62;
      void animate(movement.y, [seatY, seatY - HATCH_SIZE * 1.15, seatY], {
        duration: t.jumpMs / 1000,
        ease: ["easeOut", "easeIn"],
        times: [0, 0.4, 1],
      });
      void animate(movement.x, landX, { duration: t.jumpMs / 1000, ease: "easeOut" }).then(() => {
        setPetHappyWiggling(true);
        scheduleHatch(() => setPetHappyWiggling(false), t.happyMs);
        setHatchCutsceneActive(false);
        setIsEvolving(false);
      });
    }, t.seatedMs);

    scheduleHatch(() => setEggLeftoverFading(true), t.seatedMs + t.jumpMs + t.wanderMs);
    scheduleHatch(() => {
      setEggLeftoverFading(false);
      setEggPhase("idle");
      setEggShards([]);
      setHatchCenter(null);
      eggTopX.set(0);
      eggTopY.set(0);
      eggTopRotate.set(0);
    }, t.seatedMs + t.jumpMs + t.wanderMs + t.fadeMs);
  }, [eggPhase, game, sfx, spawnEggShards, movement.x, movement.y, lagX, lagY, eggTopX, eggTopY, eggTopRotate, hatchCenter, clearHatchTimers, scheduleHatch]);

  // Any later stage-up (baby->adult->final): no dedicated art yet, so it
  // keeps the original 10s "charging" glow placeholder + flash reveal.
  const handleEvolve = useCallback(() => {
    if (petBusy) return;
    setMenuOpen(false);
    setIsEvolving(true);

    setTimeout(() => {
      setEvolvePulse(true);
      sfx(Sounds.playEvolution);
      game.hatchOrEvolve();
      setTimeout(() => {
        setEvolvePulse(false);
        setIsEvolving(false);
      }, 2700);
    }, 10000);
  }, [game, petBusy, sfx]);

  // "Send Home" (Part F, extended): walks the pet onto the dock's nest slot
  // (the [data-homeslot] element in the Home panel header — attribute-based
  // rect lookup like the trash can) and parks it there in static mode.
  // Shared by two entry points: the radial 🏠 action (which opens the dock
  // first, hence the delayed call below) and dragging the pet/egg directly
  // onto the visible slot (petDragHandlers.onDragEnd) — the drop path calls
  // this immediately since the dock/slot must already be on-screen for the
  // drop to have hit-tested positive in the first place. `speedPxPerFrame`
  // lets the drop path use a quick snap (the pet is already right next to
  // the slot) instead of the radial path's normal walking speed.
  const enterNest = useCallback(
    (speedPxPerFrame?: number) => {
      const slot = document.querySelector("[data-homeslot]")?.getBoundingClientRect();
      if (!slot) {
        dbg("send home: no slot (dock closed?)");
        return;
      }
      setIsFollowing(false);
      prefs.setMovementMode("static");
      setSentHome(true);
      // walkTo has its own 6s watchdog — no petBusy-style lockup risk.
      // On arrival the pet tucks itself into the nest (fade+shrink, then
      // the roaming sprite stays hidden) — unless something cancelled
      // Send Home while it was still walking.
      void movement
        .walkTo(slot.left + slot.width / 2 - PET_SIZE / 2, slot.top + slot.height / 2 - PET_SIZE / 2, speedPxPerFrame)
        .then(() => {
          if (sentHomeRef.current) setPetNested(true);
        });
      dbg("sent home 🪺");
    },
    // movement.walkTo (not the whole `movement` object, which is a fresh
    // object literal every render) — see petDragOnDrag's comment below for
    // why depending on the unstable wrapper object breaks a live drag.
    [movement.walkTo, prefs.setMovementMode, dbg],
  );

  const sendHome = useCallback(() => {
    setMenuOpen(false);
    setStatsOpen(true);
    // Force the dock onto the Home tab regardless of which panel the
    // player was viewing — the nest slot only renders inside Home content,
    // and "force-focus the main tab" is the whole point of Send Home.
    ribbon.setActivePanel(null);
    // The short delay lets the Home panel's slide-in settle before its
    // rect is read.
    setTimeout(() => enterNest(), 500);
  }, [ribbon.setActivePanel, enterNest]);

  /** Release the pet from the nest — either the slot's own click, or
   *  automatically when a care action (feed/ball) grabs the pet while it's
   *  nested. No-ops if the pet isn't actually nested (safe to call from
   *  grabFood/grabBall unconditionally). Clears petNested immediately (the
   *  display-scale spring animates 0→normal on its own) and layers a short
   *  wiggle on top so it visibly "comes out" rather than just popping back. */
  const wakeFromNest = useCallback(() => {
    if (!petNestedRef.current) return;
    setPetNested(false);
    setSentHome(false);
    setPetExitingNest(true);
    setTimeout(() => setPetExitingNest(false), 650);
    dbg("pet left the nest");
  }, [dbg]);
  wakeFromNestRef.current = wakeFromNest;

  // Feed/Wash/Ball all live in the SideDock now — the radial menu only
  // handles instant-click care actions. A ready-to-hatch egg gets its own
  // minimal menu (just "Evolve!", which kicks off advanceHatch) instead of
  // the pet/sleep actions that don't apply to an egg. While asleep, the
  // only meaningful action is waking up, so nothing else even shows.
  const radialActions: RadialAction[] = game.isEgg
    ? game.canHatch
      ? [{ key: "evolve", icon: "🥚", label: "Evolve!", onClick: advanceHatch, highlight: true }]
      : []
    : save.isSleeping
      ? [{ key: "sleep", icon: "☀️", label: "Wake", onClick: game.toggleSleep }]
      : [
        {
          key: "pet",
          icon: "🤗",
          label: petCooldownMs > 0 ? `Pet — recharges in ${fmtCooldown(petCooldownMs)}` : "Pet",
          onClick: () => {
            sfx(Sounds.playSqueak);
            withDeltas(game.pet);
            pulseHappy();
          },
          disabled: petCooldownMs > 0,
          cooldownProgress: 1 - petCooldownMs / PET_COOLDOWN_MS,
          cooldownLabel: petCooldownMs > 0 ? fmtCooldown(petCooldownMs) : undefined,
        },
        {
          key: "movementMode",
          icon: prefs.movementMode === "free" ? "📌" : "🐾",
          label: prefs.movementMode === "free" ? "Stay" : "Free Roam",
          onClick: () => {
            // Choosing a movement mode is an explicit "come out" signal —
            // one of Send Home's two documented cancel conditions.
            setSentHome(false);
            setPetNested(false);
            prefs.toggleMovementMode();
          },
        },
        {
          key: "follow",
          icon: isFollowing ? "🛑" : "🧲",
          label: isFollowing ? "Stop Follow" : "Follow Me",
          onClick: () => {
            setSentHome(false);
            setPetNested(false);
            setIsFollowing((f) => !f);
            // Close the menu so the chase starts immediately — an open menu
            // pauses following (followingActive gates on !menuOpen).
            setMenuOpen(false);
          },
        },
        {
          key: "sendHome",
          icon: "🏠",
          label: sentHome ? "Come out" : "Send Home",
          onClick: () => {
            if (sentHome) {
              setSentHome(false);
              setPetNested(false);
              setMenuOpen(false);
              return;
            }
            sendHome();
          },
        },
        { key: "sleep", icon: "🌙", label: "Tuck in", onClick: game.toggleSleep },
      ];
  if (!game.isEgg && !save.isSleeping && game.canEvolve) {
    radialActions.push({ key: "evolve", icon: "✨", label: "Evolve!", onClick: handleEvolve, highlight: true });
  }

  const showRadial = save.isAlive && menuOpen && !petBusy && !petNested && (!game.isEgg || game.canHatch);

  // ── Radial menu: outside-click collapse (Phase 0.5) ──────────────────────
  // Outside the pet's hitbox the overlay window is OS-level click-through, so
  // a click "anywhere else" never even reaches the renderer. While the menu
  // is open, reuse the same capture-mode escape hatch feed-throw/scrub use
  // (clickableOverride + whole-window clickable) and render a full-window
  // transparent backdrop below the pet whose click closes the menu.
  const captureBusyRef = useRef(false);
  captureBusyRef.current = feedPhase !== "idle" || ballPhase !== "idle" || cleaningMode || warmingMode;
  useEffect(() => {
    if (!menuOpen) return;
    setClickableOverride(true);
    window.overlay.setClickable(true);
    return () => {
      // Another capture-mode gesture (feed/ball/scrub/warm) may have taken
      // ownership of the override synchronously before this cleanup runs —
      // grabbing food closes the menu as part of starting its own override —
      // and releasing here would kill THAT drag mid-gesture. Only release
      // when nothing else owns it; useHitTest's post-override resync then
      // restores normal cursor-driven click-through on the next tick.
      if (captureBusyRef.current) return;
      setClickableOverride(false);
      window.overlay.setClickable(false);
    };
  }, [menuOpen]);

  const idleBreathing =
    save.isAlive && !game.isEgg && !save.isSleeping && !movement.isMoving && !petBusy && !happyPulse && !evolvePulse;

  const bodyClass = [
    movement.isMoving ? "pet-anim-walk" : "",
    feedPhase === "eating" ? "pet-anim-eat" : "",
    happyPulse || petHappyWiggling ? "pet-anim-happy" : "",
    evolvePulse ? "pet-anim-evolve" : "",
    // The generic "charging" glow is only a stand-in for stages without
    // real art (baby->adult->final) — the egg hatch has real per-phase
    // frames, so it's excluded here (eggPhase leaves "idle" for the whole
    // hatch sequence, including its post-burst settle/wander/fade tail).
    isEvolving && eggPhase === "idle" ? "pet-anim-charging" : "",
    // petPoopWiggling: the quick "something's coming" wiggle right before a
    // poop item slides in (reuses the same transient-class pattern).
    // petExitingNest: the brief "coming out of the nest" wiggle, layered on
    // top of the scale-up spring that already plays when petNested clears.
    petSeatedWiggling || petPoopWiggling || petExitingNest ? "egg-anim-wiggle" : "",
    // Idle breathing is framer-motion-driven now (see the breathe effect
    // below) — NOT a CSS class here, so it can never fight bodyClass.
    game.isEgg && game.isEggOverheating ? "pet-anim-overheat" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // ── Idle liveliness: framer-motion breathing + random gestures ──────────
  // Moved from the pet-anim-idle-breathe CSS keyframe to framer-motion as
  // the single animation authority for idle motion (scales better as
  // gestures get richer). These motion values live on their OWN dedicated
  // wrapper node (inside the display-scale wrapper) so they never fight the
  // CSS keyframe classes on bodyClass's node or the scale spring.
  // GUARD RAIL: the instant `idleBreathing` flips off, the cleanup stops
  // every animation AND resets the motion values to rest — a lingering
  // inline transform would silently override the walk/eat/happy CSS states.
  useEffect(() => {
    if (!idleBreathing) return;
    const cy = animate(breatheScaleY, [1, 0.985, 1], { duration: 2.6, repeat: Infinity, ease: "easeInOut" });
    const cx = animate(breatheScaleX, [1, 1.015, 1], { duration: 2.6, repeat: Infinity, ease: "easeInOut" });
    // Random one-off gestures every ~6–20s: a blink (existing wink asset
    // swap), a quick head-shake twitch, or a slow look-around tilt. Each
    // resets its own motion value on completion.
    let alive = true;
    let gestureTimer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      gestureTimer = setTimeout(() => {
        if (!alive) return;
        const pick = Math.random();
        if (pick < 0.4) {
          setBlinking(true);
          setTimeout(() => alive && setBlinking(false), 160);
        } else if (pick < 0.75) {
          void animate(gestureRotate, [0, -4, 4, -2, 0], { duration: 0.7, ease: "easeInOut" }).then(() => {
            if (alive) gestureRotate.set(0);
          });
        } else {
          void animate(gestureRotate, [0, 6, 6, 0], { duration: 1.6, ease: "easeInOut", times: [0, 0.2, 0.8, 1] }).then(
            () => {
              if (alive) gestureRotate.set(0);
            },
          );
        }
        schedule();
      }, 6_000 + Math.random() * 14_000);
    };
    schedule();
    return () => {
      alive = false;
      clearTimeout(gestureTimer);
      cy.stop();
      cx.stop();
      breatheScaleX.set(1);
      breatheScaleY.set(1);
      gestureRotate.set(0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idleBreathing]);

  // True while the pet/egg is being dragged directly over the nest slot —
  // lets SideDock enlarge/highlight it so the drop target is obvious
  // before release (same hover-highlight pattern as the trash can's
  // poopOverTrash, mirrored for consistency).
  const [petOverNest, setPetOverNest] = useState(false);
  // True between onDragStart and onDragEnd — gates the position-change
  // watcher below so a pet just WANDERING near the slot never flashes the
  // hover highlight; only an active drag should.
  const isDraggingRef = useRef(false);

  /** Is the pet's CURRENT position (movement.x/y — already updated by
   *  framer by the time this is called mid-drag or at release) within
   *  NEST_DROP_RADIUS of the [data-homeslot] center? Shared by the hover
   *  watcher and the actual drop decision (onDragEnd). */
  const isOverNest = useCallback(() => {
    const slot = document.querySelector("[data-homeslot]")?.getBoundingClientRect();
    if (!slot) return false;
    const petCenterX = movement.x.get() + PET_SIZE / 2;
    const petCenterY = movement.y.get() + PET_SIZE / 2;
    const dist = Math.hypot(petCenterX - (slot.left + slot.width / 2), petCenterY - (slot.top + slot.height / 2));
    return dist < NEST_DROP_RADIUS;
  }, [movement.x, movement.y]);

  // Hover highlight while dragging: MotionValue.set() notifies "change"
  // subscribers SYNCHRONOUSLY (not rAF-gated), so this tracks position
  // during a drag without depending on framer's own frame-scheduled drag
  // internals at all — confirmed via the browser-preview-mock harness that
  // an rAF-based poll never ticks there (the pane keeps its tab
  // `document.hidden`/unfocused, which freezes all requestAnimationFrame
  // callbacks — a pane limitation, not an app bug; see the quests-testing
  // skill), while this subscription-based approach fires correctly even
  // there. `isDraggingRef` scopes it to an active drag only (wander/
  // walkTo/Follow Me also move x/y and shouldn't flash the highlight).
  useMotionValueEvent(movement.x, "change", () => {
    if (isDraggingRef.current) setPetOverNest(isOverNest());
  });
  useMotionValueEvent(movement.y, "change", () => {
    if (isDraggingRef.current) setPetOverNest(isOverNest());
  });

  // A hold-to-warm gesture that turns into an actual drag hands off to
  // usePetMovement's own drag handlers — cancel the warm interval so a
  // dragged egg doesn't also rack up warmth.
  const petDragOnStart = useCallback(() => {
    isDraggingRef.current = true;
    if (game.isEgg) stopWarmHold();
    // Dragging the pet away is Send Home's other cancel condition.
    setSentHome(false);
    setPetNested(false);
    setPetOverNest(false);
    movement.dragHandlers.onDragStart();
  }, [game.isEgg, stopWarmHold, movement.dragHandlers.onDragStart]);

  // Drag-and-drop onto the nest: released within NEST_DROP_RADIUS of the
  // [data-homeslot] center → go home instead of the normal glide-settle.
  // This is the ONLY way an egg can be sent home (it has no radial action
  // — canHatch/isEgg gates that menu to just "Evolve!"); for a hatched pet
  // it's a second entry point alongside the radial's "Send Home". Requires
  // the Home panel to already be open/visible (same as the trash-can
  // poop-drop hit-test) — dragging toward a closed/hidden dock just falls
  // through to the ordinary glide.
  const petDragOnEnd = useCallback(() => {
    isDraggingRef.current = false;
    const hit = isOverNest();
    setPetOverNest(false);
    if (hit) {
      enterNest(18); // a quick snap — the pet is already right there
      return;
    }
    movement.dragHandlers.onDragEnd();
  }, [isOverNest, enterNest, movement.dragHandlers.onDragEnd]);

  const petDragHandlers = {
    ...movement.dragHandlers,
    onDragStart: petDragOnStart,
    onDragEnd: petDragOnEnd,
  };

  // DEV-only automation hooks for the browser-preview-mock technique —
  // framer-motion's onTap doesn't fire for the synthetic/untrusted clicks
  // the preview tools dispatch (verified against the unmodified baseline),
  // so empirically testing dock/menu flows needs a state-level door. Never
  // present in production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__mpc = {
      toggleDock: () => setStatsOpen((o) => !o),
      toggleMenu: () => setMenuOpen((o) => !o),
      spawnPoop: (x?: number, y?: number) =>
        setPoops((prev) => [
          ...prev,
          { id: ++poopIdRef.current, x: x ?? movement.x.get() + PET_SIZE / 2, y: y ?? movement.y.get() + PET_SIZE - 26 },
        ]),
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__mpc;
    };
  }, [movement]);

  // Don't flash the picker while the cloud save is still loading — an
  // existing player signing in on a new device starts from a fresh local
  // save (eggChosen false) until their authoritative row arrives.
  if (!save.eggChosen && game.syncStatus !== "loading") {
    return <EggSelect onChoose={() => game.chooseEgg("cat")} />;
  }

  return (
    <>
      {/* Dev-only state badge — display only, never interactive. */}
      {import.meta.env.DEV && (
        <div
          style={{
            position: "fixed",
            top: 8,
            right: 8,
            padding: "4px 10px",
            borderRadius: 8,
            fontSize: 12,
            color: "#fff",
            background: clickable ? "rgba(16,120,60,0.85)" : "rgba(30,30,30,0.6)",
            pointerEvents: "none",
          }}
        >
          {clickable ? "interactive (over pet)" : "click-through"}
        </div>
      )}
      {import.meta.env.DEV && debugLines.length > 0 && (
        <div
          style={{
            position: "fixed",
            top: 38,
            right: 8,
            padding: "4px 10px",
            borderRadius: 8,
            fontSize: 10,
            fontFamily: "Consolas, monospace",
            color: "#a7f3d0",
            background: "rgba(30,30,30,0.75)",
            pointerEvents: "none",
            textAlign: "right",
            whiteSpace: "pre",
          }}
        >
          {debugLines.join("\n")}
        </div>
      )}

      {import.meta.env.DEV && <AdminPanel game={game} consumables={consumables} />}

      <SideDock
        side={ribbon.side}
        y={ribbon.y}
        onYChange={ribbon.setY}
        onSideChange={ribbon.setSide}
        open={statsOpen}
        onToggle={() => setStatsOpen((o) => !o)}
        activePanel={ribbon.activePanel}
        onSetActivePanel={ribbon.setActivePanel}
        updateBadge={appUpdate.updateState === "ready" && updateToastDismissed}
        chessBadgeCount={myActiveChessGames.length}
        game={game}
        auth={auth}
        lease={lease}
        canFeed={canFeed}
        foodReady={consumables.foodReady}
        foodEtaMs={consumables.foodEtaMs}
        onGrabFood={grabFood}
        ballReady={consumables.ballReady}
        canPlayBall={canPlayBall}
        onGrabBall={grabBall}
        canClean={canClean}
        onStartClean={startCleaning}
        poopHoverTrash={poopOverTrash}
        canWarm={game.isEgg && save.isAlive && !petBusy && !petNested}
        onStartWarm={startWarming}
        soundEnabled={prefs.soundEnabled}
        onToggleSound={prefs.toggleSound}
        followSpeed={prefs.followSpeed}
        onSetFollowSpeed={prefs.setFollowSpeed}
        hudScale={prefs.hudScale}
        onSetHudScale={prefs.setHudScale}
        petScale={prefs.petScale}
        onSetPetScale={prefs.setPetScale}
        sentHome={sentHome}
        petNested={petNested}
        petHoverNest={petOverNest}
        onWakeFromNest={wakeFromNest}
        onRename={game.rename}
        onSignOut={auth.signOut}
        onQuit={() => window.overlay.quit()}
        appVersion={appUpdate.version}
        updateState={appUpdate.updateState}
        updatePercent={appUpdate.updatePercent}
        updateError={appUpdate.updateError}
        onInstallUpdate={appUpdate.installUpdate}
        groupsApi={groupsApi}
        notifications={notifications}
        viewRequest={dockViewRequest}
        activeRoomGroupId={room.activeGroup?.id ?? null}
        roomMemberIds={roomMemberIds}
        pendingRoomInvites={pendingRoomInvites}
        onInviteFriend={inviteFriendToRoom}
        canGoOnline={!game.isEgg && save.isAlive}
        onEnterRoom={(g) => {
          room.join(g);
          setStatsOpen(false);
          dbg(`joined room ${g.name}`);
        }}
        onLeaveRoom={room.leaveRoom}
      />

      {/* Online room layer: friends' pets + the room bar. */}
      <RemotePets room={room} />
      <RoomBar room={room} />
      {/* Room invite banner — outside RoomBar on purpose: RoomBar renders
          nothing when you're not in a room, and an invite must be visible
          precisely then. */}
      {notifications.roomInvite && room.activeGroup?.id !== notifications.roomInvite.groupId && (
        <div
          data-interactive
          style={{
            position: "fixed",
            bottom: 64,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 23000,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            borderRadius: 12,
            background: "rgba(6,78,59,0.95)",
            color: "#fff",
            fontSize: 13,
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
            fontFamily: "'Segoe UI', system-ui, sans-serif",
          }}
        >
          🌐 {notifications.roomInvite.fromName} invited you to{" "}
          <strong>{notifications.roomInvite.groupName ?? "a room"}</strong>
          <button
            style={{
              cursor: "pointer",
              border: "none",
              borderRadius: 7,
              padding: "4px 10px",
              fontSize: 12,
              fontWeight: 700,
              background: "rgba(52,211,153,0.85)",
              color: "#06281c",
            }}
            onClick={() => {
              const inv = notifications.roomInvite!;
              notifications.dismissRoomInvite();
              const known = groupsApi.groups.find((g) => g.id === inv.groupId);
              if (known) {
                room.join(known);
                dbg(`joined room ${known.name} via invite`);
              } else if (inv.inviteCode) {
                void groupsApi.join(inv.inviteCode).then((joined) => {
                  if (joined) {
                    room.join(joined);
                    game.logHistoryEvent({ category: "social", label: `Joined group "${joined.name}"` });
                    dbg(`joined room ${joined.name} via invite code`);
                  }
                });
              }
            }}
          >
            Join
          </button>
          <button
            style={{
              cursor: "pointer",
              border: "none",
              borderRadius: 7,
              padding: "4px 8px",
              fontSize: 12,
              background: "rgba(255,255,255,0.12)",
              color: "#fff",
            }}
            onClick={notifications.dismissRoomInvite}
          >
            Dismiss
          </button>
        </div>
      )}
      {room.tossGame && auth.userId && (
        <TargetToss room={room} userId={auth.userId} mySave={save} onForfeit={forfeitToss} />
      )}
      {room.minigame && auth.userId && <RockPaperScissors room={room} userId={auth.userId} mySave={save} />}

      {/* ── Chess ─────────────────────────────────────────────────────────── */}
      {/* The open board (players or spectators). */}
      {openChessGame && !room.chessMinimized && auth.userId && (
        <ChessPanel room={room} userId={auth.userId} mySave={save} game={openChessGame} onPoke={pokeChessOpponent} />
      )}
      {/* Minimized chip — game keeps running behind it; never forfeits. */}
      {openChessGame && room.chessMinimized && (
        <Tooltip label="Restore the chess board">
          <button
            data-interactive
            onClick={room.restoreChessPanel}
            style={{
              position: "fixed",
              left: 16,
              bottom: 110,
              zIndex: 21500,
              cursor: "pointer",
              border: "none",
              borderRadius: 999,
              padding: "8px 14px",
              fontSize: 12,
              fontWeight: 700,
              background: "rgba(18,18,26,0.95)",
              color: "#fff",
              boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
              fontFamily: "'Segoe UI', system-ui, sans-serif",
            }}
          >
            ♟️ Chess game in progress{openChessGame.status === "active" && openChessGame.currentTurn === auth.userId ? " — your move!" : ""}
          </button>
        </Tooltip>
      )}
      {/* Active-games picker: multiple pairs can each have a game running in
          the same room — list them so anyone can resume/spectate. */}
      {room.activeGroup &&
        (!room.openChessGameId || room.chessMinimized) &&
        room.chessGames.some((g) => g.status === "active") && (
          <div
            data-interactive
            style={{
              position: "fixed",
              left: 16,
              bottom: 150,
              zIndex: 21400,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              padding: "8px 10px",
              borderRadius: 12,
              background: "rgba(18,18,26,0.92)",
              color: "#fff",
              fontSize: 11,
              boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
              fontFamily: "'Segoe UI', system-ui, sans-serif",
            }}
          >
            <strong style={{ fontSize: 10, opacity: 0.7, textTransform: "uppercase", letterSpacing: 0.5 }}>
              ♟️ Chess games in this room
            </strong>
            {room.chessGames
              .filter((g) => g.status === "active")
              .map((g) => {
                const iPlay = g.playerAId === auth.userId || g.playerBId === auth.userId;
                const nameOf = (id: string) =>
                  id === auth.userId ? "You" : room.members.find((m) => m.userId === id)?.name ?? "?";
                return (
                  <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ opacity: 0.85, flex: 1 }}>
                      {nameOf(g.playerAId)} vs {nameOf(g.playerBId)}
                    </span>
                    <button
                      onClick={() => room.openChessGame(g.id)}
                      style={{
                        cursor: "pointer",
                        border: "none",
                        borderRadius: 6,
                        padding: "2px 8px",
                        fontSize: 10,
                        fontWeight: 700,
                        background: iPlay ? "rgba(52,211,153,0.4)" : "rgba(96,165,250,0.3)",
                        color: "#fff",
                      }}
                    >
                      {iPlay ? "▶ Resume" : "👁 Watch"}
                    </button>
                  </div>
                );
              })}
          </div>
        )}
      {/* Incoming chess challenge banner. */}
      {room.incomingChessInvite && (
        <div
          data-interactive
          style={{
            position: "fixed",
            bottom: 104,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 23000,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            borderRadius: 12,
            background: "rgba(30,27,75,0.95)",
            color: "#fff",
            fontSize: 13,
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
            fontFamily: "'Segoe UI', system-ui, sans-serif",
          }}
        >
          ♟️ <strong>{room.incomingChessInvite.fromName}</strong> challenges you to chess!
          <button
            style={{
              cursor: "pointer",
              border: "none",
              borderRadius: 7,
              padding: "4px 10px",
              fontSize: 12,
              fontWeight: 700,
              background: "rgba(52,211,153,0.85)",
              color: "#06281c",
            }}
            onClick={room.acceptChessInvite}
          >
            Accept
          </button>
          <button
            style={{
              cursor: "pointer",
              border: "none",
              borderRadius: 7,
              padding: "4px 8px",
              fontSize: 12,
              background: "rgba(255,255,255,0.12)",
              color: "#fff",
            }}
            onClick={room.declineChessInvite}
          >
            Decline
          </button>
        </div>
      )}
      {/* Chess feedback notice ("already have a game", declines, ...). */}
      {room.chessNotice && <div style={{ ...bannerStyle, top: 56 }}>♟️ {room.chessNotice}</div>}

      {/* Food — always mounted, positioned purely via foodX/foodY motion
          values animated by throwFood. No pointer events of its own. */}
      <motion.div
        drag
        dragControls={foodDragControls}
        dragListener={false}
        dragMomentum={false}
        dragElastic={0}
        onDrag={onFoodDrag}
        onDragEnd={onFoodDragEnd}
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          fontSize: 40,
          zIndex: 26000,
          x: foodX,
          y: foodY,
          scaleX: foodScaleX,
          scaleY: foodScaleY,
          rotate: foodRotate,
          opacity: foodOpacity,
          pointerEvents: feedPhase === "held" ? "auto" : "none",
          cursor: feedPhase === "held" ? "grabbing" : "default",
          touchAction: "none",
        }}
      >
        🍖
      </motion.div>
      {lease.status === "kicked" && (
        <div style={{ ...bannerStyle, top: 24, background: "rgba(127,29,29,0.92)", color: "#fecaca" }}>
          🔒 Signed in on another device — this session was disconnected. Open Settings to reconnect here.
        </div>
      )}
      {feedPhase !== "idle" && (
        <div style={bannerStyle}>
          {feedPhase === "held"
            ? "🍖 Drag it, then let go to throw! (right-click to cancel)"
            : "🍖 Tossing food to your pet… (right-click to cancel)"}
        </div>
      )}

      {/* Poop items — drag one onto the Kitchen drawer's trash can to clean
          it up. Native framer drag on the element itself (the proven
          pet-drag pattern): the cursor stays over this data-interactive
          element for the whole drag, so the hit-test keeps the window
          clickable without needing a clickable-override. zIndex sits above
          the Kitchen drawer's own 25000 (was 15000 — the poop rendered
          BEHIND the drawer while dragging over it, even though the drop
          logic worked fine). */}
      {poops.map((p) => (
        <Tooltip key={p.id} label="Drag me to the trash can in the Kitchen!">
          <motion.div
            data-interactive
            drag
            dragMomentum={false}
            dragElastic={0}
            // Continuously mirrors dropPoop's own hit-test while dragging so
            // SideDock can enlarge/highlight the trash can the moment the
            // poop is actually over it, not just on release.
            onDrag={(_e, info) => setPoopOverTrash(isOverTrash(info.point.x, info.point.y))}
            // Release trigger of record: a NATIVE window pointerup attached
            // synchronously at grab time (framer's onDragEnd is unreliable for
            // low-movement releases — the documented house rule from the
            // feed/ball gestures). dropPoop's id-guard makes double-fires safe.
            onPointerDown={() => {
              const onUp = (ev: PointerEvent) => {
                window.removeEventListener("pointerup", onUp);
                dropPoop(p.id, ev.clientX, ev.clientY);
              };
              window.addEventListener("pointerup", onUp);
            }}
            onDragEnd={(_e, info) => dropPoop(p.id, info.point.x, info.point.y)}
            initial={{ opacity: 0, y: -12, scale: 0.6 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.45, ease: "easeOut" }}
            style={{
              position: "fixed",
              left: p.x,
              top: p.y,
              fontSize: 30,
              zIndex: 25500,
              cursor: "grab",
              userSelect: "none",
              touchAction: "none",
            }}
          >
            💩
          </motion.div>
        </Tooltip>
      ))}

      {/* Ball — same always-mounted, drag-controlled pattern as food. */}
      <motion.div
        drag
        dragControls={ballDragControls}
        dragListener={false}
        dragMomentum={false}
        dragElastic={0}
        onDrag={onBallDrag}
        onDragEnd={onBallDragEnd}
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          fontSize: 34,
          zIndex: 26000,
          pointerEvents: ballPhase === "held" ? "auto" : "none",
          cursor: ballPhase === "held" ? "grabbing" : "default",
          touchAction: "none",
          x: ballX,
          y: ballY,
          scaleX: ballScaleX,
          scaleY: ballScaleY,
          rotate: ballRotate,
          opacity: ballOpacity,
        }}
      >
        ⚾
      </motion.div>
      {ballPhase !== "idle" && (
        <div style={bannerStyle}>
          {ballPhase === "held"
            ? "⚾ Drag it, then let go to throw! (right-click to cancel)"
            : "⚾ Playing fetch… (right-click to cancel)"}
        </div>
      )}

      {/* Wash: sponge cursor + progress + bubbles */}
      {cleaningMode && (
        <>
          <div
            style={{
              position: "fixed",
              bottom: 90,
              left: "50%",
              transform: "translateX(-50%)",
              // Higher than the pet's (unstyled, effectively 0) stacking
              // order — without this, the pet's own always-present hitbox
              // painted later in the DOM could sit on top of this panel and
              // swallow clicks meant for the X button below.
              zIndex: 21000,
              padding: "8px 30px 8px 16px",
              borderRadius: 14,
              background: scrubbingEffectively ? "rgba(8,47,73,0.9)" : "rgba(20,20,26,0.88)",
              color: "#bae6fd",
              fontSize: 12,
              fontWeight: 700,
              textAlign: "center",
            }}
          >
            <Tooltip label="Cancel washing">
              <button
                data-interactive
                onClick={() => endCleaning(false)}
                // Stop this mousedown from also reaching the cleaningMode
                // effect's window-level scrub-start listener — otherwise
                // clicking the X was also registering as the start of a scrub.
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  position: "absolute",
                  top: 4,
                  right: 6,
                  cursor: "pointer",
                  border: "none",
                  background: "transparent",
                  color: "#bae6fd",
                  fontSize: 14,
                  fontWeight: 900,
                  padding: 2,
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </Tooltip>
            Hold and scrub the pet with the sponge
            <div style={{ marginTop: 4, height: 6, borderRadius: 999, background: "rgba(0,0,0,0.3)", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  borderRadius: 999,
                  width: `${Math.round((scrubProgress / scrubTargetRef.current) * 100)}%`,
                  background: "linear-gradient(90deg, #38bdf8, #67e8f9, #99f6e4)",
                  transition: "width 0.15s linear",
                }}
              />
            </div>
            <div style={{ marginTop: 4, fontSize: 10, fontWeight: 600, opacity: 0.8 }}>
              {scrubHeld ? (scrubbingEffectively ? "Cleaning…" : "Keep the sponge moving") : "Hold left mouse and move over the pet"}
              {" · Esc, right-click, or ✕ to cancel"}
            </div>
          </div>
          <motion.div
            style={{
              position: "fixed",
              left: scrubCursor.x - 18,
              top: scrubCursor.y - 18,
              fontSize: 32,
              pointerEvents: "none",
              // Above the pet's own container (up to 25200) so the sponge
              // always reads as ON TOP while scrubbing, never hidden behind
              // the pet's body when the cursor passes over it.
              zIndex: ABOVE_PET_Z,
            }}
            animate={
              scrubHeld
                ? { scale: [0.96, 1.08, 0.96], rotate: [-18, 14, -18] }
                : { scale: 1, rotate: -12 }
            }
            transition={scrubHeld ? { duration: 0.26, repeat: Infinity, ease: "easeInOut" } : { duration: 0.12 }}
          >
            🧽
          </motion.div>
          <AnimatePresence>
            {bubbles.map((b) => (
              <motion.span
                key={b.id}
                style={{ position: "fixed", left: b.x, top: b.y, fontSize: b.size, pointerEvents: "none", zIndex: ABOVE_PET_Z - 1 }}
                initial={{ opacity: 0.95, x: 0, y: 0, scale: 0.35, rotate: 0 }}
                animate={{
                  opacity: [0.95, 0.84, 0.68, 0],
                  x: [0, b.dx * 0.52, b.dx],
                  y: [0, b.arcY, b.dy],
                  scale: [0.35, 1.35, 1.1, 0.9],
                  rotate: b.rotate,
                }}
                exit={{ opacity: 0 }}
                transition={{ duration: b.duration, ease: "easeOut" }}
                onAnimationComplete={() => setBubbles((prev) => prev.filter((x) => x.id !== b.id))}
              >
                🫧
              </motion.span>
            ))}
          </AnimatePresence>
        </>
      )}

      {/* Egg warm mode: light-source cursor + instruction panel */}
      {warmingMode && (
        <>
          <div
            data-interactive
            style={{
              position: "fixed",
              bottom: 90,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 21000,
              padding: "8px 30px 8px 16px",
              borderRadius: 14,
              background: warmHeld ? "rgba(78,45,10,0.92)" : "rgba(20,20,26,0.88)",
              color: "#fde68a",
              fontSize: 12,
              fontWeight: 700,
              textAlign: "center",
            }}
          >
            <Tooltip label="Put the light away">
              <button
                data-interactive
                onClick={endWarming}
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  position: "absolute",
                  top: 4,
                  right: 6,
                  cursor: "pointer",
                  border: "none",
                  background: "transparent",
                  color: "#fde68a",
                  fontSize: 14,
                  fontWeight: 900,
                  padding: 2,
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </Tooltip>
            Hold the light over the egg to warm it
            <div style={{ marginTop: 4, fontSize: 10, fontWeight: 600, opacity: 0.8 }}>
              {warmHeld
                ? game.isEggOverheating
                  ? "Too hot! Let it breathe"
                  : "Warming…"
                : "Hold left mouse over the egg"}
              {" · Esc, right-click, or ✕ to stop"}
            </div>
          </div>
          {/* The light source itself — a layered glow orb that swells and
              brightens while actually warming, angry-red when overheating. */}
          <motion.div
            style={{
              position: "fixed",
              left: warmCursor.x,
              top: warmCursor.y,
              width: 0,
              height: 0,
              pointerEvents: "none",
              // Same reasoning as the sponge cursor above.
              zIndex: ABOVE_PET_Z,
            }}
          >
            <motion.div
              animate={{
                scale: warmHeld ? [1.15, 1.45, 1.15] : [0.85, 1, 0.85],
                opacity: warmHeld ? [0.95, 1, 0.95] : [0.65, 0.8, 0.65],
              }}
              transition={{ duration: warmHeld ? 0.5 : 1.4, repeat: Infinity, ease: "easeInOut" }}
              style={{
                position: "absolute",
                left: -55,
                top: -55,
                width: 110,
                height: 110,
                borderRadius: "50%",
                background: game.isEggOverheating
                  ? "radial-gradient(circle, rgba(254,202,202,0.95) 0%, rgba(248,113,113,0.55) 40%, rgba(239,68,68,0.18) 65%, transparent 75%)"
                  : "radial-gradient(circle, rgba(255,244,214,0.95) 0%, rgba(253,224,71,0.5) 40%, rgba(245,158,11,0.16) 65%, transparent 75%)",
                filter: "blur(1px)",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: -9,
                top: -9,
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: game.isEggOverheating ? "#fecaca" : "#fef3c7",
                boxShadow: game.isEggOverheating
                  ? "0 0 18px 8px rgba(248,113,113,0.85)"
                  : "0 0 18px 8px rgba(253,224,71,0.8)",
              }}
            />
          </motion.div>
        </>
      )}

      {/* Egg's "back" panel during the burst: a separate, lower z-index
          sibling of the pet's own container (see the ordering note on the
          pet container's style below) so the real pet visually sits in
          FRONT of it, between back and the bottom/top/shards group. */}
      {hatchCenter && eggPhase === "burst" && (
        <motion.div
          style={{
            position: "fixed",
            left: 0,
            top: 0,
            width: HATCH_SIZE,
            height: HATCH_SIZE,
            x: hatchCenter.x,
            y: hatchCenter.y,
            pointerEvents: "none",
            zIndex: 940,
          }}
          initial={{ opacity: 1 }}
          animate={{ opacity: eggLeftoverFading ? 0 : 1 }}
          transition={{ duration: EGG_HATCH_TIMING.fadeMs / 1000 }}
        >
          <img src={eggBack} width={HATCH_SIZE} height={HATCH_SIZE} draggable={false} alt="" />
        </motion.div>
      )}

      {/* Full-window transparent backdrop while the radial menu is open —
          clicking anywhere outside the pet/menu collapses it. Sits BELOW
          the pet container (zIndex 100 vs the pet's elevated 500) so the
          pet's own click and the radial actions always win. */}
      {menuOpen && (
        <div
          data-interactive
          onClick={() => setMenuOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 100, background: "transparent" }}
        />
      )}

      <motion.div
        data-interactive
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          width: PET_SIZE,
          height: PET_SIZE,
          x: movement.x,
          y: movement.y,
          // While seated in the burst shell, this container needs to paint
          // BETWEEN the back panel (940, above) and the bottom/top/shards
          // group (950, below) — those are separate top-level siblings
          // now (see the containing-block note on the hatch stage below),
          // so their z-index only compares correctly against this
          // container's own z-index, not one set on a descendant of it.
          // Elevated above the outside-click backdrop (100) while the menu
          // is open so pet/radial clicks never fall through to it.
          // Pet renders ABOVE the dock/menus (25000) in normal play — but
          // never above an active minigame overlay (Chess 21500 / Toss
          // 22000 are deliberately modal; inMinigame keeps the pet behind
          // them by falling back to auto stacking), and the mid-hatch 945
          // is untouched (it's sandwiched between the hatch stage's
          // carefully-ordered 940/950 sibling layers). Dragged items still
          // win over the pet: poop 25500, food/ball 26000. Known tradeoff:
          // where the pet visually overlaps an open dock panel, useHitTest
          // resolves the PET at those pixels — flagged for manual testing,
          // mitigate only if it proves a real nuisance.
          //
          // While NESTED this container sits right on top of the dock (its
          // real screen position is the nest slot, inside the Home panel),
          // and it's invisible but was still hit-testable — silently
          // swallowing clicks meant for the ribbon/panel beneath it (the
          // reported "can't click Quests / can't collapse the ribbon while
          // the pet is home" bug). `pointer-events: none` removes it from
          // `elementFromPoint` entirely, so the dock underneath resolves
          // correctly; the dropped zIndex is belt-and-suspenders.
          zIndex: eggPhase === "burst" ? 945 : petNested ? undefined : inMinigame ? undefined : menuOpen ? 25200 : 25100,
          pointerEvents: petNested ? "none" : undefined,
        }}
        {...(save.isAlive && !petBusy && !inMinigame && !petNested ? petDragHandlers : {})}
      >
        {/* update_ready notice — same "the pet tells you" toast spot as the
            friend/room-invite kinds, but LOCAL-ONLY (synthesized from
            appUpdate state, never sent via sendTo/broadcast), with NO TTL
            auto-clear and directly actionable: "Update now" installs right
            here, "Later" dismisses (a tab badge then persists as a
            reminder). Sits a step above the normal toast slot so the two
            can coexist. */}
        {showUpdateToast && (
          <div
            data-interactive
            style={{
              position: "absolute",
              bottom: PET_SIZE + 48,
              left: "50%",
              transform: "translateX(-50%)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              padding: "6px 10px",
              borderRadius: 12,
              background: "rgba(240,253,244,0.98)",
              color: "#14532d",
              boxShadow: "0 3px 10px rgba(0,0,0,0.35)",
              whiteSpace: "nowrap",
              zIndex: 6,
              fontFamily: "'Segoe UI', system-ui, sans-serif",
              // Explicit override: the ancestor pet container goes
              // pointer-events:none while nested, but an update notice must
              // stay clickable regardless of the pet's own state.
              pointerEvents: "auto",
            }}
          >
            <span>
              ⬆️ Update {appUpdate.updateVersion ? `v${appUpdate.updateVersion} ` : ""}is ready!
            </span>
            <Tooltip label="Restart and install the update now">
              <button
                onClick={appUpdate.installUpdate}
                style={{
                  cursor: "pointer",
                  border: "none",
                  borderRadius: 7,
                  padding: "3px 9px",
                  fontSize: 11,
                  fontWeight: 800,
                  background: "#22c55e",
                  color: "#052e12",
                }}
              >
                Update now
              </button>
            </Tooltip>
            <Tooltip label="Not now — a badge on the dock tab will remind you">
              <button
                onClick={() => setUpdateToastDismissed(true)}
                style={{
                  cursor: "pointer",
                  border: "none",
                  borderRadius: 7,
                  padding: "3px 8px",
                  fontSize: 11,
                  background: "rgba(20,83,45,0.12)",
                  color: "#14532d",
                }}
              >
                Later
              </button>
            </Tooltip>
          </div>
        )}

        {/* AFK summary — "while you were away" recap, shown whenever a big
            enough decay gap (usePetGame's AFK_SUMMARY_MIN_MINUTES) was just
            applied (app reopened after a long close, or the machine woke
            from sleep mid-session). Same dismissible-card shape as the
            update-ready notice above, one step further up so both can
            coexist without overlapping. */}
        {game.afkSummary && (
          <div
            data-interactive
            style={{
              position: "absolute",
              bottom: PET_SIZE + 48 + (showUpdateToast ? 40 : 0),
              left: "50%",
              transform: "translateX(-50%)",
              display: "flex",
              flexDirection: "column",
              gap: 4,
              fontSize: 12,
              padding: "8px 12px",
              borderRadius: 12,
              background: "rgba(30,27,50,0.96)",
              color: "#e9d5ff",
              boxShadow: "0 3px 10px rgba(0,0,0,0.35)",
              whiteSpace: "nowrap",
              zIndex: 6,
              fontFamily: "'Segoe UI', system-ui, sans-serif",
              pointerEvents: "auto",
            }}
          >
            <span style={{ fontWeight: 700 }}>
              😴 While you were away ({formatDuration(game.afkSummary.elapsedMinutes)})
            </span>
            {(() => {
              const d = game.afkSummary.deltas;
              const rows: string[] = [];
              if (!game.isEgg && d.hunger > 0) rows.push(`🍖 hunger −${Math.round(d.hunger)}`);
              if (game.isEgg && d.warmth > 0) rows.push(`🔥 warmth −${Math.round(d.warmth)}`);
              if (d.cleanliness > 0) rows.push(`🧼 cleanliness −${Math.round(d.cleanliness)}`);
              if (d.happiness > 0) rows.push(`❤️ happiness −${Math.round(d.happiness)}`);
              if (d.carePoints > 0) rows.push(`⭐ care points −${Math.round(d.carePoints * 10) / 10}`);
              return rows.length > 0 ? (
                <span style={{ opacity: 0.85 }}>{rows.join("  ·  ")}</span>
              ) : (
                <span style={{ opacity: 0.85 }}>Everything held up fine — nothing lost.</span>
              );
            })()}
            <Tooltip label="Dismiss">
              <button
                onClick={game.dismissAfkSummary}
                style={{
                  alignSelf: "flex-end",
                  cursor: "pointer",
                  border: "none",
                  borderRadius: 7,
                  padding: "3px 10px",
                  marginTop: 2,
                  fontSize: 11,
                  fontWeight: 700,
                  background: "rgba(233,213,255,0.18)",
                  color: "#e9d5ff",
                }}
              >
                OK
              </button>
            </Tooltip>
          </div>
        )}

        {/* Notification bubble — the pet "tells" you about friend requests /
            accepts / room invites. Same look as the chat bubble but clickable
            (opens the dock at the relevant view) and independent of any room. */}
        {notifications.toast && (
          <Tooltip label="Open">
            <div
              data-interactive
              onClick={() => {
                const note = notifications.toast!;
                notifications.dismissToast();
                // Chess poke / your-turn deep-link: switch into that room
                // (joining its channel if needed) and open that specific
                // game — leaving the current room this way never forfeits
                // anything.
                if (note.kind === "chess_poke" || note.kind === "chess_turn") {
                  if (note.groupId) {
                    const known = groupsApi.groups.find((g) => g.id === note.groupId);
                    if (known && room.activeGroup?.id !== note.groupId) {
                      room.join(known);
                      dbg(`joined room ${known.name} via chess ${note.kind === "chess_poke" ? "poke" : "turn"} toast`);
                    }
                  }
                  if (note.gameId) room.openChessGame(note.gameId);
                  return;
                }
                openDockAt(note.kind === "room_invite" ? "groups" : "friends");
              }}
              style={{
                position: "absolute",
                bottom: PET_SIZE + 6,
                left: "50%",
                transform: "translateX(-50%)",
                // Sized to fit the message instead of a fixed box that
                // truncated longer text with an ellipsis: a sane max width so
                // it never spans the whole screen, but wraps onto as many
                // lines as it needs rather than cutting anything off.
                maxWidth: 280,
                width: "max-content",
                fontSize: 12,
                padding: "6px 10px",
                borderRadius: 12,
                background: "rgba(255,255,255,0.97)",
                color: "#1f2937",
                cursor: "pointer",
                boxShadow: "0 3px 10px rgba(0,0,0,0.35)",
                whiteSpace: "normal",
                wordBreak: "break-word",
                zIndex: 5,
                // Same override as the update toast — must stay clickable
                // even while the ancestor pet container is pointer-events:none.
                pointerEvents: "auto",
              }}
            >
              {notifications.toast.kind === "friend_request" ? (
                `🤝 ${notifications.toast.fromName} sent you a friend request!`
              ) : notifications.toast.kind === "friend_accepted" ? (
                `🎉 ${notifications.toast.fromName} accepted your friend request!`
              ) : notifications.toast.kind === "chess_poke" || notifications.toast.kind === "chess_turn" ? (
                // Explicit "tap me" affordance — an overlay bubble's hover
                // tooltip is not discoverable enough for the deep-link.
                <>
                  {notifications.toast.kind === "chess_poke"
                    ? `♟️ ${notifications.toast.fromName} poked you — it's your move! `
                    : `♟️ ${notifications.toast.fromName} made their move — it's your turn! `}
                  <span style={{ textDecoration: "underline", fontWeight: 700 }}>🔗 Tap to jump back in</span>
                </>
              ) : (
                `🌐 ${notifications.toast.fromName} invited you to ${notifications.toast.groupName ?? "a room"}!`
              )}
            </div>
          </Tooltip>
        )}

        {/* My own room chat bubble + emote, mirroring what friends see. */}
        {auth.userId && room.activeGroup && !notifications.toast && room.bubbles[auth.userId] && Date.now() - room.bubbles[auth.userId]!.at < 6000 && (
          <div
            style={{
              position: "absolute",
              bottom: PET_SIZE + 6,
              left: "50%",
              transform: "translateX(-50%)",
              maxWidth: 260,
              width: "max-content",
              fontSize: 12,
              padding: "6px 10px",
              borderRadius: 12,
              background: "rgba(255,255,255,0.95)",
              color: "#1f2937",
              pointerEvents: "none",
              boxShadow: "0 3px 10px rgba(0,0,0,0.35)",
              whiteSpace: "normal",
              wordBreak: "break-word",
            }}
          >
            {room.bubbles[auth.userId]!.text}
          </div>
        )}
        {auth.userId && room.activeGroup && room.emotes[auth.userId] && (
          <motion.div
            key={room.emotes[auth.userId]!.emoji + room.emotes[auth.userId]!.at}
            initial={{ opacity: 0, y: 0, scale: 0.5 }}
            animate={{ opacity: [0, 1, 1, 0], y: -40, scale: 1.4 }}
            transition={{ duration: 2 }}
            style={{ position: "absolute", top: -14, left: "50%", fontSize: 26, pointerEvents: "none" }}
          >
            {room.emotes[auth.userId]!.emoji}
          </motion.div>
        )}

        {/* Floating stat-delta popups (+40 🍖 / -5 ❤️ …) — rendered on the
            un-flipped outer container so text never mirrors. */}
        {deltaPopups.map((p, i) => (
          <motion.div
            key={p.id}
            initial={{ opacity: 0, y: 4, scale: 0.7 }}
            animate={{ opacity: [0, 1, 1, 0], y: -48 - (i % 2) * 14, scale: 1 }}
            transition={{ duration: 2, ease: "easeOut" }}
            style={{
              position: "absolute",
              top: -6,
              left: PET_SIZE / 2 - 28 + ((p.id % 3) - 1) * 30,
              fontSize: 14,
              fontWeight: 800,
              whiteSpace: "nowrap",
              pointerEvents: "none",
              color: p.value >= 0 ? "#4ade80" : "#f87171",
              textShadow: "0 1px 4px rgba(0,0,0,0.85)",
            }}
          >
            {fmtDelta(p.value)} {p.icon}
          </motion.div>
        ))}

        {/*
          Two nested layers deliberately kept separate: framer-motion owns
          this outer div's `transform` (lean offset + facing flip via
          motion values), while the CSS keyframe classes (walk bounce, eat
          squash, happy wiggle) own the INNER plain div's `transform`. Both
          driving the same element's transform would fight for control
          (CSS animations win over inline styles, silently breaking the
          lean/facing effect) — splitting them onto separate nodes avoids
          that entirely.
        */}
        <motion.div
          // A ready-to-hatch egg opens the radial menu just like a hatched
          // pet does — "Evolve!" lives there (see radialActions) rather
          // than being a direct tap on the egg. Once the hatch cutscene
          // starts (hatchCutsceneActive), this container goes inert for
          // clicks while pre-burst (the centered hatch stage owns clicks
          // then); it becomes the real interactive pet again as soon as
          // the shell bursts, just elevated above the shell (zIndex) so
          // it's visible sitting in it.
          onClick={
            hatchCutsceneActive || petBusy || inMinigame
              ? undefined
              : game.isEgg && !game.canHatch
                ? undefined
                : () => {
                  setMenuOpen((o) => {
                    if (!o) sfx(Sounds.playSwish);
                    return !o;
                  });
                }
          }
          // Warming moved to the SideDock lamp (warm mode) — no direct
          // hold-on-egg pointer gesture here anymore.
          style={{
            cursor: "pointer",
            width: PET_SIZE,
            height: PET_SIZE,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            userSelect: "none",
            pointerEvents: (hatchCutsceneActive && eggPhase !== "burst") || petNested ? "none" : "auto",
            x: leanX,
            y: leanY,
            scaleX: movement.facing === "left" ? -1 : 1,
            transformOrigin: "center",
          }}
        >
          <div className={bodyClass} style={{ width: PET_SIZE, height: PET_SIZE, position: "relative" }}>
            {/* Display-scale wrapper (see PET_DISPLAY_SCALE): a dedicated
                node so its transform never fights bodyClass's CSS keyframe
                transforms. Scale stays 1 through the whole egg/hatch
                cutscene and springs down to 0.7 the moment the pet has
                jumped out of the shell (hatchCutsceneActive clears).
                initial={false} renders already-hatched pets straight at
                0.7 with no mount animation. */}
            <motion.div
              initial={false}
              // Pet-size setting multiplies the base display scale — 100%
              // preserves today's exact look, lower values only shrink
              // (shrink-only by design; composes fine with the separate
              // idle-breathing wrapper nested inside). petNested drives the
              // "going into the nest" exit: shrink to 0 + fade, and the
              // roaming pet stays hidden until the nest slot releases it.
              animate={{
                scale:
                  (game.isEgg || hatchCutsceneActive ? 1 : PET_DISPLAY_SCALE * (prefs.petScale / 100)) *
                  (petNested ? 0 : 1),
                opacity: petNested ? 0 : 1,
              }}
              transition={{ type: "spring", stiffness: 60, damping: 15 }}
              style={{
                width: PET_SIZE,
                height: PET_SIZE,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transformOrigin: "center",
              }}
            >
              {/* Idle-liveliness node: framer-motion breathing squash +
                  gesture tilt own THIS wrapper's transform exclusively —
                  separate from both bodyClass's CSS keyframes and the
                  display-scale spring above, so nothing fights. Feet-
                  planted origin so the breath reads as a chest rise. */}
              <motion.div
                style={{
                  width: PET_SIZE,
                  height: PET_SIZE,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  scaleX: breatheScaleX,
                  scaleY: breatheScaleY,
                  rotate: gestureRotate,
                  transformOrigin: "center bottom",
                }}
              >
                {visual}
              </motion.div>
            </motion.div>
            {/* Hidden while nested: this overlay is anchored to the roaming
                container, which parks invisibly at a stale snapshot of the
                nest slot once the pet tucks in — the dock's own
                NestStatusFx takes over on the home slot instead. */}
            {!petNested && (
              // Wrapped in its own positioned+z-indexed layer: PetEffects
              // itself renders no z-index, so it was stacking behind
              // RadialMenu (a later DOM sibling within the same pet
              // container, which establishes the shared stacking context —
              // later-in-DOM wins by default) whenever the radial menu was
              // open, clipping/hiding the smell/hunger/cold indicators
              // right when they'd otherwise be visible. Still
              // pointerEvents:none via PetEffects' own root, so this never
              // steals clicks meant for the menu underneath.
              //
              // Counter-flip: the parent motion.div applies `scaleX: -1`
              // when movement.facing === "left" so the sprite turns around.
              // Without canceling that here, this whole subtree — including
              // the plain-text hunger/cold speech bubble ("Keep me warm!")
              // — got mirrored too, rendering the text backwards whenever
              // the pet happened to be facing left.
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  zIndex: 50,
                  pointerEvents: "none",
                  transform: movement.facing === "left" ? "scaleX(-1)" : undefined,
                }}
              >
                <PetEffects
                  trigger={fxTrigger}
                  showEvolutionBurst={evolvePulse}
                  isSleeping={save.isSleeping}
                  isAlive={save.isAlive}
                  isEgg={game.isEgg}
                  careNeed={game.isEgg ? save.warmth : save.hunger}
                  cleanliness={save.cleanliness}
                  isCleaningMode={cleaningMode}
                />
              </div>
            )}
          </div>
        </motion.div>

        <AnimatePresence>{showRadial && <RadialMenu key="radial" actions={radialActions} />}</AnimatePresence>
      </motion.div>

      {/* Hatch stage: centered + enlarged (HATCH_SIZE = 1.5x PET_SIZE),
          fully decoupled from the pet's own wander position. Click-gated
          through crack3; at "burst" the shell splits into just its
          pieces (back/bottom/top/shards) — the pet itself is NOT
          rendered here at all. It's the real pet's own container
          (above) that shows it sitting in the shell and later jumping
          out, elevated above this stage via zIndex, so what you see is
          always the actual playable pet, never a decorative stand-in.

          Deliberately rendered as a SIBLING of the pet's own draggable
          container, not a descendant of it: that container's `x`/`y`
          motion values compile to a CSS `transform`, and any `position:
          fixed` descendant of an element with a `transform` positions
          itself relative to THAT element instead of the viewport (a CSS
          spec quirk, not a framer-motion bug). Nesting this overlay
          inside the pet's container was the actual cause of the hatch
          stage appearing off-center and drifting further right on each
          retry (offset by wherever the pet's wander/drag last left
          movement.x/y), and of dragging the pet also dragging the shell —
          moving it out here makes hatchCenter genuinely viewport-fixed. */}
      {hatchCenter && eggPhase !== "idle" && (
        <motion.div
          data-interactive
          onClick={eggPhase !== "burst" ? advanceHatch : undefined}
          style={{
            position: "fixed",
            left: 0,
            top: 0,
            width: HATCH_SIZE,
            height: HATCH_SIZE,
            x: hatchCenter.x,
            y: hatchCenter.y,
            cursor: eggPhase !== "burst" ? "pointer" : "default",
            pointerEvents: eggPhase === "burst" ? "none" : "auto",
            zIndex: 950,
          }}
          initial={{ opacity: 1 }}
          animate={{ opacity: eggLeftoverFading ? 0 : 1 }}
          transition={{ duration: EGG_HATCH_TIMING.fadeMs / 1000 }}
        >
          {eggPhase !== "burst" ? (
            <img
              src={
                eggPhase === "crack3"
                  ? EGG_SPRITES.crack3
                  : eggPhase === "crack2"
                    ? EGG_SPRITES.crack2
                    : eggPhase === "crack1"
                      ? EGG_SPRITES.crack1
                      : EGG_SPRITES.idle
              }
              width={HATCH_SIZE}
              height={HATCH_SIZE}
              draggable={false}
              className="egg-anim-wiggle"
              style={eggPhase === "crack3" ? { animationDuration: "0.28s" } : undefined}
              alt="Egg"
            />
          ) : (
            <>
              {/* eggBack itself is rendered as its own lower-z-index sibling
                  now (see above) so the real pet can sit in front of it —
                  only bottom/top/shards (all meant to sit IN FRONT of the
                  pet) belong in this front-layer group. */}
              <img
                src={eggBottom}
                width={HATCH_SIZE}
                height={HATCH_SIZE}
                draggable={false}
                alt=""
                style={{ position: "absolute", inset: 0, zIndex: 2 }}
              />
              <motion.img
                src={eggTop}
                width={HATCH_SIZE}
                height={HATCH_SIZE}
                draggable={false}
                alt=""
                style={{ position: "absolute", inset: 0, zIndex: 3, x: eggTopX, y: eggTopY, rotate: eggTopRotate }}
              />
            </>
          )}
          {eggShards.map((s) => (
            <motion.img
              key={s.id}
              src={s.src}
              width={120}
              height={120}
              draggable={false}
              alt=""
              style={{ position: "absolute", left: HATCH_SIZE / 2 - 60, top: HATCH_SIZE / 2 - 60, zIndex: 4 }}
              initial={{ x: 0, y: 0, opacity: 1, scale: 0.6, rotate: 0 }}
              animate={{ x: s.dx, y: s.dy, opacity: 1, scale: 1, rotate: s.rotate }}
              transition={{ duration: 0.6, ease: "easeOut" }}
            />
          ))}
        </motion.div>
      )}

      {/* "Help me hatch!" nudge — text only, no pointing arrow, and it
          disappears the instant the player has clicked the egg once
          (eggPhase leaves "wiggle" for crack1/2/3) rather than lingering
          through the whole crack sequence. Sibling of the pet container
          for the same containing-block reason as the hatch stage above. */}
      {hatchCenter && eggPhase === "wiggle" && (
        <motion.div
          style={{
            position: "fixed",
            left: 0,
            top: 0,
            x: hatchCenter.x + HATCH_SIZE / 2 - 90,
            y: hatchCenter.y - 40,
            width: 180,
            pointerEvents: "none",
            zIndex: 951,
            display: "flex",
            justifyContent: "center",
          }}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
        >
          <div
            style={{
              background: "rgba(20,20,26,0.9)",
              color: "#fde68a",
              padding: "5px 12px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 700,
              whiteSpace: "nowrap",
            }}
          >
            Help me hatch! Click me!
          </div>
        </motion.div>
      )}
    </>
  );
}
