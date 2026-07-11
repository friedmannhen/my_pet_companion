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
import { usePetGame } from "./usePetGame";
import { useSessionLease } from "../session/useSessionLease";
import { usePetMovement } from "./usePetMovement";
import { PetEffects, type PetFxTrigger } from "./PetEffects";
import { AdminPanel } from "./AdminPanel";
import { RadialMenu, type RadialAction } from "./RadialMenu";
import { SideDock } from "./SideDock";
import { useRibbonPrefs } from "./useRibbonPrefs";
import { useAppUpdate } from "./useAppUpdate";
import { useConsumables } from "./useConsumables";
import { useGamePrefs } from "./useGamePrefs";
import { useGroups } from "./useGroups";
import { useRoom } from "../online/useRoom";
import { RemotePets } from "../online/RemotePets";
import { RoomBar } from "../online/RoomBar";
import * as Sounds from "./petSounds";
import { setClickableOverride } from "../overlay/clickableOverride";
import "./petAnimations.css";
import catBaby from "../assets/pets/black_cat/black_cat_baby.png";
import catBabyBlink from "../assets/pets/black_cat/black_cat_baby_blink.png";
import catAdult from "../assets/pets/black_cat/black_cat_adult.png";
import catAdultBlink from "../assets/pets/black_cat/black_cat_adult_blink.png";
import catFinal from "../assets/pets/black_cat/black_cat_final.png";
import catFinalBlink from "../assets/pets/black_cat/black_cat_final_blink.png";
import catFinalSleep from "../assets/pets/black_cat/black_cat__final_sleep.png";

const PET_SIZE = 128;

