// Target Toss arena (room minigame #1). Right half: concentric-ring target;
// left half: the active thrower's launcher. Aiming is a drag-pullback
// slingshot — a power bar shows pull STRENGTH only (no exact landing
// preview, that would give away the score before throwing). The puck is
// each player's own pet sprite, sliding in a STRAIGHT line with ice-like
// friction (curlPhysics.ts). The thrower computes the stop point locally
// and broadcasts it; every client replays the identical slidePuck(), and
// the distance/marker are revealed only once that replay finishes.
//
// Scoring is golf-style (packages/pet-core/src/minigames/targetToss.ts):
// lowest TOTAL distance-from-center summed across every round wins, not
// most-rounds-won. Target/launcher move to a new random height each round
// (same spot for every player that round, seeded — see arenaLayoutForTurn).
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useMotionValue } from "framer-motion";
import {
  arenaLayoutForTurn,
  computeTotalDistances,
  currentTossTurn,
  totalDistanceLeaders,
  TARGET_TOSS_ROUNDS,
  type PetSaveData,
} from "@pet/core";
import { slidePuck, slideDuration, velocityForDistance } from "../curlPhysics";
import { spriteFor, emojiFor } from "../petSprites";
import { TOSS_TURN_TIMEOUT_MS, type RoomApi, type TossThrowFx } from "../../online/useRoom";

// Arena geometry (fractions of the window, so every screen sees the same
// relative layout — matching the pos-broadcast convention). Only the X
// positions are fixed; Y comes from arenaLayoutForTurn each round.
const TARGET_NX = 0.75;
const LAUNCH_NX = 0.2;
/** Target outer-ring radius as a fraction of min(viewport w, h). Half the
 *  original size — a smaller target reads as "harder/more precise", not
 *  just "easier to fill the screen with". */
const TARGET_R_FRAC = 0.09;
// Pull power is normalized to the ACTUAL available screen room, not a fixed
// distance — a fixed-px or fixed-diagonal-fraction threshold for "100%
// power" could sit farther from the launcher than the monitor's edge, so
// players on some screens (or pulling near an edge) could never physically
// drag far enough to fill the bar (the mouse cursor simply can't leave the
// monitor). Instead, 100% power = "pulled all the way to (near) the screen
// edge in that direction" — always reachable, on any monitor, by
// construction — and the resulting travel distance is a fraction of the
// arena's own launcher→target span (also screen-size-relative), not a raw
// pixel count, so throws still feel consistent across different monitors.
/** Safety margin (px) from the literal screen edge — the cursor doesn't
 *  need to hit pixel 0 to register 100% power. */
const EDGE_MARGIN_PX = 24;
/** A full (edge-limited) pull sends the puck this many multiples of the
 *  launcher→target distance — >1 so max power is a deliberate overshoot
 *  risk, while ~60-70% power comfortably reaches the target. */
const TRAVEL_SPAN_MULT = 1.3;
/** Number of discrete segments in the signal-strength-style power meter. */
const POWER_LEVELS = 10;
/** Pre-turn "get ready" pause before aiming unlocks. */
const TURN_READY_MS = 3_000;
/** Puck size: each player's own pet sprite, shown small. */
const PUCK_SIZE = 45;

const RING_COLORS = ["rgba(248,113,113,0.85)", "rgba(255,255,255,0.9)", "rgba(248,113,113,0.85)", "rgba(255,255,255,0.9)", "rgba(239,68,68,0.95)"];

const HOW_TO_PLAY =
  "Pull back and release to slide your pet toward the target, like curling. " +
  "Everyone throws once per round — the target and launch spot move to a new " +
  "random height each round (same spot for everyone that round, so it's fair). " +
  "After 3 rounds, LOWEST total distance-from-center across all your throws " +
  "wins — like golf! Pull too hard and your pet flies off the ice: a miss " +
  "costs a big penalty, worse than any real throw. Tied on total? Sudden death.";

function parseRoundKey(key: string): { phase: "main" | "sudden"; round: number } {
  const [phase, roundStr] = key.split(":");
  return { phase: phase === "sudden" ? "sudden" : "main", round: Number(roundStr) || 1 };
}

