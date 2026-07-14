// Target Toss arena (room minigame #1). Right half: concentric-ring target;
// left half: the active thrower's launcher. Aiming is a drag-pullback
// slingshot, and the puck slides in a STRAIGHT line with ice-like friction
// (curlPhysics.ts) — the dashed aim preview ends exactly where the puck
// will stop, by construction. An over-powered pull whose stop point falls
// off screen is a MISS (distance null, scores like a skip) but still plays
// its slide-off visual. The thrower computes the stop point locally and
// broadcasts it; every client replays the identical slidePuck().
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useMotionValue } from "framer-motion";
import { computeStandings, currentTossTurn, TARGET_TOSS_ROUNDS } from "@pet/core";
import { slidePuck, slideDistance, slideDuration } from "../curlPhysics";
import { TOSS_TURN_TIMEOUT_MS, type RoomApi } from "../../online/useRoom";

// Arena geometry (fractions of the window, so every screen sees the same
// relative layout — matching the pos-broadcast convention).
const TARGET_NX = 0.75;
const TARGET_NY = 0.55;
const LAUNCH_NX = 0.2;
const LAUNCH_NY = 0.65;
/** Target outer-ring radius as a fraction of min(viewport w, h). */
const TARGET_R_FRAC = 0.18;
/** Launch speed (px/s) per pixel of pull — high enough that a hard pull
 *  can overshoot the whole screen (that's the miss risk). */
const V0_PER_PULL_PX = 11;
/** Pre-turn "get ready" pause before aiming unlocks. */
const TURN_READY_MS = 3_000;

const RING_COLORS = ["rgba(248,113,113,0.85)", "rgba(255,255,255,0.9)", "rgba(248,113,113,0.85)", "rgba(255,255,255,0.9)", "rgba(239,68,68,0.95)"];

function targetCenter() {
  return { x: TARGET_NX * window.innerWidth, y: TARGET_NY * window.innerHeight };
}
function targetRadius() {
  return Math.min(window.innerWidth, window.innerHeight) * TARGET_R_FRAC;
}
function launcherPos() {
  return { x: LAUNCH_NX * window.innerWidth, y: LAUNCH_NY * window.innerHeight };
}

