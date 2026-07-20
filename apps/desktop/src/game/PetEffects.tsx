// Particle effects layered over the pet — ported from ERP_QA_HUB's
// src/components/pet/PetEffects.tsx. All framer-motion keyframe `animate`
// arrays, no physics engine — everything here is time-based, not
// force-based (the wash scrub-bubble particles live separately in
// GameView.tsx since they're spawned from live cursor position, not a
// fire-and-forget trigger).
import { AnimatePresence, motion } from "framer-motion";

export type PetFxTrigger = "happy" | "eat" | "overfed" | "overheated" | "distressed" | null;

export interface PetEffectsProps {
  trigger: PetFxTrigger;
  showEvolutionBurst: boolean;
  isSleeping: boolean;
  isAlive: boolean;
  isEgg: boolean;
  /** hunger (or warmth for an egg) — drives the "I'm hungry / keep me warm" bubble. */
  careNeed: number;
  cleanliness: number;
  isCleaningMode: boolean;
}

interface FloatProps {
  id: string;
  emoji: string;
  x: number;
  delayMs: number;
  repeat?: boolean;
}

function FloatParticle({ id, emoji, x, delayMs, repeat = false }: FloatProps) {
  return (
    <motion.span
      key={id}
      style={{
        position: "absolute",
        left: "50%",
        bottom: "80%",
        pointerEvents: "none",
        fontSize: 18,
        lineHeight: 1,
        userSelect: "none",
      }}
      initial={{ opacity: 0, x, y: 0, scale: 0 }}
      animate={{ opacity: [0, 1, 1, 0], y: [-4, -36, -44], scale: [0, 1, 0.8, 0] }}
      transition={{
        duration: 1.4,
        delay: delayMs / 1000,
        repeat: repeat ? Infinity : 0,
        repeatDelay: repeat ? 2.5 : 0,
        ease: "easeOut",
      }}
    >
      {emoji}
    </motion.span>
  );
}

function SmellWave({ id, x, delayMs, small = false }: { id: string; x: number; delayMs: number; small?: boolean }) {
  // `small` is the nest-slot variant — roughly half-size waves with a
  // shorter rise so they fit the 46px home slot instead of the pet cell.
  const rise = small ? [1, -5, -11, -16] : [2, -10, -22, -32];
  return (
    <motion.div
      key={id}
      style={{ position: "absolute", left: "50%", bottom: "78%", pointerEvents: "none" }}
      initial={{ opacity: 0, x, y: 4 }}
      animate={{ opacity: [0, 0.65, 0.45, 0], x: [x, x - 4, x + 6, x - 3], y: rise }}
      transition={{ duration: 2.1, delay: delayMs / 1000, repeat: Infinity, ease: "easeInOut" }}
    >
      <div style={{ display: "flex", gap: small ? 2 : 4 }}>
        <span
          style={{
            display: "block",
            height: small ? 12 : 24,
            width: small ? 2 : 3,
            borderRadius: 999,
            background: "rgba(190,242,100,0.7)",
          }}
        />
        <span
          style={{
            display: "block",
            height: small ? 10 : 20,
            width: small ? 2 : 3,
            borderRadius: 999,
            background: "rgba(110,231,183,0.55)",
          }}
        />
      </div>
    </motion.div>
  );
}

/** Compact stink/hunger indicators anchored to the dock's home/nest slot
 *  while the pet is tucked away (petNested) — the roaming PetEffects
 *  overlay is hidden then, since its container no longer tracks the dock.
 *  Same thresholds as PetEffects (cleanliness < 30, careNeed < 25) so the
 *  two presentations can never disagree. Render inside a
 *  position:relative wrapper around the slot; overflow must stay visible. */
