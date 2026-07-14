// Target Toss arena (room minigame #1). Right half: concentric-ring target;
// left half: the active thrower's launcher with drag-pullback slingshot
// aiming (same manual-velocity technique as the proven feed/ball gestures).
// The thrower computes its landing locally and broadcasts the arc params;
// EVERY client (thrower included) replays the identical throwArc() flight,
// so there's no cross-client physics simulation to desync. Placeholder
// CSS/motion shapes only — no art assets yet.
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useMotionValue } from "framer-motion";
import { computeStandings, currentTossTurn, TARGET_TOSS_ROUNDS } from "@pet/core";
import { throwArc } from "../throwPhysics";
import { TOSS_TURN_TIMEOUT_MS, type RoomApi } from "../../online/useRoom";

// Arena geometry (fractions of the window, so every screen sees the same
// relative layout — matching the pos-broadcast convention).
const TARGET_NX = 0.75;
const TARGET_NY = 0.55;
const LAUNCH_NX = 0.2;
const LAUNCH_NY = 0.65;
/** Target outer-ring radius as a fraction of min(viewport w, h). */
const TARGET_R_FRAC = 0.18;
/** Landing offset = pull vector × this (slingshot power). */
const PULL_POWER = 3.2;

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

  // ── Aiming (drag-pullback) — ref-mirrored so handlers read synchronously ──
  const [aiming, setAiming] = useState(false);
  const [pull, setPull] = useState({ dx: 0, dy: 0 });
  const aimRef = useRef<{ startX: number; startY: number; dx: number; dy: number; active: boolean }>({
    startX: 0, startY: 0, dx: 0, dy: 0, active: false,
  });

  const releaseAim = useCallback(() => {
    const aim = aimRef.current;
    if (!aim.active) return;
    aim.active = false;
    setAiming(false);
    setPull({ dx: 0, dy: 0 });
    const pullLen = Math.hypot(aim.dx, aim.dy);
    if (pullLen < 12) return; // a stray click, not a real pull — no throw
    const from = launcherPos();
    // Slingshot: launch opposite the pull.
    const toX = Math.max(20, Math.min(window.innerWidth - 20, from.x - aim.dx * PULL_POWER));
    const toY = Math.max(20, Math.min(window.innerHeight - 40, from.y - aim.dy * PULL_POWER));
    const c = targetCenter();
    const r = targetRadius();
    const distance = Math.round((Math.hypot(toX - c.x, toY - c.y) / r) * 1000) / 10; // % of target radius, 1 decimal
    const flightLen = Math.hypot(toX - from.x, toY - from.y);
    room.submitToss({
      toNX: toX / window.innerWidth,
      toNY: toY / window.innerHeight,
      arcHeight: Math.max(80, Math.min(280, 60 + pullLen * 0.9)),
      duration: 0.55 + Math.min(0.5, flightLen / 1400),
      spinDegrees: 280 + pullLen * 1.5,
      distance,
    });
  }, [room]);

  useEffect(() => {
    if (!myTurn || over) return;
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
  }, [myTurn, over, releaseAim]);

  // ── Flight replay: every client animates lastFx with the shared physics ──
  const ballX = useMotionValue(-100);
  const ballY = useMotionValue(-100);
  const ballRotate = useMotionValue(0);
  const ballScaleX = useMotionValue(1);
  const ballScaleY = useMotionValue(1);
  const [ballVisible, setBallVisible] = useState(false);
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
    void throwArc({
      x: ballX,
      y: ballY,
      rotate: ballRotate,
      scaleX: ballScaleX,
      scaleY: ballScaleY,
      toX: fx.toNX * window.innerWidth,
      toY: fx.toNY * window.innerHeight,
      arcHeight: fx.arcHeight,
      duration: fx.duration,
      spinDegrees: fx.spinDegrees,
    }).then(() => setBallVisible(false));
  }, [game.lastFx, ballX, ballY, ballRotate, ballScaleX, ballScaleY]);

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

      {/* Landing markers (current round only), hover shows the thrower */}
      {game.markers.map((m, i) => (
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
        {myTurn && !over && (
          <div
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              aimRef.current = { startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, active: true };
              setAiming(true);
            }}
            style={{ fontSize: 34, cursor: "grab", userSelect: "none", transform: `translate(${pull.dx * 0.35}px, ${pull.dy * 0.35}px)` }}
          >
            ⚾
          </div>
        )}
      </div>

      {/* Rubber-band aim line + projected direction hint */}
      {aiming && (
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
            x2={lp.x - pull.dx * 1.2}
            y2={lp.y - pull.dy * 1.2}
            stroke="rgba(255,255,255,0.35)"
            strokeWidth={2}
            strokeDasharray="6 6"
          />
        </svg>
      )}

      {/* The flying ball (replayed identically on every client) */}
      {ballVisible && (
        <motion.div
          style={{
            position: "absolute",
            left: -17,
            top: -17,
            x: ballX,
            y: ballY,
            rotate: ballRotate,
            scaleX: ballScaleX,
            scaleY: ballScaleY,
            fontSize: 34,
            pointerEvents: "none",
            zIndex: 5,
          }}
        >
          ⚾
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
        <span style={{ fontWeight: 800 }}>🎯 Target Toss</span>
        {game.core.order.map((id) => (
          <span key={id} style={{ opacity: turn?.userId === id ? 1 : 0.6, fontWeight: turn?.userId === id ? 800 : 500 }}>
            {id === userId ? "You" : nameOf(id)}: {standings[id] ?? 0}🏆
          </span>
        ))}
        {!over && turn && (
          <span style={{ color: "#fde68a", fontWeight: 700 }}>
            {turn.phase === "sudden"
              ? `⚡ Sudden death ${turn.round} — ${turnName}`
              : `Round ${turn.round}/${TARGET_TOSS_ROUNDS} — ${turnName}`}
            {" · "}
            {myTurn ? `⏳ ${remainingS}s` : `aiming… ${remainingS}s`}
          </span>
        )}
      </div>

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
            padding: "6px 14px",
            borderRadius: 10,
            background: "rgba(30,20,60,0.95)",
            color: "#fff",
            fontSize: 12,
            fontWeight: 700,
            pointerEvents: "none",
          }}
        >
          🎯 {lastFx.userId === userId ? "You" : nameOf(lastFx.userId)} landed {lastFx.distance} from center!
        </motion.div>
      )}

      {/* Aiming hint for the active player */}
      {myTurn && !over && !aiming && (
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
          Grab the ball, pull back, release to launch!
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