export function TargetToss({ room, userId }: { room: RoomApi; userId: string }) {
  const game = room.tossGame!;
  const turn = currentTossTurn(game.core);
  const myTurn = turn?.userId === userId;
  const over = game.core.winners.length > 0;
  const standings = computeStandings(game.core.order, game.core.events);

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

  // ── Aiming (drag-pullback) — ref-mirrored so handlers read synchronously ──
  const [aiming, setAiming] = useState(false);
  const [pull, setPull] = useState({ dx: 0, dy: 0 });
  const aimRef = useRef<{ startX: number; startY: number; dx: number; dy: number; active: boolean }>({
    startX: 0, startY: 0, dx: 0, dy: 0, active: false,
  });

  /** Straight-line slide: where a given pull's puck stops (may be off screen). */
  const stopPointFor = useCallback((dx: number, dy: number) => {
    const from = launcherPos();
    const pullLen = Math.hypot(dx, dy);
    if (pullLen < 1) return { x: from.x, y: from.y, v0: 0 };
    const v0 = pullLen * V0_PER_PULL_PX;
    const dist = slideDistance(v0);
    return { x: from.x - (dx / pullLen) * dist, y: from.y - (dy / pullLen) * dist, v0 };
  }, []);

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
    const c = targetCenter();
    const r = targetRadius();
    const distance = inBounds ? Math.round((Math.hypot(toX - c.x, toY - c.y) / r) * 1000) / 10 : null;
    room.submitToss({
      toNX: toX / window.innerWidth,
      toNY: toY / window.innerHeight,
      duration: slideDuration(v0),
      spinDegrees: (aim.dx > 0 ? -1 : 1) * (90 + pullLen * 0.6),
      distance,
    });
  }, [room, stopPointFor]);

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

  // ── Slide replay + deferred markers ───────────────────────────────────────
  // Markers are shown only AFTER the puck visually stops (game.markers
  // updates the instant the event applies — too early), so this component
  // keeps its own visibleMarkers, appended in the slide's completion
  // callback and wiped whenever the round (markersKey) changes.
  const ballX = useMotionValue(-100);
  const ballY = useMotionValue(-100);
  const ballRotate = useMotionValue(0);
  const [ballVisible, setBallVisible] = useState(false);
  const [visibleMarkers, setVisibleMarkers] = useState<
    { userId: string; nx: number; ny: number; distance: number }[]
  >([]);
  const markersKeyRef = useRef(game.markersKey);
  if (markersKeyRef.current !== game.markersKey) {
    markersKeyRef.current = game.markersKey;
    // New round — old markers leave with it. (Render-time reset keeps the
    // wipe in the same commit as the round change.)
    if (visibleMarkers.length > 0) setVisibleMarkers([]);
  }
  const playedFxRef = useRef<string | null>(null);
  useEffect(() => {
    const fx = game.lastFx;
    if (!fx || playedFxRef.current === fx.id) return;
    playedFxRef.current = fx.id;
    const from = launcherPos();
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
      if (fx.distance !== null) {
        setVisibleMarkers((prev) => [...prev, { userId: fx.userId, nx: fx.toNX, ny: fx.toNY, distance: fx.distance! }]);
      }
    });
  }, [game.lastFx, ballX, ballY, ballRotate]);

  const c = targetCenter();
  const r = targetRadius();
  const lp = launcherPos();
  const nameOf = (id: string) => game.names[id] ?? "?";
  const turnName = turn ? (turn.userId === userId ? "You" : nameOf(turn.userId)) : "";
  const lastFx = game.lastFx;

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

      {/* Landing markers (current round only, shown once the puck stops),
          hover shows the thrower */}
      {visibleMarkers.map((m, i) => (
        <div
          key={`${m.userId}-${i}`}
          title={`${nameOf(m.userId)} — ${m.distance} from center`}
          style={{
            position: "absolute",
            left: m.nx * window.innerWidth - 7,
            top: m.ny * window.innerHeight - 7,
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: m.userId === userId ? "#34d399" : "#60a5fa",
            border: "2px solid rgba(0,0,0,0.55)",
            zIndex: 3,
          }}
        />
      ))}

      {/* Launcher pad + slingshot (active player aims here) */}
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
        {myTurn && !over && !gettingReady && (
          <div
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              aimRef.current = { startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, active: true };
              setAiming(true);
            }}
            style={{ fontSize: 34, cursor: "grab", userSelect: "none", transform: `translate(${pull.dx * 0.35}px, ${pull.dy * 0.35}px)` }}
          >
            🥌
          </div>
        )}
      </div>

      {/* Rubber-band aim line + the puck's EXACT projected stop point
          (straight-line physics — the preview is the travel line). */}
      {aiming &&
        (() => {
          const stop = stopPointFor(pull.dx, pull.dy);
          const willMiss =
            stop.x < 0 || stop.x > window.innerWidth || stop.y < 0 || stop.y > window.innerHeight;
          return (
            <svg style={{ position: "absolute", inset: 0, pointerEvents: "none" }} width="100%" height="100%">
              <line
                x1={lp.x}
                y1={lp.y}
                x2={lp.x + pull.dx * 0.35}
                y2={lp.y + pull.dy * 0.35}
                stroke="rgba(253,224,71,0.9)"
                strokeWidth={3}
              />
              <line
                x1={lp.x}
                y1={lp.y}
                x2={stop.x}
                y2={stop.y}
                stroke={willMiss ? "rgba(248,113,113,0.7)" : "rgba(255,255,255,0.4)"}
                strokeWidth={2}
                strokeDasharray="6 6"
              />
              {!willMiss && <circle cx={stop.x} cy={stop.y} r={7} fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth={2} />}
            </svg>
          );
        })()}

      {/* The sliding puck (replayed identically on every client) */}
      {ballVisible && (
        <motion.div
          style={{
            position: "absolute",
            left: -17,
            top: -17,
            x: ballX,
            y: ballY,
            rotate: ballRotate,
            fontSize: 34,
            pointerEvents: "none",
            zIndex: 5,
          }}
        >
          🥌
        </motion.div>
      )}

      {/* Top status strip: scoreboard + turn/countdown */}
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
            style={{ fontSize: 18, opacity: turn?.userId === id ? 1 : 0.6, fontWeight: turn?.userId === id ? 800 : 500 }}
          >
            {id === userId ? "You" : nameOf(id)}: {standings[id] ?? 0}🏆
          </span>
        ))}
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
      </div>

      {/* Per-turn "get ready" banner — shown to EVERYONE the moment the
          turn changes; the active player's aiming unlocks when it clears. */}
      {gettingReady && turn && (
        <motion.div
          key={turnKey}
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 220, damping: 16 }}
          style={{
            position: "absolute",
            top: "34%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            padding: "16px 34px",
            borderRadius: 16,
            background: "rgba(20,20,26,0.94)",
            color: myTurn ? "#34d399" : "#fde68a",
            fontSize: 30,
            fontWeight: 900,
            textAlign: "center",
            boxShadow: "0 8px 30px rgba(0,0,0,0.6)",
            pointerEvents: "none",
          }}
        >
          {myTurn ? "🥌 Your turn!" : `${turnName}'s turn`}
          <div style={{ fontSize: 40, marginTop: 4 }}>{readyRemainingS}</div>
        </motion.div>
      )}

      {/* Result toast for the latest throw */}
      {lastFx && !over && (
        <motion.div
          key={lastFx.id}
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
          {lastFx.distance === null
            ? `💨 ${lastFx.userId === userId ? "Your" : `${nameOf(lastFx.userId)}'s`} puck sailed off the ice — miss!`
            : `🎯 ${lastFx.userId === userId ? "You" : nameOf(lastFx.userId)} landed ${lastFx.distance} from center!`}
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
          Grab the puck, pull back, release to slide it — too hard and it flies off the ice!
        </div>
      )}

      {/* Winner banner */}
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
