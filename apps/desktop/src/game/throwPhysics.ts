// Shared ballistic-arc flight math, extracted from GameView.tsx so the
// feed/ball throws and the Target Toss minigame replay the EXACT same
// parabola — do not fork/duplicate this formula.
import { animate, type MotionValue } from "framer-motion";

/**
 * Ballistic arc flight for a thrown item: constant horizontal velocity +
 * a gravity-shaped parabola for the vertical rise/fall (peaking at
 * `arcHeight` above the straight line between start and end, at the
 * midpoint of the flight), plus continuous spin. The progress driver runs
 * on a plain linear tween — easing lives in the quadratic height formula
 * itself (that's what makes it decelerate/accelerate like a real toss); an
 * eased progress on top of that would double up and distort the arc.
 */
export async function throwArc(opts: {
  x: MotionValue<number>;
  y: MotionValue<number>;
  rotate: MotionValue<number>;
  scaleX: MotionValue<number>;
  scaleY: MotionValue<number>;
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
