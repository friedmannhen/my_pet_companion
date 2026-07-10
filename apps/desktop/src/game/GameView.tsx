// The actual pet overlay + care loop. Only ever mounted while signed in
// (see App.tsx) — this repo is online-only by design (plan MVP decision),
// so no pet exists to render or play with before authentication.
//
// UI architecture (per design intent): the overlay shows ONLY the pet and a
// compact radial interaction menu, QA-hub-style — never a stats/data
// readout. All progress/data lives in the separate stats window
// (stats/StatsApp.tsx, opened via the control strip's 📊 button).
//
// Movement/interaction mechanics (wander springs, drag-glide throw,
// feed/wash gestures, particle timings) are ported from ERP_QA_HUB's
// usePetMovement.ts / PetOverlay.tsx / PetEffects.tsx — see those files'
// history for the original reference implementation this was studied from.
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationControls, useSpring, useTransform } from "framer-motion";
import type { AuthState } from "../supabase/useAuth";
import { usePetGame } from "./usePetGame";
import { useSessionLease } from "../session/useSessionLease";
import { usePetMovement } from "./usePetMovement";
import { PetEffects, type PetFxTrigger } from "./PetEffects";
import { AdminPanel } from "./AdminPanel";
import { RadialMenu, type RadialAction } from "./RadialMenu";
import { setClickableOverride } from "../overlay/clickableOverride";
import "./petAnimations.css";
import catBaby from "../assets/pets/black_cat/black_cat_baby.png";
import catBabyBlink from "../assets/pets/black_cat/black_cat_baby_blink.png";
import catAdult from "../assets/pets/black_cat/black_cat_adult.png";
import catAdultBlink from "../assets/pets/black_cat/black_cat_adult_blink.png";
import catFinal from "../assets/pets/black_cat/black_cat_final.png";
import catFinalBlink from "../assets/pets/black_cat/black_cat_final_blink.png";
import catFinalSleep from "../assets/pets/black_cat/black_cat__final_sleep.png";

const SYNC_COLOR: Record<string, string> = {
  offline: "#9ca3af",
  loading: "#fbbf24",
  synced: "#34d399",
  error: "#f87171",
};

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

const TUMBLE_EASE: [number, number, number, number] = [0.2, 0, 0.8, 1];

