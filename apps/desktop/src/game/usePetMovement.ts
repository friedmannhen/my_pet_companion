// Wander + drag-and-throw physics — ported from ERP_QA_HUB's
// src/hooks/usePetMovement.ts (see PET_GAME_TRANSFORMATION_PLAN.md §7). Uses
// framer-motion motion values + imperative `animate()` springs instead of
// manual rAF/lerp math, which is what gives the wander its organic
// "settle into place" feel instead of a robotic straight-line glide.
import { useCallback, useEffect, useRef, useState } from "react";
import { useMotionValue, animate, type PanInfo } from "framer-motion";

const PET_SIZE = 128;
const MARGIN = 16;
// "Follow Me" chase tuning — halts inside the dead zone so the cursor can
// rest near the pet without it jittering in place chasing sub-pixel deltas.
const FOLLOW_DEAD_ZONE = 140;
const FOLLOW_SPEED: Record<"slow" | "normal" | "fast", { f: number; max: number }> = {
  slow: { f: 0.055, max: 4 },
  normal: { f: 0.09, max: 7 },
  fast: { f: 0.14, max: 14 },
};

function clampPos(x: number, y: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.max(MARGIN, Math.min(vw - PET_SIZE - MARGIN, x)),
    y: Math.max(MARGIN, Math.min(vh - PET_SIZE - MARGIN, y)),
  };
}

function randomTarget() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return clampPos(
    MARGIN + Math.random() * (vw - PET_SIZE - MARGIN * 2),
    MARGIN + Math.random() * (vh - PET_SIZE - MARGIN * 4),
  );
}

export interface UsePetMovementOptions {
  /** Wander only runs when this is true (alive, hatched, not sleeping, menu closed). */
  active: boolean;
  initial?: { x: number; y: number };
  /** "Follow Me" — chases the OS cursor instead of wandering. Callers
   * should also pass `active: false` while this is true (wander and
   * follow must never drive x/y in the same tick). */
  following?: boolean;
  followSpeed?: "slow" | "normal" | "fast";
}

export interface UsePetMovement {
  x: ReturnType<typeof useMotionValue<number>>;
  y: ReturnType<typeof useMotionValue<number>>;
  facing: "left" | "right";
  /** True while wandering, being thrown, or walking-to-target — drives the CSS walk-bounce class. */
  isMoving: boolean;
  /** Spread onto the draggable motion.div. */
  dragHandlers: {
    drag: true;
    dragMomentum: false;
    dragElastic: 0;
    onDragStart: () => void;
    onDrag: (e: unknown, info: PanInfo) => void;
    onDragEnd: () => void;
  };
  /** Imperatively walk to a point (used by feed/evolve sequences) — resolves on arrival, pauses wander. */
  walkTo: (targetX: number, targetY: number, speedPxPerFrame?: number) => Promise<void>;
}

