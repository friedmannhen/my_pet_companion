// Wander + drag-and-throw physics — ported from ERP_QA_HUB's
// src/hooks/usePetMovement.ts (see PET_GAME_TRANSFORMATION_PLAN.md §7). Uses
// framer-motion motion values + imperative `animate()` springs instead of
// manual rAF/lerp math, which is what gives the wander its organic
// "settle into place" feel instead of a robotic straight-line glide.
import { useCallback, useEffect, useRef, useState } from "react";
import { useMotionValue, animate, type PanInfo } from "framer-motion";

const PET_SIZE = 128;
const MARGIN = 16;

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

export function usePetMovement({ active, initial }: UsePetMovementOptions): UsePetMovement {
  const x = useMotionValue(initial?.x ?? 200);
  const y = useMotionValue(initial?.y ?? 200);
  const [facing, setFacing] = useState<"left" | "right">("right");
  const [isMoving, setIsMoving] = useState(false);

  // Manual velocity tracker during drag — framer-motion's own dragMomentum
  // is disabled so all "throw" feel comes from this + the glide spring below.
  const dragVelRef = useRef({ vx: 0, vy: 0, lastX: 0, lastY: 0, lastT: 0 });
  const activeRef = useRef(false);
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

  const onDragStart = useCallback(() => {
    stopAnims();
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setIsMoving(false);
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
      setIsMoving(true);
      return new Promise((resolve) => {
        const step = () => {
          const dx = targetX - x.get();
          const dy = targetY - y.get();
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 28) {
            setIsMoving(false);
            if (activeRef.current) timerRef.current = setTimeout(() => scheduleNext(), 650);
            resolve();
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