function targetCenter(ny: number) {
  return { x: TARGET_NX * window.innerWidth, y: ny * window.innerHeight };
}
function targetRadius() {
  return Math.min(window.innerWidth, window.innerHeight) * TARGET_R_FRAC;
}
function launcherPos(ny: number) {
  return { x: LAUNCH_NX * window.innerWidth, y: ny * window.innerHeight };
}
/** How far back a player can physically drag before hitting the left
 *  screen edge — the natural pull direction is "away from the target",
 *  i.e. leftward, so this is what actually bounds 100% power. */
function availablePullPx(lp: { x: number }) {
  return Math.max(60, lp.x - EDGE_MARGIN_PX);
}
/** Launcher→target distance — the "one arena span" that a full pull
 *  travels TRAVEL_SPAN_MULT multiples of. */
function arenaSpanPx(lp: { x: number }, c: { x: number }) {
  return Math.max(60, c.x - lp.x);
}

function PuckSprite({ petType, stage, opacity = 1 }: { petType: string; stage: number; opacity?: number }) {
  const src = spriteFor(petType, stage);
  return src ? (
    <img
      src={src}
      width={PUCK_SIZE}
      height={PUCK_SIZE}
      draggable={false}
      alt=""
      style={{ display: "block", opacity }}
    />
  ) : (
    <span style={{ fontSize: PUCK_SIZE * 0.75, opacity }}>{emojiFor(petType)}</span>
  );
}