export function NestStatusFx({
  cleanliness,
  careNeed,
  isEgg,
  isSleeping,
  isAlive,
}: {
  cleanliness: number;
  careNeed: number;
  isEgg: boolean;
  isSleeping: boolean;
  isAlive: boolean;
}) {
  if (!isAlive) return null;
  const smelly = cleanliness < 30;
  const hungry = !isSleeping && careNeed < 25;
  if (!smelly && !hungry) return null;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {smelly &&
        [-9, 8].map((xOff, i) => (
          <SmellWave key={`nest-smell-${i}`} id={`nest-smell-${i}`} x={xOff} delayMs={i * 520} small />
        ))}
      <AnimatePresence>
        {hungry && (
          <motion.div
            style={{
              position: "absolute",
              top: -16,
              left: "50%",
              transform: "translateX(-50%)",
              whiteSpace: "nowrap",
              borderRadius: 999,
              padding: "1px 6px",
              fontSize: 10,
              fontWeight: 700,
              background: "rgba(30,10,10,0.85)",
              color: "#fecaca",
              border: "1px solid rgba(248,113,113,0.4)",
            }}
            initial={{ opacity: 0, scale: 0.7, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.7, y: 4 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
          >
            {isEgg ? "🥶" : "🍔"}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function PetEffects({
  trigger,
  showEvolutionBurst,
  isSleeping,
  isAlive,
  isEgg,
  careNeed,
  cleanliness,
  isCleaningMode,
}: PetEffectsProps) {
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <AnimatePresence>
        {trigger === "happy" &&
          [0, 1, 2].map((i) => (
            <FloatParticle key={`heart-${i}`} id={`heart-${i}`} emoji="❤️" x={(i - 1) * 22} delayMs={i * 200} />
          ))}
        {trigger === "eat" &&
          [0, 1].map((i) => (
            <FloatParticle key={`spark-${i}`} id={`spark-${i}`} emoji="✨" x={(i - 0.5) * 30} delayMs={i * 300} />
          ))}
        {trigger === "overfed" &&
          [0, 1].map((i) => (
            <FloatParticle key={`sick-${i}`} id={`sick-${i}`} emoji="🤢" x={(i - 0.5) * 28} delayMs={i * 300} />
          ))}
        {trigger === "overheated" &&
          [0, 1, 2].map((i) => (
            <FloatParticle
              key={`hot-${i}`}
              id={`hot-${i}`}
              emoji={i === 1 ? "🥵" : "♨️"}
              x={(i - 1) * 24}
              delayMs={i * 180}
            />
          ))}
        {/* One-shot burst the instant hunger bottoms out (Phase C: replaces
            the old death screen — the pet stays interactive, this just
            marks the moment neglect became serious). Same shape as the
            overfeed "sick" burst above. */}
        {trigger === "distressed" &&
          [0, 1].map((i) => (
            <FloatParticle key={`sad-${i}`} id={`sad-${i}`} emoji="😢" x={(i - 0.5) * 26} delayMs={i * 300} />
          ))}
      </AnimatePresence>

      {/* Dirty smell waves — ambient while cleanliness is low and not mid-scrub */}
      {!isCleaningMode &&
        isAlive &&
        cleanliness < 30 &&
        [-18, 2, 20].map((xOff, i) => (
          <SmellWave key={`smell-${i}`} id={`smell-${i}`} x={xOff} delayMs={i * 520} />
        ))}

      {/* Hunger/cold speech bubble */}
      <AnimatePresence>
        {isAlive && !isSleeping && careNeed < 25 && (
          <motion.div
            style={{
              position: "absolute",
              top: -34,
              left: "50%",
              transform: "translateX(-50%)",
              whiteSpace: "nowrap",
              borderRadius: 999,
              padding: "3px 9px",
              fontSize: 11,
              fontWeight: 700,
              background: "rgba(30,10,10,0.85)",
              color: "#fecaca",
              border: "1px solid rgba(248,113,113,0.4)",
            }}
            initial={{ opacity: 0, scale: 0.7, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.7, y: 6 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
          >
            {isEgg ? "🥶 Keep me warm!" : "🍔 I'm hungry!"}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ZZZ sleeping */}
      {isSleeping &&
        isAlive &&
        ["z", "Z", "z"].map((ch, i) => (
          <motion.span
            key={`zzz-${i}`}
            style={{
              position: "absolute",
              right: 8,
              top: 8,
              fontSize: 10 + i * 4,
              fontWeight: 700,
              color: "#93c5fd",
              pointerEvents: "none",
            }}
            initial={{ opacity: 0, x: 8 + i * 12, y: 0, scale: 0.6 }}
            animate={{ opacity: [0, 1, 1, 0], y: -(20 + i * 14), scale: [0.6, 1, 0.7] }}
            transition={{ duration: 2.4, delay: i * 0.75, repeat: Infinity, repeatDelay: 0.8 }}
          >
            {ch}
          </motion.span>
        ))}

      {/* Wash rain — falling water drops + splash accents, ported from
          ERP_QA_HUB's PetOverlay.tsx wash sequence. */}
      {isCleaningMode && (
        <div
          style={{
            position: "absolute",
            // Spans from clearly above the pet's head down to about its feet —
            // drops fall the sprite's full height instead of stopping mid-body.
            // Sprites render centered in the cell (egg 0.5x, pets 0.7x), so the
            // band anchors at 50% and shrinks for the small egg — the old 56%
            // offset left the scaled-down egg sitting left of the rain.
            top: isEgg ? -20 : -30,
            left: "50%",
            height: isEgg ? 130 : 170,
            width: isEgg ? 76 : 112,
            transform: "translateX(-50%)",
            overflow: "hidden",
            pointerEvents: "none",
          }}
        >
          {/* x is a % of the band width so the same pattern fits both the
              narrow egg band and the full pet band without clipping. */}
          {[
            { x: 9, delay: 0, duration: 0.72 },
            { x: 21, delay: 0.2, duration: 0.86 },
            { x: 35, delay: 0.08, duration: 0.78 },
            { x: 49, delay: 0.31, duration: 0.9 },
            { x: 64, delay: 0.13, duration: 0.8 },
            { x: 79, delay: 0.42, duration: 0.94 },
          ].map((drop, i) => (
            <motion.span
              key={`rain-drop-${i}`}
              style={{
                position: "absolute",
                top: 0,
                left: `${drop.x}%`,
                display: "block",
                height: 10,
                width: 4,
                borderRadius: 999,
                background: "rgba(186,230,253,0.9)",
                boxShadow: "0 0 8px rgba(125,211,252,0.8)",
              }}
              initial={{ y: -14, opacity: 0, scaleY: 0.65 }}
              animate={{ y: [-14, 150], opacity: [0, 1, 0.9, 0], scaleY: [0.65, 1.25, 0.85] }}
              transition={{ duration: drop.duration, repeat: Infinity, delay: drop.delay, ease: "linear" }}
            />
          ))}
          {[
            { x: 11, delay: 0.56 },
            { x: 32, delay: 0.68 },
            { x: 54, delay: 0.5 },
            { x: 73, delay: 0.75 },
          ].map((splash, i) => (
            <motion.span
              key={`rain-splash-${i}`}
              style={{
                position: "absolute",
                bottom: 18,
                left: `${splash.x}%`,
                display: "block",
                height: 4,
                width: 12,
                borderRadius: 999,
                borderTop: "1px solid rgba(186,230,253,0.8)",
              }}
              initial={{ opacity: 0, scaleX: 0.2, y: 0 }}
              animate={{ opacity: [0, 0.95, 0], scaleX: [0.2, 1.6, 2.2], y: [0, -3, 0] }}
              transition={{ duration: 0.38, repeat: Infinity, delay: splash.delay, ease: "easeOut" }}
            />
          ))}
        </div>
      )}

      {/* Evolution burst — 6 stars in a ring */}
      {showEvolutionBurst &&
        [0, 1, 2, 3, 4, 5].map((i) => {
          const angle = (i * 60 * Math.PI) / 180;
          const rx = Math.cos(angle) * 55;
          const ry = Math.sin(angle) * 55;
          return (
            <motion.span
              key={`star-${i}`}
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                fontSize: 20,
                pointerEvents: "none",
              }}
              initial={{ opacity: 1, x: 0, y: 0, scale: 0 }}
              animate={{ opacity: [1, 1, 0], x: rx, y: ry, scale: [0, 1.5, 0] }}
              transition={{ duration: 1.4, delay: i * 0.08, repeat: Infinity, repeatDelay: 0.55 }}
            >
              ⭐
            </motion.span>
          );
        })}
    </div>
  );
}