const SPRITES: Record<number, { idle: string; blink: string; sleep?: string }> = {
  1: { idle: catBaby, blink: catBabyBlink },
  2: { idle: catAdult, blink: catAdultBlink },
  3: { idle: catFinal, blink: catFinalBlink, sleep: catFinalSleep },
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

/**
 * Ballistic arc flight for a thrown item: constant horizontal velocity +
 * a gravity-shaped parabola for the vertical rise/fall (peaking at
 * `arcHeight` above the straight line between start and end, at the
 * midpoint of the flight), plus continuous spin. The progress driver runs
 * on a plain linear tween — easing lives in the quadratic height formula
 * itself (that's what makes it decelerate/accelerate like a real toss); an
 * eased progress on top of that would double up and distort the arc.
 */
async function throwArc(opts: {
  x: ReturnType<typeof useMotionValue<number>>;
  y: ReturnType<typeof useMotionValue<number>>;
  rotate: ReturnType<typeof useMotionValue<number>>;
  scaleX: ReturnType<typeof useMotionValue<number>>;
  scaleY: ReturnType<typeof useMotionValue<number>>;
  toX: number;
  toY: number;
  arcHeight: number;
  duration: number;
  spinDegrees: number;
}): Promise<void> {
  const { x, y, rotate, scaleX, scaleY, toX, toY, arcHeight, duration, spinDegrees } = opts;
  const fromX = x.get();
  const fromY = y.get();
  const fromRotate = rotate.get();
  await animate(0, 1, {
    duration,
    ease: "linear",
    onUpdate: (t) => {
      x.set(fromX + (toX - fromX) * t);
      // Parabola: 4*t*(1-t) peaks at 1 when t=0.5, zero at t=0 and t=1 —
      // exactly an object leaving and returning to the flight line's height.
      y.set(fromY + (toY - fromY) * t - arcHeight * 4 * t * (1 - t));
      rotate.set(fromRotate + spinDegrees * t);
      // A little "toward camera" pop at the apex sells the height.
      const pop = 1 + 0.22 * 4 * t * (1 - t);
      scaleX.set(pop);
      scaleY.set(pop);
    },
  });
}

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
  const [cleaningMode, setCleaningMode] = useState(false);
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

  // True while the pet is mid-action in a way that needs it to stand still
  // and not be interrupted: no wander, no drag, no menu-open tap. Any
  // interaction that's more than a single click (feed throw, ball fetch,
  // scrubbing, evolving) sets this.
  const petBusy = cleaningMode || feedPhase !== "idle" || ballPhase !== "idle" || isEvolving;

  const stationary = save.isSleeping || !save.isAlive || game.isEgg;
  const movement = usePetMovement({
    active: !stationary && !menuOpen && !petBusy,
  });

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

  const pulseHappy = useCallback(() => {
    setFxTrigger("happy");
    setHappyPulse(true);
    setTimeout(() => setHappyPulse(false), 700);
    setTimeout(() => setFxTrigger((t) => (t === "happy" ? null : t)), 900);
  }, []);

  // ── Online: groups + realtime room ──────────────────────────────────────
  const groupsApi = useGroups(auth.userId);
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
  const room = useRoom({
    userId: auth.userId,
    displayName: auth.displayName || auth.email?.split("@")[0] || "Player",
    save,
    isEgg: game.isEgg,
    onSocialPet,
    onBattleResolved,
  });

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

  const throwFoodRef = useRef<(vx: number, vy: number) => void>(() => {});

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
  const runBallFetchRef = useRef<(vx: number, vy: number) => void>(() => {});

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

  // Sprite selection: egg + dead are emoji (no cat art for those states yet).
  const stageSprites = SPRITES[save.evolutionStage];
  let visual: React.ReactNode;
  if (!save.isAlive) {
    visual = <span style={{ fontSize: 84, filter: "grayscale(1)" }}>🪦</span>;
  } else if (game.isEgg) {
    visual = <span style={{ fontSize: 84 }}>🥚</span>;
  } else if (stageSprites) {
    const src =
      save.isSleeping && stageSprites.sleep
        ? stageSprites.sleep
        : blinking || save.isSleeping
          ? stageSprites.blink
          : stageSprites.idle;
    visual = (
      <img
        src={src}
        width={PET_SIZE}
        height={PET_SIZE}
        draggable={false}
        style={{ filter: save.isSleeping ? "brightness(0.8)" : undefined }}
        alt={save.name}
      />
    );
  }

  const needsAttention =
    save.isAlive &&
    !save.isSleeping &&
    ((game.isEgg ? save.warmth : save.hunger) < 25 || save.cleanliness < 25 || save.happiness < 25);

  // Evolving (hatch or stage-up) charges for 10s — a stand-in for real
  // sprite art not existing yet — before the new stage is actually applied
  // and briefly revealed with the star burst.
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
  // handles instant-click care actions. While asleep, the only meaningful
  // action is waking up, so nothing else even shows.
  const radialActions: RadialAction[] = save.isSleeping
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
        { key: "sleep", icon: "🌙", label: "Tuck in", onClick: game.toggleSleep },
      ];
  if (!save.isSleeping && game.canEvolve) {
    radialActions.push({ key: "evolve", icon: "✨", label: "Evolve!", onClick: handleEvolve, highlight: true });
  }

  const showRadial = !game.isEgg && save.isAlive && menuOpen && !petBusy;

  const idleBreathing =
    save.isAlive && !game.isEgg && !save.isSleeping && !movement.isMoving && !petBusy && !happyPulse && !evolvePulse;

  const bodyClass = [
    movement.isMoving ? "pet-anim-walk" : "",
    feedPhase === "eating" ? "pet-anim-eat" : "",
    happyPulse ? "pet-anim-happy" : "",
    evolvePulse ? "pet-anim-evolve" : "",
    isEvolving ? "pet-anim-charging" : "",
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
        onClose={() => setStatsOpen(false)}
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
        soundEnabled={prefs.soundEnabled}
        onToggleSound={prefs.toggleSound}
        onRename={game.rename}
        onSignOut={auth.signOut}
        onQuit={() => window.overlay.quit()}
        appVersion={appUpdate.version}
        updateState={appUpdate.updateState}
        onInstallUpdate={appUpdate.installUpdate}
        groupsApi={groupsApi}
        activeRoomGroupId={room.activeGroup?.id ?? null}
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

      <motion.div
        data-interactive
        style={{ position: "fixed", left: 0, top: 0, width: PET_SIZE, height: PET_SIZE, x: movement.x, y: movement.y }}
        {...(save.isAlive && !petBusy ? petDragHandlers : {})}
      >
        {/* Status blip above the pet — sleeping already has PetEffects' own
            animated ZZZ particles, no need for a second static icon. */}
        {needsAttention && (
          <div style={{ position: "absolute", top: -18, right: 8, fontSize: 18, pointerEvents: "none" }}>❗</div>
        )}

        {/* My own room chat bubble + emote, mirroring what friends see. */}
        {auth.userId && room.activeGroup && room.bubbles[auth.userId] && Date.now() - room.bubbles[auth.userId]!.at < 6000 && (
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
          // A ready-to-hatch egg has no radial menu (eggs only hold-to-warm),
          // so a plain tap is its hatch trigger — a quick tap never becomes
          // a "hold" (startWarmHold's interval hasn't ticked yet), so this
          // can't be mistaken for warming.
          onClick={
            game.isEgg
              ? game.canHatch && !petBusy
                ? handleEvolve
                : undefined
              : petBusy
                ? undefined
                : () => {
                    setMenuOpen((o) => {
                      if (!o) sfx(Sounds.playSwish);
                      return !o;
                    });
                  }
          }
          onPointerDown={game.isEgg && save.isAlive && !petBusy ? startWarmHold : undefined}
          onPointerUp={game.isEgg && save.isAlive && !petBusy ? stopWarmHold : undefined}
          onPointerLeave={game.isEgg && save.isAlive && !petBusy ? stopWarmHold : undefined}
          style={{
            cursor: "pointer",
            width: PET_SIZE,
            height: PET_SIZE,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            userSelect: "none",
            x: leanX,
            y: leanY,
            scaleX: movement.facing === "left" ? -1 : 1,
            transformOrigin: "center",
          }}
        >
          <div className={bodyClass} style={{ width: PET_SIZE, height: PET_SIZE, position: "relative" }}>
            {visual}
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
    </>
  );
}