export function TargetToss({ room, userId, mySave }: { room: RoomApi; userId: string; mySave: PetSaveData }) {
  const game = room.tossGame!;
  const turn = currentTossTurn(game.core);
  const myTurn = turn?.userId === userId;
  const over = game.core.winners.length > 0;
  const totals = computeTotalDistances(game.core.order, game.core.events);
  const leaders = game.core.events.length > 0 ? totalDistanceLeaders(totals) : [];

  const petInfoFor = useCallback(
    (id: string): { petType: string; stage: number } => {
      if (id === userId) return { petType: mySave.petType, stage: mySave.evolutionStage };
      const m = room.members.find((mm) => mm.userId === id);
      return m ? { petType: m.petType, stage: m.stage } : { petType: "cat", stage: 1 };
    },
    [userId, mySave.petType, mySave.evolutionStage, room.members],
  );

  // Countdown tick.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, []);
  const remainingS = Math.max(0, Math.ceil((TOSS_TURN_TIMEOUT_MS - (Date.now() - game.turnStartedAt)) / 1000));

  // Per-turn "get ready" pause: every turn change shows a big banner and
  // blocks aiming for 3s so nobody gets ambushed by their own turn.
  const turnKey = turn ? `${turn.phase}:${turn.round}:${turn.userId}` : "over";
  const readyUntilRef = useRef(0);
  const lastTurnKeyRef = useRef<string | null>(null);
  if (lastTurnKeyRef.current !== turnKey) {
    lastTurnKeyRef.current = turnKey;
    if (turn) readyUntilRef.current = Date.now() + TURN_READY_MS;
  }
  const gettingReady = turn !== null && Date.now() < readyUntilRef.current;
  const readyRemainingS = Math.max(1, Math.ceil((readyUntilRef.current - Date.now()) / 1000));

  // ── Seeded per-round arena layout ─────────────────────────────────────────
  // Stays on the CURRENT round's position for the whole time a throw is
  // still flying (so the aim/flight always matches what was on screen when
  // it was launched), and only advances to the next round's position once
  // that flight finishes — see the completion callback below.
  const gameRef = useRef(game);
  gameRef.current = game;
  const [layoutRoundKey, setLayoutRoundKey] = useState(() => {
    const t = currentTossTurn(game.core);
    return t ? `${t.phase}:${t.round}` : game.markersKey;
  });
  const layout = arenaLayoutForTurn(game.seed, parseRoundKey(layoutRoundKey).phase, parseRoundKey(layoutRoundKey).round);

  // ── Aiming (drag-pullback) — ref-mirrored so handlers read synchronously ──
  const [aiming, setAiming] = useState(false);
  const [pull, setPull] = useState({ dx: 0, dy: 0 });
  const aimRef = useRef<{ startX: number; startY: number; dx: number; dy: number; active: boolean }>({
    startX: 0, startY: 0, dx: 0, dy: 0, active: false,
  });

  /** Straight-line slide: where a given pull's puck stops (may be off
   *  screen — that's the miss risk). Pull ratio is normalized to the
   *  ACTUAL room available to drag back (to the screen edge), so 100%
   *  power is always physically reachable, and travel distance is a
   *  multiple of THIS arena's own launcher→target span — both screen-size
   *  relative, neither a fixed pixel count. */
  const stopPointFor = useCallback(
    (dx: number, dy: number) => {
      const from = launcherPos(layout.launchNY);
      const pullLen = Math.hypot(dx, dy);
      if (pullLen < 1) return { x: from.x, y: from.y, v0: 0 };
      const pullRatio = pullLen / availablePullPx(from);
      const dist = pullRatio * arenaSpanPx(from, targetCenter(layout.targetNY)) * TRAVEL_SPAN_MULT;
      const v0 = velocityForDistance(dist);
      return { x: from.x - (dx / pullLen) * dist, y: from.y - (dy / pullLen) * dist, v0 };
    },
    [layout.launchNY, layout.targetNY],
  );

  const releaseAim = useCallback(() => {
    const aim = aimRef.current;
    if (!aim.active) return;
    aim.active = false;
    setAiming(false);
    setPull({ dx: 0, dy: 0 });
    const pullLen = Math.hypot(aim.dx, aim.dy);
    if (pullLen < 12) return; // a stray click, not a real pull — no throw
    const { x: toX, y: toY, v0 } = stopPointFor(aim.dx, aim.dy);
    // Off-screen stop point = a MISS (scores like a skip), but the slide
    // visual still plays so everyone sees the puck sail away.
    const inBounds = toX >= 0 && toX <= window.innerWidth && toY >= 0 && toY <= window.innerHeight;
    const c = targetCenter(layout.targetNY);
    const r = targetRadius();
    const distance = inBounds ? Math.round((Math.hypot(toX - c.x, toY - c.y) / r) * 1000) / 10 : null;
    room.submitToss({
      toNX: toX / window.innerWidth,
      toNY: toY / window.innerHeight,
      duration: slideDuration(v0),
      // A gentle tumble, not a full spin — this is a recognizable pet now,
      // not an anonymous puck, so keep it readable mid-slide.
      spinDegrees: (aim.dx > 0 ? -1 : 1) * Math.min(50, 10 + pullLen * 0.08),
      distance,
    });
  }, [room, stopPointFor, layout.targetNY]);

  useEffect(() => {
    if (!myTurn || over || gettingReady) return;
    const onMove = (e: MouseEvent) => {
      const aim = aimRef.current;
      if (!aim.active) return;
      aim.dx = e.clientX - aim.startX;
      aim.dy = e.clientY - aim.startY;
      setPull({ dx: aim.dx, dy: aim.dy });
    };
    const onUp = () => releaseAim();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [myTurn, over, gettingReady, releaseAim]);

  // ── Slide replay + deferred reveal ────────────────────────────────────────
  // Distance/marker/toast are only shown AFTER the puck visually stops
  // (game.lastFx/markers update the instant the event applies — too early,
  // that would show the result before the throw "arrives"). This component
  // keeps its own visibleMarkers + revealedFx, both set inside the slide's
  // completion callback, and wiped whenever the round (markersKey) changes.
  const ballX = useMotionValue(-100);
  const ballY = useMotionValue(-100);
  const ballRotate = useMotionValue(0);
  const [ballVisible, setBallVisible] = useState(false);
  const [visibleMarkers, setVisibleMarkers] = useState<
    { userId: string; nx: number; ny: number; distance: number }[]
  >([]);
  const [revealedFx, setRevealedFx] = useState<TossThrowFx | null>(null);
  const markersKeyRef = useRef(game.markersKey);
  if (markersKeyRef.current !== game.markersKey) {
    markersKeyRef.current = game.markersKey;
    // New round — old markers (the resting pets on the ice) leave with it.
    if (visibleMarkers.length > 0) setVisibleMarkers([]);
  }
  const playedFxRef = useRef<string | null>(null);
  useEffect(() => {
    const fx = game.lastFx;
    if (!fx || playedFxRef.current === fx.id) return;
    playedFxRef.current = fx.id;
    const from = launcherPos(layout.launchNY);
    ballX.set(from.x);
    ballY.set(from.y);
    ballRotate.set(0);
    setBallVisible(true);
    void slidePuck({
      x: ballX,
      y: ballY,
      rotate: ballRotate,
      toX: fx.toNX * window.innerWidth,
      toY: fx.toNY * window.innerHeight,
      duration: fx.duration,
      spinDegrees: fx.spinDegrees,
    }).then(() => {
      setBallVisible(false);
      setRevealedFx(fx); // only now does the distance/result become visible
      if (fx.distance !== null) {
        setVisibleMarkers((prev) => [...prev, { userId: fx.userId, nx: fx.toNX, ny: fx.toNY, distance: fx.distance! }]);
      }
      // Move the arena to the next round's layout only now that this
      // throw's flight has actually finished playing.
      const nowTurn = currentTossTurn(gameRef.current.core);
      setLayoutRoundKey(nowTurn ? `${nowTurn.phase}:${nowTurn.round}` : markersKeyRef.current);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.lastFx, ballX, ballY, ballRotate]);

  const c = targetCenter(layout.targetNY);
  const r = targetRadius();
  const lp = launcherPos(layout.launchNY);
  const nameOf = (id: string) => game.names[id] ?? "?";
  const turnName = turn ? (turn.userId === userId ? "You" : nameOf(turn.userId)) : "";
  const powerPct = Math.min(1, Math.hypot(pull.dx, pull.dy) / availablePullPx(lp));
  const [showHelp, setShowHelp] = useState(false);

  return (
    <div
      data-interactive
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 22000,
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        background: "rgba(8,8,14,0.35)",
        cursor: myTurn && !over ? "crosshair" : "default",
      }}
    >
      {/* Dashed halfway divider */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "8%",
          bottom: "8%",
          width: 0,
          borderLeft: "3px dashed rgba(255,255,255,0.25)",
        }}
      />

      {/* Concentric-ring target */}
      {[1, 0.78, 0.56, 0.34, 0.15].map((f, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: c.x - r * f,
            top: c.y - r * f,
            width: r * f * 2,
            height: r * f * 2,
            borderRadius: "50%",
            background: RING_COLORS[i],
            boxShadow: i === 0 ? "0 8px 30px rgba(0,0,0,0.45)" : undefined,
          }}
        />
      ))}

      {/* Resting pets — stay exactly where they landed (like a real puck on
          ice) for the rest of the round, shown once each throw's flight has
          actually finished, hover shows the thrower + distance */}
      {visibleMarkers.map((m, i) => {
        const info = petInfoFor(m.userId);
        return (
          <div
            key={`${m.userId}-${i}`}
            title={`${nameOf(m.userId)} — ${m.distance} from center`}
            style={{
              position: "absolute",
              left: m.nx * window.innerWidth - PUCK_SIZE / 2,
              top: m.ny * window.innerHeight - PUCK_SIZE / 2,
              zIndex: 3,
              filter: m.userId === userId ? "drop-shadow(0 0 5px rgba(52,211,153,0.9))" : "drop-shadow(0 0 5px rgba(96,165,250,0.9))",
            }}
          >
            <PuckSprite petType={info.petType} stage={info.stage} />
          </div>
        );
      })}

      {/* Launcher pad — shows whoever's turn it is (their own pet); only the
          active player gets the grab handle. */}
      <div
        style={{
          position: "absolute",
          left: lp.x - 34,
          top: lp.y - 34,
          width: 68,
          height: 68,
          borderRadius: "50%",
          background: "rgba(255,255,255,0.08)",
          border: "2px dashed rgba(255,255,255,0.35)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {turn &&
          !over &&
          (myTurn && !gettingReady ? (
            <div
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                aimRef.current = { startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, active: true };
                setAiming(true);
              }}
              style={{ cursor: "grab", transform: `translate(${pull.dx * 0.35}px, ${pull.dy * 0.35}px)` }}
            >
              <PuckSprite petType={mySave.petType} stage={mySave.evolutionStage} />
            </div>
          ) : (
            <PuckSprite {...petInfoFor(turn.userId)} opacity={0.6} />
          ))}
      </div>

      {/* Pull direction (short) + a power bar — strength only, no landing
          spot preview (that would reveal the score before the throw). */}
      {aiming && (
        <>
          <svg style={{ position: "absolute", inset: 0, pointerEvents: "none" }} width="100%" height="100%">
            <line
              x1={lp.x}
              y1={lp.y}
              x2={lp.x + pull.dx * 0.35}
              y2={lp.y + pull.dy * 0.35}
              stroke="rgba(253,224,71,0.9)"
              strokeWidth={3}
            />
          </svg>
          {/* Signal-strength-style power meter: POWER_LEVELS separate bars,
              each a bit taller than the last (staircase), lit up to the
              current power level. Strength only — never where it'll land. */}
          <div
            style={{
              position: "absolute",
              left: lp.x + 40,
              top: lp.y - 44,
              display: "flex",
              alignItems: "flex-end",
              gap: 2,
              pointerEvents: "none",
            }}
          >
            {Array.from({ length: POWER_LEVELS }, (_, i) => {
              const level = i + 1;
              const lit = powerPct * POWER_LEVELS >= level - 0.001;
              const barHeight = 8 + i * 3.6; // staircase, shortest to tallest
              const color = level > 8.5 ? "#ef4444" : level > 5.5 ? "#f59e0b" : "#22c55e";
              return (
                <div
                  key={i}
                  style={{
                    width: 6,
                    height: barHeight,
                    borderRadius: 2,
                    background: lit ? color : "rgba(255,255,255,0.15)",
                    boxShadow: lit ? `0 0 4px ${color}` : undefined,
                  }}
                />
              );
            })}
          </div>
          <div
            style={{
              position: "absolute",
              left: lp.x + 40,
              top: lp.y - 62,
              fontSize: 10,
              fontWeight: 800,
              color: powerPct > 0.85 ? "#f87171" : "#fde68a",
              textShadow: "0 2px 4px rgba(0,0,0,0.8)",
              pointerEvents: "none",
            }}
          >
            {powerPct > 0.85 ? "TOO HARD!" : "POWER"}
          </div>
        </>
      )}

      {/* The sliding puck (replayed identically on every client) */}
      {ballVisible && (
        <motion.div
          style={{
            position: "absolute",
            left: -PUCK_SIZE / 2,
            top: -PUCK_SIZE / 2,
            x: ballX,
            y: ballY,
            rotate: ballRotate,
            pointerEvents: "none",
            zIndex: 5,
          }}
        >
          <PuckSprite petType={petInfoFor(game.lastFx?.userId ?? "").petType} stage={petInfoFor(game.lastFx?.userId ?? "").stage} />
        </motion.div>
      )}

      {/* Top status strip: scoreboard (lowest total wins) + turn/countdown */}
      <div
        style={{
          position: "absolute",
          top: 14,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "8px 16px",
          borderRadius: 12,
          background: "rgba(20,20,26,0.92)",
          color: "#fff",
          fontSize: 13,
          boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
        }}
      >
        <span style={{ fontWeight: 800, fontSize: 18 }}>🎯 Target Toss</span>
        {game.core.order.map((id) => (
          <span
            key={id}
            style={{
              fontSize: 18,
              opacity: turn?.userId === id ? 1 : 0.6,
              fontWeight: turn?.userId === id ? 800 : 500,
              color: leaders.includes(id) ? "#34d399" : "#fff",
            }}
          >
            {leaders.includes(id) ? "👑 " : ""}
            {id === userId ? "You" : nameOf(id)}: {Math.round((totals[id] ?? 0) * 10) / 10} 📏
          </span>
        ))}
        <span style={{ fontSize: 9, opacity: 0.55 }}>(total dist. from center, lower wins)</span>
        {!over && turn && (
          <span style={{ color: "#fde68a", fontWeight: 800, fontSize: 18 }}>
            {turn.phase === "sudden"
              ? `⚡ Sudden death ${turn.round} — ${turnName}`
              : `Round ${turn.round}/${TARGET_TOSS_ROUNDS} — ${turnName}`}
            {" · "}
            <span style={{ fontSize: 22, fontWeight: 900, color: remainingS <= 5 ? "#f87171" : "#fde68a" }}>
              ⏳{remainingS}s
            </span>
          </span>
        )}
        <button
          title="How to play"
          onClick={() => setShowHelp((s) => !s)}
          style={{
            cursor: "pointer",
            border: "none",
            borderRadius: "50%",
            width: 22,
            height: 22,
            fontSize: 12,
            fontWeight: 900,
            background: showHelp ? "rgba(52,211,153,0.5)" : "rgba(255,255,255,0.15)",
            color: "#fff",
          }}
        >
          ?
        </button>
      </div>

      {showHelp && (
        <div
          style={{
            position: "absolute",
            top: 62,
            left: "50%",
            transform: "translateX(-50%)",
            maxWidth: 380,
            padding: "12px 16px",
            borderRadius: 12,
            background: "rgba(20,20,26,0.96)",
            color: "#e5e7eb",
            fontSize: 12,
            lineHeight: 1.5,
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            zIndex: 10,
          }}
        >
          {HOW_TO_PLAY}
        </div>
      )}

      {/* Per-turn "get ready" banner — shown to EVERYONE the moment the
          turn changes; the active player's aiming unlocks when it clears.
          Anchored just above the actual launch spot (not screen-center) so
          it's obvious WHERE the throw is about to happen. Clamped down from
          the top edge since launchNY can be as low as 0.3 of the viewport. */}
      {gettingReady && turn && (
        <motion.div
          key={turnKey}
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 220, damping: 16 }}
          style={{
            position: "absolute",
            left: lp.x,
            top: Math.max(90, lp.y - 90),
            transform: "translate(-50%, -100%)",
            padding: "12px 26px",
            borderRadius: 14,
            background: "rgba(20,20,26,0.94)",
            color: myTurn ? "#34d399" : "#fde68a",
            fontSize: 22,
            fontWeight: 900,
            textAlign: "center",
            boxShadow: "0 8px 30px rgba(0,0,0,0.6)",
            pointerEvents: "none",
          }}
        >
          {myTurn ? "Your turn!" : `${turnName}'s turn`}
          <div style={{ fontSize: 30, marginTop: 2 }}>{readyRemainingS}</div>
        </motion.div>
      )}

      {/* Result toast — only for the REVEALED throw (after its puck has
          actually finished sliding), never the in-flight one. */}
      {revealedFx && !over && (
        <motion.div
          key={revealedFx.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: [0, 1, 1, 0], y: 0 }}
          transition={{ duration: 2.6, times: [0, 0.15, 0.8, 1] }}
          style={{
            position: "absolute",
            top: 62,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "8px 16px",
            borderRadius: 10,
            background: "rgba(30,20,60,0.95)",
            color: "#fff",
            fontSize: 16,
            fontWeight: 700,
            pointerEvents: "none",
          }}
        >
          {revealedFx.distance === null
            ? `💨 ${revealedFx.userId === userId ? "Your" : `${nameOf(revealedFx.userId)}'s`} pet slid off the ice — miss!`
            : `🎯 ${revealedFx.userId === userId ? "You" : nameOf(revealedFx.userId)} landed ${revealedFx.distance} from center!`}
        </motion.div>
      )}

      {/* Aiming hint for the active player */}
      {myTurn && !over && !aiming && !gettingReady && (
        <div
          style={{
            position: "absolute",
            left: lp.x - 120,
            top: lp.y + 48,
            width: 240,
            textAlign: "center",
            color: "#fde68a",
            fontSize: 12,
            fontWeight: 700,
            textShadow: "0 2px 6px rgba(0,0,0,0.8)",
            pointerEvents: "none",
          }}
        >
          Grab your pet, pull back, release to slide it — too hard and it flies off the ice!
        </div>
      )}

      {/* Winner banner — full standings, lowest total first */}
      {over && (
        <div
          style={{
            position: "absolute",
            top: "40%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            padding: "18px 30px",
            borderRadius: 16,
            background: "rgba(20,20,26,0.96)",
            color: "#fff",
            fontSize: 18,
            fontWeight: 800,
            textAlign: "center",
            boxShadow: "0 8px 30px rgba(0,0,0,0.6)",
          }}
        >
          {game.core.winners.includes(userId)
            ? game.core.winners.length > 1
              ? "🤝 Shared victory!"
              : "🏆 You win!"
            : `🏆 ${game.core.winners.map(nameOf).join(" & ")} wins!`}
          <div style={{ marginTop: 2, fontSize: 10, fontWeight: 600, opacity: 0.6 }}>
            Total distance from center across all throws — lowest wins
          </div>
          <div style={{ marginTop: 8, fontSize: 12, fontWeight: 600, opacity: 0.85 }}>
            {[...game.core.order]
              .sort((a, b) => (totals[a] ?? 0) - (totals[b] ?? 0))
              .map((id) => (
                <div key={id}>
                  {game.core.winners.includes(id) ? "👑 " : "　"}
                  {id === userId ? "You" : nameOf(id)} — {Math.round((totals[id] ?? 0) * 10) / 10} total distance
                </div>
              ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <button
              onClick={room.dismissTossGame}
              style={{
                cursor: "pointer",
                border: "none",
                borderRadius: 8,
                padding: "7px 18px",
                fontSize: 13,
                fontWeight: 700,
                background: "rgba(52,211,153,0.85)",
                color: "#06281c",
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