export function GameView({ auth, clickable }: { auth: AuthState; clickable: boolean }) {
  const game = usePetGame(auth.userId);
  const lease = useSessionLease(auth.userId);
  const { save } = game;

  const [menuOpen, setMenuOpen] = useState(false);
  const [feedPhase, setFeedPhase] = useState<"idle" | "holding" | "flying" | "eating">("idle");
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

  const stationary = save.isSleeping || !save.isAlive || game.isEgg;
  const movement = usePetMovement({
    active: !stationary && !menuOpen && feedPhase === "idle" && !cleaningMode,
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
      gameRef.current.warmTick();
    }, 200);
  }, []);

  const pulseHappy = useCallback(() => {
    setFxTrigger("happy");
    setHappyPulse(true);
    setTimeout(() => setHappyPulse(false), 700);
    setTimeout(() => setFxTrigger((t) => (t === "happy" ? null : t)), 900);
  }, []);

  const act = useCallback(
    (fn: () => void, kind: "happy" | "none" = "none") => {
      fn();
      if (kind === "happy") pulseHappy();
    },
    [pulseHappy],
  );

  // ── Feed: hold-and-throw ────────────────────────────────────────────────
  const foodControls = useAnimationControls();
  const feedVelRef = useRef({ vx: 0, vy: 0, lastX: 0, lastY: 0, lastT: 0 });

  const startFeedThrow = useCallback(() => {
    if (!save.isAlive || save.isSleeping) return;
    setMenuOpen(false);
    setClickableOverride(true);
    window.overlay.setClickable(true);
    setFeedPhase("holding");
    const sx = movement.x.get() + PET_SIZE / 2;
    const sy = movement.y.get() + PET_SIZE / 2;
    foodControls.set({ x: sx - 24, y: sy - 24, scale: 0.9, rotate: -10, opacity: 1 });
    feedVelRef.current = { vx: 0, vy: 0, lastX: sx, lastY: sy, lastT: performance.now() };
  }, [save.isAlive, save.isSleeping, movement.x, movement.y, foodControls]);

  const throwFood = useCallback(
    async (releaseX: number, releaseY: number) => {
      setFeedPhase("flying");
      const GLIDE = 0.22;
      const vel = feedVelRef.current;
      const landX = Math.max(40, Math.min(window.innerWidth - 40, releaseX + vel.vx * GLIDE));
      const landY = Math.max(60, Math.min(window.innerHeight - 100, releaseY + vel.vy * GLIDE - 30));

      await foodControls.start(
        { x: landX - 24, y: landY - 24, rotate: 15, scale: 1 },
        { duration: 0.5, ease: TUMBLE_EASE },
      );
      await foodControls.start({ y: landY - 36 }, { duration: 0.12, ease: "easeOut" });
      await foodControls.start({ y: landY - 24 }, { duration: 0.1, ease: "easeIn" });

      setClickableOverride(false);
      await movement.walkTo(landX - 44, landY - 88);

      setFeedPhase("eating");
      setFxTrigger("eat");
      game.feed();
      await new Promise((r) => setTimeout(r, 450));
      await foodControls.start({ scale: 0, opacity: 0, y: landY - 54 }, { duration: 0.3, ease: "easeIn" });
      foodControls.set({ opacity: 0, x: -200, y: -200 });

      setFxTrigger(null);
      setFeedPhase("idle");
    },
    [foodControls, movement, game],
  );

  useEffect(() => {
    if (feedPhase !== "holding") return;
    const onMove = (e: MouseEvent) => {
      const now = performance.now();
      const v = feedVelRef.current;
      const dt = now - v.lastT;
      if (dt > 0 && dt < 100) {
        v.vx = ((e.clientX - v.lastX) / dt) * 1000;
        v.vy = ((e.clientY - v.lastY) / dt) * 1000;
      }
      v.lastX = e.clientX;
      v.lastY = e.clientY;
      v.lastT = now;
      foodControls.set({ x: e.clientX - 24, y: e.clientY - 24 });
    };
    const onClick = (e: MouseEvent) => {
      void throwFood(e.clientX, e.clientY);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("click", onClick);
    };
  }, [feedPhase, foodControls, throwFood]);

  // ── Wash: hold sponge + scrub ────────────────────────────────────────────
  const scrubHeldRef = useRef(false);
  const scrubTargetRef = useRef(1000);
  const lastScrubPointRef = useRef<{ x: number; y: number } | null>(null);
  const lastScrubAtRef = useRef<number | null>(null);
  const scrubEffectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bubbleSpawnRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const scrubCursorRef = useRef({ x: 0, y: 0 });

  const endCleaning = useCallback((completed: boolean) => {
    if (completed) gameRef.current.wash();
    setCleaningMode(false);
    setScrubHeld(false);
    scrubHeldRef.current = false;
    setScrubbingEffectively(false);
    setScrubProgress(0);
    setBubbles([]);
    lastScrubPointRef.current = null;
    lastScrubAtRef.current = null;
    setClickableOverride(false);
  }, []);

  const startCleaning = useCallback(() => {
    if (!save.isAlive || save.isSleeping || save.cleanliness >= 100) return;
    setMenuOpen(false);
    const missing = Math.max(0, 100 - Math.round(save.cleanliness));
    scrubTargetRef.current = Math.min(10, Math.max(1, missing / 10)) * 1000;
    setScrubProgress(0);
    setCleaningMode(true);
    setClickableOverride(true);
    window.overlay.setClickable(true);
  }, [save.isAlive, save.isSleeping, save.cleanliness]);

  useEffect(() => {
    if (!cleaningMode) return;

    const onMove = (e: MouseEvent) => {
      scrubCursorRef.current = { x: e.clientX, y: e.clientY };
      setScrubCursor(scrubCursorRef.current);
      if (!scrubHeldRef.current || (e.buttons & 1) !== 1) return;

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
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [cleaningMode, endCleaning]);

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

  const handleEvolve = useCallback(() => {
    setEvolvePulse(true);
    game.hatchOrEvolve();
    setTimeout(() => setEvolvePulse(false), 2700);
  }, [game]);

  const radialActions: RadialAction[] = [
    { key: "feed", icon: "🍖", label: "Feed", onClick: startFeedThrow, disabled: save.isSleeping },
    { key: "wash", icon: "🧼", label: "Wash", onClick: startCleaning, disabled: save.isSleeping || save.cleanliness >= 100 },
    { key: "pet", icon: "🤗", label: "Pet", onClick: () => act(game.pet, "happy"), disabled: save.isSleeping },
    { key: "ball", icon: "⚾", label: "Ball", onClick: () => act(game.throwBall, "happy"), disabled: save.isSleeping },
    { key: "sleep", icon: save.isSleeping ? "☀️" : "🌙", label: save.isSleeping ? "Wake" : "Tuck in", onClick: game.toggleSleep },
  ];
  if (game.canEvolve) {
    radialActions.push({ key: "evolve", icon: "✨", label: "Evolve!", onClick: handleEvolve, highlight: true });
  }

  const showRadial = !game.isEgg && save.isAlive && menuOpen;
  const bodyClass = [
    movement.isMoving && feedPhase !== "flying" ? "pet-anim-walk" : "",
    feedPhase === "eating" ? "pet-anim-eat" : "",
    happyPulse ? "pet-anim-happy" : "",
    evolvePulse ? "pet-anim-evolve" : "",
  ]
    .filter(Boolean)
    .join(" ");

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

      {import.meta.env.DEV && <AdminPanel game={game} />}

      {/* Compact always-visible control strip — app/account controls, not game data. */}
      <div
        data-interactive
        style={{
          position: "fixed",
          bottom: 12,
          right: 12,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
          borderRadius: 10,
          background: "rgba(20,20,26,0.85)",
          fontFamily: "'Segoe UI', system-ui, sans-serif",
        }}
      >
        <span
          title={game.syncError ?? game.syncStatus}
          style={{ width: 8, height: 8, borderRadius: "50%", background: SYNC_COLOR[game.syncStatus], flexShrink: 0 }}
        />
        {lease.status === "conflict" && (
          <button
            style={{ ...chipStyle, background: "rgba(248,113,113,0.35)" }}
            onClick={lease.forceTakeover}
            title={lease.conflict ? `Active on ${lease.conflict.deviceType} — click to take over here` : "Active elsewhere"}
          >
            ⚠️ Take over
          </button>
        )}
        <button style={chipStyle} onClick={() => window.overlay.openStats()}>
          📊 Stats
        </button>
        <button style={chipStyle} onClick={auth.signOut}>
          Sign out
        </button>
        <button style={{ ...chipStyle, opacity: 0.7 }} onClick={() => window.overlay.quit()}>
          Quit
        </button>
      </div>

      {/* Food — held, thrown, and eaten. Not data-interactive: the whole
          screen is forced-clickable during hold/flight via clickableOverride,
          and release is a plain window click, not a click on the food itself. */}
      {feedPhase !== "idle" && (
        <motion.div
          style={{ position: "fixed", left: 0, top: 0, fontSize: 40, pointerEvents: "none", zIndex: 20000 }}
          animate={foodControls}
          initial={{ opacity: 0 }}
        >
          🍖
        </motion.div>
      )}
      {feedPhase === "holding" && (
        <div
          style={{
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
          }}
        >
          🍖 Click anywhere to throw the food!
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
              zIndex: 20000,
              padding: "8px 16px",
              borderRadius: 14,
              background: scrubbingEffectively ? "rgba(8,47,73,0.9)" : "rgba(20,20,26,0.88)",
              color: "#bae6fd",
              fontSize: 12,
              fontWeight: 700,
              textAlign: "center",
              pointerEvents: "none",
            }}
          >
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
            </div>
          </div>
          <motion.div
            style={{
              position: "fixed",
              left: scrubCursor.x - 18,
              top: scrubCursor.y - 18,
              fontSize: 32,
              pointerEvents: "none",
              zIndex: 20001,
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
                style={{ position: "fixed", left: b.x, top: b.y, fontSize: b.size, pointerEvents: "none", zIndex: 19999 }}
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
        {...(!game.isEgg && save.isAlive ? movement.dragHandlers : {})}
      >
        {/* Status blips above the pet */}
        {save.isSleeping && save.isAlive && (
          <div style={{ position: "absolute", top: -18, left: 8, fontSize: 18, pointerEvents: "none" }}>💤</div>
        )}
        {needsAttention && (
          <div style={{ position: "absolute", top: -18, right: 8, fontSize: 18, pointerEvents: "none" }}>❗</div>
        )}

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
          onClick={game.isEgg ? (game.canHatch ? handleEvolve : undefined) : () => setMenuOpen((o) => !o)}
          onPointerDown={game.isEgg && save.isAlive ? startWarmHold : undefined}
          onPointerUp={game.isEgg && save.isAlive ? stopWarmHold : undefined}
          onPointerLeave={game.isEgg && save.isAlive ? stopWarmHold : undefined}
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
              readyToEvolve={game.canHatch || game.canEvolve}
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
