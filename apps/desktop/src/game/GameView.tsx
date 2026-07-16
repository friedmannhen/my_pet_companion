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
  useSpring,
  useTransform,
} from "framer-motion";
import type { AuthState } from "../supabase/useAuth";
import { supabase } from "../supabase/client";
import { usePetGame } from "./usePetGame";
import { EggSelect } from "./EggSelect";
import { useSessionLease } from "../session/useSessionLease";
import { usePetMovement } from "./usePetMovement";
import { PetEffects, type PetFxTrigger } from "./PetEffects";
import { AdminPanel } from "./AdminPanel";
import { RadialMenu, type RadialAction } from "./RadialMenu";
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

  // Death knell — plays once on the alive→dead transition.
  const wasAliveRef = useRef(save.isAlive);
  useEffect(() => {
    if (wasAliveRef.current && !save.isAlive) sfx(Sounds.playDeath);
    wasAliveRef.current = save.isAlive;
  }, [save.isAlive, sfx]);

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
  const [warming, setWarming] = useState(false);
  const holdRef = useRef<{ interval?: ReturnType<typeof setInterval>; heldLong: boolean }>({ heldLong: false });
  const gameRef = useRef(game);
  gameRef.current = game;

  const stopWarmHold = useCallback(() => {
    const hold = holdRef.current;
    if (hold.interval) clearInterval(hold.interval);
    hold.interval = undefined;
    setWarming(false);
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
        setWarming(true);
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
    (outcome: "win" | "lose" | "tie", opponentName: string) => {
      // No progression rewards for minigames — just the history log + a
      // lifetime result row (each client records its OWN result; RLS blocks
      // writing anyone else's).
      game.applyMinigameResult(outcome, "Rock-Paper-Scissors");
      if (supabase) {
        void supabase
          .rpc("record_minigame_result", { p_game_code: "rps", p_distance: null, p_won: outcome === "win" })
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
  const room = useRoom({
    userId: auth.userId,
    displayName: myName,
    save,
    isEgg: game.isEgg,
    onSocialPet,
    onBattleResolved,
    onMinigameResolved,
  });

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
  // minigame_scores row via the atomic RPC (p_distance = my best throw of
  // the main phase, for the lifetime best_score).
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
    const myDistances = g.core.events
      .filter((e) => e.userId === auth.userId && e.distance !== null)
      .map((e) => e.distance!) ;
    const best = myDistances.length > 0 ? Math.min(...myDistances) : null;
    game.applyMinigameResult(won ? "win" : "lose", "Target Toss");
    if (supabase) {
      void supabase
        .rpc("record_minigame_result", { p_game_code: "target_toss", p_distance: best, p_won: won })
        .then(({ error }) => {
          if (error) dbg(`toss score save failed: ${error.message}`);
        });
    }
    if (won) {
      pulseHappy();
      sfx(Sounds.playEvolution);
    }
  }, [room.tossGame, auth.userId, game, pulseHappy, sfx, dbg]);

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

  const canFeed = save.isAlive && !save.isSleeping && !game.isEgg && !petBusy;
  const canPlayBall = save.isAlive && !save.isSleeping && !game.isEgg && !petBusy;
  const canClean = save.isAlive && !save.isSleeping && save.cleanliness < 100 && !petBusy;

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
      setStatsOpen(false);
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
    [foodX, foodY, foodScaleX, foodScaleY, foodRotate, foodOpacity, movement, game, sfx, dbg],
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
    }
    dbg("feed canceled");
  }, [feedPhase, foodOpacity, dbg]);

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
      setStatsOpen(false);
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

  // Sprite selection: dead is an emoji (no cat art for that state). The
  // still-waiting egg is small (EGG_IDLE_SIZE) and flashes/wiggles once
  // ready to hatch. While the click-gated crack sequence is running
  // (wiggle/crack1-3), this slot renders nothing — that part of the
  // cutscene lives in the centered/enlarged hatch stage overlay instead.
  // The instant the shell bursts, game.isEgg flips false and this slot
  // goes straight back to rendering the REAL pet (renderPetSprite()) — it
  // sits right in the shell and later jumps out by animating its own
  // movement.x/y, never a decorative stand-in.
  let visual: React.ReactNode;
  if (!save.isAlive) {
    visual = <span style={{ fontSize: 84, filter: "grayscale(1)" }}>🪦</span>;
  } else if (game.isEgg && eggPhase === "idle") {
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
          onClick: prefs.toggleMovementMode,
        },
        {
          key: "follow",
          icon: isFollowing ? "🛑" : "🧲",
          label: isFollowing ? "Stop Follow" : "Follow Me",
          onClick: () => {
            setIsFollowing((f) => !f);
            // Close the menu so the chase starts immediately — an open menu
            // pauses following (followingActive gates on !menuOpen).
            setMenuOpen(false);
          },
        },
        { key: "sleep", icon: "🌙", label: "Tuck in", onClick: game.toggleSleep },
      ];
  if (!game.isEgg && !save.isSleeping && game.canEvolve) {
    radialActions.push({ key: "evolve", icon: "✨", label: "Evolve!", onClick: handleEvolve, highlight: true });
  }

  const showRadial = save.isAlive && menuOpen && !petBusy && (!game.isEgg || game.canHatch);

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
    petSeatedWiggling ? "egg-anim-wiggle" : "",
    idleBreathing ? "pet-anim-idle-breathe" : "",
    game.isEgg && game.isEggOverheating ? "pet-anim-overheat" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // A hold-to-warm gesture that turns into an actual drag hands off to
  // usePetMovement's own drag handlers — cancel the warm interval so a
  // dragged egg doesn't also rack up warmth.
  const petDragHandlers = {
    ...movement.dragHandlers,
    onDragStart: () => {
      if (game.isEgg) stopWarmHold();
      movement.dragHandlers.onDragStart();
    },
  };

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
        canWarm={game.isEgg && save.isAlive && !petBusy}
        onStartWarm={startWarming}
        soundEnabled={prefs.soundEnabled}
        onToggleSound={prefs.toggleSound}
        followSpeed={prefs.followSpeed}
        onSetFollowSpeed={prefs.setFollowSpeed}
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
      {room.tossGame && auth.userId && <TargetToss room={room} userId={auth.userId} mySave={save} />}
      {room.minigame && auth.userId && <RockPaperScissors room={room} userId={auth.userId} mySave={save} />}

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
            <button
              data-interactive
              onClick={() => endCleaning(false)}
              // Stop this mousedown from also reaching the cleaningMode
              // effect's window-level scrub-start listener — otherwise
              // clicking the X was also registering as the start of a scrub.
              onMouseDown={(e) => e.stopPropagation()}
              title="Cancel washing"
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
              zIndex: 21002,
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
                style={{ position: "fixed", left: b.x, top: b.y, fontSize: b.size, pointerEvents: "none", zIndex: 21001 }}
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
            <button
              data-interactive
              onClick={endWarming}
              onMouseDown={(e) => e.stopPropagation()}
              title="Put the light away"
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
              zIndex: 21002,
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
          zIndex: eggPhase === "burst" ? 945 : undefined,
        }}
        {...(save.isAlive && !petBusy && !inMinigame ? petDragHandlers : {})}
      >
        {/* Notification bubble — the pet "tells" you about friend requests /
            accepts / room invites. Same look as the chat bubble but clickable
            (opens the dock at the relevant view) and independent of any room. */}
        {notifications.toast && (
          <div
            data-interactive
            onClick={() => {
              openDockAt(notifications.toast!.kind === "room_invite" ? "groups" : "friends");
              notifications.dismissToast();
            }}
            title="Open"
            style={{
              position: "absolute",
              bottom: PET_SIZE + 6,
              left: "50%",
              transform: "translateX(-50%)",
              maxWidth: 240,
              fontSize: 12,
              padding: "6px 10px",
              borderRadius: 12,
              background: "rgba(255,255,255,0.97)",
              color: "#1f2937",
              cursor: "pointer",
              boxShadow: "0 3px 10px rgba(0,0,0,0.35)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              zIndex: 5,
            }}
          >
            {notifications.toast.kind === "friend_request"
              ? `🤝 ${notifications.toast.fromName} sent you a friend request!`
              : notifications.toast.kind === "friend_accepted"
                ? `🎉 ${notifications.toast.fromName} accepted your friend request!`
                : `🌐 ${notifications.toast.fromName} invited you to ${notifications.toast.groupName ?? "a room"}!`}
          </div>
        )}

        {/* My own room chat bubble + emote, mirroring what friends see. */}
        {auth.userId && room.activeGroup && !notifications.toast && room.bubbles[auth.userId] && Date.now() - room.bubbles[auth.userId]!.at < 6000 && (
          <div
            style={{
              position: "absolute",
              bottom: PET_SIZE + 6,
              left: "50%",
              transform: "translateX(-50%)",
              maxWidth: 220,
              fontSize: 12,
              padding: "6px 10px",
              borderRadius: 12,
              background: "rgba(255,255,255,0.95)",
              color: "#1f2937",
              pointerEvents: "none",
              boxShadow: "0 3px 10px rgba(0,0,0,0.35)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
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
            pointerEvents: hatchCutsceneActive && eggPhase !== "burst" ? "none" : "auto",
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
              animate={{ scale: game.isEgg || hatchCutsceneActive ? 1 : PET_DISPLAY_SCALE }}
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
              {visual}
            </motion.div>
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
            {warming && (
              <div
                style={{
                  position: "absolute",
                  bottom: -6,
                  left: "50%",
                  transform: "translateX(-50%)",
                  fontSize: 26,
                  pointerEvents: "none",
                  animation: "flame-pulse 0.5s ease-in-out infinite alternate",
                }}
              >
                🔥
              </div>
            )}
          </div>
          <style>{`@keyframes flame-pulse { from { transform: translateX(-50%) scale(0.9); } to { transform: translateX(-50%) scale(1.15); } }`}</style>
        </motion.div>

        <AnimatePresence>{showRadial && <RadialMenu key="radial" actions={radialActions} />}</AnimatePresence>

        {!save.isAlive && menuOpen && (
          <div
            data-interactive
            style={{
              position: "absolute",
              top: PET_SIZE + 6,
              left: -40,
              width: 210,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: 12,
              borderRadius: 12,
              background: "rgba(22,22,28,0.94)",
              color: "#fff",
              fontFamily: "'Segoe UI', system-ui, sans-serif",
              fontSize: 13,
              boxShadow: "0 4px 18px rgba(0,0,0,0.5)",
            }}
          >
            <span>{save.name} didn&apos;t make it… 💔</span>
            <button style={chipStyle} onClick={game.restart}>
              🥚 Start over
            </button>
          </div>
        )}
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