export function usePetMovement({ active, initial, following = false, followSpeed = "normal" }: UsePetMovementOptions): UsePetMovement {
  const x = useMotionValue(initial?.x ?? 200);
  const y = useMotionValue(initial?.y ?? 200);
  const [facing, setFacing] = useState<"left" | "right">("right");
  const [isMoving, setIsMoving] = useState(false);

  // Manual velocity tracker during drag — framer-motion's own dragMomentum
  // is disabled so all "throw" feel comes from this + the glide spring below.
  const dragVelRef = useRef({ vx: 0, vy: 0, lastX: 0, lastY: 0, lastT: 0 });
  const activeRef = useRef(false);
  // Follow Me — dragging always takes priority: paused while a drag is in
  // progress and for a short grace period after release (matches the
  // pet's own "never fight the user's cursor" drag-glide behavior).
  const followSpeedRef = useRef(followSpeed);
  followSpeedRef.current = followSpeed;
  const cursorRef = useRef({ x: 0, y: 0 });
  const dragActiveRef = useRef(false);
  const followPauseUntilRef = useRef(0);
  const followMovingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animsRef = useRef<{ stop: () => void }[]>([]);

  const stopAnims = useCallback(() => {
    animsRef.current.forEach((a) => a.stop());
    animsRef.current = [];
  }, []);

  const scheduleNext = useCallback(() => {
    if (!activeRef.current) return;
    const pause = 4000 + Math.random() * 8000; // 4–12s between walks
    timerRef.current = setTimeout(() => {
      if (!activeRef.current) return;
      const target = randomTarget();
      const curX = x.get();
      setFacing(target.x > curX ? "right" : "left");
      setIsMoving(true);
      stopAnims();

      const ax = animate(x, target.x, { type: "spring", stiffness: 45, damping: 16 });
      const ay = animate(y, target.y, { type: "spring", stiffness: 45, damping: 16 });
      animsRef.current = [ax, ay];

      timerRef.current = setTimeout(() => {
        setIsMoving(false);
        scheduleNext();
      }, 2200);
    }, pause);
  }, [x, y, stopAnims]);

  useEffect(() => {
    if (!active) {
      activeRef.current = false;
      stopAnims();
      if (timerRef.current) clearTimeout(timerRef.current);
      setIsMoving(false);
      return;
    }
    activeRef.current = true;
    scheduleNext();
    return () => {
      activeRef.current = false;
      stopAnims();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [active, scheduleNext, stopAnims]);

  // Keep the pet on-screen if the window/work-area size ever changes.
  useEffect(() => {
    function onResize() {
      const { x: cx, y: cy } = clampPos(x.get(), y.get());
      x.set(cx);
      y.set(cy);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [x, y]);

  // Follow Me — track the OS cursor via the main-process stream (plain
  // `mousemove` doesn't reach this click-through overlay reliably, see
  // useHitTest.ts) while following is active.
  useEffect(() => {
    if (!following) return;
    const off = window.overlay.onCursor(({ x: cx, y: cy }) => {
      cursorRef.current = { x: cx, y: cy };
    });
    return off;
  }, [following]);

  // Follow Me — rAF chase loop. Mutually exclusive with wander: the caller
  // is expected to pass `active: false` while `following` is true.
  useEffect(() => {
    if (!following) return;
    let raf: number;
    const frame = () => {
      const paused = dragActiveRef.current || performance.now() < followPauseUntilRef.current;
      if (paused) {
        if (followMovingRef.current) {
          followMovingRef.current = false;
          setIsMoving(false);
        }
        raf = requestAnimationFrame(frame);
        return;
      }
      const dx = cursorRef.current.x - (x.get() + PET_SIZE / 2);
      const dy = cursorRef.current.y - (y.get() + PET_SIZE / 2);
      const dist = Math.sqrt(dx * dx + dy * dy);
      const moving = dist > FOLLOW_DEAD_ZONE;
      if (moving !== followMovingRef.current) {
        followMovingRef.current = moving;
        setIsMoving(moving);
      }
      if (moving) {
        const nf: "left" | "right" = dx > 0 ? "right" : "left";
        setFacing((prev) => (prev !== nf ? nf : prev));
        const { f, max } = FOLLOW_SPEED[followSpeedRef.current];
        const speed = Math.min(dist * f, max);
        const { x: cx, y: cy } = clampPos(x.get() + (dx / dist) * speed, y.get() + (dy / dist) * speed);
        x.set(cx);
        y.set(cy);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [following, x, y]);

  const onDragStart = useCallback(() => {
    stopAnims();
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setIsMoving(false);
    dragActiveRef.current = true;
    dragVelRef.current = { vx: 0, vy: 0, lastX: x.get(), lastY: y.get(), lastT: performance.now() };
  }, [stopAnims, x, y]);

  const onDrag = useCallback(
    (_e: unknown, info: PanInfo) => {
      // Framer's drag already applies info.delta to x/y for us (motion.div
      // style={{x,y}} + drag="both" wires that up); we just track velocity.
      const now = performance.now();
      const dt = now - dragVelRef.current.lastT;
      if (dt > 0 && dt < 100) {
        dragVelRef.current.vx = ((x.get() - dragVelRef.current.lastX) / dt) * 1000;
        dragVelRef.current.vy = ((y.get() - dragVelRef.current.lastY) / dt) * 1000;
      }
      dragVelRef.current.lastX = x.get();
      dragVelRef.current.lastY = y.get();
      dragVelRef.current.lastT = now;
      void info; // info.point/delta not needed — motion values already updated
    },
    [x, y],
  );

  const onDragEnd = useCallback(() => {
    const { vx: velX, vy: velY } = dragVelRef.current;
    const GLIDE = 0.13;
    const targetX = x.get() + velX * GLIDE;
    const targetY = y.get() + velY * GLIDE;
    const { x: cx, y: cy } = clampPos(targetX, targetY);
    const gx = animate(x, cx, { type: "spring", stiffness: 80, damping: 24 });
    const gy = animate(y, cy, { type: "spring", stiffness: 80, damping: 24 });
    animsRef.current = [gx, gy];
    dragActiveRef.current = false;
    followPauseUntilRef.current = performance.now() + 650;
    if (activeRef.current) {
      timerRef.current = setTimeout(() => scheduleNext(), 650);
    }
  }, [x, y, scheduleNext]);

  const walkTo = useCallback(
    (targetX: number, targetY: number, speedPxPerFrame = 10): Promise<void> => {
      // Pause wander for the duration of the walk, matching drag's cleanup.
      activeRef.current && stopAnims();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // Callers pass raw landing points (e.g. thrown-food position minus an
      // offset) that can fall outside the walkable area — clamp so the loop
      // can actually arrive.
      const target = clampPos(targetX, targetY);
      setIsMoving(true);
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(watchdog);
          setIsMoving(false);
          if (activeRef.current) timerRef.current = setTimeout(() => scheduleNext(), 650);
          resolve();
        };
        // Watchdog: a caller must NEVER await forever — a stuck walk would
        // freeze the whole feed/ball sequence and (via petBusy) deadlock all
        // later interactions. Any screen crossing takes well under 6s at
        // ~10px/frame; past that, teleport to the target and move on.
        const watchdog = setTimeout(() => {
          x.set(target.x);
          y.set(target.y);
          console.warn("[walkTo] watchdog fired — teleported to target");
          finish();
        }, 6000);
        const step = () => {
          if (done) return;
          const dx = target.x - x.get();
          const dy = target.y - y.get();
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 28) {
            finish();
            return;
          }
          const nf: "left" | "right" = dx > 0 ? "right" : "left";
          setFacing((prev) => (prev !== nf ? nf : prev));
          const speed = Math.min(dist * 0.08, speedPxPerFrame);
          x.set(x.get() + (dx / dist) * speed);
          y.set(y.get() + (dy / dist) * speed);
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    },
    [x, y, stopAnims, scheduleNext],
  );

  return {
    x,
    y,
    facing,
    isMoving,
    dragHandlers: {
      drag: true,
      dragMomentum: false,
      dragElastic: 0,
      onDragStart,
      onDrag,
      onDragEnd,
    },
    walkTo,
  };
}
