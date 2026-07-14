// Straight-line "puck on ice" slide physics for Target Toss (deliberately
// separate from throwPhysics.ts's ballistic throwArc — different mechanic,
// and that file's header forbids forking the parabola; this is not a fork).
//
// Model: velocity decays exponentially (v(t) = v0·e^(−k·t)), so position
// integrates to a closed form and the puck travels a FINITE distance
// v0/k along a straight line. The drag-aim preview line therefore IS the
// travel line by construction — no aim-vs-flight mismatch.
import { animate, type MotionValue } from "framer-motion";

/** Friction coefficient (1/s). Higher = stops sooner. */
export const CURL_FRICTION_K = 2.2;
/** Velocity considered "stopped" (px/s) — bounds the slide duration. */
const V_MIN = 40;

/** Total travel distance for a launch speed (px): v0/k, capped by V_MIN cutoff. */
export function slideDistance(v0: number, k: number = CURL_FRICTION_K): number {
  if (v0 <= V_MIN) return 0;
  // Distance covered until v decays to V_MIN: (v0 - V_MIN) / k.
  return (v0 - V_MIN) / k;
}

/** Time (s) until the puck decays to V_MIN and visually stops. */
export function slideDuration(v0: number, k: number = CURL_FRICTION_K): number {
  if (v0 <= V_MIN) return 0;
  return Math.log(v0 / V_MIN) / k;
}

/**
 * Animate a straight-line slide with exponential deceleration. Linear
 * progress driver + closed-form decay mapping (same philosophy as
 * throwArc: the physics lives in the formula, never in an easing curve).
 */
export async function slidePuck(opts: {
  x: MotionValue<number>;
  y: MotionValue<number>;
  rotate: MotionValue<number>;
  toX: number;
  toY: number;
  duration: number;
  spinDegrees: number;
  k?: number;
}): Promise<void> {
  const { x, y, rotate, toX, toY, duration, spinDegrees } = opts;
  const k = opts.k ?? CURL_FRICTION_K;
  const fromX = x.get();
  const fromY = y.get();
  const fromRotate = rotate.get();
  if (duration <= 0) {
    x.set(toX);
    y.set(toY);
    return;
  }
  // Normalized decay: p(t) = (1 − e^(−k·t)) / (1 − e^(−k·T)) so p(T) = 1 —
  // fast at launch, asymptotically gliding to a stop, like a puck on ice.
  const denom = 1 - Math.exp(-k * duration);
  await animate(0, 1, {
    duration,
    ease: "linear",
    onUpdate: (t) => {
      const p = (1 - Math.exp(-k * t * duration)) / denom;
      x.set(fromX + (toX - fromX) * p);
      y.set(fromY + (toY - fromY) * p);
      rotate.set(fromRotate + spinDegrees * p);
    },
  });
}
