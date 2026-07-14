// Full-screen Rock-Paper-Scissors modal (moved out of RoomBar's tiny inline
// strip). Flow: 5s pick countdown (big buttons) → both moves in → 3s reveal
// drumroll → both moves shown + winner's pet does the happy wiggle. If the
// 5s elapses without both picks, useRoom cancels the game with a message
// naming who didn't pick. All timing state lives in useRoom's
// ActiveMinigame (startedAt/resolvedAt/cancelled) — this component only
// renders it.
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import type { PetSaveData } from "@pet/core";
import { spriteFor, emojiFor } from "../petSprites";
import {
  RPS_PICK_TIMEOUT_MS,
  RPS_REVEAL_MS,
  type RoomApi,
  type RpsMove,
} from "../../online/useRoom";

const RPS_EMOJI: Record<RpsMove, string> = { rock: "✊", paper: "✋", scissors: "✌️" };
const MOVES: RpsMove[] = ["rock", "paper", "scissors"];

function PetSprite({ petType, stage, name, wiggle }: { petType: string; stage: number; name: string; wiggle: boolean }) {
  const sprite = spriteFor(petType, stage);
  return (
    <div className={wiggle ? "pet-anim-happy" : undefined} style={{ textAlign: "center" }}>
      {sprite ? (
        <img src={sprite} width={72} height={72} draggable={false} alt={name} />
      ) : (
        <span style={{ fontSize: 56 }}>{emojiFor(petType)}</span>
      )}
      <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.85, marginTop: 2 }}>{name}</div>
    </div>
  );
}

export function RockPaperScissors({ room, userId, mySave }: { room: RoomApi; userId: string; mySave: PetSaveData }) {
  const game = room.minigame!;
  // Half-second tick drives both countdowns.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, []);

  const opponent = room.members.find((m) => m.userId === game.opponentId);
  const pickRemaining = Math.max(0, Math.ceil((RPS_PICK_TIMEOUT_MS - (Date.now() - game.startedAt)) / 1000));
  const revealRemaining = game.resolvedAt
    ? Math.max(0, Math.ceil((RPS_REVEAL_MS - (Date.now() - game.resolvedAt)) / 1000))
    : null;
  const revealed = game.outcome !== null && revealRemaining === 0;

  const panel: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 16,
    padding: "26px 40px",
    borderRadius: 20,
    background: "rgba(18,18,26,0.97)",
    color: "#fff",
    boxShadow: "0 12px 40px rgba(0,0,0,0.65)",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    minWidth: 340,
    textAlign: "center",
  };

  return (
    <div
      data-interactive
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 22000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(8,8,14,0.45)",
      }}
    >
      <div style={panel}>
        <div style={{ fontSize: 16, fontWeight: 800 }}>
          ✊✋✌️ Rock · Paper · Scissors — vs {game.opponentName}
        </div>

        {game.cancelled ? (
          <>
            <div style={{ fontSize: 14, color: "#fca5a5", fontWeight: 700 }}>⏱️ {game.cancelled}</div>
            <button style={closeBtn} onClick={room.clearMinigame}>
              Close
            </button>
          </>
        ) : game.outcome === null ? (
          <>
            {/* Pick phase — big countdown + big buttons */}
            <motion.div
              key={pickRemaining}
              initial={{ scale: 1.5, opacity: 0.4 }}
              animate={{ scale: 1, opacity: 1 }}
              style={{ fontSize: 44, fontWeight: 900, color: pickRemaining <= 2 ? "#f87171" : "#fde68a" }}
            >
              {pickRemaining}
            </motion.div>
            {game.myMove ? (
              <div style={{ fontSize: 14, opacity: 0.85 }}>
                <span style={{ fontSize: 40 }}>{RPS_EMOJI[game.myMove]}</span>
                <div>Locked in — waiting for {game.opponentName}…</div>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 14 }}>
                {MOVES.map((m) => (
                  <motion.button
                    key={m}
                    whileHover={{ scale: 1.12 }}
                    whileTap={{ scale: 0.94 }}
                    title={m}
                    onClick={() => room.sendRpsMove(m)}
                    style={{
                      cursor: "pointer",
                      border: "2px solid rgba(255,255,255,0.18)",
                      borderRadius: 18,
                      width: 88,
                      height: 88,
                      fontSize: 46,
                      background: "rgba(255,255,255,0.08)",
                    }}
                  >
                    {RPS_EMOJI[m]}
                  </motion.button>
                ))}
              </div>
            )}
            <div style={{ fontSize: 11, opacity: 0.6 }}>Pick before the timer runs out!</div>
          </>
        ) : !revealed ? (
          <>
            {/* Reveal drumroll */}
            <div style={{ fontSize: 13, opacity: 0.8 }}>Both picks are in…</div>
            <motion.div
              key={revealRemaining ?? 0}
              initial={{ scale: 1.6, opacity: 0.3 }}
              animate={{ scale: 1, opacity: 1 }}
              style={{ fontSize: 52, fontWeight: 900, color: "#fde68a" }}
            >
              {revealRemaining}
            </motion.div>
          </>
        ) : (
          <>
            {/* Reveal: both moves + winner celebration */}
            <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
              <motion.div initial={{ x: -40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 54 }}>{RPS_EMOJI[game.myMove!]}</div>
                <PetSprite
                  petType={mySave.petType}
                  stage={mySave.evolutionStage}
                  name="You"
                  wiggle={game.outcome === "win" || game.outcome === "tie"}
                />
              </motion.div>
              <div style={{ fontSize: 20, fontWeight: 900, opacity: 0.6 }}>VS</div>
              <motion.div initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 54 }}>{RPS_EMOJI[game.theirMove!]}</div>
                <PetSprite
                  petType={opponent?.petType ?? "cat"}
                  stage={opponent?.stage ?? 1}
                  name={game.opponentName}
                  wiggle={game.outcome === "lose" || game.outcome === "tie"}
                />
              </motion.div>
            </div>
            <motion.div
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 200, damping: 14 }}
              style={{
                fontSize: 20,
                fontWeight: 900,
                color: game.outcome === "win" ? "#34d399" : game.outcome === "tie" ? "#fde68a" : "#fca5a5",
              }}
            >
              {game.outcome === "win" ? "🏆 You win!" : game.outcome === "tie" ? "🤝 It's a tie!" : `💔 ${game.opponentName} wins!`}
            </motion.div>
            <button style={closeBtn} onClick={room.clearMinigame}>
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const closeBtn: React.CSSProperties = {
  cursor: "pointer",
  border: "none",
  borderRadius: 10,
  padding: "8px 22px",
  fontSize: 14,
  fontWeight: 700,
  background: "rgba(52,211,153,0.85)",
  color: "#06281c",
};
